'use strict';

/**
 * The Jenkins tools a Claude session can call: what they are called, what they
 * take, and how what they take is checked.
 *
 * Shared by two processes that must agree and must not trust each other. The
 * relay Claude starts (`jenkins-mcp-stdio.js`) uses the descriptions and
 * schemas to answer `tools/list`. The app (`jenkins-mcp.js`) uses the same
 * definitions to check every call, because the relay is a process the model
 * can influence and this file is the contract, not the guard: nothing a relay
 * sends is believed until it has been through `validateArgs` on the app's side.
 *
 * No Electron, no network and no secrets in here: it is loaded by a plain
 * `node` the Claude CLI spawns.
 *
 * Names carry no `jenkins_` prefix. The server is called `jenkins`, so a
 * session sees `mcp__jenkins__builds` — a second `jenkins` in the middle of
 * that reads as a stutter, and the prefix is what the server name is for.
 */

/** A call that cannot be made: its message is for the model, in plain words. */
class ToolError extends Error {}

const BUILD_REFS = ['last', 'lastFailed', 'lastSuccessful'];

const prop = {
  server: { type: 'string', max: 100, optional: true, description: 'Which Jenkins, by the name or id `servers` gives. Left out, the only one connected is used.' },
  path: { type: 'path', description: 'The job, as the folders and name Jenkins shows, separated by `/`: `team/app/main`.' },
  build: {
    type: 'build',
    description: 'A build number, or `last`, `lastFailed` or `lastSuccessful`.',
  },
};

