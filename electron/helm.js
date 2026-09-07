'use strict';

/**
 * Talking to Helm.
 *
 * The same shape as `kube.js` and for the same reasons: `execFile` with the
 * arguments as an array, names checked for a leading dash before they are
 * passed, and the context carried on every call rather than switched.
 *
 * Helm spells that last one differently — `--kube-context`, not `--context` —
 * and gets it wrong quietly if you forget: it falls back to whatever kubeconfig
 * says is current, so a rollback aimed at staging lands in production and looks
 * like it worked. Every call below carries it.
 *
 * What a release *is* matters for how this file is shaped. It is not a thing in
 * a cluster you can `get`; it is a record Helm keeps of what it installed, in a
 * secret, with every revision it has ever applied still in there. So the useful
 * questions are historical — what changed, what were the values then, put it
 * back — and those are what this offers.
 */

const { execFile, spawn } = require('node:child_process');
const { resolvedPath } = require('./cli-env');

/** A chart can take a while to render, and a big release longer to read. */
const TIMEOUT = 60000;

const { safeArg } = require('./kube');

/**
 * Where a call is aimed.
 *
 * `--kube-context`, because Helm does not answer to `--context` — and it does
 * not complain either: it falls back to whatever kubeconfig says is current, so
 * a rollback aimed at staging lands in production and looks like it worked.
 *
 * `--all-namespaces` is not here, the same way it is not in kubectl's: it
 * belongs to `list` rather than to helm, and in front it is an unknown flag.
 */
function scope({ context, namespace } = {}) {
  const args = [];
  if (context) args.push('--kube-context', safeArg(context, 'the context'));
  if (namespace) args.push('--namespace', safeArg(namespace, 'the namespace'));
  return args;
}

let cachedEnv = null;
async function environment() {
  if (!cachedEnv) cachedEnv = { ...process.env, PATH: await resolvedPath() };
  return cachedEnv;
}

function run(args, { timeout = TIMEOUT } = {}) {
  return environment().then(
    (env) =>
      new Promise((resolve) => {
        execFile(
          'helm',
          args,
          { timeout, env, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) => {
            if (!error) return resolve({ ok: true, stdout, stderr });
            resolve({ ok: false, stdout: stdout || '', error: cleanError(stderr, error) });
          },
        );
      }),
  );
}

/**
 * What went wrong, in Helm's words rather than ours.
 *
 * Except when Helm is not installed at all, where the message is about spawning
 * a file and tells nobody what to do — and that case is not an error worth a red
 * box anyway: plenty of people run Kubernetes and no Helm.
 */
function cleanError(stderr, error) {
  const text = String(stderr || '').trim();
  if (!text) {
    if (error?.code === 'ENOENT') return 'helm is not installed, or not on the PATH this app can see.';
    if (error?.killed) return `helm did not answer within ${TIMEOUT / 1000} seconds.`;
    return String(error?.message ?? 'helm failed');
  }
  return text.replace(/^Error:\s*/i, '').trim();
}

async function runJson(args, options) {
  const result = await run(args, options);
  if (!result.ok) return result;
  try {
    return { ok: true, data: JSON.parse(result.stdout || 'null') };
  } catch (error) {
    return { ok: false, error: `helm answered with something that is not JSON — ${String(error?.message ?? error)}` };
  }
}

/* --------------------------------------------------------------------------
 * Shaping. Pure, and tested as such.
 * ------------------------------------------------------------------------ */

/** How old, the way the rest of the app says it. Helm's timestamps carry an offset. */
function age(stamp, now = Date.now()) {
  const then = Date.parse(String(stamp || '').replace(/ [+-]\d{4} \w+$/, ''));
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 365 ? `${days}d` : `${Math.floor(days / 365)}y${days % 365}d`;
}

/**
 * A release's health, in the three colours the rest of the panel uses.
 *
 * `deployed` is the only good one. `failed` and `pending-*` are not the same
 * thing — one is over and one is still going — but both mean the release is not
 * what its chart says it should be, and both want looking at.
 */
function health(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'deployed') return 'ok';
  if (value === 'superseded' || value === 'uninstalled') return 'idle';
  if (value.startsWith('pending') || value === 'unknown') return 'warn';
  return 'bad';
}

/** The chart's own name, without the version Helm glues onto it. */
function chartName(chart) {
  return String(chart || '').replace(/-\d+\.\d+\.\d+.*$/, '');
}

function releaseRows(list, now = Date.now()) {
  return (list ?? []).map((entry) => ({
    uid: `${entry.namespace}/${entry.name}`,
    name: entry.name,
    namespace: entry.namespace,
    revision: Number(entry.revision) || 0,
    status: entry.status ?? '',
    health: health(entry.status),
    chart: chartName(entry.chart),
    chartVersion: String(entry.chart || '').slice(chartName(entry.chart).length + 1),
    appVersion: entry.app_version ?? '',
    updated: entry.updated ?? '',
    age: age(entry.updated, now),
  }));
}

/**
 * The revisions, newest first, and which ones are worth going back to.
 *
 * Newest first because that is the order the question is asked in — what
 * happened *last* — and a history read downwards like a log makes you scroll to
 * find the thing you came for. The current one is marked rather than hidden: it
 * is the reference point for every other row.
 */
