'use strict';

/**
 * How the machine is doing, measured on a clock, and said when it crosses a line.
 *
 * Two clocks, because the two kinds of reading cost nothing alike. The system
 * is read every minute: free disk, free memory, load, the app's own memory, how
 * many terminals are open, how big the database and its log are. That is a few
 * syscalls. The inventory — what the sessions, worktrees and caches weigh — is
 * read once an hour, or when the panel asks, because it walks the disk.
 *
 * Every reading is held against thresholds with three levels: fine, attention,
 * limit. A metric that crosses into attention or limit is said once by a
 * notification, and not again for a day unless it gets worse; a panel can be
 * ignored, a notification every minute cannot. Each condition carries why it
 * matters in plain words, because "disk 92%" is a number and "builds and the
 * database slow down when the volume is this full" is a reason to act.
 *
 * Readings are kept for a month, which is enough to say how fast a bucket is
 * growing and, for the disk, how many days are left at that rate.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

/**
 * The lines, by metric. `direction` says which way is worse. `attention` and
 * `limit` are the defaults; a setting of the same name overrides each.
 */
const THRESHOLDS = Object.freeze({
  'disk.free.pct': { label: 'Disk free', unit: '%', direction: 'below', attention: 15, limit: 8, why: 'A nearly full volume slows every build, the database and the system itself; APFS needs room to write.' },
  'disk.free.bytes': { label: 'Disk free', unit: 'bytes', direction: 'below', attention: 50 * GB, limit: 20 * GB, why: 'Below this, one large build cache or one container image can fill the disk.' },
  'mem.free.bytes': { label: 'Memory free', unit: 'bytes', direction: 'below', attention: 2 * GB, limit: 1 * GB, why: 'With little memory free the system swaps, and typing in the terminals starts to lag.' },
  'swap.used.pct': { label: 'Swap in use', unit: '%', direction: 'above', attention: 50, limit: 80, why: 'Swap is memory on disk: every page the system has to bring back is a pause, and the terminals feel every one. This is what makes the machine lag.' },
  'swap.used.bytes': { label: 'Swap used', unit: 'bytes', direction: 'above', attention: 2 * GB, limit: 6 * GB, why: 'Gigabytes of swap mean the programs open do not fit in memory together; closing some is the only real fix.' },
  'load.per.core': { label: 'Load per core', unit: 'x', direction: 'above', attention: 1, limit: 2, why: 'More runnable work than cores for five minutes means everything waits its turn, the terminals included.' },
  'app.rss.bytes': { label: 'App memory', unit: 'bytes', direction: 'above', attention: 3 * GB, limit: 6 * GB, why: 'The app itself holding this much is usually many open sessions with long scrollback.' },
  'sessions.open': { label: 'Open sessions', unit: '', direction: 'above', attention: 30, limit: 60, why: 'Each open Claude session is a process and a conversation in memory; past a point, the machine is the limit.' },
  'db.bytes': { label: 'Database', unit: 'bytes', direction: 'above', attention: 1 * GB, limit: 2 * GB, why: 'Searching and opening history take longer as the file grows; most of it is kept conversations.' },
  'db.wal.bytes': { label: 'Database log', unit: 'bytes', direction: 'above', attention: 256 * MB, limit: 1 * GB, why: 'The write-ahead log grows while the app runs and is folded back only now and then; a large one slows every read.' },
  'worktrees.inactive': { label: 'Inactive worktrees', unit: '', direction: 'above', attention: 20, limit: 50, why: 'Worktrees nobody has touched in two weeks are mostly build caches, and Spotlight indexes every one.' },
  'budget.app.bytes': { label: 'App data', unit: 'bytes', direction: 'above', attention: null, limit: null, why: 'What Smart Terminal keeps — conversations, copies, backups — past the budget you set.' },
  'budget.worktrees.bytes': { label: 'Worktrees and caches', unit: 'bytes', direction: 'above', attention: null, limit: null, why: 'What the worktrees and their caches weigh, past the budget you set.' },
});

const LEVELS = ['fine', 'attention', 'limit'];
const NOTIFY_COOLDOWN = DAY;

