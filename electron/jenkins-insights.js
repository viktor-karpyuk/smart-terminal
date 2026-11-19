'use strict';

/**
 * What a lead reads off the history, once it is kept: the board of services
 * by environment, the heatmap of days, the cards that say what needs a look
 * and why, the summary to paste in a chat, the light page for a wall screen.
 *
 * Everything here is made from the history (`jenkins-metrics.js`) and from
 * what the poller already knows — the job list, what runs now — and every
 * number is explainable: a card names the jobs, the builds and the times it
 * is about, and what is offered to do about it is a verb the panel can
 * already call. Nothing is guessed by a model and nothing here changes
 * Jenkins.
 *
 * Each function takes the collector `c` first: they are its methods, kept in
 * a file of their own so that the engine does not have to carry them.
 */

const metrics = require('./jenkins-metrics');
const { families, mergeSettings, DEFAULT_SETTINGS } = require('./jenkins-board');

const { RANGES, DAY, MINUTE, HOUR, rangeOf, matchScope, scopeKey, middle } = metrics;

const MAX_BOARD_ROWS = 300;
const MAX_CARDS = 30;
const VERSION_FETCH = 60;
const VERSION_BUDGET_MS = 1500;
const BOARD_CACHE_MS = 10_000;
const WALL_CACHE_MS = 2000;
const REPORT_MAX = 8000;
const SUSPECT_CARDS = 3;
/** Red for days: this many in one folder are one card, and no more than this many get a card of their own. */
const GROUP_RED = 4;
const MAX_RED_SINGLES = 8;

/** The parameter that says which version a build is, by what it is called, best name first. */
const VERSION_NAMES = ['VERSION', 'APP_VERSION', 'RELEASE_VERSION', 'TAG', 'IMAGE_TAG', 'IMAGE', 'RELEASE'];

const clamp = (value, low, high, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.floor(n))) : fallback;
};

/** "3 minutes", "2 hours", "4 days": the largest unit that says it plainly. */
function human(ms) {
  const n = Math.max(0, Math.round(ms));
  if (n < 90 * 1000) return `${Math.max(1, Math.round(n / 1000))} s`;
  if (n < 90 * MINUTE) return `${Math.round(n / MINUTE)} min`;
  if (n < 48 * HOUR) return `${Math.round(n / HOUR * 10) / 10} h`.replace('.0 h', ' h');
  return `${Math.round(n / DAY)} days`;
}

/** Which of a build's parameters is its version, and what it says; secrets are never one. */
function pickVersion(params) {
  const list = (Array.isArray(params) ? params : []).filter((one) => one && one.name && typeof one.value === 'string' && one.value && !/^•+$/.test(one.value));
  let chosen = null;
  for (const wanted of VERSION_NAMES) {
    chosen = list.find((one) => String(one.name).toUpperCase() === wanted);
    if (chosen) break;
  }
  // A branch is not a version (DEV on `develop` and PROD on `main` is not "different versions"), nor are the notes or the registry of a release.
  chosen ??= list.find((one) => /version|tag|image|release/i.test(one.name) && !/pass|secret|token|key|credential|notes|registry|url|repo|host|path|branch/i.test(one.name));
  if (!chosen) return null;
  // A value that carries credentials in an address keeps the address.
  const value = String(chosen.value).replace(/\/\/[^/@\s]*@/g, '//').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  return value ? { name: String(chosen.name).slice(0, 60), value } : null;
}

// --- the board -------------------------------------------------------------------------------------------------

function cellHealth(cell) {
  if (!cell.last) return 'none';
  if (cell.last.running) return 'running';
  if (cell.last.status === 'failed') return 'red';
  if (cell.last.status === 'unstable' || cell.last.status === 'aborted') return 'amber';
  if (cell.last.status === 'success') return 'green';
  return 'none';
}

const WORST = { red: 5, amber: 4, running: 3, green: 2, none: 1 };

/**
 * Versions of what the board shows, asked for the few builds that have none
 * kept: a build's parameters never change, so each is asked once. A few at a
 * time, within a budget; what is not there yet is there on the next read.
 */
async function fillVersions(c, id, api, wants) {
  if (!api?.buildParams) return;
  const todo = wants.filter((one) => !c.store.paramOf(id, one.path, one.number).known).slice(0, VERSION_FETCH);
  if (!todo.length) return;
  const generation = c.generation.get(id) ?? 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length && !c.closed) {
      const { path, number } = todo[next++];
      try {
        const picked = pickVersion(await api.buildParams(path, number));
        if ((c.generation.get(id) ?? 0) === generation) c.store.setParam(id, path, number, picked?.name ?? null, picked?.value ?? null);
      } catch (error) {
        // A build that is gone will never say; any other trouble is asked about again.
        if (error?.status === 404 && (c.generation.get(id) ?? 0) === generation) c.store.setParam(id, path, number, null, null);
      }
    }
  };
  await Promise.race([Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker)), c.sleep(VERSION_BUDGET_MS)]);
}