function historyRows(list, now = Date.now()) {
  const rows = (list ?? []).map((entry) => ({
    revision: Number(entry.revision) || 0,
    status: entry.status ?? '',
    health: health(entry.status),
    chart: entry.chart ?? '',
    appVersion: entry.app_version ?? '',
    description: entry.description ?? '',
    updated: entry.updated ?? '',
    age: age(entry.updated, now),
  }));
  rows.sort((a, b) => b.revision - a.revision);
  const current = rows.find((row) => row.status === 'deployed')?.revision ?? rows[0]?.revision ?? 0;
  return rows.map((row) => ({ ...row, current: row.revision === current }));
}

/* --------------------------------------------------------------------------
 * The verbs.
 * ------------------------------------------------------------------------ */

async function releases(args = {}) {
  const command = [...scope(args), 'list', '-o', 'json'];
  // Every namespace unless one was asked for — and after the subcommand.
  if (!args.namespace) command.push('--all-namespaces');
  const result = await runJson(command);
  if (!result.ok) return result;
  return { ok: true, rows: releaseRows(result.data) };
}

async function history({ name, ...rest }) {
  const result = await runJson([
    ...scope(rest),
    'history',
    safeArg(name, 'the release'),
    '--max',
    '50',
    '-o',
    'json',
  ]);
  if (!result.ok) return result;
  return { ok: true, rows: historyRows(result.data) };
}

/**
 * The values a release was installed with.
 *
 * Two different questions, and the difference matters when something is not
 * behaving: `all` is every value the chart ended up using, defaults included,
 * which is what actually took effect. Without it you get only what somebody
 * overrode — usually a dozen lines, and the ones a person actually wrote.
 */
async function values({ name, revision, all = false, ...rest }) {
  const args = [...scope(rest), 'get', 'values', safeArg(name, 'the release')];
  if (revision) args.push('--revision', String(Number(revision) || 1));
  if (all) args.push('--all');
  const result = await run([...args, '-o', 'yaml']);
  return result.ok ? { ok: true, yaml: result.stdout } : result;
}

/** What the release actually put in the cluster, at a revision. */
async function manifest({ name, revision, ...rest }) {
  const args = [...scope(rest), 'get', 'manifest', safeArg(name, 'the release')];
  if (revision) args.push('--revision', String(Number(revision) || 1));
  const result = await run(args);
  return result.ok ? { ok: true, yaml: result.stdout } : result;
}

/** What the chart told you when it was installed. Often where the passwords are. */
async function notes({ name, ...rest }) {
  const result = await run([...scope(rest), 'get', 'notes', safeArg(name, 'the release')]);
  return result.ok ? { ok: true, text: result.stdout } : result;
}

/**
 * Put a release back to an earlier revision.
 *
 * `--wait` deliberately not passed. It would make this sit there until every
 * pod is ready, which on a rollback is exactly when you want to be watching the
 * pods rather than watching a spinner — and Helm holds a lock while it waits,
 * so a hung wait is a release nobody can touch.
 */
async function rollback({ name, revision, ...rest }) {
  const target = Number(revision);
  if (!Number.isInteger(target) || target < 1) return { ok: false, error: 'A revision is a whole number, one or more.' };
  const result = await run([...scope(rest), 'rollback', safeArg(name, 'the release'), String(target)]);
  return result.ok ? { ok: true, text: result.stdout.trim() } : result;
}

async function uninstall({ name, keepHistory = false, ...rest }) {
  const args = [...scope(rest), 'uninstall', safeArg(name, 'the release')];
  if (keepHistory) args.push('--keep-history');
  const result = await run(args);
  return result.ok ? { ok: true, text: result.stdout.trim() } : result;
}

/**
 * The arguments for an upgrade, built rather than typed.
 *
 * Its own function because an upgrade is the one thing here that can take
 * minutes and should be watched while it happens — it runs through the same
 * streaming machinery as a followed log, so what is spawned has to be
 * inspectable without spawning it.
 *
 * `--reuse-values` is the default because the panel edits *some* values: without
 * it, every value the person did not retype reverts to the chart's default,
 * which is a spectacular way to lose a configuration.
 */
function upgradeArgs({ name, chart, valuesFile, reuseValues = true, ...rest }) {
  const args = [
    ...scope(rest),
    'upgrade',
    safeArg(name, 'the release'),
    safeArg(chart, 'the chart'),
    '--history-max',
    '20',
  ];
  if (reuseValues) args.push('--reuse-values');
  if (valuesFile) args.push('--values', safeArg(valuesFile, 'the values file'));
  return args;
}

/** Whether helm is here at all, and which version. Cheap, and asked once. */
async function version() {
  const result = await run(['version', '--short'], { timeout: 8000 });
  return result.ok ? { ok: true, version: result.stdout.trim() } : { ok: true, version: null, error: result.error };
}

module.exports = {
  releases,
  history,
  values,
  manifest,
  notes,
  rollback,
  uninstall,
  upgradeArgs,
  version,
  // pure
  age,
  health,
  chartName,
  releaseRows,
  historyRows,
  scope,
  cleanError,
};