class HousekeepingMonitor {
  /**
   * @param {object} deps
   * @param {object} deps.store        a HousekeepingStore (readings and settings)
   * @param {object} deps.housekeeping the Housekeeping, for the hourly inventory
   * @param {string} deps.userData
   * @param {() => number} [deps.openSessions]
   * @param {(note: {title: string, body: string, metric: string}) => void} [deps.notify]
   * @param {(name: string, payload: unknown) => void} [deps.emit]
   * @param {object} [deps.sys]        overrides for tests: freemem, totalmem, loadavg, cpus, rss, statfs
   * @param {() => number} [deps.now]
   */
  constructor({ store, housekeeping, userData, openSessions = () => 0, notify = () => {}, emit = () => {}, sys = {}, now = () => Date.now(), systemEvery = MINUTE, inventoryEvery = HOUR }) {
    this.store = store;
    this.housekeeping = housekeeping;
    this.userData = userData;
    this.openSessions = openSessions;
    this.notify = notify;
    this.emit = emit;
    this.sys = sys;
    this.now = now;
    this.systemEvery = systemEvery;
    this.inventoryEvery = inventoryEvery;
    this.timers = [];
    this.latest = {};
    this.lastInventoryAt = 0;
    this.conditions = [];
  }

  start() {
    if (this.timers.length) return;
    const sys = setInterval(() => this.tickSystem().catch(() => {}), this.systemEvery);
    const inv = setInterval(() => this.tickInventory().catch(() => {}), this.inventoryEvery);
    sys.unref?.();
    inv.unref?.();
    this.timers = [sys, inv];
    // A first reading soon after start, and the inventory a little later so start-up is not spent walking the disk.
    const first = setTimeout(() => this.tickSystem().catch(() => {}), 5_000);
    const second = setTimeout(() => this.tickInventory().catch(() => {}), 2 * MINUTE);
    first.unref?.();
    second.unref?.();
    this.timers.push(first, second);
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer), clearInterval(timer);
    this.timers = [];
  }

  // --- readings ---------------------------------------------------------------

  /** The cheap readings: a few syscalls. */
  async tickSystem() {
    const free = this.sys.freemem?.() ?? os.freemem();
    const total = this.sys.totalmem?.() ?? os.totalmem();
    const load = this.sys.loadavg?.() ?? os.loadavg();
    const cores = this.sys.cpus?.() ?? os.cpus().length;
    const rss = this.sys.rss?.() ?? process.memoryUsage().rss;
    const disk = this.sys.statfs?.() ?? diskOf(this.userData);
    const swap = this.sys.swap?.() ?? readSwap();
    const dbFile = path.join(this.userData, 'smart-terminal.db');
    const readings = {
      'disk.free.bytes': disk.free,
      'disk.free.pct': disk.total ? Math.round((disk.free / disk.total) * 1000) / 10 : null,
      'disk.used.bytes': disk.total && disk.free !== null ? disk.total - disk.free : null,
      'mem.free.bytes': free,
      'mem.total.bytes': total,
      'swap.used.bytes': swap.used,
      'swap.total.bytes': swap.total,
      'swap.used.pct': swap.total ? Math.round((swap.used / swap.total) * 1000) / 10 : null,
      // The five-minute average: a one-minute spike is a build starting, not a condition.
      'load.per.core': cores ? Math.round((load[1] / cores) * 100) / 100 : null,
      'app.rss.bytes': rss,
      'sessions.open': this.openSessions(),
      'db.bytes': sizeOf(dbFile),
      'db.wal.bytes': sizeOf(`${dbFile}-wal`),
    };
    this.#record(readings);
    return this.#evaluate();
  }

  /** The expensive readings: what things weigh, once an hour. */
  async tickInventory() {
    const inventory = await this.housekeeping.inventory();
    const worktrees = inventory.items.filter((one) => one.kind === 'worktree');
    const inactive = worktrees.filter((one) => one.lastActivityAt !== null && this.now() - one.lastActivityAt > 14 * DAY);
    const readings = {
      'bucket.sessions.bytes': inventory.totals.sessions.bytes,
      'bucket.worktrees.bytes': inventory.totals.worktrees.bytes,
      'bucket.app.bytes': inventory.totals.app.bytes,
      'budget.app.bytes': inventory.totals.sessions.bytes + inventory.totals.app.bytes,
      'budget.worktrees.bytes': inventory.totals.worktrees.bytes,
      'free.now.bytes': inventory.totals.all.reversibleBytes,
      'worktrees.count': worktrees.length,
      'worktrees.inactive': inactive.length,
      'worktrees.finished': worktrees.filter((one) => one.meta?.finished).length,
    };
    this.lastInventoryAt = this.now();
    this.#record(readings);
    return this.#evaluate();
  }

  #record(readings) {
    const at = this.now();
    const kept = [];
    for (const [metric, value] of Object.entries(readings)) {
      if (value === null || value === undefined || Number.isNaN(value)) continue;
      this.latest[metric] = { value, at };
      kept.push([metric, value]);
    }
    try {
      this.store.recordReadings(kept, at);
    } catch {
      /* a reading not kept is still a reading shown */
    }
  }

  // --- thresholds ---------------------------------------------------------------

  /** The lines as they stand: defaults with the person's settings over them. */
  thresholds() {
    const settings = this.store.settings();
    const out = {};
    for (const [metric, base] of Object.entries(THRESHOLDS)) {
      const attention = settings[`${metric}.attention`];
      const limit = settings[`${metric}.limit`];
      out[metric] = {
        ...base,
        attention: attention === undefined ? base.attention : attention,
        limit: limit === undefined ? base.limit : limit,
      };
    }
    return out;
  }

  /** Change a line. `null` turns it off. */
  setThreshold(metric, level, value) {
    if (!THRESHOLDS[metric] || !['attention', 'limit'].includes(level)) throw new Error(`Not a threshold: ${metric}.${level}`);
    const number = value === null || value === '' ? null : Number(value);
    if (number !== null && !Number.isFinite(number)) throw new Error('A threshold is a number, or nothing.');
    this.store.setSetting(`${metric}.${level}`, number);
    return this.#evaluate();
  }

  /** Where each metric stands, and what to say about it. Notifies on the way when a line was crossed. */
  #evaluate() {
    const lines = this.thresholds();
    const conditions = [];
    for (const [metric, line] of Object.entries(lines)) {
      const reading = this.latest[metric];
      if (!reading) continue;
      const level = levelOf(reading.value, line);
      if (level === 'fine') continue;
      conditions.push({
        metric,
        label: line.label,
        level,
        value: reading.value,
        unit: line.unit,
        threshold: level === 'limit' ? line.limit : line.attention,
        direction: line.direction,
        why: line.why,
        at: reading.at,
      });
    }
    conditions.sort((a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level) || a.label.localeCompare(b.label));
    this.conditions = conditions;
    this.#say(conditions);
    const status = conditions.some((one) => one.level === 'limit') ? 'limit' : conditions.length ? 'attention' : 'fine';
    this.emit('health', { status, conditions });
    return { status, conditions };
  }

  /** One notification per crossing, and not again for a day unless it got worse. */
  #say(conditions) {
    const said = this.store.setting('notified') ?? {};
    let changed = false;
    for (const one of conditions) {
      const before = said[one.metric];
      const worse = !before || LEVELS.indexOf(one.level) > LEVELS.indexOf(before.level);
      const stale = !before || this.now() - before.at > NOTIFY_COOLDOWN;
      if (!worse && !stale) continue;
      this.notify({
        title: one.level === 'limit' ? `${one.label} is at its limit` : `${one.label} needs attention`,
        body: `${describe(one)}. ${one.why}`,
        metric: one.metric,
      });
      said[one.metric] = { level: one.level, at: this.now() };
      changed = true;
    }
    // A metric that came back to fine may be said again next time it crosses.
    for (const metric of Object.keys(said)) {
      if (!conditions.some((one) => one.metric === metric)) {
        delete said[metric];
        changed = true;
      }
    }
    if (changed) this.store.setSetting('notified', said);
  }

  // --- trend ----------------------------------------------------------------------

  /**
   * How fast a metric moves, from the readings of the last `days`, as a change
   * per day — a least-squares slope, so one odd reading does not set the pace.
   * Null with fewer than two days of readings: a guess from an hour is a guess.
   */
  slopePerDay(metric, days = 14) {
    const rows = this.store.readings(metric, this.now() - days * DAY);
    if (rows.length < 2 || rows[rows.length - 1].at - rows[0].at < DAY) return null;
    const n = rows.length;
    const meanX = rows.reduce((s, r) => s + r.at, 0) / n;
    const meanY = rows.reduce((s, r) => s + r.value, 0) / n;
    let num = 0;
    let den = 0;
    for (const r of rows) {
      num += (r.at - meanX) * (r.value - meanY);
      den += (r.at - meanX) ** 2;
    }
    return den ? (num / den) * DAY : 0;
  }

  /** What the panel shows: the latest of everything, the conditions, the lines, and where things are heading. */
  report() {
    const usedSlope = this.slopePerDay('disk.used.bytes');
    const free = this.latest['disk.free.bytes']?.value ?? null;
    const daysUntilFull = usedSlope && usedSlope > 0 && free !== null ? Math.floor(free / usedSlope) : null;
    const growth = {};
    for (const metric of ['bucket.sessions.bytes', 'bucket.worktrees.bytes', 'bucket.app.bytes', 'db.bytes', 'disk.used.bytes']) {
      const slope = this.slopePerDay(metric);
      growth[metric] = slope === null ? null : Math.round(slope * 7);
    }
    const status = this.conditions.some((one) => one.level === 'limit') ? 'limit' : this.conditions.length ? 'attention' : 'fine';
    return {
      status,
      conditions: this.conditions,
      latest: this.latest,
      thresholds: this.thresholds(),
      growthPerWeek: growth,
      daysUntilFull,
      lastInventoryAt: this.lastInventoryAt || null,
      readAt: this.now(),
    };
  }
}