/** The board: every service that lives in more than one environment, side by side, and what separates them. */
async function board(c, id, api, index, args = {}) {
  const now = c.now();
  const settings = { ...DEFAULT_SETTINGS, ...c.store.boardSettings(id) };
  if (args.includeSingles !== undefined) settings.includeSingles = args.includeSingles === true;
  const wanted = await c.resolveScope(id, api, index, args.scope);
  const scope = wanted.scope;
  const notes = [...wanted.notes];
  if (scope.trigger || scope.user || scope.result) notes.push('A filter about who started a build, or how it ended, does not apply to the board: it is about jobs.');
  const rows = [...(index?.rows?.values?.() ?? [])];
  const found = families(rows, settings);
  const where = { folder: scope.folder, pattern: scope.pattern, branch: scope.branch, paths: scope.paths, pathSet: scope.pathSet };
  let list = found.families.filter((family) => Object.values(family.members).some((path) => matchScope(where, path)));
  // Families in folders that say they are old are there when asked for.
  const inactive = list.filter((family) => family.inactive).length;
  if (args.showInactive !== true) list = list.filter((family) => !family.inactive);
  else if (inactive) notes.push(`${inactive} ${inactive === 1 ? 'service is' : 'services are'} in a folder that looks old or deprecated: shown because they were asked for, and never promoted.`);
  const truncated = list.length > MAX_BOARD_ROWS;
  list = list.slice(0, MAX_BOARD_ROWS);
  if (index?.truncated) notes.push('This Jenkins has more jobs than this app reads: some services may be missing.');
  if (!rows.length) notes.push('The job list is not there yet: the board fills in when it is.');
  const extras = list.filter((family) => family.ambiguous).length;
  if (extras) notes.push(`${extras} ${extras === 1 ? 'service has' : 'services have'} two jobs for one environment: the first is shown and nothing is promoted until you say which is right (board settings, rowOverrides).`);

  const paths = [...new Set(list.flatMap((family) => Object.values(family.members)))];
  const latest = c.store.latestBuilds(id, paths);
  const success = c.store.latestSuccess(id, paths);
  const live = await c.live(id, api, index).catch(() => null);
  const queued = new Map((live?.queue ?? []).map((one) => [one.path, one.since]));
  const stuck = new Set((live?.runs ?? []).filter((run) => run.stuck).map((run) => run.path));

  const cellOf = (path) => {
    const row = index?.rows?.get(path);
    const mine = latest.get(path) ?? null;
    let last = null;
    if (row?.last) {
      const endedAt = row.running ? null : (row.last.timestamp ? row.last.timestamp + (row.last.duration || 0) : null);
      last = {
        number: row.last.number, status: row.running ? 'running' : (row.last.status ?? 'none'), running: Boolean(row.running),
        startedAt: row.last.timestamp ?? null, endedAt, age: row.last.timestamp ? Math.max(0, now - (endedAt ?? row.last.timestamp)) : null,
        duration: row.running ? null : (row.last.duration ?? null),
      };
    } else if (mine) {
      const running = mine.endedAt === null;
      last = {
        number: mine.number, status: running ? 'running' : (mine.result ?? 'none'), running, startedAt: mine.startedAt, endedAt: mine.endedAt,
        age: Math.max(0, now - (mine.endedAt ?? mine.startedAt)), duration: running ? null : mine.duration,
      };
    }
    let ok = success.get(path) ?? null;
    // The job list may know of a success the history has not been told about yet.
    if (last && last.status === 'success' && last.endedAt && (!ok || last.endedAt > ok.endedAt)) ok = { number: last.number, endedAt: last.endedAt };
    const known = last && mine && mine.number === last.number ? mine : null;
    return {
      path,
      last,
      lastSuccess: ok ? { number: ok.number, endedAt: ok.endedAt, age: Math.max(0, now - ok.endedAt) } : null,
      version: null,
      versionName: null,
      successVersion: null,
      trigger: known?.who ?? null,
      queued: queued.has(path),
      queuedSince: queued.get(path) ?? null,
      disabled: row?.status === 'disabled',
      stuck: stuck.has(path),
    };
  };

  const cells = new Map(paths.map((path) => [path, cellOf(path)]));
  // Versions: kept for builds seen before; the few that are not are fetched in the background and are there next time.
  const wantedVersions = [];
  for (const cell of cells.values()) {
    if (cell.lastSuccess) wantedVersions.push({ path: cell.path, number: cell.lastSuccess.number });
    if (cell.last && cell.last.number !== cell.lastSuccess?.number && !cell.last.running) wantedVersions.push({ path: cell.path, number: cell.last.number });
  }
  await fillVersions(c, id, api, wantedVersions).catch(() => {});
  for (const cell of cells.values()) {
    const ofLast = cell.last ? c.store.paramOf(id, cell.path, cell.last.number) : null;
    const ofSuccess = cell.lastSuccess ? c.store.paramOf(id, cell.path, cell.lastSuccess.number) : null;
    cell.version = ofLast?.value ?? null;
    cell.versionName = ofLast?.name ?? ofSuccess?.name ?? null;
    cell.successVersion = ofSuccess?.value ?? null;
    cell.successVersionName = ofSuccess?.name ?? null;
  }

  const out = [];
  const byEnv = {};
  const summary = { services: 0, red: 0, amber: 0, green: 0, running: 0, none: 0, lagging: 0 };
  for (const family of list) {
    const envs = found.envs.filter((env) => family.members[env]);
    const rowCells = Object.fromEntries(envs.map((env) => [env, cells.get(family.members[env])]));
    const drift = [];
    const promotable = [];
    for (let i = 0; i + 1 < envs.length; i += 1) {
      const from = envs[i];
      const to = envs[i + 1];
      const a = rowCells[from];
      const b = rowCells[to];
      const after = c.store.successesAfter(id, a.path, b.lastSuccess?.endedAt ?? 0);
      // Two versions are compared when both are the same kind of thing (the same parameter): `VERSION` against `IMAGE_TAG` says nothing.
      const versionsDiffer = a.successVersion && b.successVersion && a.successVersionName === b.successVersionName ? a.successVersion !== b.successVersion : null;
      drift.push({ from, to, behind: versionsDiffer === false ? 0 : after.count, since: versionsDiffer === false ? null : after.oldest, versionsDiffer });
      // Equal versions: nothing to promote, however many times the earlier environment was rebuilt. With no way to tell, newer builds there are the signal.
      const ahead = versionsDiffer === true || (versionsDiffer === null && after.count > 0);
      if (!family.ambiguous && !family.inactive && a.last?.status === 'success' && !a.last.running && ahead && !b.disabled && !b.queued && !b.last?.running) promotable.push({ from, to });
    }
    const worst = Object.values(rowCells).map(cellHealth).reduce((w, h) => (WORST[h] > WORST[w] ? h : w), 'none');
    out.push({
      key: family.key, service: family.service, folder: family.folder, cells: rowCells, drift, promotable, health: worst,
      ambiguous: family.ambiguous, inactive: family.inactive, candidates: family.ambiguous ? family.candidates : undefined,
    });
    summary.services += 1;
    summary[worst] += 1;
    if (drift.some((one) => one.behind > 0)) summary.lagging += 1;
    for (const env of envs) {
      byEnv[env] ??= { red: 0, amber: 0, green: 0, running: 0, none: 0 };
      byEnv[env][cellHealth(rowCells[env])] += 1;
    }
  }
  return {
    asOf: now,
    envs: found.envs,
    labels: found.labels,
    rows: out,
    hiddenInactive: args.showInactive === true ? 0 : inactive,
    summary: { ...summary, byEnv },
    settings,
    truncated,
    notes,
  };
}

