'use strict';

/**
 * What to do about it, in order — the panel's own plan, before anybody asks
 * Claude.
 *
 * Each proposal names a cause, the effect it would have (bytes freed, memory
 * given back), and when the panel can do it, the action that does it. The
 * order is by what hurts most now: swap and memory first, because that is
 * what makes the machine lag this minute; then the disk, largest and safest
 * first; then the database. Nothing here runs anything: it reads the report,
 * the inventory and the processes, and says.
 */

const { formatBytes } = require('./housekeeping-items');

const DAY = 86_400_000;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

/**
 * @param {object} input
 * @param {object|null} input.report       the monitor's report (latest readings, conditions)
 * @param {object|null} input.inventory    items and totals
 * @param {Array} [input.processes]        top processes by memory
 * @param {object|null} [input.dbHealth]   the database's health (wasted, walBytes)
 * @param {number} [input.now]
 * @returns {Array<{id: string, priority: 'now'|'soon'|'later', title: string, detail: string, effect: string|null, bytes: number, action: {id: string, label: string, ids?: string[], danger?: boolean}|null}>}
 */
function proposals({ report, inventory, processes = [], dbHealth = null, now = Date.now() }) {
  const out = [];
  const v = (metric) => report?.latest?.[metric]?.value ?? null;
  const items = inventory?.items ?? [];
  const condition = (metric) => report?.conditions?.find((one) => one.metric === metric) ?? null;

  // --- memory and swap: what hurts this minute ------------------------------------
  const swapPct = v('swap.used.pct');
  const memFree = v('mem.free.bytes');
  const pageouts = v('swap.pageouts.perMin');
  const swapping = (swapPct !== null && swapPct >= 50) || (memFree !== null && memFree < 2 * GB) || (pageouts !== null && pageouts > 100);
  if (swapping) {
    const heavy = processes.slice(0, 5);
    const heavyBytes = heavy.reduce((s, p) => s + p.bytes, 0);
    out.push({
      id: 'memory-processes',
      priority: 'now',
      title: pageouts !== null && pageouts > 100 ? 'The machine is swapping right now' : 'Memory is short and swap is in use',
      detail:
        (heavy.length
          ? `The five processes holding the most memory hold ${formatBytes(heavyBytes)}: ${heavy.map((p) => `${shortName(p.command)} (${formatBytes(p.bytes)})`).join(', ')}. Closing or restarting the ones you are not using gives memory back at once; nothing on disk does.`
          : 'Close the programs you are not using; nothing on disk gives memory back.') +
        (swapPct !== null ? ` Swap is ${swapPct}% used.` : '') +
        (pageouts !== null && pageouts > 0 ? ` ${Math.round(pageouts)} pages a minute are going to disk.` : ''),
      effect: heavy.length ? `up to ${formatBytes(heavyBytes)} of memory` : null,
      bytes: 0,
      action: null,
    });
    const open = v('sessions.open');
    if (open !== null && open >= 10) {
      out.push({
        id: 'memory-sessions',
        priority: 'now',
        title: `${open} sessions are open in Smart Terminal`,
        detail: `Each Claude session is a process with its conversation in memory, and the app's own memory is ${formatBytes(v('app.rss.bytes') ?? 0)}. Closing the ones that finished, or pausing the ones waiting on you, is the fastest memory back from this app.`,
        effect: null,
        bytes: 0,
        action: { id: 'show-sessions', label: 'Show the sessions' },
      });
    }
  }

  // --- disk: largest and safest first ------------------------------------------------
  const trees = items.filter((one) => one.kind === 'worktree');
  const treeByPath = new Map(trees.map((one) => [one.path, one]));
  const caches = items.filter((one) => one.kind === 'build-cache' && one.blockers.length === 0);
  const idleCaches = caches.filter((one) => {
    const tree = treeByPath.get(one.meta?.checkout);
    const at = tree?.lastActivityAt ?? one.lastActivityAt;
    return at !== null && at !== undefined && now - at > 14 * DAY;
  });
  const idleBytes = sum(idleCaches);
  if (idleBytes > 1 * GB) {
    out.push({
      id: 'caches-inactive',
      priority: 'soon',
      title: `${formatBytes(idleBytes)} of build caches in worktrees idle for two weeks or more`,
      detail: `${idleCaches.length} folders (${topNames(idleCaches)}) a build writes again. Nothing of yours is in them; the next build in those worktrees takes longer once.`,
      effect: `frees ${formatBytes(idleBytes)}`,
      bytes: idleBytes,
      action: { id: 'free', label: `Clear ${formatBytes(idleBytes)} of idle caches`, ids: idleCaches.map((one) => one.id) },
    });
  }
  const finished = trees.filter((one) => one.meta?.finished && one.blockers.length === 0);
  if (finished.length) {
    const bytes = sum(finished);
    out.push({
      id: 'worktrees-finished',
      priority: 'soon',
      title: `${finished.length} worktree${finished.length === 1 ? '' : 's'} whose work is merged or whose branch is gone`,
      detail: `${topNames(finished)}. Each is removed with git worktree remove, never forced; its branch is deleted only if merged.`,
      effect: bytes ? `frees ${formatBytes(bytes)}` : 'frees their folders',
      bytes,
      action: { id: 'remove-worktrees', label: `Remove ${finished.length} finished`, ids: finished.map((one) => one.id), danger: true },
    });
  }
  const unmergedIdle = trees.filter((one) => one.meta?.work === 'unmerged' && one.lastActivityAt && now - one.lastActivityAt > 30 * DAY);
  if (unmergedIdle.length) {
    out.push({
      id: 'worktrees-unmerged-idle',
      priority: 'later',
      title: `${unmergedIdle.length} worktree${unmergedIdle.length === 1 ? '' : 's'} with unmerged work and no activity for a month`,
      detail: `${topNames(unmergedIdle)}. Decide each one: push and open a pull request, merge, or drop it. The panel will not remove unmerged work.`,
      effect: null,
      bytes: 0,
      action: { id: 'show-worktrees', label: 'Show them' },
    });
  }
  const reversibleApp = items.filter((one) => one.bucket === 'app' && one.reversible && one.blockers.length === 0 && !(one.kind === 'installer' && one.state === 'latest'));
  const appBytes = sum(reversibleApp);
  if (appBytes > 500 * MB) {
    out.push({
      id: 'app-files',
      priority: 'soon',
      title: `${formatBytes(appBytes)} of old installations, backups and installers`,
      detail: `${reversibleApp.length} items beside the app's data: ${topNames(reversibleApp)}. Copies of versions already replaced.`,
      effect: `frees ${formatBytes(appBytes)}`,
      bytes: appBytes,
      action: { id: 'free', label: `Remove ${formatBytes(appBytes)}`, ids: reversibleApp.map((one) => one.id) },
    });
  }
  const oldSessions = items.filter((one) => one.kind === 'session' && one.blockers.length === 0 && one.lastActivityAt && now - one.lastActivityAt > 90 * DAY && one.bytes > 0);
  const oldBytes = sum(oldSessions);
  if (oldBytes > 200 * MB) {
    out.push({
      id: 'sessions-old',
      priority: 'later',
      title: `${formatBytes(oldBytes)} of conversations from sessions idle for three months`,
      detail: `${oldSessions.length} sessions. Forgetting the conversations keeps the record of what ran; History still lists them.`,
      effect: `frees ${formatBytes(oldBytes)}`,
      bytes: oldBytes,
      action: { id: 'forget-transcripts', label: `Forget ${oldSessions.length} conversations`, ids: oldSessions.map((one) => String(one.meta?.sessionId)), danger: true },
    });
  }

  // --- the database ------------------------------------------------------------------
  const wal = v('db.wal.bytes');
  if (wal !== null && wal > 128 * MB) {
    out.push({
      id: 'db-checkpoint',
      priority: condition('db.wal.bytes') ? 'soon' : 'later',
      title: `The database log is ${formatBytes(wal)}`,
      detail: 'The write-ahead log grows while the app runs and is folded back only now and then; folding it is a second, and every read gets faster.',
      effect: `frees ${formatBytes(wal)}`,
      bytes: wal,
      action: { id: 'db-checkpoint', label: 'Fold the log' },
    });
  }
  if (dbHealth && dbHealth.wasted > 100 * MB && dbHealth.wasted / Math.max(1, dbHealth.bytes) > 0.1) {
    out.push({
      id: 'db-reclaim',
      priority: 'later',
      title: `${formatBytes(dbHealth.wasted)} of the database holds nothing`,
      detail: 'Deleted rows leave their pages behind; VACUUM rewrites the file without them. It takes a few seconds and the app pauses while it runs.',
      effect: `frees ${formatBytes(dbHealth.wasted)}`,
      bytes: dbHealth.wasted,
      action: { id: 'db-reclaim', label: 'Compact the database' },
    });
  }

  // --- the disk itself -------------------------------------------------------------------
  const days = report?.daysUntilFull;
  if (days !== null && days !== undefined && days < 60) {
    out.unshift({
      id: 'disk-trend',
      priority: days < 14 ? 'now' : 'soon',
      title: `At the current rate the disk is full in about ${days} days`,
      detail: `Disk used grows ${formatBytes(report.growthPerWeek?.['disk.used.bytes'] ?? 0)} a week. The proposals below are what would turn that around; the caches are the largest and safest.`,
      effect: null,
      bytes: 0,
      action: null,
    });
  }

  const rank = { now: 0, soon: 1, later: 2 };
  return out.sort((a, b) => rank[a.priority] - rank[b.priority] || b.bytes - a.bytes);
}

function sum(list) {
  return list.reduce((s, one) => s + (one.bytes || 0), 0);
}

function topNames(list, n = 3) {
  const sorted = [...list].sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  const names = sorted.slice(0, n).map((one) => (one.bytes ? `${one.label} ${formatBytes(one.bytes)}` : one.label));
  return names.join(', ') + (sorted.length > n ? `, and ${sorted.length - n} more` : '');
}

function shortName(command) {
  const base = String(command).split('/').filter(Boolean).pop() || String(command);
  return base.replace(/\.app$/, '').slice(0, 40);
}

module.exports = { proposals, shortName };
