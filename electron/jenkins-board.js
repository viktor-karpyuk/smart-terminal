'use strict';

/**
 * Which jobs are the same service in different environments.
 *
 * A company's Jenkins is rarely one job per product. It is the same service
 * built for DEV and for PROD, and the question a lead asks is about the pair:
 * is what is in production what was green in development? Jenkins knows
 * nothing of that — to it these are two unrelated jobs that happen to have
 * similar names — so the pairing is worked out here, from the names.
 *
 * This file is only that: pure functions, no I/O, nothing about builds. What
 * a service's cells say (last build, version, drift) is made elsewhere from
 * what `families` found. It is separate because more than the dashboard wants
 * the families: whatever offers to promote a build from one environment to the
 * next needs to know which job that is.
 *
 * How a family is found, in order of how sure it is:
 *
 *   1. An environment word at the end or the start of the job's name, split
 *      on spaces, dashes, underscores and dots: `TIMELOG MS DEV`,
 *      `KUBRIK-CORE-PROD`, `TIMELOGBOOK-V5-DEV`, `DEV-gateway`.
 *   2. A folder named for the environment: `payments/DEV/deploy`.
 *
 * Two jobs are the same service when they sit in the same folder and have the
 * same name apart from the environment word. A service seen in one
 * environment only is not a family (unless asked for), because one job is not
 * a comparison. An environment word at the START of a name (`Dev Tools`, `QA
 * Report`) is how many jobs are named that are not environments at all, so it
 * counts only for a word the person added themselves. Jobs inside a multibranch project are branches, not
 * environments, and are left alone: a branch called `dev` is not DEV.
 */

/** The canonical environments, in the order a change travels through them. */
const ENV_ORDER = ['DEV', 'TEST', 'QA', 'STG', 'UAT', 'PRE', 'PROD'];

/** Every word that means an environment, and which one. */
const WORDS = {
  DEV: 'DEV', DEVELOP: 'DEV', DEVELOPMENT: 'DEV',
  TEST: 'TEST', TESTING: 'TEST',
  QA: 'QA',
  STG: 'STG', STAGE: 'STG', STAGING: 'STG',
  UAT: 'UAT',
  PRE: 'PRE', PREPROD: 'PRE',
  PROD: 'PROD', PRODUCTION: 'PROD', PRO: 'PROD', PRD: 'PROD',
};

const SEPARATORS = /[\s_.\-]+/;
/** A folder whose jobs are not live: what is in it is shown only when asked for, and nothing is promoted into it. */
const INACTIVE_FOLDER = /(^|[^a-z0-9])(old|deprecated|archive[ds]?|do not use|legacy|unused|obsolete)([^a-z0-9]|$)/i;
const MAX_TOKENS = 30;
const MAX_ORDER = 12;
const MAX_OVERRIDES = 200;
const MAX_HIDE = 200;
const KEY_PATTERN = /^[A-Z0-9]{1,10}$/;

/** What a name is, with the words that mean an environment (and the ones this server added) understood. */
function vocabulary(settings) {
  const words = { ...WORDS };
  for (const [token, env] of Object.entries(settings?.envTokens ?? {})) words[String(token).toUpperCase()] = String(env).toUpperCase();
  return words;
}

/** The environments in the order the settings give, then the usual order, then whatever else there is, alphabetical. */
function orderOf(present, settings) {
  const given = Array.isArray(settings?.order) ? settings.order.map((one) => String(one).toUpperCase()) : [];
  const rank = (env) => {
    const own = given.indexOf(env);
    if (own !== -1) return own;
    const usual = ENV_ORDER.indexOf(env);
    return usual !== -1 ? given.length + usual : given.length + ENV_ORDER.length;
  };
  return [...present].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
}

/** A service's name spelled one way however the job spelled it: `Timelog MS`, `timelog-ms` and `TIMELOG_MS` are one. */
function normal(text) {
  return String(text).toLowerCase().split(SEPARATORS).filter(Boolean).join(' ');
}

/**
 * The environment in a job's name, and what is left of the name without it:
 * `{ env, service }`, or null. At the end first (`ORDERS PROD`), then the start
 * (`PROD orders`); `PRE PROD` as two words is the one environment before
 * production, not production.
 */