/** Change what the board makes of the job names, for this server. Returns the settings as they now are. */
function saveBoardSettings(c, id, input) {
  const merged = mergeSettings({ ...DEFAULT_SETTINGS, ...c.store.boardSettings(id) }, input);
  c.store.saveBoardSettings(id, merged);
  c.boardCache?.delete?.(id);
  return merged;
}

// --- the heatmap ---------------------------------------------------------------------------------------------

/** Jobs by days: where the red is, and since when. */
async function heatmap(c, id, api, index, args = {}) {
  const days = [7, 14, 30, 90].includes(Number(args.days)) ? Number(args.days) : 14;
  const limit = clamp(args.limit, 5, 120, 60);
  const sort = args.sort === 'activity' ? 'activity' : 'failed';
  const now = c.now();
  const offset = clamp(args.utcOffsetMinutes, -14 * 60, 14 * 60, 0) * MINUTE;
  const lastDay = Math.floor((now + offset) / DAY);
  const firstDay = lastDay - (days - 1);
  const from = firstDay * DAY - offset;
  const wanted = await c.resolveScope(id, api, index, args.scope);
  const data = await c.store.offload('heatmapData', [id, wanted.scope, { from, to: now + 1, offsetMs: offset, limit, sort }]);
  const axis = Array.from({ length: days }, (_, i) => (firstDay + i) * DAY - offset);
  const half = Math.floor(days / 2);
  const rows = data.jobs.map((job) => {
    const byDay = data.cells.get(job.path);
    let s = 0;
    let f = 0;
    let u = 0;
    const split = { before: { s: 0, d: 0 }, recent: { s: 0, d: 0 } };
    const cells = axis.map((_, i) => {
      const cell = byDay.get(firstDay + i);
      if (!cell) return [0, 0, 0, 0];
      s += cell.s;
      f += cell.f;
      u += cell.u;
      const side = i < half ? split.before : split.recent;
      side.s += cell.s;
      side.d += cell.s + cell.f + cell.u;
      return [cell.s, cell.f, cell.o, cell.w];
    });
    const decided = s + f + u;
    const rate = (side) => (side.d >= 4 ? side.s / side.d : null);
    const before = rate(split.before);
    const recent = rate(split.recent);
    const delta = before !== null && recent !== null ? recent - before : null;
    return {
      path: job.path,
      total: job.total,
      failed: job.failed,
      stability: decided ? s / decided : null,
      trend: delta === null ? null : { recent, before, delta, direction: delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : 'flat' },
      cells,
    };
  });
  const cover = c.store.coverage(id, from);
  const notes = [...wanted.notes];
  if (cover.from === null) notes.push('There is no history yet: it is being gathered now.');
  else if (cover.from > from) notes.push('History starts later than the first day shown: those days are only partly known.');
  return {
    asOf: now, days, from, to: now, utcOffsetMinutes: offset / MINUTE, axis, rows,
    totalJobs: data.total, truncated: data.total > rows.length,
    coverage: { from: cover.from, complete: cover.complete }, notes,
  };
}

// --- the insights -----------------------------------------------------------------------------------------------

const SEVERITY = { critical: 3, warning: 2, info: 1, good: 0 };
const BASE = { critical: 300, warning: 200, info: 100, good: 50 };

function card({ kind, key, severity, score = 0, title, detail, jobs = [], evidence = {}, actions = [] }) {
  return { id: `${kind}:${key}`, severity, kind, score: BASE[severity] + Math.max(0, Math.min(99, Math.round(score))), title, detail, jobs, evidence, actions };
}

const run = (path) => ({ label: 'Re-run', verb: 'run', args: { path } });
const ask = (path, number) => ({ label: 'Ask Claude', verb: 'ask', args: { path, number } });
const open = (path, number) => ({ label: 'Open', page: number ? { type: 'build', path, number } : { type: 'job', path } });
const leaf = (path) => String(path).split('/').pop();

