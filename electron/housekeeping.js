'use strict';

/**
 * Housekeeping: what Smart Terminal and the work around it leave on disk, and
 * giving it back.
 *
 * This file knows no filesystem layout of its own. It asks the parts that do —
 * the database for sessions, the context store for their saved copies, the
 * Code Reviewer for its clones, the folders the person named for worktrees and
 * build caches — and turns each answer into items of one shape (see
 * `housekeeping-items.js`). The panel adds them up and asks for removals by id;
 * every removal comes back here, is checked again against what is on disk
 * now, and is written to the log with what it gave back.
 *
 * Two kinds of removal, never mixed. `free` takes what comes back by itself
 * (caches, old installers, backups of installations long replaced) and runs
 * behind one button. `deleteSessions` and `discardWorkshops` take the only
 * copy of something and are asked for by name, item by item.
 *
 * Measuring is separate from listing. `inventory` answers at once with the
 * sizes it already knows and marks the rest unknown; `measure` walks those on
 * a worker and reports each as it lands. A panel is never kept waiting on the
 * slowest directory to show the first number.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { item, totals, byWeight, formatBytes, KINDS } = require('./housekeeping-items');
const caches = require('./build-caches');
const { fileSize } = require('./disk-usage');

const DAY = 86_400_000;
/** How long the last inventory is trusted to resolve ids for a removal. */
const LAST_INVENTORY_MS = 10 * 60_000;

class Housekeeping {
  /**
   * @param {object} options
   * @param {object} options.db the app database (`sessionFootprints`, `deleteSessions`, `health`)
   * @param {object} options.store a HousekeepingStore
   * @param {object} options.sizes a DiskUsage
   * @param {string} options.userData the app's data folder
   * @param {object} [options.context] the context store (`forget`, `trackedIds`)
   * @param {object} [options.review] `{ workshops(): Promise<[]>, discard(repoId, prId) }`
   * @param {object} [options.browser] `{ size(): Promise<number>, clear(): Promise<void> }`
   * @param {() => string[]} [options.live] the folders live sessions are standing in
   * @param {() => number} [options.now]
   */
  constructor({ db, store, sizes, userData, context = null, review = null, browser = null, live = () => [], now = () => Date.now(), emit = () => {} }) {
    this.db = db;
    this.store = store;
    this.sizes = sizes;
    this.userData = userData;
    this.context = context;
    this.review = review;
    this.browser = browser;
    this.live = live;
    this.now = now;
    this.emit = emit;
    /** The last inventory, so a removal asked for a moment later resolves its ids without reading the disk again. */
    this.last = null;
  }

  // --- roots ------------------------------------------------------------------

  /** The folders looked through for checkouts: the ones the person added. */
  roots() {
    return this.store.roots();
  }

  addRoot(folder) {
    const resolved = path.resolve(String(folder || '').replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`${resolved} is not a folder.`);
    // The root of the disk or a home folder is not a folder of worktrees. Only their direct children would be looked at
    // anyway, and a cache found directly under one of them is somebody's, not a build's.
    if (resolved === path.parse(resolved).root || resolved === os.homedir()) throw new Error('Choose a folder of worktrees or a checkout, not the whole disk or your home folder.');
    this.store.addRoot(resolved);
    return this.roots();
  }

  removeRoot(folder) {
    this.store.removeRoot(folder);
    return this.roots();
  }