function inName(name, words) {
  const text = String(name).trim();
  const parts = text.split(SEPARATORS).filter(Boolean);
  if (parts.length < 2) return null;
  const upper = parts.map((one) => one.toUpperCase());
  // The two-word spelling first: "PRE PROD" and "PRE-PROD" are not "PROD".
  if (parts.length >= 3 && upper[upper.length - 2] === 'PRE' && upper[upper.length - 1] === 'PROD') {
    return { env: words.PREPROD ?? 'PRE', service: parts.slice(0, -2).join(' '), at: 'tail', token: 'PRE PROD' };
  }
  const tail = words[upper[upper.length - 1]];
  if (tail) return { env: tail, service: parts.slice(0, -1).join(' '), at: 'tail', token: upper[upper.length - 1] };
  const head = words[upper[0]];
  if (head) return { env: head, service: parts.slice(1).join(' '), at: 'head', token: upper[0] };
  return null;
}

/**
 * The families among a server's jobs.
 *
 * `rows` — the job list the poller keeps: `{ kind, path, multibranch? }`, folders
 * included (a job inside a multibranch folder is a branch). `settings` — what
 * the person tuned for this server: `envTokens` (their own words for an
 * environment), `order`, `rowOverrides` (a service named by hand, or cells put
 * together by hand), `hide`, `includeSingles`.
 *
 * Returns `{ envs, labels, families }`; a family is `{ key, service, folder,
 * members: { DEV: 'path', PROD: 'path' }, extras, candidates, ambiguous,
 * inactive }`. `extras` are jobs that claimed an environment already taken in
 * the same family, `candidates` every job that claims each environment, and
 * `ambiguous` says there was a choice nobody made: nothing is promoted along an
 * ambiguous family until a `rowOverrides` entry puts its cells together by hand.
 * `inactive` is a family in a folder that says it is old (`old`, `deprecated`,
 * `archive`, `do not use`, `legacy`…).
 */
function families(rows, settings = {}) {
  const words = vocabulary(settings);
  const folders = new Set();
  const branchParents = new Set();
  const jobs = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.path !== 'string') continue;
    if (row.kind === 'folder') {
      folders.add(row.path);
      if (row.multibranch) branchParents.add(row.path);
    } else if (row.kind === 'job') jobs.push(row.path);
  }
  const hide = Array.isArray(settings?.hide) ? settings.hide.map(String) : [];
  const hidden = (key, path) => hide.some((one) => one === key || (one && (path === one || path.startsWith(`${one}/`))));
  const overrides = settings?.rowOverrides && typeof settings.rowOverrides === 'object' ? settings.rowOverrides : {};

  const own = new Set(Object.keys(settings?.envTokens ?? {}).map((one) => one.toUpperCase()));
  const found = new Map();
  for (const path of jobs.sort()) {
    const segments = path.split('/');
    const name = segments[segments.length - 1];
    const parent = segments.slice(0, -1).join('/');
    // A branch of a multibranch project is a branch, whatever it is called.
    if (parent && branchParents.has(parent)) continue;
    let env = null;
    let service = null;
    let folder = parent;
    let byName = inName(name, words);
    // A word at the start of a name is an environment only if the person said so.
    if (byName?.at === 'head' && !own.has(byName.token)) byName = null;
    if (byName && byName.service) {
      env = byName.env;
      service = byName.service;
    } else {
      // A folder named for the environment, anywhere above the job.
      const at = segments.slice(0, -1).findIndex((segment) => words[segment.toUpperCase()]);
      if (at !== -1) {
        env = words[segments[at].toUpperCase()];
        const without = [...segments.slice(0, at), ...segments.slice(at + 1, -1)];
        folder = without.join('/');
        service = name;
      }
    }
    if (!env || !service) continue;
    const key = `${folder}|${normal(service)}`;
    let family = found.get(key);
    if (!family) {
      family = { key, service: service.trim(), folder, members: {}, extras: [], candidates: {}, ambiguous: false, inactive: INACTIVE_FOLDER.test(parent) };
      found.set(key, family);
    }
    (family.candidates[env] ??= []).push(path);
    if (family.members[env]) { family.extras.push(path); family.ambiguous = true; } else family.members[env] = path;
  }

  // Rows put together by hand: the person says which job is which environment.
  for (const [key, over] of Object.entries(overrides)) {
    if (!over || typeof over !== 'object') continue;
    const cells = over.cells && typeof over.cells === 'object' ? over.cells : null;
    if (cells) {
      const members = {};
      for (const [env, path] of Object.entries(cells)) if (typeof path === 'string' && jobs.includes(path)) members[String(env).toUpperCase()] = path;
      if (Object.keys(members).length) {
        const first = Object.values(members)[0];
        const folder = first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : '';
        // Put together by hand, it is settled: nothing left to choose between.
        found.set(key, { key, service: over.name ? String(over.name) : (found.get(key)?.service ?? first.split('/').pop()), folder, members, extras: [], candidates: Object.fromEntries(Object.entries(members).map(([env, path]) => [env, [path]])), ambiguous: false, inactive: INACTIVE_FOLDER.test(folder), manual: true });
      }
    } else if (over.name && found.has(key)) {
      found.get(key).service = String(over.name);
    }
  }

  const includeSingles = settings?.includeSingles === true;
  const list = [];
  for (const family of found.values()) {
    if (hidden(family.key, Object.values(family.members)[0] ?? '')) continue;
    if (!includeSingles && !family.manual && Object.keys(family.members).length < 2) continue;
    list.push(family);
  }
  list.sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : normal(a.service) < normal(b.service) ? -1 : normal(a.service) > normal(b.service) ? 1 : 0));
  const present = new Set();
  for (const family of list) for (const env of Object.keys(family.members)) present.add(env);
  const envs = orderOf(present, settings);
  return { envs, labels: Object.fromEntries(envs.map((env) => [env, env])), families: list };
}