/** The commits behind a build, from what is kept or a small question — asked for a few cards, and remembered. */
async function suspectsOf(c, id, api, path, number) {
  try {
    const kept = c.store.db.prepare('SELECT changes FROM jk_build WHERE server = ? AND path = ? AND number = ?').get(String(id), path, number);
    if (kept?.changes) {
      const list = JSON.parse(kept.changes);
      if (Array.isArray(list) && list.length) return list.slice(0, 5);
    }
  } catch { /* nothing kept of this build */ }
  c.changesCache ??= new Map();
  const key = `${id}\n${path}\n${number}`;
  if (c.changesCache.has(key)) return c.changesCache.get(key);
  let list = null;
  try { list = (await api?.buildChanges?.(path, number))?.slice(0, 5) ?? null; } catch { list = null; }
  c.changesCache.set(key, list);
  while (c.changesCache.size > 200) c.changesCache.delete(c.changesCache.keys().next().value);
  return list;
}

/**
 * The cards: what a lead would want to be told, in the order they would want
 * to be told it. Each one is a claim that can be checked — the jobs, the
 * builds and the times are in `evidence` — and offers what can be done about
 * it with the verbs the panel already has.
 */
async function insights(c, id, api, index, args = {}) {
  const key = rangeOf(args.range);
  const now = c.now();
  const length = RANGES[key].ms;
  const from = now - length;
  const dash = await c.dashboard(id, api, index, { range: key, scope: args.scope, utcOffsetMinutes: args.utcOffsetMinutes });
  const wanted = await c.resolveScope(id, api, index, args.scope);
  const scope = wanted.scope;
  const cards = [];
  const notes = [...dash.notes.filter((one) => /clock|History starts|no history|Filtered|view|mine/.test(one))];

  // Red now, split into what just broke and what has been broken for days.
  const reds = await c.store.offload('redJobs', [id, scope, { limit: 200 }]);
  const fresh = [];
  const longRed = [];
  const shortRed = [];
  for (const red of reds) {
    const greens = c.store.greensBefore(id, red.path, red.since);
    if (red.since >= from && greens >= 3) fresh.push({ red, greens });
    else if (now - red.since >= 3 * DAY) longRed.push(red);
    else shortRed.push(red);
  }
  // Red for under three days after fewer than three greens: not "newly broken", not "for days", but it is failing and the list would otherwise not say so.
  for (const red of shortRed.sort((a, b) => b.since - a.since).slice(0, MAX_RED_SINGLES)) {
    cards.push(card({
      kind: 'failing', key: red.path, severity: 'info', score: Math.min(40, red.builds * 5),
      title: `${leaf(red.path)} is failing`,
      detail: `Red since ${human(now - red.since)} ago, ${red.builds} ${red.builds === 1 ? 'build' : 'builds'} in a row; the last is #${red.lastNumber}.`,
      jobs: [red.path], evidence: { since: red.since, builds: red.builds, lastNumber: red.lastNumber },
      actions: [ask(red.path, red.lastNumber), open(red.path, red.lastNumber)],
    }));
  }
  // Red for days: a card for each job when there are a few; one card for a folder when it is many, or the list would be all one folder's.
  const byFolder = new Map();
  for (const red of longRed) {
    const folder = red.path.includes('/') ? red.path.slice(0, red.path.lastIndexOf('/')) : '';
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), red]);
  }
  let singles = 0;
  for (const [folder, group] of byFolder) {
    if (group.length >= GROUP_RED) {
      const oldest = Math.min(...group.map((red) => red.since));
      cards.push(card({
        kind: 'red-for-days', key: folder || '/', severity: now - oldest >= 7 * DAY ? 'critical' : 'warning', score: Math.min(99, group.length * 3 + 20),
        title: `${group.length} jobs in ${folder || 'the top level'} have been red for 3+ days`,
        detail: `The longest since ${human(now - oldest)} ago. Disable or delete the ones nobody needs, and the list shows what is worth fixing.`,
        jobs: group.slice(0, 10).map((red) => red.path), evidence: { count: group.length, since: oldest, folder },
        actions: [{ label: 'Open folder', page: { type: 'folder', path: folder } }],
      }));
      continue;
    }
    for (const red of group) {
      if (singles >= MAX_RED_SINGLES) break;
      singles += 1;
      const days = Math.round((now - red.since) / DAY);
      cards.push(card({
        kind: 'red-for-days', key: red.path, severity: now - red.since >= 7 * DAY ? 'critical' : 'warning', score: Math.min(99, days * 4),
        title: `${leaf(red.path)} has been failing for ${days} days`,
        detail: `Red since ${human(now - red.since)} ago, ${red.builds} ${red.builds === 1 ? 'build' : 'builds'} in a row; the last is #${red.lastNumber}.`,
        jobs: [red.path], evidence: { since: red.since, builds: red.builds, firstFailing: red.firstNumber, lastNumber: red.lastNumber },
        actions: [ask(red.path, red.lastNumber), run(red.path), open(red.path, red.lastNumber)],
      }));
    }
  }
  fresh.sort((a, b) => b.greens - a.greens || b.red.since - a.red.since);
  const suspected = await Promise.all(fresh.slice(0, SUSPECT_CARDS).map((one) => suspectsOf(c, id, api, one.red.path, one.red.firstNumber)));
  fresh.forEach(({ red, greens }, i) => {
    cards.push(card({
      kind: 'new-failure', key: red.path, severity: greens >= 10 ? 'critical' : 'warning', score: Math.min(99, greens * 3),
      title: `${leaf(red.path)} started failing`,
      detail: `First red after ${greens} green ${greens === 1 ? 'build' : 'builds'}, ${human(now - red.since)} ago (#${red.firstNumber}).${red.builds > 1 ? ` It has failed ${red.builds} times since.` : ''}`,
      jobs: [red.path],
      evidence: { number: red.firstNumber, previousGreen: greens, since: red.since, builds: red.builds, suspects: i < SUSPECT_CARDS ? (suspected[i] ?? null) : null },
      actions: [ask(red.path, red.firstNumber), run(red.path), open(red.path, red.firstNumber)],
    }));
  });

  // A day that went worse than the one before.
  const failed = dash.kpi.failed;
  // Only against a period the history covers: with no baseline, "worse than before" is not something that is known.
  if (failed.prev !== null && failed.count >= 5 && failed.count >= 2 * Math.max(1, failed.prev)) {
    const worst = dash.failures.topJobs.slice(0, 3).map((one) => one.path);
    cards.push(card({
      kind: 'failure-spike', key: key, severity: failed.count >= 10 && failed.count >= 4 * Math.max(1, failed.prev) ? 'critical' : 'warning', score: Math.min(99, failed.count),
      title: `${failed.count} builds failed in the last ${key}`,
      detail: `${failed.prev === 0 ? 'None' : failed.prev} in the ${key} before. Most in ${worst.map(leaf).join(', ') || 'no one job'}.`,
      jobs: worst, evidence: { failed: failed.count, previous: failed.prev, rate: dash.kpi.rate },
      actions: worst.slice(0, 1).map((path) => open(path)),
    }));
  }

  // Slower than they used to be.
  for (const slow of dash.perf.regressions.slice(0, 5)) {
    cards.push(card({
      kind: 'duration-regression', key: slow.path, severity: slow.ratio >= 2 ? 'warning' : 'info', score: Math.min(99, slow.ratio * 20),
      title: `${leaf(slow.path)} takes ${slow.ratio}× as long as it did`,
      detail: `Its last five builds took ${human(slow.now)} (median); the twenty before, ${human(slow.before)}.`,
      jobs: [slow.path], evidence: slow, actions: [open(slow.path)],
    }));
  }

  // Running too long.
  for (const running of dash.live.runs.filter((one) => one.stuck).slice(0, 5)) {
    const usual = c.store.usualDuration(id, running.path);
    cards.push(card({
      kind: 'stuck-build', key: `${running.path}#${running.number}`, severity: running.estimated && running.elapsed > 4 * running.estimated ? 'critical' : 'warning', score: Math.min(99, Math.round(running.elapsed / HOUR) * 8),
      title: `${leaf(running.path)} #${running.number} has been running for ${human(running.elapsed)}`,
      detail: running.estimated ? `Jenkins expected about ${human(running.estimated)}.` : `Nothing says how long it should take${usual ? `; its builds usually take ${human(usual.p50)}` : ''}.`,
      jobs: [running.path], evidence: { number: running.number, elapsed: running.elapsed, estimated: running.estimated, usualMedian: usual?.p50 ?? null, usualP95: usual?.p95 ?? null, stage: running.stage },
      actions: [{ label: 'Stop', verb: 'stop', args: { path: running.path, number: running.number } }, ask(running.path, running.number), open(running.path, running.number)],
    }));
  }
  // Longer than nearly all of its own history, even if Jenkins has no estimate to compare to.
  for (const running of dash.live.runs.filter((one) => !one.stuck && one.elapsed > 10 * MINUTE).slice(0, 20)) {
    const usual = c.store.usualDuration(id, running.path);
    if (usual && usual.n >= 10 && running.elapsed > Math.max(usual.p95 * 1.5, usual.p50 * 3)) {
      cards.push(card({
        kind: 'stuck-build', key: `${running.path}#${running.number}`, severity: 'warning', score: 40,
        title: `${leaf(running.path)} #${running.number} is taking longer than usual`,
        detail: `Running for ${human(running.elapsed)}; 95% of its last ${usual.n} builds took less than ${human(usual.p95)}.`,
        jobs: [running.path], evidence: { number: running.number, elapsed: running.elapsed, usualMedian: usual.p50, usualP95: usual.p95, stage: running.stage },
        actions: [{ label: 'Stop', verb: 'stop', args: { path: running.path, number: running.number } }, open(running.path, running.number)],
      }));
    }
  }

  // Waiting for an executor longer than anything usually does.
  const wait = dash.kpi.queueWait;
  const baseline = wait.n >= 3 && wait.avg !== null ? wait.avg : 0;
  for (const queued of dash.live.queue.filter((one) => one.stuck || one.waited > Math.max(10 * MINUTE, 3 * baseline)).slice(0, 5)) {
    cards.push(card({
      kind: 'queue-wait', key: `${queued.path}#${queued.id}`, severity: queued.waited > HOUR || queued.stuck ? 'critical' : 'warning', score: Math.min(99, Math.round(queued.waited / MINUTE)),
      title: `${leaf(queued.path)} has been waiting ${human(queued.waited)} for an executor`,
      detail: `${queued.why || 'Jenkins gives no reason.'}${baseline ? ` Builds usually wait ${human(baseline)}.` : ''}`,
      jobs: [queued.path], evidence: { id: queued.id, since: queued.since, waited: queued.waited, why: queued.why, usualWait: baseline || null },
      actions: [{ label: 'Cancel', verb: 'cancelQueued', args: { id: queued.id } }, { label: 'Queue & agents', page: { type: 'queue' } }],
    }));
  }

  // Every executor busy and a line behind them.
  const samples = c.store.samples(id, now - 30 * MINUTE, now + 1);
  if (samples.length >= 10) {
    const saturated = samples.filter((one) => one.total > 0 && one.busy >= one.total && one.queued > 0);
    if (saturated.length / samples.length >= 0.8) {
      const queuedAvg = Math.round(saturated.reduce((n, one) => n + one.queued, 0) / saturated.length * 10) / 10;
      cards.push(card({
        kind: 'executor-saturation', key: 'now', severity: queuedAvg >= 10 ? 'critical' : 'warning', score: Math.min(99, queuedAvg * 4),
        title: 'Every executor has been busy for the last half hour',
        detail: `About ${queuedAvg} ${queuedAvg === 1 ? 'build is' : 'builds are'} waiting at any moment. More executors, or fewer builds at once, would move them.`,
        jobs: [], evidence: { samples: samples.length, saturated: saturated.length, queuedAverage: queuedAvg, executors: samples.at(-1).total },
        actions: [{ label: 'Queue & agents', page: { type: 'queue' } }],
      }));
    }
  }

  // Agents.
  const offline = dash.live.agents.list.filter((one) => one.offline);
  if (offline.length) {
    cards.push(card({
      kind: 'agents-offline', key: 'now', severity: dash.live.agents.total > 0 && offline.length === dash.live.agents.total ? 'critical' : 'warning', score: offline.length * 10,
      title: `${offline.length} ${offline.length === 1 ? 'agent is' : 'agents are'} offline`,
      detail: `${offline.map((one) => one.name).slice(0, 5).join(', ')}${offline.length > 5 ? ` and ${offline.length - 5} more` : ''}. Builds that need them wait in the queue.`,
      jobs: [], evidence: { agents: offline.map((one) => ({ name: one.name, labels: one.labels })).slice(0, 20), total: dash.live.agents.total },
      actions: [{ label: 'Queue & agents', page: { type: 'queue' } }],
    }));
  }
  if (dash.activity.agentFlaps >= 6) {
    cards.push(card({
      kind: 'agents-flapping', key: key, severity: 'warning', score: Math.min(99, dash.activity.agentFlaps * 3),
      title: 'Agents keep going away and coming back',
      detail: `The number of agents that are offline changed ${dash.activity.agentFlaps} times in the last ${key}.`,
      jobs: [], evidence: { flaps: dash.activity.agentFlaps }, actions: [{ label: 'Queue & agents', page: { type: 'queue' } }],
    }));
  }

  // Good news: what was broken and is not.
  const fixed = (await fixedJobs(c, id, scope, from, now)).slice(0, 5);
  for (const one of fixed) {
    cards.push(card({
      kind: 'fixed', key: one.path, severity: 'good', score: Math.min(99, one.failures * 5),
      title: `${leaf(one.path)} is green again`,
      detail: `Passing since ${human(now - one.end)} ago${one.start === null ? '' : `, after being red for ${human(one.end - one.start)}`} (${one.failures} failed ${one.failures === 1 ? 'build' : 'builds'}).`,
      jobs: [one.path], evidence: { recoveredAt: one.end, redSince: one.start, failures: one.failures }, actions: [open(one.path)],
    }));
  }

  // A job that is busy until it suddenly is not: judged against the hours it builds at on weekdays and on weekends, so a job that builds in working hours is not quiet at night or on Sunday.
  const slotOf = (t) => (((Math.floor(t / DAY) + 4) % 7) % 6 === 0 ? 24 : 0) + (Math.floor(t / HOUR) % 24);
  const expectedSince = (habit) => {
    let expected = 0;
    const end = Math.floor(now / HOUR);
    const begin = Math.floor(habit.last / HOUR) + 1;
    for (let h = begin; h < end && h - begin < 14 * 24; h += 1) {
      // An hour counts when the job has built in it on at least two different days of the same kind (weekdays, weekend days): once is an accident, not a habit.
      const slot = habit.slots[slotOf(h * HOUR)];
      if (slot && slot.days >= 2) expected += slot.n / slot.days;
    }
    return expected;
  };
  const quiet = c.store.habits(id, scope, { since: now - 14 * DAY })
    .map((habit) => ({ ...habit, silence: now - habit.last, expected: 0 }))
    .filter((habit) => habit.silence > 3 * HOUR && habit.silence < 14 * DAY)
    .filter((habit) => index?.rows?.get(habit.path)?.status !== 'disabled')
    .map((habit) => ({ ...habit, expected: expectedSince(habit) }))
    .filter((habit) => habit.expected >= 4)
    .sort((a, b) => b.expected - a.expected)
    .slice(0, 5);
  for (const habit of quiet) {
    cards.push(card({
      kind: 'gone-quiet', key: habit.path, severity: 'info', score: Math.min(99, Math.round(habit.expected) * 3),
      title: `${leaf(habit.path)} has not been built for ${human(habit.silence)}`,
      detail: `About ${Math.round(habit.expected)} builds were due since, at the hours it usually builds (${habit.builds} builds in the last two weeks).`,
      jobs: [habit.path], evidence: { builds: habit.builds, expected: Math.round(habit.expected), lastBuild: habit.last },
      actions: [run(habit.path), open(habit.path)],
    }));
  }

  if (dash.activity.staleJobs !== null && dash.activity.staleJobs >= 20) {
    cards.push(card({
      kind: 'stale-jobs', key: 'all', severity: 'info', score: Math.min(99, dash.activity.staleJobs / 4),
      title: `${dash.activity.staleJobs} jobs have not been built in 30 days`,
      detail: 'They are still on the server and still count when it is browsed. Disabling or removing the ones nobody needs makes it easier to read.',
      jobs: [], evidence: { count: dash.activity.staleJobs }, actions: [{ label: 'Show them', page: { type: 'view', kind: 'smart', name: 'stale' } }],
    }));
  }

  if (dash.failures.incidents >= 3 && dash.failures.mttrMs !== null) {
    cards.push(card({
      kind: 'mttr', key: key, severity: dash.failures.mttrMs > DAY ? 'warning' : 'info', score: Math.min(99, dash.failures.mttrMs / HOUR),
      title: `Failures take ${human(dash.failures.mttrMs)} to fix, in the middle`,
      detail: `${dash.failures.incidents} ${dash.failures.incidents === 1 ? 'job' : 'jobs'} broke in the last ${key}; the slowest tenth took ${human(dash.failures.mttrP90Ms)} or more to recover.`,
      jobs: [], evidence: { incidents: dash.failures.incidents, median: dash.failures.mttrMs, p90: dash.failures.mttrP90Ms, open: dash.failures.open }, actions: [],
    }));
  }

  cards.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || b.score - a.score || (a.id < b.id ? -1 : 1));
  const shown = cards.slice(0, MAX_CARDS);
  const counts = { critical: 0, warning: 0, info: 0, good: 0 };
  for (const one of cards) counts[one.severity] += 1;
  if (cards.length > shown.length) notes.push(`${cards.length - shown.length} more are not shown.`);
  return { asOf: now, range: key, counts, cards: shown, notes: [...new Set(notes)] };
}