const TOOLS = [
  {
    name: 'servers',
    description:
      'The Jenkins servers Smart Terminal is connected to: a name, an id, the host and whether it is answering. ' +
      'Start here when you do not know which Jenkins the user means. Never shows credentials — you cannot see them and do not need them.',
    props: {},
  },
  {
    name: 'find_job',
    description:
      'Find jobs by part of a name or path — `payments`, `deploy prod`. Returns each match with its last build and whether it ' +
      'is passing. Use it when the user names a job loosely, or when you have a repository name and want its pipeline.',
    props: {
      query: { type: 'string', min: 1, max: 200, description: 'Words that appear in the job\'s path. All of them must.' },
      limit: { type: 'integer', min: 1, max: 25, optional: true, description: 'How many matches. 10 by default.' },
      server: prop.server,
    },
    required: ['query'],
  },
  {
    name: 'job_for_cwd',
    description:
      'Which Jenkins job might belong to the folder you are working in. Smart Terminal does not yet know which repository a job ' +
      'builds, so this only suggests jobs whose name matches the folder\'s — guesses, and says so. Check what it returns before relying on it.',
    props: {
      cwd: { type: 'string', min: 1, max: 1000, description: 'Your working directory. Only its last folder\'s name is used; nothing is read from disk.' },
      server: prop.server,
    },
    required: ['cwd'],
  },
  {
    name: 'builds',
    description:
      'The recent builds of one job, newest first: number, result, when and how long — and the parameters the job takes. ' +
      'Use it to see whether a failure is new (`#41` failed, `#40` passed), or has been red for a while.',
    props: {
      path: prop.path,
      n: { type: 'integer', min: 1, max: 30, optional: true, description: 'How many builds. 10 by default.' },
      server: prop.server,
    },
    required: ['path'],
  },
  {
    name: 'build',
    description:
      'One build in full: its result, what started it, the stages that ran and the ones that did not, the commits it picked up, ' +
      'its parameters (secrets are masked) and its artifacts. The first thing to read about a failure.',
    props: { path: prop.path, number: prop.build, server: prop.server },
    required: ['path', 'number'],
  },
  {
    name: 'stages',
    description:
      'How a pipeline\'s stages did across its recent runs: for each run, each stage\'s result and duration, with the usual duration ' +
      'of each stage. Use it to see which stage a failure belongs to, whether it fails every time, and which one got slower.',
    props: {
      path: prop.path,
      count: { type: 'integer', min: 1, max: 30, optional: true, description: 'How many runs. 10 by default.' },
      server: prop.server,
    },
    required: ['path'],
  },
  {
    name: 'failing_step_log',
    description:
      'The output of the step that failed — not the whole console, which is mostly noise. Returns the failing stage and step and the ' +
      'lines around where it broke. Use it right after `build` shows a failed stage, before reaching for `log`.',
    props: {
      path: prop.path,
      number: prop.build,
      max_lines: { type: 'integer', min: 10, max: 300, optional: true, description: 'How many lines at most. 120 by default.' },
      server: prop.server,
    },
    required: ['path', 'number'],
  },
  {
    name: 'log',
    description:
      'Part of a build\'s console, never all of it. Give `tail` for the last lines, `from_line`/`to_line` for a range, or `grep` ' +
      'for the lines that contain some text (with `context` lines either side). A long console comes back a window at a time: ' +
      'the answer says how many lines there are, so you can ask for the next one. Secrets are masked.',
    props: {
      path: prop.path,
      number: prop.build,
      tail: { type: 'integer', min: 1, max: 400, optional: true, description: 'The last N lines.' },
      from_line: { type: 'integer', min: 1, max: 100_000_000, optional: true, description: 'First line of a range, counting from 1.' },
      to_line: { type: 'integer', min: 1, max: 100_000_000, optional: true, description: 'Last line of the range. At most 400 lines after from_line.' },
      grep: { type: 'string', min: 1, max: 100, optional: true, description: 'Show lines containing this text, ignoring case. Plain text, not a pattern.' },
      context: { type: 'integer', min: 0, max: 10, optional: true, description: 'With grep: lines of context either side. 2 by default.' },
      server: prop.server,
    },
    required: ['path', 'number'],
  },
  {
    name: 'queue_why',
    description:
      'Why builds are waiting rather than running: what is in the queue and the reason Jenkins gives, and which agents are offline or ' +
      'full. Use it when the user says a build "does not start" or "is stuck". Give a job path to look at just that one.',
    props: {
      path: { type: 'path', optional: true, description: 'Only this job\'s waiting builds.' },
      server: prop.server,
    },
  },
  {
    name: 'seen_before',
    description:
      'Whether this same failure has happened before: when it first and last appeared, in which builds, how often, and what turned the ' +
      'job green again (and anything the user wrote down about that build). It compares the error itself, not the build number. Use it ' +
      'right after you know a build failed and before you start to investigate — a failure seen five times has a history worth reading. ' +
      'Only builds kept on this computer are compared.',
    props: { path: prop.path, number: prop.build, server: prop.server },
    required: ['path', 'number'],
  },
  {
    name: 'search_archive',
    description:
      'Search the consoles Smart Terminal has kept on this computer, to answer "has this error happened before?" — which jobs, which ' +
      'builds, when. Only finished builds that were kept can be found, so an empty answer is not proof it never happened.',
    props: {
      query: { type: 'string', min: 2, max: 200, description: 'The text to look for — an error message, a test name.' },
      limit: { type: 'integer', min: 1, max: 25, optional: true, description: 'How many matches. 10 by default.' },
      server: prop.server,
    },
    required: ['query'],
  },
  {
    name: 'dashboard_summary',
    description:
      'What is running right now and how the last day (or hour, week, month) went: builds running and queued, how many failed, the jobs ' +
      'that fail most, the slowest. Use it for "how is CI doing?" before looking at any one build.',
    props: {
      range: { type: 'enum', values: ['1h', '24h', '7d', '30d'], optional: true, description: '24h by default.' },
      server: prop.server,
    },
  },
  {
    name: 'request_run',
    description:
      'ASK for a job to be run. You cannot run it: this raises a question the user sees and answers, and the build starts only if they ' +
      'say yes. Say why in `reason` — they read it. Do not ask twice for the same job; if they decline, they decided. Jobs with ' +
      'secret parameters cannot be requested this way.',
    props: {
      path: prop.path,
      params: { type: 'strings', maxKeys: 30, maxKey: 100, maxValue: 300, optional: true, description: 'Parameter values, as text, by name.' },
      reason: { type: 'string', min: 3, max: 300, description: 'Why this build is worth running, in a sentence the user will read.' },
      server: prop.server,
    },
    required: ['path', 'reason'],
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** The JSON Schema a tool is advertised with, written from the same definition the app checks against. */
function inputSchema(tool) {
  const properties = {};
  for (const [name, def] of Object.entries(tool.props)) {
    const base = { description: def.description };
    if (def.type === 'string' || def.type === 'path') Object.assign(base, { type: 'string', ...(def.min ? { minLength: def.min } : {}), maxLength: def.type === 'path' ? 2000 : def.max });
    else if (def.type === 'integer') Object.assign(base, { type: 'integer', minimum: def.min, maximum: def.max });
    else if (def.type === 'enum') Object.assign(base, { type: 'string', enum: def.values });
    else if (def.type === 'build') Object.assign(base, { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: BUILD_REFS }] });
    else if (def.type === 'strings') Object.assign(base, { type: 'object', additionalProperties: { type: 'string', maxLength: def.maxValue }, maxProperties: def.maxKeys });
    properties[name] = base;
  }
  return { type: 'object', properties, ...(tool.required?.length ? { required: tool.required } : {}), additionalProperties: false };
}

/** What `tools/list` shows. */
const listing = (names) => TOOLS.filter((tool) => !names || names.includes(tool.name)).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: inputSchema(tool) }));