/**
 * The family one job belongs to, from that job's point of view: which
 * environment it is, and which jobs come before and after it. What something
 * that offers to promote a build needs, and the same answer the board gives
 * because it is the same function.
 *
 * `rows` — the job list, as a Map by path or a list. Returns null for a job in
 * no family; otherwise `{ key, service, me, members, downstream, upstream,
 * single }`. `members` are `{ path, env, rank, row }` in the order a change
 * travels (rank counts from 0), `downstream` are the ones after this job
 * nearest first — `downstream[0]` is the environment a build here is promoted
 * to — and `upstream` the ones before it, nearest first. A family of one
 * (`single`) is returned too, with nothing on either side. So is a family that
 * is `ambiguous` (two jobs for one environment: `candidates` lists them) or
 * `inactive` (in a folder marked old): `downstream` and `upstream` are empty,
 * because nothing may be promoted along a pairing that is a guess.
 */
function familyOf(rows, path, settings = {}) {
  const list = rows instanceof Map ? [...rows.values()] : (Array.isArray(rows) ? rows : []);
  const byPath = new Map(list.filter((row) => row && typeof row.path === 'string').map((row) => [row.path, row]));
  const found = families(list, { ...settings, includeSingles: true });
  const family = found.families.find((one) => Object.values(one.members).includes(path) || one.extras.includes(path));
  if (!family) return null;
  const members = found.envs.filter((env) => family.members[env]).map((env, rank) => ({ path: family.members[env], env, rank, row: byPath.get(family.members[env]) ?? null }));
  let at = members.findIndex((one) => one.path === path);
  // A job that lost the choice for its environment (two jobs claim it) is still that environment, but it is no member.
  const env = Object.entries(family.candidates).find(([, paths]) => paths.includes(path))?.[0] ?? null;
  const me = at !== -1 ? members[at] : { path, env, rank: members.findIndex((one) => one.env === env), row: byPath.get(path) ?? null };
  // Nothing is promoted along a family where the pairing is a guess, nor into or out of one that is old.
  const blocked = family.ambiguous || family.inactive;
  if (at === -1) at = members.length;
  return {
    key: family.key,
    service: family.service,
    me,
    members,
    downstream: blocked ? [] : members.slice(at + 1),
    upstream: blocked ? [] : members.slice(0, at).reverse(),
    single: members.length < 2,
    ambiguous: family.ambiguous,
    inactive: family.inactive,
    candidates: family.candidates,
    extras: family.extras,
  };
}

// --- the settings ---------------------------------------------------------------

/** What a person may tune, with nothing in it that was not asked for. */
const DEFAULT_SETTINGS = { envTokens: {}, order: [], rowOverrides: {}, hide: [], includeSingles: false };

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/**
 * Settings after a change. `input` replaces the fields it names; a field set to
 * null goes back to its default; what is not named stays. Everything is
 * checked and bounded: this comes from a panel and is kept on disk. Throws an
 * Error whose message is a sentence.
 */