/** Jobs that failed three builds or more (or two, over six hours) and then passed, in a slice: the good news. */
async function fixedJobs(c, id, scope, from, to) {
  const out = [];
  for (const one of await c.store.offload('recoveriesIn', [id, scope, from, to])) {
    const failures = one.start === null ? 1 : c.store.failuresBetween(id, one.path, one.start, one.end);
    if (failures >= 3 || (one.start !== null && one.end - one.start >= 6 * HOUR && failures >= 2)) out.push({ ...one, failures });
  }
  return out.sort((a, b) => b.end - a.end);
}

// --- the report --------------------------------------------------------------------------------------------------

/**
 * Everything that can end a line, move text right to left or hide what is
 * written, for taking out of a piece of text from a server. Spelled as
 * escapes in a string: a line separator written out would end the line of
 * this file.
 */
const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]', 'g');

/**
 * A piece of text from a server, fit to be pasted into a chat: no control
 * characters, no mention, and nothing that makes a link, a tag or a code
 * span. Only what can do something is changed, to a character that looks like
 * it and does nothing: the sentence around a name is ours, and stays as written.
 */
function plain(text, max = 120) {
  return String(text ?? '')
    .replace(INVISIBLE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/@/g, '＠')
    .replace(/\[/g, '［').replace(/\]/g, '］')
    .replace(/</g, '＜').replace(/>/g, '＞')
    .replace(/`/g, 'ʼ')
    .trim()
    .slice(0, max);
}
/** A job's path as code: backticks inside a name would end it. */
const code = (path) => `\`${String(path ?? '').replace(INVISIBLE, ' ').replace(/`/g, ' ').replace(/@/g, '＠').trim().slice(0, 120)}\``;
const percent = (value) => (value === null || value === undefined ? 'n/a' : `${Math.round(value * 1000) / 10}%`);
const minutes = (ms) => (ms === null || ms === undefined ? 'n/a' : human(ms));