// --- checking what a call brings ------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
/** What `jenkins-redact` strips as invisible: a call may not carry what a reader could not see. Kept the same as that list. */
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u17B4\u17B5\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFC\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
const CONTROL = { test: (text) => CONTROL_CHARS.test(text) || INVISIBLE.test(text) };
const HIDDEN = 'a control character or an invisible one';

/** A job's path, as Jenkins writes it: segments separated by `/`, none of them a way out of its folder. */
function cleanPath(value, what) {
  if (typeof value !== 'string') throw new ToolError(`${what} has to be text`);
  const text = value.trim().replace(/^\/+|\/+$/g, '');
  if (!text) throw new ToolError(`${what} is missing`);
  if (text.length > 2000) throw new ToolError(`${what} is too long`);
  if (CONTROL.test(text)) throw new ToolError(`${what} has ${HIDDEN} in it, which no Jenkins job has`);
  if (text.includes('\\')) throw new ToolError(`${what} cannot contain a backslash: folders are separated by "/"`);
  for (const segment of text.split('/')) {
    if (!segment || segment === '.' || segment === '..') throw new ToolError(`${what} cannot contain empty, "." or ".." parts`);
  }
  return text;
}

/**
 * Check a call's arguments against the tool's definition and hand back a clean
 * copy: only declared names, each the right kind and size. Anything else — an
 * unknown name, a wrong type, a value too big — is refused with a sentence the
 * model can act on. Nothing is coerced beyond "12" → 12 for numbers: a model
 * that sends the wrong thing should be told, not guessed at.
 */
function validateArgs(tool, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ToolError('The arguments have to be an object');
  const given = Object.keys(args);
  for (const key of given) {
    if (!Object.hasOwn(tool.props, key)) throw new ToolError(`${tool.name} has no argument called "${String(key).slice(0, 40)}"`);
  }
  const clean = {};
  for (const [name, def] of Object.entries(tool.props)) {
    const value = args[name];
    if (value === undefined || value === null || value === '') {
      if (!def.optional && tool.required?.includes(name)) throw new ToolError(`${name} is missing`);
      continue;
    }
    if (def.type === 'path') clean[name] = cleanPath(value, name);
    else if (def.type === 'string') {
      if (typeof value !== 'string') throw new ToolError(`${name} has to be text`);
      const text = value.trim();
      if (text.length < (def.min ?? 1)) throw new ToolError(`${name} is too short`);
      if (text.length > def.max) throw new ToolError(`${name} is too long (at most ${def.max} characters)`);
      if (CONTROL.test(text)) throw new ToolError(`${name} has ${HIDDEN} in it`);
      clean[name] = text;
    } else if (def.type === 'integer' || def.type === 'build') {
      if (def.type === 'build' && typeof value === 'string' && BUILD_REFS.includes(value)) {
        clean[name] = value;
        continue;
      }
      const number = typeof value === 'string' && /^\d{1,12}$/.test(value.trim()) ? Number(value) : value;
      const min = def.min ?? 1;
      const max = def.max ?? 1_000_000_000;
      if (!Number.isInteger(number) || number < min || number > max) {
        throw new ToolError(def.type === 'build' ? `${name} has to be a build number, or one of ${BUILD_REFS.join(', ')}` : `${name} has to be a whole number from ${min} to ${max}`);
      }
      clean[name] = number;
    } else if (def.type === 'enum') {
      if (!def.values.includes(value)) throw new ToolError(`${name} has to be one of ${def.values.join(', ')}`);
      clean[name] = value;
    } else if (def.type === 'strings') {
      if (typeof value !== 'object' || Array.isArray(value)) throw new ToolError(`${name} has to be an object of text values`);
      const keys = Object.keys(value);
      if (keys.length > def.maxKeys) throw new ToolError(`${name} has too many entries (at most ${def.maxKeys})`);
      const out = {};
      for (const key of keys) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new ToolError(`${name} has a name that cannot be a parameter`);
        if (!key || key.length > def.maxKey || CONTROL.test(key)) throw new ToolError(`${name} has a parameter name that is empty, too long or has ${HIDDEN} in it`);
        const item = value[key];
        if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') throw new ToolError(`${name}.${key} has to be text`);
        const text = String(item);
        if (text.length > def.maxValue) throw new ToolError(`${name}.${key} is too long (at most ${def.maxValue} characters)`);
        if (CONTROL.test(text.replace(/[\n\t]/g, ''))) throw new ToolError(`${name}.${key} has ${HIDDEN} in it`);
        out[key] = text;
      }
      clean[name] = out;
    }
  }
  return clean;
}

module.exports = { TOOLS, BY_NAME, BUILD_REFS, ToolError, inputSchema, listing, validateArgs, cleanPath };