  /**
   * The checkouts under the roots: each root itself when it is one, and its
   * direct children that are. One level, on purpose — a root is a folder of
   * worktrees, not a home directory to crawl.
   */
  checkouts() {
    const found = new Set();
    for (const { path: root } of this.roots()) {
      if (caches.isCheckout(root)) found.add(root);
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const full = path.join(root, entry.name);
        if (caches.isCheckout(full)) found.add(full);
      }
    }
    return [...found].sort();
  }

  // --- inventory ----------------------------------------------------------------

  /** Everything, as items, with the sizes already known. Unknown sizes are 0 and `sized: false`. */
  async inventory() {
    // The checkouts are read once per inventory: three of the lists below want them, and a root of
    // two hundred worktrees is two hundred stats each time it is asked.
    this.#checkouts = this.checkouts();
    const items = [
      ...this.sessionItems(),
      ...(await this.buildCacheItems()),
      ...(await this.workshopItems()),
      ...this.appItems(),
      ...(await this.browserItems()),
    ];
    const sized = items.filter((one) => one.meta?.sized === false).map((one) => one.path);
    this.last = { items, at: this.now() };
    return {
      items: byWeight(items, this.now()),
      totals: totals(items),
      unsized: sized,
      roots: this.roots(),
      checkouts: this.#checkouts.length,
      disk: diskFree(this.userData),
      log: this.store.recentLog(20),
      readAt: this.now(),
    };
  }

  /**
   * Walk the paths whose size is not known or not fresh, telling the window about each.
   *
   * Only paths that are an item's own folder are walked — a cache, a clone, a copied data folder. A
   * session's path is the folder it worked in, which may be a whole repository, and walking that
   * because somebody pressed "measure again" would be minutes spent on a number nobody asked for.
   */
  async measure(paths = [], { force = false } = {}) {
    const allowed = new Set(this.measurable());
    const wanted = paths.filter((one) => typeof one === 'string' && allowed.has(one));
    if (!wanted.length) return {};
    const out = {};
    await this.sizes.measure(wanted, {
      force,
      onEach: (target, kept) => {
        if (!kept.partial) out[target] = kept.bytes;
        this.emit('size', { path: target, bytes: kept.bytes, files: kept.files, partial: Boolean(kept.partial) });
      },
    });
    return out;
  }

  /** The folders whose size is a thing of their own: what `measure` agrees to walk. */
  measurable() {
    const checkouts = this.#checkouts ?? this.checkouts();
    const out = [];
    for (const checkout of checkouts) for (const found of caches.findIn(checkout)) out.push(found.path);
    for (const trash of caches.pendingTrash(checkouts)) out.push(trash);
    const parent = path.dirname(this.userData);
    const aside = new RegExp(`^${escapeRegExp(path.basename(this.userData))}[.-](backup|state)[-.]`);
    for (const name of readdir(parent)) if (aside.test(name) && isDir(path.join(parent, name))) out.push(path.join(parent, name));
    if (this.review?.dirs) for (const dir of this.review.dirs()) out.push(dir);
    return out;
  }

  sessionItems() {
    const live = new Set(this.context?.trackedIds?.() ?? []);
    const snapshots = path.join(this.userData, 'context-snapshots');
    return this.db.sessionFootprints().map((row) => {
      const snapshot = snapshotBytes(path.join(snapshots, row.id));
      const blockers = [];
      if (row.endedAt === null) blockers.push('still running');
      else if (live.has(row.id)) blockers.push('still being recorded');
      const where = row.lastCwd || row.startCwd || '';
      return item({
        id: `session:${row.id}`,
        kind: 'session',
        label: row.title || path.basename(where) || row.id.slice(0, 8),
        path: where,
        bytes: row.transcriptBytes + snapshot,
        lastActivityAt: row.lastActivityAt,
        state: row.endedAt === null ? 'open' : 'ended',
        blockers,
        detail: [row.profileName, row.kind, snapshot ? `${fmt(snapshot)} saved copy` : null].filter(Boolean).join(' · '),
        meta: { sessionId: row.id, transcriptBytes: row.transcriptBytes, snapshotBytes: snapshot, sized: true },
      });
    });
  }

  /** The checkouts as of the last inventory, so one pass does not stat the roots three times. */
  #checkouts = null;

  async buildCacheItems() {
    const live = this.live().filter(Boolean);
    const out = [];
    const checkouts = this.#checkouts ?? this.checkouts();
    // Up to eight checkouts at a time asked which names they ignore: enough to hide the latency, few enough not to fork a storm.
    const answers = await mapLimit(checkouts, 8, async (checkout) => {
      const list = caches.findIn(checkout);
      const ignored = await caches.ignoredIn(checkout, list.map((one) => one.name));
      return { checkout, list, ignored };
    });
    for (const { checkout, list, ignored } of answers) {
      const inside = live.some((cwd) => cwd === checkout || cwd.startsWith(checkout + path.sep));
      for (const found of list) {
        const known = this.sizes.known(found.path);
        const blockers = [];
        if (!ignored.has(found.name)) blockers.push('not ignored by git, so it may be committed work');
        if (inside) blockers.push('a session is working in this checkout');
        out.push(
          item({
            id: `cache:${found.path}`,
            kind: 'build-cache',
            label: `${path.basename(checkout)}/${found.name}`,
            path: found.path,
            bytes: known?.bytes ?? 0,
            lastActivityAt: mtime(found.path),
            state: found.tool,
            blockers,
            detail: `${found.tool} output in ${checkout}`,
            meta: { checkout, name: found.name, sized: Boolean(known) },
          }),
        );
      }
    }
    return out;
  }

  async workshopItems() {
    if (!this.review) return [];
    let shops = [];
    try {
      shops = await this.review.workshops();
    } catch {
      return [];
    }
    return shops.map((shop) => {
      const known = this.sizes.known(shop.dir);
      const blockers = [];
      if (shop.busy) blockers.push('a fix is being written in it');
      if (shop.pendingReturn) blockers.push(`${shop.pendingReturn} fix(es) not handed back`);
      if (!shop.prState || shop.prState === 'OPEN') blockers.push('the pull request is still open');
      return item({
        id: `workshop:${shop.repoId}:${shop.prId}`,
        kind: 'workshop',
        label: `${shop.repoName} #${shop.prId}`,
        path: shop.dir,
        bytes: known?.bytes ?? 0,
        lastActivityAt: mtime(shop.dir),
        state: shop.prState ? String(shop.prState).toLowerCase() : 'unknown',
        blockers,
        detail: shop.title || null,
        meta: { repoId: shop.repoId, prId: shop.prId, sized: Boolean(known) },
      });
    });
  }

  appItems() {
    const out = [];
    const dbFile = path.join(this.userData, 'smart-terminal.db');
    const parent = path.dirname(this.userData);
    const base = path.basename(this.userData);

    // Copies of the database left by hand or by an older build. The live file is not one of them.
    for (const name of readdir(this.userData)) {
      if (!name.startsWith('smart-terminal.db.backup')) continue;
      const full = path.join(this.userData, name);
      out.push(
        item({ id: `dbbackup:${full}`, kind: 'db-backup', label: name, path: full, bytes: fileSize(full), lastActivityAt: mtime(full), detail: `beside ${path.basename(dbFile)}`, meta: { sized: true } }),
      );
    }

    // Whole data folders copied aside before an upgrade: `Smart Terminal.backup-…`, `Smart Terminal-backup-…`, `Smart Terminal.state-…`.
    const aside = new RegExp(`^${escapeRegExp(base)}[.-](backup|state)[-.]`);
    for (const name of readdir(parent)) {
      if (!aside.test(name)) continue;
      const full = path.join(parent, name);
      if (!isDir(full)) continue;
      const known = this.sizes.known(full);
      out.push(
        item({ id: `installbackup:${full}`, kind: 'install-backup', label: name, path: full, bytes: known?.bytes ?? 0, lastActivityAt: mtime(full), detail: `a copy of the data folder in ${parent}`, meta: { sized: Boolean(known) } }),
      );
    }

    // Installers already downloaded. The newest is the one waiting to be installed; it is listed and said so.
    const updates = path.join(this.userData, 'updates');
    const installers = readdir(updates)
      .filter((name) => /\.(dmg|appimage|deb|exe|zip)$/i.test(name))
      .map((name) => ({ name, full: path.join(updates, name), at: mtime(path.join(updates, name)) }))
      .sort((a, b) => b.at - a.at);
    installers.forEach((one, index) => {
      out.push(
        item({
          id: `installer:${one.full}`,
          kind: 'installer',
          label: one.name,
          path: one.full,
          bytes: fileSize(one.full),
          lastActivityAt: one.at,
          state: index === 0 ? 'latest' : 'superseded',
          detail: index === 0 ? 'the newest download — removing it means downloading again to install' : 'replaced by a newer download',
          meta: { sized: true },
        }),
      );
    });

    // Pasted images older than a week, which the paste itself normally sweeps.
    const pasted = path.join(this.userData, 'pasted');
    const old = readdir(pasted).filter((name) => name.startsWith('pasted-') && this.now() - mtime(path.join(pasted, name)) > 7 * DAY);
    if (old.length) {
      const bytes = old.reduce((sum, name) => sum + fileSize(path.join(pasted, name)), 0);
      out.push(
        item({ id: 'pasted:old', kind: 'pasted', label: `${old.length} pasted image${old.length === 1 ? '' : 's'} older than a week`, path: pasted, bytes, lastActivityAt: Math.max(...old.map((name) => mtime(path.join(pasted, name)))), meta: { names: old, sized: true } }),
      );
    }

    // Removals a previous run started and did not finish.
    for (const trash of caches.pendingTrash(this.#checkouts ?? this.checkouts())) {
      out.push(item({ id: `trash:${trash}`, kind: 'trash', label: path.basename(trash), path: trash, bytes: this.sizes.known(trash)?.bytes ?? 0, lastActivityAt: mtime(trash), detail: 'being deleted in the background', meta: { sized: Boolean(this.sizes.known(trash)) } }));
    }
    return out;
  }

  async browserItems() {
    if (!this.browser) return [];
    let bytes = 0;
    try {
      bytes = await this.browser.size();
    } catch {
      return [];
    }
    return [
      item({ id: 'browser:cache', kind: 'browser-cache', label: 'Browser cache', path: path.join(this.userData, 'Cache'), bytes, lastActivityAt: mtime(path.join(this.userData, 'Cache')), detail: 'pages and images the window fetched; refilled as they are needed', meta: { sized: true } }),
    ];
  }

  // --- removing -------------------------------------------------------------------

  /**
   * Remove reversible items by id. Each is looked at again now: an id for a
   * folder that is gone is a success, an id for something that is not
   * reversible is refused rather than quietly done.
   */
  async free(ids = []) {
    const current = this.last && this.now() - this.last.at < LAST_INVENTORY_MS ? this.last : await this.inventory();
    const byId = new Map(current.items.map((one) => [one.id, one]));
    const results = [];
    let freed = 0;
    for (const id of ids) {
      const one = byId.get(id);
      if (!one) {
        results.push({ id, ok: true, bytes: 0, note: 'already gone' });
        continue;
      }
      if (!one.reversible) {
        results.push({ id, ok: false, error: `${KINDS[one.kind].label} is not something this button removes.` });
        continue;
      }
      try {
        this.#guard(one);
        await this.#freeOne(one);
        freed += one.bytes;
        this.store.log({ action: 'free', kind: one.kind, label: one.label, bytes: one.bytes, ok: true });
        results.push({ id, ok: true, bytes: one.bytes });
      } catch (error) {
        const message = String(error?.message ?? error);
        this.store.log({ action: 'free', kind: one.kind, label: one.label, bytes: 0, ok: false, detail: message });
        results.push({ id, ok: false, error: message });
      }
    }
    return { results, freed };
  }

  /**
   * Before anything is removed, its path is checked against where its kind lives.
   *
   * The ids come from the window, and the window is trusted — but an id made
   * from a path is still a path, and the cheapest defence against a mistake
   * anywhere upstream is to refuse to delete a database backup that is not
   * beside the database, or a copied data folder that is not beside this one.
   */
  #guard(one) {
    const target = one.path ? path.resolve(one.path) : null;
    const under = (parent) => target && (target === parent || target.startsWith(parent + path.sep));
    const userData = path.resolve(this.userData);
    switch (one.kind) {
      case 'build-cache':
      case 'trash': {
        const checkouts = this.#checkouts ?? this.checkouts();
        if (!checkouts.some((checkout) => target && path.dirname(target) === path.resolve(checkout))) throw new Error(`${one.label} is not directly inside a checkout this app looks through.`);
        return;
      }
      case 'db-backup':
        if (!target || path.dirname(target) !== userData || !path.basename(target).startsWith('smart-terminal.db.backup')) throw new Error(`${one.label} is not a database backup beside the database.`);
        return;
      case 'install-backup':
        if (!target || path.dirname(target) !== path.dirname(userData) || target === userData) throw new Error(`${one.label} is not a copy of the data folder beside this one.`);
        return;
      case 'installer':
        if (!under(path.join(userData, 'updates'))) throw new Error(`${one.label} is not in the updates folder.`);
        return;
      case 'pasted':
        if (target !== path.join(userData, 'pasted')) throw new Error('Not the pasted-images folder.');
        return;
      default:
        return;
    }
  }

  async #freeOne(one) {
    switch (one.kind) {
      case 'build-cache': {
        const result = await caches.discard(one.path, { now: this.now() });
        this.sizes.forget(one.path);
        return result;
      }
      case 'db-backup':
      case 'installer':
        await fsp.rm(one.path, { force: true });
        return { ok: true };
      case 'install-backup':
      case 'trash':
        await fsp.rm(one.path, { recursive: true, force: true, maxRetries: 2 });
        this.sizes.forget(one.path);
        return { ok: true };
      case 'pasted':
        for (const name of one.meta?.names ?? []) await fsp.rm(path.join(one.path, name), { force: true }).catch(() => {});
        return { ok: true };
      case 'browser-cache':
        await this.browser?.clear?.();
        return { ok: true };
      default:
        throw new Error(`${one.kind} is not reversible.`);
    }
  }

  /**
   * Delete ended sessions and their saved copies, in one transaction for the
   * database and one pass for the files. A session still being recorded is an
   * ended tab whose copy is still being written; it is skipped like a running
   * one, because deleting under a writer leaves a copy with no session.
   */
  deleteSessions(sessionIds = []) {
    const recording = new Set(this.context?.trackedIds?.() ?? []);
    const wanted = [...new Set(sessionIds)].filter((id) => !recording.has(id));
    const gone = this.db.deleteSessions(wanted);
    let bytes = 0;
    for (const id of gone) {
      const dir = path.join(this.userData, 'context-snapshots', id);
      bytes += snapshotBytes(dir);
      try {
        this.context?.forget?.(id);
      } catch {
        /* the folder may already be gone */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (gone.length) this.store.log({ action: 'delete-sessions', kind: 'session', label: `${gone.length} session${gone.length === 1 ? '' : 's'}`, bytes, ok: true });
    return { deleted: gone, skipped: sessionIds.filter((id) => !gone.includes(id)), bytes };
  }

  /** Delete only the kept conversations of sessions, leaving the record of what ran. */
  forgetTranscripts(sessionIds = []) {
    let bytes = 0;
    let count = 0;
    for (const id of new Set(sessionIds)) {
      const dir = path.join(this.userData, 'context-snapshots', id);
      const before = (this.db.sessionSizes([id])[id] ?? 0) + snapshotBytes(dir);
      this.db.forgetTranscript(id);
      try {
        this.context?.setRecording?.(id, false);
        this.context?.forget?.(id);
      } catch {
        /* not tracked */
      }
      fs.rmSync(dir, { recursive: true, force: true });
      bytes += before;
      count += 1;
    }
    if (count) this.store.log({ action: 'forget-transcripts', kind: 'session', label: `${count} conversation${count === 1 ? '' : 's'}`, bytes, ok: true });
    return { count, bytes };
  }

  /** Discard the Code Reviewer's clones for pull requests that are finished. The reviewer's own checks still apply. */
  async discardWorkshops(ids = []) {
    const results = [];
    for (const id of ids) {
      const [, repoId, prId] = String(id).split(':');
      if (!repoId || !prId || !this.review?.discard) {
        results.push({ id, ok: false, error: 'Not a review clone.' });
        continue;
      }
      try {
        const bytes = this.sizes.known(this.review.dirOf?.(repoId, prId) ?? '')?.bytes ?? 0;
        await this.review.discard(repoId, prId);
        this.store.log({ action: 'discard-workshop', kind: 'workshop', label: `PR #${prId}`, bytes, ok: true });
        results.push({ id, ok: true, bytes });
      } catch (error) {
        const message = String(error?.message ?? error);
        this.store.log({ action: 'discard-workshop', kind: 'workshop', label: `PR #${prId}`, bytes: 0, ok: false, detail: message });
        results.push({ id, ok: false, error: message });
      }
    }
    return { results };
  }

  /**
   * The tidying of the tidier, once at start: removals a previous run left half
   * done are finished, sizes of folders that no longer exist are forgotten, and
   * the log is cut to a year. Nothing that was not already going is removed.
   */
  async sweep() {
    const swept = await caches.sweep(this.checkouts());
    const forgotten = this.sizes.pruneMissing?.() ?? 0;
    const trimmed = this.store.trimLog();
    return { swept, forgotten, trimmed };
  }

  log(limit = 50) {
    return this.store.recentLog(limit);
  }
}

// --- small helpers -----------------------------------------------------------

/** `Promise.all` with at most `limit` in flight, in the order given. */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const index = next++;
      out[index] = await fn(list[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function readdir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function mtime(target) {
  try {
    return Math.floor(fs.statSync(target).mtimeMs);
  } catch {
    return null;
  }
}

/** A snapshot folder is two files; adding them up here is cheaper than asking the worker. */
function snapshotBytes(dir) {
  let bytes = 0;
  for (const name of readdir(dir)) bytes += fileSize(path.join(dir, name));
  return bytes;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Free and total bytes of the volume holding `where`; nulls where the platform will not say. */
function diskFree(where) {
  try {
    const stat = fs.statfsSync(where);
    return { free: Number(stat.bavail) * Number(stat.bsize), total: Number(stat.blocks) * Number(stat.bsize) };
  } catch {
    return { free: null, total: null };
  }
}

const fmt = formatBytes;

module.exports = { Housekeeping, diskFree, snapshotBytes };