/** A summary a person can paste into a chat or a ticket. Always the same shape, and never longer than a screen or two. */
async function report(c, id, api, index, args = {}) {
  const format = args.format === 'text' ? 'text' : 'markdown';
  const md = format === 'markdown';
  const key = rangeOf(args.range);
  const now = c.now();
  const dash = await c.dashboard(id, api, index, { range: key, scope: args.scope, utcOffsetMinutes: args.utcOffsetMinutes });
  const wanted = await c.resolveScope(id, api, index, args.scope);
  const cardsPage = await insights(c, id, api, index, { range: key, scope: args.scope, utcOffsetMinutes: args.utcOffsetMinutes });
  const k = dash.kpi;
  const name = (path) => (md ? code(path) : plain(path, 120));
  const text = (value, max) => plain(value, max ?? 120);
  const head = (title) => (md ? `\n## ${title}\n` : `\n${title.toUpperCase()}\n`);
  const bullet = md ? '- ' : '  * ';
  const lines = [];
  const server = text(args.serverName || 'Jenkins', 60);
  lines.push(md ? `# CI summary — ${server} — last ${key}` : `CI SUMMARY — ${server} — last ${key}`);
  const filter = Object.entries(wanted.asked ?? {}).map(([field, value]) => `${field}: ${value === true ? 'yes' : text(value, 60)}`).join(', ');
  if (filter) lines.push(md ? `_Filtered — ${filter}_` : `Filtered — ${filter}`);
  lines.push('');
  const delta = (value, previous, unit = '') => (previous === null || previous === undefined ? '' : ` (${previous}${unit} before)`);
  lines.push(`${md ? '**Builds**' : 'Builds'}: ${k.finished.count} finished${delta(k.finished.count, k.finished.prev)} · success rate ${percent(k.rate.value)}${k.rate.prev === null ? '' : ` (${percent(k.rate.prev)} before)`} · ${k.failed.count} failed${delta(k.failed.count, k.failed.prev)} · average duration ${minutes(k.duration.avg)}`);
  lines.push(`${md ? '**Now**' : 'Now'}: ${dash.live.running} running · ${dash.live.queued} queued · executors ${dash.live.executors.busy}/${dash.live.executors.total} · agents ${dash.live.agents.total - dash.live.agents.offline}/${dash.live.agents.total} online`);

  const reds = await c.store.offload('redJobs', [id, wanted.scope, { limit: 10 }]);
  lines.push(head(`Failing now (${dash.failures.open})`));
  if (!reds.length) lines.push(`${bullet}Nothing is red.`);
  for (const red of reds) lines.push(`${bullet}${name(red.path)} — red for ${human(now - red.since)} (${red.builds} ${red.builds === 1 ? 'build' : 'builds'}), last #${red.lastNumber}`);
  if (dash.failures.open > reds.length) lines.push(`${bullet}…and ${dash.failures.open - reds.length} more.`);

  if (dash.live.runs.length) {
    lines.push(head(`Running now (${dash.live.running})`));
    for (const one of dash.live.runs.slice(0, 8)) {
      lines.push(`${bullet}${name(one.path)} #${one.number} — ${human(one.elapsed)}${one.estimated ? ` of about ${human(one.estimated)}` : ''}${one.stuck ? ' — taking too long' : ''}`);
    }
  }

  if (cardsPage.cards.length) {
    lines.push(head('Needs attention'));
    cardsPage.cards.slice(0, 5).forEach((one, i) => lines.push(`${md ? `${i + 1}. ` : `  ${i + 1}) `}[${one.severity}] ${text(one.title, 140)} — ${text(one.detail, 220)}`));
  }

  if (dash.perf.slowest.length) {
    lines.push(head('Slowest builds'));
    for (const one of dash.perf.slowest.slice(0, 5)) lines.push(`${bullet}${name(one.path)} #${one.number} — ${human(one.duration)}`);
  }

  // Environments that are behind each other.
  const boardPage = await board(c, id, api, index, { scope: args.scope }).catch(() => null);
  const behind = (boardPage?.rows ?? []).filter((row) => row.drift.some((d) => d.behind > 0 || d.versionsDiffer === true)).slice(0, 8);
  if (behind.length) {
    lines.push(head('Environments that are behind'));
    for (const row of behind) {
      for (const d of row.drift.filter((one) => one.behind > 0 || one.versionsDiffer === true)) {
        const a = row.cells[d.from];
        const b = row.cells[d.to];
        const versions = a.successVersion && b.successVersion ? ` (${text(d.from)} ${text(a.successVersion, 40)}, ${text(d.to)} ${text(b.successVersion, 40)})` : '';
        lines.push(`${bullet}${text(row.service, 80)}: ${text(d.to)} is ${d.behind} ${d.behind === 1 ? 'build' : 'builds'} behind ${text(d.from)}${versions}`);
      }
    }
  }

  const offline = dash.live.agents.list.filter((one) => one.offline);
  if (offline.length) {
    lines.push(head('Agents'));
    lines.push(`${bullet}Offline: ${offline.slice(0, 8).map((one) => text(one.name, 60)).join(', ')}`);
  }
  if (dash.notes.length) {
    lines.push(head('Notes'));
    for (const note of dash.notes.slice(0, 5)) lines.push(`${bullet}${text(note, 200)}`);
  }
  lines.push('');
  lines.push(md ? `_Generated ${new Date(now).toISOString()}_` : `Generated ${new Date(now).toISOString()}`);

  let out = lines.join('\n');
  let truncated = false;
  if (out.length > REPORT_MAX) {
    out = `${out.slice(0, REPORT_MAX - 40).replace(/\n[^\n]*$/, '')}\n…`;
    truncated = true;
  }
  return { format, text: out, bytes: Buffer.byteLength(out), truncated };
}