/**
 * Swap, as the system reports it. macOS: `sysctl vm.swapusage` says
 * "total = 4096.00M  used = 2818.38M  free = 1277.62M". Linux: /proc/meminfo.
 * Elsewhere, or when the question fails, nothing — a reading not taken is
 * better than one made up.
 */
function readSwap() {
  try {
    if (process.platform === 'darwin') {
      return parseSwapUsage(execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8', timeout: 2000 }));
    }
    if (process.platform === 'linux') {
      const info = fs.readFileSync('/proc/meminfo', 'utf8');
      const kb = (name) => Number((info.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm')) ?? [])[1] ?? 0) * 1024;
      const total = kb('SwapTotal');
      return { total, used: total - kb('SwapFree') };
    }
  } catch {
    /* no swap reading on this machine */
  }
  return { total: null, used: null };
}

/** "total = 4096.00M  used = 2818.38M  free = 1277.62M  (encrypted)" → bytes. */
function parseSwapUsage(text) {
  const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  const grab = (name) => {
    const m = String(text).match(new RegExp(`${name}\\s*=\\s*([\\d.]+)([KMGT])`));
    return m ? Math.round(Number(m[1]) * unit[m[2]]) : null;
  };
  return { total: grab('total'), used: grab('used') };
}

/**
 * The processes holding the most memory, by resident size. What a person asks
 * first when the machine swaps, and what Claude needs to say which to close.
 */
function topProcesses(limit = 12) {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,rss=,comm='], { encoding: 'utf8', timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
    return out
      .split('\n')
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), bytes: Number(m[2]) * 1024, command: m[3] }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** Which side of the lines a value is on. */
function levelOf(value, line) {
  const worse = line.direction === 'below' ? (v, t) => v < t : (v, t) => v > t;
  if (line.limit !== null && line.limit !== undefined && worse(value, line.limit)) return 'limit';
  if (line.attention !== null && line.attention !== undefined && worse(value, line.attention)) return 'attention';
  return 'fine';
}

/** A condition in words: "Disk free is 6% (limit 8%)". */
function describe(one) {
  const fmt = (v) => (one.unit === 'bytes' ? formatBytes(v) : one.unit === '%' ? `${v}%` : one.unit === 'x' ? `${v}×` : String(v));
  return `${one.label} is ${fmt(one.value)} (${one.level} ${one.direction === 'below' ? 'below' : 'above'} ${fmt(one.threshold)})`;
}

function formatBytes(n) {
  return require('./housekeeping-items').formatBytes(n);
}

function diskOf(where) {
  try {
    const stat = fs.statfsSync(where);
    return { free: Number(stat.bavail) * Number(stat.bsize), total: Number(stat.blocks) * Number(stat.bsize) };
  } catch {
    return { free: null, total: null };
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

module.exports = { HousekeepingMonitor, THRESHOLDS, LEVELS, levelOf, describe, readSwap, parseSwapUsage, topProcesses, DAY, HOUR, MINUTE };