function mergeSettings(current, input) {
  const base = { ...DEFAULT_SETTINGS, ...(current && typeof current === 'object' ? current : {}) };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings have to be an object');
  const next = { ...base };

  if ('envTokens' in input) {
    if (input.envTokens === null) next.envTokens = {};
    else {
      if (typeof input.envTokens !== 'object' || Array.isArray(input.envTokens)) throw new Error('envTokens has to be an object like { "HOM": "STG" }');
      const entries = Object.entries(input.envTokens);
      if (entries.length > MAX_TOKENS) throw new Error(`envTokens has too many words (at most ${MAX_TOKENS})`);
      const tokens = {};
      for (const [token, env] of entries) {
        const word = clean(token, 30).toUpperCase();
        const key = clean(env, 10).toUpperCase();
        if (!/^[A-Z0-9]{1,30}$/.test(word)) throw new Error(`"${word}" is not a word an environment can be called: letters and digits only`);
        if (!KEY_PATTERN.test(key)) throw new Error(`"${key}" is not an environment: one to ten letters or digits`);
        tokens[word] = key;
      }
      next.envTokens = tokens;
    }
  }
  if ('order' in input) {
    if (input.order === null) next.order = [];
    else {
      if (!Array.isArray(input.order)) throw new Error('order has to be a list of environments');
      if (input.order.length > MAX_ORDER) throw new Error('order has too many environments');
      const order = [];
      for (const one of input.order) {
        const key = clean(one, 10).toUpperCase();
        if (!KEY_PATTERN.test(key)) throw new Error(`"${key}" is not an environment: one to ten letters or digits`);
        if (!order.includes(key)) order.push(key);
      }
      next.order = order;
    }
  }
  if ('hide' in input) {
    if (input.hide === null) next.hide = [];
    else {
      if (!Array.isArray(input.hide)) throw new Error('hide has to be a list of rows or paths');
      if (input.hide.length > MAX_HIDE) throw new Error(`hide has too many entries (at most ${MAX_HIDE})`);
      next.hide = [...new Set(input.hide.map((one) => clean(one, 1000)).filter(Boolean))];
    }
  }
  if ('includeSingles' in input) next.includeSingles = input.includeSingles === true;
  if ('rowOverrides' in input) {
    if (input.rowOverrides === null) next.rowOverrides = {};
    else {
      if (typeof input.rowOverrides !== 'object' || Array.isArray(input.rowOverrides)) throw new Error('rowOverrides has to be an object keyed by row');
      const entries = Object.entries(input.rowOverrides);
      if (entries.length > MAX_OVERRIDES) throw new Error(`rowOverrides has too many rows (at most ${MAX_OVERRIDES})`);
      const overrides = {};
      for (const [key, over] of entries) {
        const row = clean(key, 1000);
        if (!row) throw new Error('a row override needs the row\'s key');
        if (!over || typeof over !== 'object' || Array.isArray(over)) throw new Error(`the override for "${row}" has to be an object`);
        const one = {};
        if (over.name !== undefined && over.name !== null) {
          const name = clean(over.name, 120);
          if (name) one.name = name;
        }
        if (over.cells !== undefined && over.cells !== null) {
          if (typeof over.cells !== 'object' || Array.isArray(over.cells)) throw new Error(`the cells of "${row}" have to be an object like { "DEV": "path" }`);
          const cells = {};
          const pairs = Object.entries(over.cells);
          if (pairs.length > MAX_ORDER) throw new Error(`"${row}" has too many environments`);
          for (const [env, path] of pairs) {
            const key = clean(env, 10).toUpperCase();
            const job = clean(path, 2000).replace(/^\/+|\/+$/g, '');
            if (!KEY_PATTERN.test(key)) throw new Error(`"${key}" is not an environment: one to ten letters or digits`);
            if (!job || job.split('/').some((part) => part === '..' || part === '.')) throw new Error(`"${job}" is not a job path`);
            cells[key] = job;
          }
          one.cells = cells;
        }
        overrides[row] = one;
      }
      next.rowOverrides = overrides;
    }
  }
  return next;
}

module.exports = { INACTIVE_FOLDER, families, familyOf, mergeSettings, inName, normal, vocabulary, orderOf, ENV_ORDER, WORDS, DEFAULT_SETTINGS };