// --- the wallboard ------------------------------------------------------------------------------------------------

/** The page for a screen on a wall: small, and it can be read again every few seconds. */
async function wallboard(c, id, api, index, args = {}) {
  const now = c.now();
  const wanted = await c.resolveScope(id, api, index, args.scope);
  const cacheKey = `${id}|${scopeKey(wanted.scope)}`;
  c.wallCache ??= new Map();
  const held = c.wallCache.get(cacheKey);
  if (held && now - held.at < WALL_CACHE_MS && now >= held.at) return held.value;
  const scope = wanted.scope;
  const live = metrics.scoped ? metrics.scoped(await c.live(id, api, index).catch(() => null), scope) : null;
  const liveNow = live ?? metrics.emptyLive();
  const reds = await c.store.offload('redJobs', [id, scope, { limit: 12, oldest: true }]);
  const total = (await c.store.offload('redJobs', [id, scope, { limit: 1000, scan: 1000 }])).length;
  const day = c.store.dashboardPlan(id, { range: '24h', now, scope });
  day.steps[0]();
  const kpi = day.result().kpi;
  let boardSummary = null;
  try {
    const page = await board(c, id, api, index, { scope: args.scope });
    boardSummary = { services: page.summary.services, red: page.summary.red, amber: page.summary.amber, green: page.summary.green, running: page.summary.running, byEnv: page.summary.byEnv };
  } catch { boardSummary = null; }
  const value = {
    asOf: now,
    counts: { running: liveNow.running, queued: liveNow.queued, failing: total, stuck: liveNow.stuck },
    executors: liveNow.executors,
    rate24h: kpi.rate.value,
    failing: reds.map((red) => ({ path: red.path, number: red.lastNumber, since: red.since, builds: red.builds, status: 'failed' })),
    running: liveNow.runs.slice(0, 12).map((one) => ({
      path: one.path, number: one.number, elapsed: one.elapsed, estimated: one.estimated, progress: one.progress, stage: one.stage, agent: one.agent, trigger: one.trigger, stuck: one.stuck,
    })),
    ticker: c.store.finished(id, scope, 20).map((one) => ({ path: one.path, number: one.number, result: one.result, endedAt: one.endedAt, ago: Math.max(0, now - one.endedAt), duration: one.duration })),
    board: boardSummary,
  };
  c.wallCache.set(cacheKey, { at: now, value });
  while (c.wallCache.size > 20) c.wallCache.delete(c.wallCache.keys().next().value);
  return value;
}

module.exports = { board, saveBoardSettings, heatmap, insights, report, wallboard, pickVersion, human, plain, code };
