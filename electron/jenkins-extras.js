'use strict';

const crypto = require('node:crypto');
const { JenkinsError, jobPath, stripNotes } = require('./jenkins-api');

// What is taken out of a console before it is indexed or shown to somebody who will pass it on: the same rules as the Claude tools'.
let redactor = null;
try { redactor = require('./jenkins-redact'); } catch { redactor = null; }

/**
 * What a person asks of a build once it has gone wrong — or never starts.
 *
 * Why did it fail (the step, not the console), has this happened before, why is
 * it not running, can I check a Jenkinsfile or replay one, and what did I write
 * down about it last time. Each is a verb on the Jenkins service; this file is
 * all of them, so that the service stays the one door and this stays one piece.
 *
 * Three decisions are worth stating rather than discovering.
 *
 * **Nothing here is read twice that cannot change.** A finished build's failing
 * step is read from Jenkins once and kept; asking again, or asking when Jenkins
 * has discarded the build or cannot be reached, answers from what was kept — and
 * from the archived console when even that is gone.
 *
 * **Search is honest about what it covers.** A console can be tens of megabytes
 * and a trigram index is several times the size of what it indexes, so what goes
 * in is each console's errors and its last 192 KB (a small console, all of it),
 * and the notes. Every hit says which, and the answer says how much is indexed.
 *
 * **What is guessed is shown with its evidence.** A failure's "signature" is the
 * first error line with the numbers, hashes, paths and times taken out; two
 * builds that share one are said to be the same failure, and both lines are
 * shown, because a heuristic that only says "seen 3 times" cannot be checked.
 *
 * Its own tables (`jx_*`) in the archive's file, with their own schema counter:
 * the archive is a file a person may delete, and everything here goes with it.
 */

/** The most of a step's output that is handed back: it is read by a person or a model, not archived. */
const STEP_LOG_MAX = 64 * 1024;
/** Per console, what is indexed: the end, and the lines that say what went wrong. */
const INDEX_TAIL = 192 * 1024;
const INDEX_ERRORS = 64 * 1024;
const INDEX_FULL_UP_TO = 256 * 1024;
const NOTE_MAX = 2000;
const NOTES_PER_SERVER = 3000;
const PRESETS_PER_JOB = 20;
const PRESET_VALUES = 100;
const SCRIPT_MAX = 512 * 1024;
const SIGNATURES_PER_SERVER = 20000;
const STEPS_PER_SERVER = 2000;
const SEARCH_MAX = 100;
const SEARCH_DEFAULT = 20;
/** How many index entries a search looks at before it says it stopped, and how many documents a scan reads. */
const CANDIDATES_MAX = 5000;
const SCAN_MAX = 600;
const BATCH = 100;
const SCAN_BATCH = 25;
/** How many hits are counted for "total", and how many are not worth counting past. */
const COUNT_MAX = 1000;
/** Index entries removed at a time: a 256 KB console is a few milliseconds of index, and the loop is let go between them. */
const PURGE_CHUNK = 4;
const NODE_DESCRIBES_MAX = 6;
const WHY_CACHE_MS = 3000;
const MAINTENANCE_MS = 20_000;
const INDEX_BATCH = 20;
const INDEX_BUDGET_MS = 150;

/** Words that make a parameter's name a secret's: the whole word, so that KEYSTORE_ALIAS and MONKEY are not. */
const SECRET_WORDS = new Set([
  'pass', 'password', 'passwd', 'passphrase', 'pwd', 'secret', 'secrets', 'token', 'tokens', 'key', 'keys', 'apikey', 'accesskey', 'privatekey',
  'credential', 'credentials', 'cred', 'creds', 'pat', 'auth', 'authorization', 'bearer', 'cert', 'certificate', 'private', 'jwt', 'cookie',
]);

function secretName(name) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => SECRET_WORDS.has(word));
}

/** A value that has the shape of a secret, whatever its parameter is called: a password in an address, a bearer token, a key's prefix. */
function secretValue(value) {
  const text = String(value);
  if (text.length < 8) return false;
  if (/:\/\/[^/@\s:]+:[^@\s]+@/.test(text)) return true;
  if (/\bBearer\s+\S{6,}/i.test(text) || /\bBasic\s+[A-Za-z0-9+/=]{8,}/.test(text)) return true;
  if (/\bgh[pousr]_[A-Za-z0-9]{20,}/.test(text) || /\bglpat-[\w-]{10,}/.test(text) || /\bxox[baprs]-[\w-]{10,}/.test(text)) return true;
  if (/\bAKIA[0-9A-Z]{12,}/.test(text) || /\bAIza[\w-]{20,}/.test(text) || /\bsk-[A-Za-z0-9]{20,}/.test(text) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
  // A long run of letters and digits, mixed, that is not a path or an address: a key. A commit's hash is only hex, and is kept.
  return /^[A-Za-z0-9+/=_-]{40,}$/.test(text) && /[A-Z]/.test(text) && /[a-z]/.test(text) && /\d/.test(text) && !/^\//.test(text);
}
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_KEEP_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS jx_doc (
     id INTEGER PRIMARY KEY,
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     number INTEGER NOT NULL,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     full INTEGER NOT NULL DEFAULT 0,
     status TEXT,
     at INTEGER NOT NULL
   );
   CREATE UNIQUE INDEX IF NOT EXISTS jx_doc_key ON jx_doc (server, path, number, kind);
   CREATE INDEX IF NOT EXISTS jx_doc_at ON jx_doc (at);
   CREATE TABLE IF NOT EXISTS jx_sig (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     number INTEGER NOT NULL,
     sig TEXT NOT NULL,
     text TEXT NOT NULL,
     normalized TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (server, path, number)
   );
   CREATE INDEX IF NOT EXISTS jx_sig_by_sig ON jx_sig (server, sig, at);
   CREATE TABLE IF NOT EXISTS jx_step (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     number INTEGER NOT NULL,
     json TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (server, path, number)
   );
   CREATE TABLE IF NOT EXISTS jx_note (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     number INTEGER NOT NULL,
     text TEXT NOT NULL,
     updated INTEGER NOT NULL,
     PRIMARY KEY (server, path, number)
   );
   CREATE TABLE IF NOT EXISTS jx_preset (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     name TEXT NOT NULL,
     vals TEXT NOT NULL,
     updated INTEGER NOT NULL,
     PRIMARY KEY (server, path, name)
   );
   CREATE TABLE IF NOT EXISTS jx_indexed (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     number INTEGER NOT NULL,
     log_at INTEGER,
     PRIMARY KEY (server, path, number)
   );`,
  // A document that was forgotten is hidden at once and taken out of the index afterwards, a little at a time.
  `ALTER TABLE jx_doc ADD COLUMN dead INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX IF NOT EXISTS jx_doc_dead ON jx_doc (id) WHERE dead = 1;`,
];

// --- arguments ---------------------------------------------------------------------

function needText(value, what, max = 500) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!text) throw new JenkinsError(`${what} is missing`);
  if (text.length > max) throw new JenkinsError(`${what} is too long`);
  return text;
}

/** A job's name has no control characters (Jenkins will not make one that has), and the database ends a string at a NUL. */
function needPath(value) {
  const path = needText(value, 'job', 2000);
  if (CONTROL.test(path)) throw new JenkinsError('job is not a name Jenkins could have');
  // Slashes alone name no job, and would put what follows them at the top of the server.
  if (!path.replace(/^\/+|\/+$/g, '')) throw new JenkinsError('job is missing');
  return path;
}

function needInt(value, what, min = 0, max = 2_000_000_000) {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) throw new JenkinsError(`${what} is missing`);
  return n;
}

function optInt(value, what, min, max) {
  if (value === undefined || value === null || value === '') return null;
  return needInt(value, what, min, max);
}

/** Text a person wrote: kept as written, minus the characters that are not text. */
function cleanNote(value, what, max) {
  if (typeof value !== 'string') throw new JenkinsError(`${what} is missing`);
  const text = value.replace(/\r\n?/g, '\n').replace(CONTROL_KEEP_TEXT, '').trim();
  if (!text) throw new JenkinsError(`${what} is missing`);
  if (text.length > max) throw new JenkinsError(`${what} is longer than ${max} characters`);
  return text;
}

// --- reading what Jenkins says ------------------------------------------------------

/** A reply's body as JSON; anything that is not is Jenkins saying something this app does not understand. */
function asJson(reply, what) {
  if (reply.tooBig) throw new JenkinsError(`Jenkins sent more than this app will read for ${what}`);
  try {
    return JSON.parse(reply.bytes.toString('utf8'));
  } catch {
    throw new JenkinsError(`Jenkins answered ${what} in a way this app does not understand`);
  }
}

const isGone = (error) => Boolean(error) && (error.status === 404 || /^Could not reach|did not answer|stopped answering|cut off/.test(String(error.message ?? '')));

/** A step's output as plain text: Jenkins' hidden annotations and carriage returns taken out. */
function plain(text) {
  return stripNotes(String(text ?? '')).replace(/\r\n/g, '\n');
}

/** The end of a text, cut at the start of a line, and whether anything was cut. */
function tailOf(text, max) {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(text.length - max);
  const at = cut.indexOf('\n');
  return { text: at >= 0 && at < max / 2 ? cut.slice(at + 1) : cut, truncated: true };
}

// --- what counts as an error line --------------------------------------------------

const ERROR_LINE = /\b(?:ERROR|FAILED|FAILURE|FATAL|Exception|Traceback|AssertionError|panic:|error:|fatal:|npm ERR!|BUILD FAILURE|Caused by|segmentation fault|OutOfMemory|permission denied|timed out|connection refused|No such file)\b|\b(?:errors?|failures?|failed)\s*[:=]\s*[1-9]\d*\b|\b[1-9]\d*\s+(?:errors?|failures?)\b/i;
/** A summary that says nothing went wrong, in the words a failure would use ("Tests: 0 failed", "no errors"). */
const BENIGN = [
  /\b0\s+(?:failed|failures?|errors?|failing|fatal)\b/i,
  /\b(?:failed|failures?|errors?|failing)\s*[:=]\s*0\b/i,
  /\bno\s+(?:errors?|failures?|failed)\b/i,
  /\b(?:without|zero)\s+(?:any\s+)?(?:errors?|failures?)\b/i,
];
const isErrorLine = (line) => ERROR_LINE.test(line) && !BENIGN.some((one) => one.test(line));
/** Lines that every failure has, and so say nothing about which one it was. */
const GENERIC_ERROR = [
  /^ERROR: script returned exit code \d+\s*$/,
  /^Finished: (?:FAILURE|ABORTED|UNSTABLE)\s*$/,
  /^\[Pipeline\]/,
  /^hudson\.AbortException: script returned exit code/,
  /^Build step '.*' marked build as failure/,
  /^Stage ".*" skipped/,
  /^Caused: /,
  /^\s+at\s/,
  /^Error when executing \w+ post condition/,
  /^ERROR: Build step failed with exception\s*$/,
  /^Failed in branch /,
  /^Sending interrupt signal/,
  // What a shell prints about the command it is running (`+ echo ERROR: …`): the command, not what it said.
  /^\+ /,
];

const isGeneric = (line) => GENERIC_ERROR.some((one) => one.test(line));

/**
 * The lines that say what went wrong: the first that is not what every failure says, and the line after it.
 * Bounded: only the first 20 000 lines are looked at, each cut at 600 characters.
 */
function errorLines(text, { count = 2 } = {}) {
  const lines = text.split('\n', 20_000);
  const strong = [];
  const weak = [];
  for (let i = 0; i < lines.length && strong.length < count; i += 1) {
    const line = lines[i].slice(0, 600).trimEnd();
    if (!line || !isErrorLine(line)) continue;
    if (isGeneric(line)) { if (weak.length < count) weak.push({ line, at: i }); continue; }
    strong.push({ line, at: i });
  }
  return strong.length ? strong : weak;
}

/** The window of a console around its first error: a few lines before, and what follows. */
function errorWindow(text, { before = 5, after = 25, fallback = 60 } = {}) {
  const lines = text.split('\n');
  const first = errorLines(text, { count: 1 })[0];
  if (!first) return { text: lines.slice(-fallback).join('\n'), found: false };
  return { text: lines.slice(Math.max(0, first.at - before), first.at + after + 1).join('\n'), found: true };
}

/** A source file's extension: what follows it after a colon is a line number, not a port. */
const SOURCE_FILE = /\.(?:java|kt|kts|groovy|scala|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|c|cc|cpp|h|hpp|cs|php|sh|xml|ya?ml|json|gradle|html|vue|swift)$/i;
/** Words after which a number is part of what happened ("exit code 3", "HTTP 502"), not something that varies. */
const MEANING_NUMBER = /(?:code|status|errno|http|returned|signal|exit|rc|retcode|error)\s*[:=#]?\s*$/i;
/** A port from the ephemeral range is chosen at random for each connection; a service's own is not. */
const EPHEMERAL_PORT = 10_000;

/**
 * A line with what varies from one build to the next taken out: timestamps,
 * ids, hashes, paths, process ids, line numbers, the random suffix of a pod,
 * durations and counts. What says which failure it was stays: the words, the
 * port of the service that refused, an exit code, an HTTP status. Two lines that
 * are the same failure normalise to the same text, and two that are not do not.
 * Every pattern is linear, and the line is cut before any of them sees it.
 */
function normalize(line) {
  return String(line)
    .slice(0, 1000)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\bpid\s*[:=#]?\s*\d+/gi, 'pid <n>')
    .replace(/\b[0-9a-f]{7,64}\b/gi, '<hex>')
    .replace(/(?:\/[\w.@+~-]+){2,}\/?/g, '<path>')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '<path>')
    // What Kubernetes adds to a pod's name: five characters, with a digit in them.
    .replace(/-(?=[a-z0-9]*\d)[a-z0-9]{5}\b/g, '-<id>')
    .replace(/:(\d{1,5})(?::\d{1,5})?\b/g, (all, port, at, whole) => {
      const before = whole.slice(Math.max(0, at - 14), at);
      if (before.endsWith('<path>') || SOURCE_FILE.test(before)) return ':<n>';
      return Number(port) >= EPHEMERAL_PORT ? ':<port>' : all;
    })
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|min|mins|h)\b/gi, '<dur>')
    // A number stays when it says what happened (an exit code, a status) or which service (the port after a colon).
    .replace(/\b\d+\b/g, (number, at, whole) => (whole[at - 1] === ':' || MEANING_NUMBER.test(whole.slice(Math.max(0, at - 16), at)) ? number : '#'))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/** The part of a console a signature is worked out from: the same whether it came from the archive or from Jenkins just now. */
const SIGNATURE_WINDOW = 400_000;

/**
 * `{ sig, text, normalized }` for the first error of a console, or null when it has none.
 * The key is the first line that says what went wrong and nothing else: a second
 * error line, a warning after it, a stack, none of those change which failure it was.
 */
function signatureOf(text) {
  const window = tailOf(String(text ?? ''), SIGNATURE_WINDOW).text;
  const first = errorLines(window, { count: 1 })[0];
  if (!first) return null;
  const normalized = normalize(first.line);
  if (!normalized) return null;
  return {
    sig: crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16),
    text: first.line.slice(0, 300),
    normalized,
  };
}

/** What of a console is worth an index: all of a small one; the end and the error lines of a large one. */
function extract(text) {
  if (text.length <= INDEX_FULL_UP_TO) return { text, full: true };
  const tail = tailOf(text, INDEX_TAIL).text;
  const head = text.slice(0, text.length - tail.length);
  const lines = head.split('\n', 200_000);
  const keep = new Set();
  let size = 0;
  for (let i = 0; i < lines.length && size < INDEX_ERRORS; i += 1) {
    if (!isErrorLine(lines[i].slice(0, 600))) continue;
    for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j += 1) {
      if (keep.has(j)) continue;
      keep.add(j);
      size += Math.min(lines[j].length, 600) + 1;
    }
  }
  const windows = [...keep].sort((a, b) => a - b).map((i) => lines[i].slice(0, 600)).join('\n');
  return { text: `${windows}\n…\n${tail}`, full: false };
}

// --- HTML, a little of it -----------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The entities a Jenkins form uses, decoded without evaluating anything. */
function decodeEntities(text) {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos|nbsp));/gi, (match, dec, hex, name) => {
    if (name) return ENTITIES[name.toLowerCase()];
    const code = dec ? Number(dec) : parseInt(hex, 16);
    // eslint-disable-next-line no-control-regex
    if (!Number.isInteger(code) || code > 0x10ffff || (code < 32 && ![9, 10, 13].includes(code)) || (code >= 0xd800 && code <= 0xdfff)) return '';
    return String.fromCodePoint(code);
  });
}

/** A tag longer than this is not a form field of Jenkins'. */
const TAG_MAX = 4000;

/**
 * The scripts in a replay form: `_.mainScript`, and one `_.<Name>` for each
 * script it loaded. One pass, each step looking only forward from where the
 * last ended, so that no page — however it is built — costs more than its length.
 */
function scriptsOf(html) {
  const found = [];
  let at = 0;
  while (found.length < 30) {
    const open = html.indexOf('<textarea', at);
    if (open < 0) break;
    const tagEnd = html.indexOf('>', open + 9);
    if (tagEnd < 0) break;
    at = tagEnd + 1;
    const after = html.charCodeAt(open + 9);
    // `<textareas` is not a textarea; a tag is a space, a newline, a slash or the end of it after its name.
    if (!(after === 32 || after === 10 || after === 9 || after === 13 || after === 47 || open + 9 === tagEnd)) continue;
    if (tagEnd - open > TAG_MAX) continue;
    const name = /\bname="_\.([^"]{1,200})"/.exec(html.slice(open, tagEnd));
    if (!name) continue;
    const end = html.indexOf('</textarea>', at);
    if (end < 0) break;
    found.push({ name: decodeEntities(name[1]), script: decodeEntities(html.slice(at, end)) });
    at = end + 11;
  }
  const main = found.find((one) => one.name === 'mainScript');
  return { main: main ? main.script : null, loaded: found.filter((one) => one !== main) };
}

// --- the queue's own words -----------------------------------------------------------

/**
 * One line of what a queue item says it is waiting for → a reason a person can
 * act on. The `why` is prose in the server's language; the recorded strings
 * are in `test/jenkins-extras.test.js`. Anything not recognised is `other`, with
 * the raw text kept in `detail`, because a wrong guess is worse than none.
 */
function reasonFrom(why, item = {}) {
  const text = String(why ?? '').trim();
  const quoted = (re) => { const m = re.exec(text); return m ? m[1] : null; };
  let m;
  if ((m = /^In the quiet period\. Expires in ([\d.]+) sec/i.exec(text))) {
    return { code: 'quiet-period', text: `It is in its quiet period and will start in about ${Math.ceil(Number(m[1]))} s.`, detail: text, seconds: Number(m[1]) };
  }
  if (/^Finished waiting/i.test(text)) return { code: 'finished-waiting', text: 'It has finished waiting and is about to be scheduled.', detail: text };
  if ((m = /^Build #(\d+) is already in progress(?: \(ETA: (.+)\))?/i.exec(text))) {
    return {
      code: 'concurrent-build',
      text: `Build #${m[1]} of this job is still running, and this job does not allow two builds at once.`,
      detail: text,
      fix: 'Wait for it to finish, or turn on "Execute concurrent builds if necessary" in the job.',
      ...(m[2] && m[2] !== 'N/A' ? { eta: m[2] } : {}),
    };
  }
  if ((m = /^Upstream project [‘'"]?(.+?)[’'"]? is already building/i.exec(text))) {
    return { code: 'blocked-by-upstream', text: `Its upstream job ${m[1]} is building, and this job waits for it.`, detail: text, fix: 'It starts when that build ends.' };
  }
  if ((m = /^Downstream project [‘'"]?(.+?)[’'"]? is already building/i.exec(text))) {
    return { code: 'blocked-by-downstream', text: `Its downstream job ${m[1]} is building, and this job waits for it.`, detail: text, fix: 'It starts when that build ends.' };
  }
  const label = quoted(/(?:doesn[’']t have label|no nodes with the label) [‘']([^’']+)[’']/i);
  if (label) {
    return {
      code: 'no-node-with-label',
      text: `No agent has the label ‘${label}’, so this can never start.`,
      detail: text,
      fix: 'Add that label to an agent, or change the label the job asks for.',
      label,
    };
  }
  const allOffline = quoted(/All nodes of label [‘']([^’']+)[’'] are offline/i);
  if (allOffline) {
    return { code: 'label-all-offline', text: `Every agent labelled ‘${allOffline}’ is offline.`, detail: text, fix: 'Bring one of them back online.', label: allOffline };
  }
  if ((m = /^[‘']?(.+?)[’']? is offline/i.exec(text)) && !/^Waiting/i.test(text)) {
    return { code: 'node-offline', text: `The agent ${m[1]} it needs is offline.`, detail: text, fix: 'Bring it back online.', node: m[1] };
  }
  if ((m = /^Waiting for next available executor(?: on [‘']?(.+?)[’']?)?\s*$/i.exec(text))) {
    if (m[1] && /\(offline\)\s*$/i.test(m[1])) {
      const node = m[1].replace(/\s*\(offline\)\s*$/i, '').replace(/[’']$/, '');
      return { code: 'node-offline', text: `The agent ${node} it needs is offline.`, detail: text, fix: 'Bring it back online.', node };
    }
    return m[1]
      ? { code: 'waiting-executor-on-node', text: `Every executor on ${m[1]} is busy; it starts when one is free.`, detail: text, node: m[1] }
      : { code: 'waiting-executor', text: 'Every executor is busy; it starts when one is free.', detail: text };
  }
  if (/throttl/i.test(text)) return { code: 'throttled', text: 'A throttling rule is holding it back.', detail: text };
  if (/shut ?down|quieting down|restart/i.test(text)) return { code: 'shutting-down', text: 'Jenkins is shutting down or restarting, so it starts nothing new.', detail: text };
  void item;
  return { code: 'other', text: text || 'It is waiting, and Jenkins does not say for what.', detail: text };
}

// --- the extras themselves -----------------------------------------------------------

class Extras {
  /**
   * @param {{
   *   archive: object | null,                          the console archive (its file is shared; its tables are not)
   *   on: (serverId: string) => { server: object, api: object },
   *   now?: () => number,
   *   openExternal?: ((url: string) => unknown) | null,
   *   isClosed?: () => boolean,
   * }} options
   */
  constructor({
    archive, on, now = Date.now, openExternal = null, isClosed = () => false, maintain = true,
    // `(text) => text`: applied to every console before it is indexed and to anything handed to a caller that asks for `redacted`.
    // `redactWhole`: the same, for a whole console before it is cut — a private key's BEGIN line may be far from the part that is kept.
    redact = redactor ? (text) => redactor.sanitize(text).text : null,
    redactWhole = redactor ? (text) => redactor.redactBlocks(text) : null,
  }) {
    this.archive = archive ?? null;
    this.db = archive?.db ?? null;
    this.on = on;
    this.now = now;
    this.openExternal = openExternal;
    this.isClosed = isClosed;
    this.fts = false;
    this.error = null;
    this.redact = redact;
    this.redactWhole = redactWhole;
    this.steps = new Map();
    this.why = new Map();
    this.snapshots = new Map();
    this.indexing = null;
    this.purging = null;
    this.draining = false;
    this.timer = null;
    if (this.db) {
      try {
        this.#migrate();
      } catch (error) {
        this.db = null;
        this.error = String(error?.message ?? error).split('\n')[0].slice(0, 200);
      }
    }
    if (this.db && maintain) {
      this.timer = setInterval(() => {
        if (this.isClosed()) { this.stop(); return; }
        void this.maintain().catch(() => { /* a nicety: it tries again next time */ });
      }, MAINTENANCE_MS);
      this.timer.unref?.();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS jx_schema (version INTEGER NOT NULL)');
    let row = this.db.prepare('SELECT version FROM jx_schema').get();
    if (!row) {
      this.db.prepare('INSERT INTO jx_schema (version) VALUES (0)').run();
      row = { version: 0 };
    }
    if (row.version > MIGRATIONS.length) throw new Error(`The extras tables are at version ${row.version}, newer than this build knows (${MIGRATIONS.length}). Update Smart Terminal.`);
    for (let version = row.version; version < MIGRATIONS.length; version += 1) {
      this.#tx(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.prepare('UPDATE jx_schema SET version = ?').run(version + 1);
      });
    }
    // Trigram search where this SQLite has it; a scan where it has not. Said in every answer.
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS jx_fts USING fts5(text, content='jx_doc', content_rowid='id', tokenize='trigram')");
      this.fts = true;
    } catch {
      this.fts = false;
    }
  }

  /** The archive's own transaction when there is one, so that the two never begin twice. */
  #tx(fn) {
    return this.archive?.transaction ? this.archive.transaction(fn) : (() => { this.db.exec('BEGIN'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; } })();
  }

  #need() {
    if (!this.db) throw new JenkinsError(`The local archive could not be opened${this.error ? `: ${this.error}` : ''}, so this cannot be kept`);
    return this.db;
  }

  // --- redaction ---------------------------------------------------------------------

  /** Text through the redactor. One that fails is a reason not to show the text, never to show it unmasked. */
  #mask(text) {
    if (!this.redact) return text;
    let out;
    try { out = this.redact(text); } catch { throw new JenkinsError('That could not be redacted, so it is not shown'); }
    if (typeof out !== 'string') throw new JenkinsError('That could not be redacted, so it is not shown');
    return out;
  }

  /** Every string in an answer through the redactor: what a caller that passes it on is given when it asks for `redacted`. */
  #maskDeep(value, depth = 0) {
    if (typeof value === 'string') return value.length > 20_000 ? this.#mask(value.slice(0, 20_000)) : this.#mask(value);
    if (depth > 8 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.slice(0, 500).map((one) => this.#maskDeep(one, depth + 1));
    const out = {};
    for (const [key, one] of Object.entries(value)) out[key] = this.#maskDeep(one, depth + 1);
    return out;
  }

  // --- documents: what search is made of -------------------------------------------

  /**
   * A document's key is when its build ran, times 1024 (and a few more for builds in the same millisecond), so that
   * the order of the keys is the order of the builds, and the index can be read newest first without being sorted.
   */
  #nextId(at) {
    const base = Math.max(0, Math.floor(Number(at) || this.now())) * 1024;
    const taken = this.db.prepare('SELECT 1 AS x FROM jx_doc WHERE id = ?');
    for (let i = 0; i < 1024; i += 1) if (!taken.get(base + i)) return base + i;
    return base + 1023;
  }

  #docPut(server, path, number, kind, text, { full = 0, status = null, at = this.now() } = {}) {
    this.#tx(() => {
      const old = this.db.prepare('SELECT id, text FROM jx_doc WHERE server = ? AND path = ? AND number = ? AND kind = ?').get(server, path, number, kind);
      if (old) {
        if (this.fts) this.db.prepare("INSERT INTO jx_fts (jx_fts, rowid, text) VALUES ('delete', ?, ?)").run(old.id, old.text);
        this.db.prepare('UPDATE jx_doc SET text = ?, full = ?, status = ?, at = ?, dead = 0 WHERE id = ?').run(text, full, status, at, old.id);
        if (this.fts) this.db.prepare('INSERT INTO jx_fts (rowid, text) VALUES (?, ?)').run(old.id, text);
      } else {
        const id = this.#nextId(at);
        this.db.prepare('INSERT INTO jx_doc (id, server, path, number, kind, text, full, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, server, path, number, kind, text, full, status, at);
        if (this.fts) this.db.prepare('INSERT INTO jx_fts (rowid, text) VALUES (?, ?)').run(id, text);
      }
    });
  }

  /**
   * Put a console in the index: its errors and its end, or all of it if it is small, through the redactor, so that
   * what is found and what is shown never holds what a console printed by mistake.
   */
  indexConsole(server, path, number, text, { status = null, at = this.now(), logAt = undefined } = {}) {
    this.#need();
    const cleaned = this.redactWhole ? this.redactWhole(plain(text)) : plain(text);
    const part = extract(cleaned);
    this.#docPut(server, path, number, 'log', this.#mask(part.text), { full: part.full ? 1 : 0, status, at });
    const row = logAt === undefined ? this.db.prepare('SELECT archived_at FROM jk_log WHERE server = ? AND path = ? AND number = ?').get(server, path, number) : { archived_at: logAt };
    this.db.prepare('INSERT OR REPLACE INTO jx_indexed (server, path, number, log_at) VALUES (?, ?, ?, ?)').run(server, path, number, row?.archived_at ?? null);
    return cleaned;
  }

  /** Hide documents at once. They are taken out of the index in the background (`purge`), because that is the slow part. */
  #docKill(where, params) {
    const changed = this.db.prepare(`UPDATE jx_doc SET dead = 1 WHERE dead = 0 AND ${where}`).run(...params).changes;
    if (changed) this.#drain();
    return changed;
  }

  /**
   * Take hidden documents out of the index: a few, then let go of the loop, until there are none or the time is up.
   * The index is told what to forget by SQL, from the rows themselves — the text of a console is never read into
   * this process to be forgotten.
   */
  async purge({ budgetMs = 100, chunk = PURGE_CHUNK } = {}) {
    if (!this.db) return 0;
    while (this.purging) await this.purging.catch(() => {});
    this.purging = (async () => {
      const began = Date.now();
      let removed = 0;
      for (;;) {
        const ids = this.db.prepare('SELECT id FROM jx_doc WHERE dead = 1 LIMIT ?').all(chunk).map((row) => row.id);
        if (!ids.length) break;
        const marks = ids.map(() => '?').join(',');
        this.#tx(() => {
          if (this.fts) this.db.prepare(`INSERT INTO jx_fts (jx_fts, rowid, text) SELECT 'delete', id, text FROM jx_doc WHERE id IN (${marks})`).run(...ids);
          this.db.prepare(`DELETE FROM jx_doc WHERE id IN (${marks})`).run(...ids);
        });
        removed += ids.length;
        if (Date.now() - began > budgetMs || this.isClosed()) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      return removed;
    })().finally(() => { this.purging = null; });
    return this.purging;
  }

  /** Purge in the background until nothing is left to purge. */
  #drain() {
    if (this.draining) return;
    this.draining = true;
    setImmediate(async () => {
      try {
        while (!this.isClosed()) {
          if (!(await this.purge({ budgetMs: 40 }))) break;
          await new Promise((resolve) => setImmediate(resolve));
        }
      } catch { /* the next maintenance does it */ } finally { this.draining = false; }
    });
  }

  // --- indexing --------------------------------------------------------------------

  /** How much of the archive is indexed: consoles with an index entry, of the consoles kept whole. */
  #coverage(server) {
    const filter = server ? ' AND l.server = ?' : '';
    const args = server ? [server] : [];
    const of = this.db.prepare(`SELECT count(*) AS n FROM jk_log l WHERE l.complete = 1${filter}`).get(...args).n;
    const done = this.db.prepare(`SELECT count(*) AS n FROM jk_log l JOIN jx_indexed i ON i.server = l.server AND i.path = l.path AND i.number = l.number AND i.log_at IS l.archived_at WHERE l.complete = 1${filter}`).get(...args).n;
    return { builds: done, of, pending: Math.max(0, of - done) };
  }

  /** Index the consoles that are kept and not yet indexed, a few, for a little while. Resolves with how many. */
  async indexSome({ budgetMs = INDEX_BUDGET_MS, max = INDEX_BATCH, server = null } = {}) {
    if (!this.db || !this.archive) return 0;
    if (this.indexing) return this.indexing;
    this.indexing = (async () => {
      const began = Date.now();
      let n = 0;
      const filter = server ? ' AND l.server = ?' : '';
      const rows = this.db.prepare(
        `SELECT l.server, l.path, l.number, l.archived_at AS log_at, b.status, b.timestamp
           FROM jk_log l JOIN jk_build b ON b.server = l.server AND b.path = l.path AND b.number = l.number
           LEFT JOIN jx_indexed i ON i.server = l.server AND i.path = l.path AND i.number = l.number
          WHERE l.complete = 1 AND (i.number IS NULL OR i.log_at IS NOT l.archived_at)${filter}
          ORDER BY b.timestamp DESC LIMIT ?`,
      ).all(...(server ? [server] : []), max);
      for (const row of rows) {
        if (Date.now() - began > budgetMs || this.isClosed()) break;
        let log = null;
        try { log = await this.archive.readLog(row.server, row.path, row.number); } catch { log = null; }
        // Read, or unreadable, or one that cannot be redacted: either way it is looked at once, not every time.
        if (log && log.text) {
          try {
            const at = row.timestamp ?? this.now();
            const whole = this.indexConsole(row.server, row.path, row.number, log.text, { status: row.status, at, logAt: row.log_at });
            if (row.status === 'failed' || row.status === 'unstable') {
              const sig = this.#signature(whole);
              if (sig) this.#sigPut(row.server, row.path, row.number, sig, at);
            }
          } catch { /* not indexed; marked below */ }
        }
        this.db.prepare('INSERT OR REPLACE INTO jx_indexed (server, path, number, log_at) VALUES (?, ?, ?, ?)').run(row.server, row.path, row.number, row.log_at);
        n += 1;
        // Let go of the loop between consoles: each is a few milliseconds, and a person is typing.
        await new Promise((resolve) => setImmediate(resolve));
      }
      return n;
    })().finally(() => { this.indexing = null; });
    return this.indexing;
  }

  /**
   * A console's signature, always from the same part of it and always from redacted text, so that a build has one
   * whether it was worked out from the archive or from what Jenkins just sent, and no secret is kept as evidence.
   */
  /** A whole console through the redactor that sees whole consoles (private keys), if there is one. */
  #whole(text) {
    return this.redactWhole ? this.redactWhole(text) : text;
  }

  #signature(text) {
    const window = tailOf(text, SIGNATURE_WINDOW).text;
    let masked;
    try { masked = this.#mask(window); } catch { return null; }
    return signatureOf(masked);
  }

  #sigPut(server, path, number, sig, at) {
    this.db.prepare('INSERT OR REPLACE INTO jx_sig (server, path, number, sig, text, normalized, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(server, path, number, sig.sig, sig.text, sig.normalized, at);
  }

  /** Housekeeping: index a few more, hide the index of consoles that are gone, keep the small tables small. */
  async maintain() {
    if (!this.db) return;
    await this.indexSome({ max: 40 });
    // An evicted console takes its index entry with it, all of them at once; its notes, signature and failing step stay.
    this.#docKill("kind = 'log' AND NOT EXISTS (SELECT 1 FROM jk_log l WHERE l.server = jx_doc.server AND l.path = jx_doc.path AND l.number = jx_doc.number)", []);
    await this.purge({ budgetMs: 100 });
    for (const [table, cap] of [['jx_sig', SIGNATURES_PER_SERVER], ['jx_step', STEPS_PER_SERVER]]) {
      const servers = this.db.prepare(`SELECT server, count(*) AS n FROM ${table} GROUP BY server HAVING n > ?`).all(cap);
      for (const one of servers) {
        this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE server = ? ORDER BY at ASC LIMIT ?)`).run(one.server, one.n - cap);
      }
    }
  }

  /** What `forget` forgets: a build's, a job's, or a server's — notes, signatures, failing steps, the index. */
  forget(server, { path = null, number = null } = {}) {
    if (!this.db) return;
    const scope = path !== null && number !== null ? [' AND path = ? AND number = ?', [path, number]] : path !== null ? [' AND path = ?', [path]] : ['', []];
    this.#docKill(`server = ?${scope[0]}`, [server, ...scope[1]]);
    for (const table of ['jx_sig', 'jx_step', 'jx_note', 'jx_indexed']) this.db.prepare(`DELETE FROM ${table} WHERE server = ?${scope[0]}`).run(server, ...scope[1]);
    if (path === null) this.db.prepare('DELETE FROM jx_preset WHERE server = ?').run(server);
    else if (number === null) this.db.prepare('DELETE FROM jx_preset WHERE server = ? AND path = ?').run(server, path);
    this.steps.clear();
    this.why.clear();
  }

  // --- the verbs ---------------------------------------------------------------------

  verbs() {
    const serverOf = (args) => this.on(needText(args.server, 'server', 100));
    const buildOf = (args) => ({ ...serverOf(args), path: needPath(args.path), number: needInt(args.number, 'build number', 1) });
    // A caller that will pass the answer on to somebody else (a model, a message) asks for `redacted`, and gets every string of it masked.
    const view = (args, value) => (args && args.redacted === true ? this.#maskDeep(value) : value);
    return {
      failingStep: async (args) => view(args, await this.#failingStep(buildOf(args))),
      whyNotRunning: async (args) => this.#whyNotRunning({ ...serverOf(args), path: needPath(args.path) }),
      lint: async (args) => this.#lint({ ...serverOf(args), text: args.text }),
      replayScript: async (args) => this.#replayScript(buildOf(args)),
      searchArchive: async (args) => this.#search(args),
      seenBefore: async (args) => view(args, await this.#seenBefore(buildOf(args))),
      notes: async (args) => view(args, this.#notes({ ...serverOf(args), path: needPath(args.path), number: optInt(args.number, 'build number', 0) })),
      link: async (args) => ({ url: this.#url(serverOf(args), args) }),
      presets: async (args) => this.#presets({ ...serverOf(args), path: needPath(args.path) }),

      replay: async (args) => this.#replay({ ...buildOf(args), script: args.script, loaded: args.loadedScripts }),
      restartFromStage: async (args) => this.#restart({ ...buildOf(args), stage: needText(args.stage, 'stage', 300) }),
      noteSet: async (args) => this.#noteSet({ ...serverOf(args), path: needPath(args.path), number: optInt(args.number, 'build number', 0) ?? 0, text: args.text }),
      noteDelete: async (args) => this.#noteDelete({ ...serverOf(args), path: needPath(args.path), number: optInt(args.number, 'build number', 0) ?? 0 }),
      openInBrowser: async (args) => this.#open(serverOf(args), args),
      presetSave: async (args) => this.#presetSave({ ...serverOf(args), path: needPath(args.path), name: args.name, values: args.values }),
      presetDelete: async (args) => this.#presetDelete({ ...serverOf(args), path: needPath(args.path), name: needText(args.name, 'name', 100) }),
    };
  }

  // --- failingStep -------------------------------------------------------------------

  /** The failing step of a build, for what is built on top of the verb (the briefing Claude is handed). */
  async step(serverId, path, number, { redacted = false } = {}) {
    const found = await this.#failingStep({ ...this.on(serverId), path: needPath(path), number: needInt(number, 'build number', 1) });
    return redacted ? this.#maskDeep(found) : found;
  }

  async #failingStep({ server, api, path, number }) {
    const key = `${server.id}\n${path}\n${number}`;
    // The same question asked twice at once is one question.
    const held = this.steps.get(key);
    if (held) return held;
    const work = this.#failingStepWork({ server, api, path, number }).finally(() => this.steps.delete(key));
    this.steps.set(key, work);
    return work;
  }

  async #failingStepWork({ server, api, path, number }) {
    const kept = this.db ? this.db.prepare('SELECT json FROM jx_step WHERE server = ? AND path = ? AND number = ?').get(server.id, path, number) : null;
    if (kept) {
      try { return { ...JSON.parse(kept.json), source: 'local' }; } catch { /* unreadable: read it again */ }
    }
    let result;
    try {
      result = await this.#stepsFromJenkins(api, path, number);
    } catch (error) {
      if (!isGone(error)) throw error;
      const local = await this.#stepsFromArchive(server.id, path, number);
      if (local) return local;
      throw error;
    }
    // A build that finished does not change: what was found is kept, and is the answer from now on.
    if (this.db && result.finished && result.found) {
      const { finished, ...body } = result;
      this.db.prepare('INSERT OR REPLACE INTO jx_step (server, path, number, json, at) VALUES (?, ?, ?, ?, ?)').run(server.id, path, number, JSON.stringify({ ...body, source: undefined }), this.now());
    }
    const { finished, ...out } = result;
    void finished;
    return out;
  }

  /** The failing stage and step, read from the Pipeline step graph; the console's first error when there is none. */
  async #stepsFromJenkins(api, path, number) {
    const base = `${jobPath(path)}/${number}`;
    let describe = null;
    try {
      describe = asJson(await api.rawGet(`${base}/wfapi/describe`), 'the stages');
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (!describe || !Array.isArray(describe.stages)) return this.#stepsFromConsole(api, path, number, base);

    const status = lower(describe.status);
    if (status === 'success') return { found: false, reason: 'passed', status, source: 'jenkins', finished: true };
    const running = status === 'in_progress' || status === 'paused_pending_input';
    const stages = describe.stages
      .map((one) => ({ id: String(one.id), name: String(one.name ?? ''), status: lower(one.status), start: Number(one.startTimeMillis) || 0, error: one.error ?? null }))
      .sort((a, b) => a.start - b.start || Number(a.id) - Number(b.id));
    const candidates = stages.filter((one) => ['failed', 'unstable', 'aborted'].includes(one.status) || /^Declarative: Post/i.test(one.name));
    const failures = [];
    let looked = 0;
    for (const stage of candidates) {
      if (looked >= NODE_DESCRIBES_MAX) break;
      looked += 1;
      let nodes;
      try {
        nodes = asJson(await api.rawGet(`${base}/execution/node/${encodeURIComponent(stage.id)}/wfapi/describe`), 'a stage').stageFlowNodes ?? [];
      } catch (error) {
        if (error.status === 404) continue;
        throw error;
      }
      const bad = failingNodes(nodes);
      // A stage that Jenkins reports as failed and whose steps all passed is one that never ran: it carries the error of the stage before.
      if (!bad.length) continue;
      for (const node of bad) failures.push({ stage, node });
    }
    if (!failures.length) {
      if (running) return { found: false, reason: 'running', status, source: 'jenkins', finished: false };
      // Pipeline, but nothing in its steps says what went wrong: the console does.
      const viaConsole = await this.#stepsFromConsole(api, path, number, base, { status });
      const failedStage = stages.find((one) => one.status === 'failed');
      return failedStage ? { ...viaConsole, stage: { name: failedStage.name, id: failedStage.id } } : viaConsole;
    }
    const first = failures[0];
    // Jenkins hands back the end of a step's output (the last 10 KB) and says whether there was more before it.
    let stepLog = { text: '', more: false };
    try {
      const body = asJson(await api.rawGet(`${base}/execution/node/${encodeURIComponent(first.node.id)}/wfapi/log`), 'a step');
      stepLog = { text: plain(body.text), more: Boolean(body.hasMore) };
    } catch { /* the step is still known, without its output */ }
    const cut = tailOf(stepLog.text, STEP_LOG_MAX);
    let restartable = null;
    if (!running) {
      try {
        const actions = asJson(await api.rawGet(`${base}/api/json?tree=actions[restartEnabled,restartableStages]`), 'the build').actions ?? [];
        const one = actions.find((a) => a && Array.isArray(a.restartableStages));
        restartable = one && one.restartEnabled !== false ? one.restartableStages.map(String).slice(0, 50) : null;
      } catch { restartable = null; }
    }
    return {
      found: true,
      via: 'steps',
      source: 'jenkins',
      status,
      stage: { name: first.stage.name, id: first.stage.id },
      step: { name: String(first.node.name ?? ''), description: String(first.node.parameterDescription ?? '') },
      error: String(first.node.error?.message ?? first.stage.error?.message ?? ''),
      log: { text: cut.text, truncated: cut.truncated || stepLog.more, bytes: cut.text.length },
      others: failures.slice(1, 8).map((one) => ({ stage: one.stage.name, step: String(one.node.name ?? ''), description: String(one.node.parameterDescription ?? ''), error: String(one.node.error?.message ?? '') })),
      restartable,
      finished: !running,
    };
  }

  /** Freestyle jobs, or anything without a step graph: the first error of the console, and a window around it. */
  async #stepsFromConsole(api, path, number, base, { status = null } = {}) {
    let st = status;
    let finished = true;
    if (!st) {
      const info = asJson(await api.rawGet(`${base}/api/json?tree=building,result`), 'the build');
      finished = !info.building;
      st = info.building ? 'running' : fromResult(info.result);
      if (info.building) return { found: false, reason: 'running', status: 'running', source: 'jenkins', finished: false };
      if (st === 'success') return { found: false, reason: 'passed', status: st, source: 'jenkins', finished: true };
    }
    const tail = await api.tail(path, number, 400_000);
    const window = errorWindow(tail.text);
    const cut = tailOf(window.text, STEP_LOG_MAX);
    if (!window.found) return { found: false, reason: 'no-error-found', status: st, source: 'jenkins', finished, via: 'console', stage: null, step: null, log: { text: cut.text, truncated: tail.truncated, bytes: cut.text.length } };
    const first = errorLines(tail.text, { count: 1 })[0];
    return {
      found: true, via: 'console', source: 'jenkins', status: st, stage: null, step: null,
      error: first ? first.line.slice(0, 300) : '',
      log: { text: cut.text, truncated: cut.truncated || tail.truncated, bytes: cut.text.length },
      others: [], restartable: null, finished,
    };
  }

  /** When Jenkins has discarded the build or cannot be reached: what the archive kept of it. */
  async #stepsFromArchive(serverId, path, number) {
    if (!this.archive) return null;
    const build = this.archive.build(serverId, path, number);
    if (!build) return null;
    if (build.status === 'success') return { found: false, reason: 'passed', status: 'success', source: 'local' };
    const stage = (build.stages ?? []).find((one) => one.status === 'failed' && one.executed !== false) ?? null;
    const log = await this.archive.readLog(serverId, path, number).catch(() => null);
    if (!log || !log.text) {
      return { found: Boolean(stage), via: 'console', source: 'local', status: build.status, stage: stage ? { name: stage.name } : null, step: null, error: '', log: { text: '', truncated: false, bytes: 0 }, others: [], restartable: null, ...(stage ? {} : { reason: 'no-error-found' }) };
    }
    const window = errorWindow(plain(log.text));
    const cut = tailOf(window.text, STEP_LOG_MAX);
    const first = errorLines(plain(log.text), { count: 1 })[0];
    return {
      found: window.found || Boolean(stage), via: 'console', source: 'local', status: build.status,
      stage: stage ? { name: stage.name } : null, step: null, error: first ? first.line.slice(0, 300) : '',
      log: { text: cut.text, truncated: cut.truncated, bytes: cut.text.length }, others: [], restartable: null,
    };
  }

  // --- why it does not run -------------------------------------------------------------

  async #whyNotRunning({ server, api, path }) {
    const key = `${server.id}\n${path}`;
    const hit = this.why.get(key);
    if (hit && Math.abs(this.now() - hit.at) < WHY_CACHE_MS) return hit.value;
    const base = jobPath(path);
    const [job, { queue, computers }] = await Promise.all([
      api.rawGet(`${base}/api/json?tree=_class,buildable,inQueue,concurrentBuild,color,lastBuild[number,building,timestamp,estimatedDuration],queueItem[id,why,blocked,stuck,buildable,inQueueSince]`).then((r) => asJson(r, 'the job')),
      this.#snapshot(server.id, api),
    ]);
    const agents = (computers.computer ?? []).slice(0, 60).map((one) => agentOf(one));
    const mine = (queue.items ?? []).filter((item) => queuedFor(item, base));
    const item = job.queueItem ?? mine[0] ?? null;
    const reasons = [];
    const disabled = job.buildable === false && /^disabled$/.test(String(job.color ?? ''));
    const running = job.lastBuild && job.lastBuild.building ? { number: job.lastBuild.number, startedAt: job.lastBuild.timestamp ?? null } : null;
    let state = running ? 'running' : 'idle';
    let waitSeconds = null;
    if (disabled) {
      state = 'disabled';
      reasons.push({ code: 'disabled', text: 'The job is disabled, so nothing starts it.', detail: 'disabled', fix: 'Enable it in Jenkins.' });
    }
    if (item) {
      state = 'queued';
      const why = String(item.why ?? '');
      const reason = reasonFrom(why, item);
      reasons.push(reason);
      if (reason.code === 'label-all-offline' || reason.code === 'no-node-with-label' || reason.code === 'node-offline') {
        const offline = agents.filter((one) => one.offline && (!reason.label || one.labels.includes(reason.label)) && (!reason.node || one.name === reason.node));
        for (const one of offline.slice(0, 3)) reasons.push({ code: 'node-offline', text: `${one.name} is offline${one.reason ? `: ${one.reason}` : ''}.`, detail: one.reason, fix: 'Bring it back online.', node: one.name });
      }
      if (reason.code === 'waiting-executor' || reason.code === 'waiting-executor-on-node') {
        const eta = soonestFree(computers.computer ?? [], this.now());
        if (eta !== null) waitSeconds = eta;
      }
      if (reason.code === 'quiet-period') waitSeconds = Math.ceil(reason.seconds);
      if (item.stuck) reasons.push({ code: 'stuck', text: 'Jenkins considers it stuck: nothing is available to take it.', detail: why, fix: 'Check the agents below.' });
    }
    for (const one of agents) {
      if (one.diskLow) reasons.push({ code: 'disk-low', text: `${one.name} is low on disk (${one.diskFreeMB} MB free), which can take it offline.`, detail: String(one.diskFreeMB), node: one.name, fix: 'Free some disk on that agent.' });
    }
    const out = {
      state,
      reasons,
      queueItem: item ? { id: item.id, since: item.inQueueSince ?? null, why: String(item.why ?? ''), stuck: Boolean(item.stuck), blocked: Boolean(item.blocked) } : null,
      agents: agents.slice(0, 20),
      running,
      waitSeconds,
      advice: adviceFor(state, reasons, waitSeconds),
    };
    this.why.set(key, { at: this.now(), value: out });
    if (this.why.size > 200) this.why.delete(this.why.keys().next().value);
    return out;
  }

  /**
   * The queue and the agents, asked of Jenkins once for every job asked about within a few seconds: they are the
   * same for every job, and a screen of twenty jobs is not forty requests.
   */
  #snapshot(serverId, api) {
    const held = this.snapshots.get(serverId);
    if (held && Math.abs(this.now() - held.at) < WHY_CACHE_MS) return held.promise;
    const promise = Promise.all([
      api.rawGet('/queue/api/json?tree=items[id,why,blocked,stuck,buildable,inQueueSince,task[name,fullName,url]]').then((r) => asJson(r, 'the queue')).catch(() => ({ items: [] })),
      api.rawGet('/computer/api/json?tree=computer[displayName,offline,temporarilyOffline,offlineCauseReason,numExecutors,idle,assignedLabels[name],executors[currentExecutable[url,timestamp,estimatedDuration]],oneOffExecutors[currentExecutable[url]],monitorData[*]]').then((r) => asJson(r, 'the agents')).catch(() => ({ computer: [] })),
    ]).then(([queue, computers]) => ({ queue, computers }));
    this.snapshots.set(serverId, { at: this.now(), promise });
    if (this.snapshots.size > 50) this.snapshots.delete(this.snapshots.keys().next().value);
    return promise;
  }

  // --- Jenkinsfile: lint, replay, restart -----------------------------------------------

  async #lint({ server, api, text }) {
    void server;
    if (typeof text !== 'string' || !text.trim()) throw new JenkinsError('There is no Jenkinsfile to check');
    if (text.length > SCRIPT_MAX) throw new JenkinsError('That Jenkinsfile is too big to check');
    if (text.includes('\u0000')) throw new JenkinsError('That is not a text file');
    // Only Declarative Pipeline can be checked; saying so beats a message about a missing `pipeline` step.
    if (!hasPipelineBlock(stripComments(text))) return { available: true, valid: null, reason: 'scripted', errors: [] };
    let reply;
    try {
      reply = await api.rawPost('/pipeline-model-converter/validate', `jenkinsfile=${encodeURIComponent(text)}`, { read: 'bytes', max: 256 * 1024 });
    } catch (error) {
      if (error.status === 404) return { available: false, valid: null, errors: [] };
      throw error;
    }
    const answer = reply.bytes.toString('utf8');
    if (/successfully validated/i.test(answer)) return { available: true, valid: true, errors: [] };
    const errors = validatorErrors(answer);
    if (!errors.length && /did not contain the 'pipeline' step/i.test(answer)) return { available: true, valid: null, reason: 'scripted', errors: [] };
    if (!errors.length) errors.push({ line: null, column: null, message: answer.slice(0, 2000).replace(/\s+/g, ' ').trim().slice(0, 300) || 'Jenkins did not accept it, and did not say why' });
    return { available: true, valid: false, errors };
  }

  async #replayForm({ api, path, number }) {
    const base = `${jobPath(path)}/${number}`;
    let reply;
    try {
      reply = await api.rawGet(`${base}/replay/`, { max: 2 * 1024 * 1024, accept: 'text/html' });
    } catch (error) {
      if (error.status === 404) throw new JenkinsError('That build cannot be replayed (it is not a Pipeline, or the replay form is not there)');
      if (error.status === 403) throw new JenkinsError('Jenkins does not let this user replay builds (it needs the Replay permission)');
      throw error;
    }
    if (reply.tooBig) throw new JenkinsError('The replay form is bigger than this app will read');
    const found = scriptsOf(reply.bytes.toString('utf8'));
    if (found.main === null) throw new JenkinsError('Jenkins did not show a script to replay for that build');
    return { base, ...found };
  }

  async #replayScript({ api, path, number }) {
    const form = await this.#replayForm({ api, path, number });
    const cut = form.main.length > SCRIPT_MAX;
    return {
      script: cut ? form.main.slice(0, SCRIPT_MAX) : form.main,
      loadedScripts: form.loaded.map((one) => ({ name: one.name, script: one.script.slice(0, SCRIPT_MAX) })),
      truncated: cut,
    };
  }

  async #replay({ server, api, path, number, script, loaded }) {
    void server;
    if (typeof script !== 'string' || !script.trim()) throw new JenkinsError('There is no script to replay');
    if (script.length > SCRIPT_MAX) throw new JenkinsError('That script is too big to replay');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(script)) throw new JenkinsError('That is not a text script');
    const form = await this.#replayForm({ api, path, number });
    // The scripts the build loaded go back as they were, unless the caller changed one.
    const scripts = { mainScript: script };
    const changed = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
    for (const one of form.loaded) {
      const mine = Object.hasOwn(changed, one.name) && typeof changed[one.name] === 'string' ? changed[one.name] : one.script;
      if (mine.length > SCRIPT_MAX) throw new JenkinsError('A loaded script is too big to replay');
      scripts[one.name] = mine;
    }
    const expected = await this.#nextNumber(api, path);
    try {
      await api.rawPost(`${form.base}/replay/run`, `json=${encodeURIComponent(JSON.stringify(scripts))}&mainScript=${encodeURIComponent(script)}`);
    } catch (error) {
      if (error.status === 403) throw new JenkinsError('Jenkins does not let this user replay builds (it needs the Replay permission)');
      if (error.status === 400) throw new JenkinsError('Jenkins did not accept that replay');
      throw error;
    }
    return { ok: true, expectedNumber: expected, hint: 'A new build was started with that script. It runs with whatever access the job has.' };
  }

  async #restart({ server, api, path, number, stage }) {
    void server;
    const base = `${jobPath(path)}/${number}`;
    let actions;
    try {
      actions = asJson(await api.rawGet(`${base}/api/json?tree=actions[restartEnabled,restartableStages]`), 'the build').actions ?? [];
    } catch (error) {
      if (error.status === 404) throw new JenkinsError('Jenkins has no such build');
      throw error;
    }
    const action = actions.find((a) => a && Array.isArray(a.restartableStages));
    if (!action || action.restartEnabled === false) throw new JenkinsError('That build cannot be restarted from a stage (it has to be a finished Declarative Pipeline)');
    const names = action.restartableStages.map(String);
    if (!names.includes(stage)) throw new JenkinsError(`Jenkins can restart that build from ${names.length ? names.map((n) => `"${n}"`).join(', ') : 'no stage'}, not from "${stage}"`);
    const expected = await this.#nextNumber(api, path);
    try {
      await api.rawPost(`${base}/restart/restart`, `json=${encodeURIComponent(JSON.stringify({ stageName: stage }))}&stageName=${encodeURIComponent(stage)}`);
    } catch (error) {
      if (error.status === 403) throw new JenkinsError('Jenkins does not let this user restart builds');
      if (error.status === 400) throw new JenkinsError('Jenkins did not accept that restart');
      throw error;
    }
    return { ok: true, expectedNumber: expected, hint: `A new build was started from stage "${stage}".` };
  }

  async #nextNumber(api, path) {
    try {
      const body = asJson(await api.rawGet(`${jobPath(path)}/api/json?tree=nextBuildNumber`), 'the job');
      return Number.isInteger(body.nextBuildNumber) ? body.nextBuildNumber : null;
    } catch {
      return null;
    }
  }

  // --- search and "seen before" ------------------------------------------------------------

  async #search(args) {
    const db = this.#need();
    const q = typeof args.q === 'string' ? args.q.replace(CONTROL_KEEP_TEXT, ' ').trim() : '';
    if (q.length < 2) throw new JenkinsError('Type at least two characters to search for');
    if (q.length > 200) throw new JenkinsError('That search is too long');
    const server = args.server === undefined || args.server === null || args.server === '' ? null : needText(args.server, 'server', 100);
    if (server) this.on(server);
    const path = args.path === undefined || args.path === null || args.path === '' ? null : needPath(args.path);
    const limit = Math.min(SEARCH_MAX, optInt(args.limit, 'limit', 1, 10_000) ?? SEARCH_DEFAULT);
    let before = null;
    if (args.before !== undefined && args.before !== null && args.before !== '') {
      const m = /^(\d{1,16}):(\d{1,16})$/.exec(String(args.before));
      if (!m) throw new JenkinsError('That is not a place in the results');
      before = Number(m[2]);
    }
    // What is kept and not yet indexed is indexed first, for a moment: the answer is about what the archive holds.
    await this.indexSome({ budgetMs: 60, max: 8, server });

    const terms = [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
    // The index finds what has three characters or more; a word shorter than that only has to be in what the index found.
    const long = terms.filter((t) => t.length >= 3);
    const short = terms.filter((t) => t.length < 3);
    const useFts = this.fts && long.length > 0;
    // Where a hit is shown from: the whole of what was asked when it is there as asked, else its longest word.
    const phrase = terms.join(' ');
    const longest = [...terms].sort((a, b) => b.length - a.length)[0];
    // What a document must be to be a hit: not forgotten, in the server and the folder asked for, and — for a console — still kept.
    const conditions = ['d.dead = 0', "(d.kind <> 'log' OR EXISTS (SELECT 1 FROM jk_log l WHERE l.server = d.server AND l.path = d.path AND l.number = d.number))"];
    const params = [];
    if (server) { conditions.push('d.server = ?'); params.push(server); }
    if (path) { conditions.push("(d.path = ? OR d.path LIKE ? ESCAPE '\\')"); params.push(path, `${path.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`); }
    const live = conditions.join(' AND ');

    /*
     * The index is read newest first in batches, the way it is kept, and the loop is let go between batches: no
     * question costs more than a batch at a time, and none looks at more than CANDIDATES_MAX entries. The
     * hits are counted up to COUNT_MAX so that a page knows how many there are in all; the ones newer than
     * the cursor are the ones kept for this page.
     */
    const wanted = limit + 1;
    const picked = [];
    let counted = 0;
    let examined = 0;
    let partial = false;
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const done = () => picked.length >= wanted && counted >= COUNT_MAX;
    let cursor = null;
    if (useFts) {
      const match = long.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
      const alsoShort = short.map(() => ' AND instr(lower(d.text), ?) > 0').join('');
      while (!done()) {
        if (examined >= CANDIDATES_MAX) { partial = true; break; }
        const batch = db.prepare(`SELECT rowid AS id FROM jx_fts WHERE jx_fts MATCH ?${cursor === null ? '' : ' AND rowid < ?'} ORDER BY rowid DESC LIMIT ${BATCH}`)
          .all(match, ...(cursor === null ? [] : [cursor])).map((row) => row.id);
        if (!batch.length) break;
        examined += batch.length;
        cursor = batch[batch.length - 1];
        const kept = new Set(db.prepare(`SELECT d.id FROM jx_doc d WHERE d.id IN (${batch.map(() => '?').join(',')}) AND ${live}${alsoShort}`).all(...batch, ...params, ...short).map((row) => row.id));
        for (const id of batch) {
          if (!kept.has(id)) continue;
          counted += 1;
          if ((before === null || id < before) && picked.length < wanted) picked.push(id);
        }
        if (batch.length < BATCH) break;
        await tick();
      }
    } else {
      const like = terms.map(() => 'instr(lower(d.text), ?) > 0').join(' AND ');
      while (!done()) {
        if (examined >= SCAN_MAX) { partial = true; break; }
        const rows = db.prepare(`SELECT d.id AS id, (${like}) AS hit FROM jx_doc d WHERE ${cursor === null ? '1 = 1' : 'd.id < ?'} AND ${live} ORDER BY d.id DESC LIMIT ${SCAN_BATCH}`)
          .all(...terms, ...(cursor === null ? [] : [cursor]), ...params);
        if (!rows.length) break;
        examined += rows.length;
        cursor = rows[rows.length - 1].id;
        for (const row of rows) {
          if (!row.hit) continue;
          counted += 1;
          if ((before === null || row.id < before) && picked.length < wanted) picked.push(row.id);
        }
        if (rows.length < SCAN_BATCH) break;
        await tick();
      }
    }

    const ids = picked.slice(0, limit);
    const hits = [];
    const redacted = args.redacted === true;
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      const rows = db.prepare(
        `SELECT id, server, path, number, kind, status, at, full, pos, substr(text, max(1, pos - 120), 320) AS around,
                CASE WHEN full = 1 AND pos > 0 THEN length(substr(text, 1, pos - 1)) - length(replace(substr(text, 1, pos - 1), char(10), '')) + 1 END AS line
           FROM (SELECT id, server, path, number, kind, status, at, full, text, COALESCE(NULLIF(instr(lower(text), ?), 0), instr(lower(text), ?)) AS pos
                   FROM jx_doc WHERE id IN (${chunk.map(() => '?').join(',')}))`,
      ).all(phrase, longest, ...chunk);
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const id of chunk) {
        const row = byId.get(id);
        if (!row) continue;
        const snippet = snippetOf(row.around, String(row.around ?? '').toLowerCase().includes(phrase) ? phrase : longest);
        hits.push({
          id: row.id, kind: row.kind, server: row.server, path: row.path, number: row.number, status: row.status, at: row.at,
          line: row.kind === 'log' && row.line ? row.line : null,
          snippet: redacted ? this.#mask(snippet) : snippet,
        });
      }
      if (i + 10 < ids.length) await tick();
    }
    const more = picked.length > limit;
    const last = hits[hits.length - 1];
    return {
      mode: useFts ? 'fts' : 'scan',
      hits: hits.map(({ id, ...hit }) => hit),
      total: Math.min(counted, COUNT_MAX),
      totalCapped: counted >= COUNT_MAX,
      truncated: more,
      // True when the search stopped looking before it reached the oldest consoles: what is older was not searched.
      partial,
      nextBefore: more && last ? `${last.at}:${last.id}` : null,
      indexed: this.#coverage(server),
    };
  }

  async #seenBefore({ server, api, path, number }) {
    const db = this.#need();
    // What is kept and not yet looked at is looked at first: what it is compared with is the archive.
    await this.indexSome({ budgetMs: 60, max: 8, server: server.id });
    let mine = db.prepare('SELECT sig, text, normalized, at FROM jx_sig WHERE server = ? AND path = ? AND number = ?').get(server.id, path, number);
    if (!mine) {
      const build = this.archive?.build(server.id, path, number) ?? null;
      let status = build?.status ?? null;
      let at = build?.timestamp ?? null;
      let text = null;
      const kept = build ? await this.archive.readLog(server.id, path, number).catch(() => null) : null;
      if (kept?.text) text = this.#whole(plain(kept.text));
      if (status === null || text === null) {
        const base = `${jobPath(path)}/${number}`;
        const info = asJson(await api.rawGet(`${base}/api/json?tree=building,result,timestamp`), 'the build');
        if (info.building) return { found: false, reason: 'running' };
        status = fromResult(info.result);
        at = Number(info.timestamp) || this.now();
        if (status !== 'failed' && status !== 'unstable') return { found: false, reason: 'not-failed' };
        if (text === null) {
          const tail = await api.tail(path, number, 400_000).catch(() => null);
          if (!tail) return { found: false, reason: 'no-console' };
          text = this.#whole(plain(tail.text));
        }
      }
      if (status !== 'failed' && status !== 'unstable') return { found: false, reason: 'not-failed' };
      const sig = this.#signature(text);
      if (!sig) return { found: false, reason: 'no-error-found' };
      // Kept only for a build whose console is kept too, or one that finished: a failure does not change.
      this.#sigPut(server.id, path, number, sig, at ?? this.now());
      mine = { sig: sig.sig, text: sig.text, normalized: sig.normalized, at: at ?? this.now() };
    }
    const others = db.prepare('SELECT path, number, text, at FROM jx_sig WHERE server = ? AND sig = ? AND NOT (path = ? AND number = ?) ORDER BY at DESC LIMIT 10').all(server.id, mine.sig, path, number);
    const count = db.prepare('SELECT count(*) AS n FROM jx_sig WHERE server = ? AND sig = ?').get(server.id, mine.sig).n;
    const sameJob = db.prepare('SELECT count(*) AS n FROM jx_sig WHERE server = ? AND sig = ? AND path = ?').get(server.id, mine.sig, path).n;
    const range = db.prepare('SELECT min(at) AS first, max(at) AS last FROM jx_sig WHERE server = ? AND sig = ?').get(server.id, mine.sig);
    const occurrences = others.map((row) => {
      const known = db.prepare('SELECT status FROM jk_build WHERE server = ? AND path = ? AND number = ?').get(server.id, row.path, row.number);
      return { path: row.path, number: row.number, at: row.at, status: known?.status ?? null, text: row.text };
    });
    // What fixed it: the next green build of the job where it last happened, and what was written down about that build.
    let fixedBy = null;
    const previous = others.find((row) => row.path === path && row.number < number) ?? others[0];
    if (previous) {
      const green = db.prepare("SELECT number, timestamp FROM jk_run WHERE server = ? AND path = ? AND number > ? AND status = 'success' ORDER BY number LIMIT 1").get(server.id, previous.path, previous.number);
      if (green) {
        const note = db.prepare('SELECT text FROM jx_note WHERE server = ? AND path = ? AND number = ?').get(server.id, previous.path, green.number);
        fixedBy = { path: previous.path, number: green.number, at: green.timestamp ?? null, ...(note ? { note: note.text } : {}) };
      }
    }
    return {
      found: true, signature: mine.sig, text: mine.text, normalized: mine.normalized,
      count, sameJob, firstSeen: range.first, lastSeen: range.last, occurrences, fixedBy,
    };
  }

  // --- notes ------------------------------------------------------------------------------------

  #notes({ server, path, number }) {
    const db = this.#need();
    const rows = number === null
      ? db.prepare('SELECT path, number, text, updated FROM jx_note WHERE server = ? AND (path = ? OR path LIKE ? ESCAPE \'\\\') ORDER BY updated DESC LIMIT 200').all(server.id, path, `${path.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`)
      : db.prepare('SELECT path, number, text, updated FROM jx_note WHERE server = ? AND path = ? AND number IN (?, 0) ORDER BY number DESC').all(server.id, path, number);
    return { notes: rows.map((row) => ({ path: row.path, number: row.number, text: row.text, updated: row.updated })) };
  }

  #noteSet({ server, path, number, text }) {
    const db = this.#need();
    const clean = cleanNote(text, 'The note', NOTE_MAX);
    const exists = db.prepare('SELECT 1 AS x FROM jx_note WHERE server = ? AND path = ? AND number = ?').get(server.id, path, number);
    if (!exists && db.prepare('SELECT count(*) AS n FROM jx_note WHERE server = ?').get(server.id).n >= NOTES_PER_SERVER) {
      throw new JenkinsError(`There are already ${NOTES_PER_SERVER} notes for this Jenkins; remove some first`);
    }
    const at = this.now();
    this.#tx(() => {
      db.prepare('INSERT OR REPLACE INTO jx_note (server, path, number, text, updated) VALUES (?, ?, ?, ?, ?)').run(server.id, path, number, clean, at);
      // Findable by search, like a console is.
      this.#docPut(server.id, path, number, 'note', clean, { full: 1, status: null, at });
    });
    return { ok: true, note: { path, number, text: clean, updated: at } };
  }

  #noteDelete({ server, path, number }) {
    const db = this.#need();
    const removed = this.#tx(() => {
      const n = db.prepare('DELETE FROM jx_note WHERE server = ? AND path = ? AND number = ?').run(server.id, path, number).changes;
      this.#docKill("server = ? AND path = ? AND number = ? AND kind = 'note'", [server.id, path, number]);
      return n;
    });
    return { ok: true, removed };
  }

  // --- links ------------------------------------------------------------------------------------

  #url({ api }, args) {
    const hasPath = args.path !== undefined && args.path !== null && args.path !== '';
    const path = hasPath ? needPath(args.path) : null;
    const number = args.number === undefined || args.number === null || args.number === '' ? null : needInt(args.number, 'build number', 1);
    if (number !== null && path === null) throw new JenkinsError('Say which job that build is of');
    const part = args.part === undefined || args.part === null || args.part === '' ? (number !== null ? 'build' : path !== null ? 'job' : 'home') : needText(args.part, 'part', 30);
    const base = api.base;
    const job = path !== null ? `${base}${jobPath(path)}` : null;
    const build = job && number !== null ? `${job}/${number}` : null;
    const need = (value, what) => { if (!value) throw new JenkinsError(`${what} needs ${what === 'a job page' ? 'a job' : 'a build'}`); return value; };
    switch (part) {
      case 'home': case 'queue': return `${base}/`;
      case 'agents': return `${base}/computer/`;
      case 'job': return `${need(job, 'a job page')}/`;
      case 'build': return `${need(build, 'a build page')}/`;
      case 'console': return `${need(build, 'a build page')}/console`;
      case 'stages': return `${need(build, 'a build page')}/flowGraphTable/`;
      case 'input': return `${need(build, 'a build page')}/input/`;
      case 'replay': return `${need(build, 'a build page')}/replay/`;
      case 'pipeline-graph': {
        throw new JenkinsError('The Pipeline Graph View plugin is not known to be installed on this Jenkins');
      }
      default: throw new JenkinsError(`There is no "${part}" page`);
    }
  }

  #open({ api, server }, args) {
    const url = this.#url({ api }, args);
    if (!this.openExternal) throw new JenkinsError('Opening a browser is not available here');
    // Only ever this Jenkins, and only ever as a web page.
    let parsed;
    try { parsed = new URL(url); } catch { throw new JenkinsError('That is not an address'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !(url === `${api.base}/` || url.startsWith(`${api.base}/`))) throw new JenkinsError(`That page is not on ${server.name}`);
    this.openExternal(url);
    return { ok: true, url };
  }

  // --- parameter sets --------------------------------------------------------------------------------

  #presets({ server, path }) {
    const db = this.#need();
    const rows = db.prepare('SELECT name, vals, updated FROM jx_preset WHERE server = ? AND path = ? ORDER BY name').all(server.id, path);
    return { presets: rows.map((row) => ({ name: row.name, values: parseValues(row.vals), updated: row.updated })) };
  }

  async #presetSave({ server, api, path, name, values }) {
    const db = this.#need();
    const label = cleanNote(typeof name === 'string' ? name : '', 'The name', 100).replace(/\n/g, ' ');
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new JenkinsError('The values are missing');
    const entries = Object.entries(values);
    if (entries.length > PRESET_VALUES) throw new JenkinsError(`A set holds at most ${PRESET_VALUES} parameters`);
    // The job says which of its parameters are passwords; a name that sounds like one is also left out.
    let secret = new Set();
    try {
      const job = await api.job(path, { builds: 1 });
      secret = new Set((job.parameters ?? []).filter((p) => p.secret).map((p) => p.name));
    } catch { /* the names still decide */ }
    const kept = {};
    const dropped = [];
    for (const [key, value] of entries) {
      if (!key || key.length > 200 || CONTROL.test(key)) throw new JenkinsError('A parameter has a name that Jenkins could not have');
      if (secret.has(key) || secretName(key)) { dropped.push(key); continue; }
      if (!['string', 'number', 'boolean'].includes(typeof value)) throw new JenkinsError(`The value of ${key} has to be text, a number or true/false`);
      const text = String(value);
      if (text.length > 4000) throw new JenkinsError(`The value of ${key} is too long`);
      if (secretValue(text)) { dropped.push(key); continue; }
      kept[key] = text;
    }
    const exists = db.prepare('SELECT 1 AS x FROM jx_preset WHERE server = ? AND path = ? AND name = ?').get(server.id, path, label);
    if (!exists && db.prepare('SELECT count(*) AS n FROM jx_preset WHERE server = ? AND path = ?').get(server.id, path).n >= PRESETS_PER_JOB) {
      throw new JenkinsError(`A job keeps at most ${PRESETS_PER_JOB} parameter sets; remove one first`);
    }
    const at = this.now();
    db.prepare('INSERT OR REPLACE INTO jx_preset (server, path, name, vals, updated) VALUES (?, ?, ?, ?, ?)').run(server.id, path, label, JSON.stringify(kept), at);
    return { ok: true, preset: { name: label, values: kept, updated: at }, dropped };
  }

  #presetDelete({ server, path, name }) {
    const db = this.#need();
    return { ok: true, removed: db.prepare('DELETE FROM jx_preset WHERE server = ? AND path = ? AND name = ?').run(server.id, path, name).changes };
  }
}

// --- small things ----------------------------------------------------------------------------------

const lower = (value) => String(value ?? '').toLowerCase();

/** A build's `result` as the statuses the rest of the extension uses. */
const fromResult = (result) => ({ success: 'success', failure: 'failed', unstable: 'unstable', aborted: 'aborted', not_built: 'none' }[lower(result)] ?? lower(result));

/** The steps that failed: leaves, not the blocks around them, which fail whenever what is in them does. */
function failingNodes(nodes) {
  const bad = nodes.filter((node) => ['failed', 'unstable', 'aborted'].includes(lower(node.status)));
  const parents = new Set(bad.flatMap((node) => (Array.isArray(node.parentNodes) ? node.parentNodes.map(String) : [])));
  const leaves = bad.filter((node) => !parents.has(String(node.id)));
  return (leaves.length ? leaves : bad).sort((a, b) => (a.startTimeMillis ?? 0) - (b.startTimeMillis ?? 0));
}

/**
 * A Jenkinsfile without its comments, in one pass: the next slash is found with
 * `indexOf` and each comment ends where its own ending is. An unterminated
 * comment runs to the end, as it does for Groovy.
 */
function stripComments(text) {
  const out = [];
  let from = 0;
  for (;;) {
    const slash = text.indexOf('/', from);
    if (slash < 0) { out.push(text.slice(from)); break; }
    const next = text.charCodeAt(slash + 1);
    if (next === 42) {
      out.push(text.slice(from, slash), ' ');
      const end = text.indexOf('*/', slash + 2);
      if (end < 0) break;
      from = end + 2;
    } else if (next === 47 && (slash === 0 || /\s/.test(text[slash - 1]))) {
      out.push(text.slice(from, slash));
      const newline = text.indexOf('\n', slash + 2);
      if (newline < 0) break;
      from = newline;
    } else {
      out.push(text.slice(from, slash + 1));
      from = slash + 1;
    }
  }
  return out.join('');
}

/** Whether the text has `pipeline {` at the start of a line — the one thing only Declarative Pipeline has. */
function hasPipelineBlock(text) {
  let from = 0;
  for (;;) {
    const at = text.indexOf('pipeline', from);
    if (at < 0) return false;
    from = at + 8;
    let back = at - 1;
    while (back >= 0 && (text[back] === ' ' || text[back] === '\t' || text[back] === '\r')) back -= 1;
    if (back >= 0 && text[back] !== '\n') continue;
    let ahead = at + 8;
    while (ahead < text.length && /\s/.test(text[ahead])) ahead += 1;
    if (text[ahead] === '{') return true;
  }
}

/** What Jenkins' validator said, as lines and columns: each line looked at once, none longer than it needs to be. */
function validatorErrors(answer) {
  const errors = [];
  const lines = answer.split('\n', 5000);
  for (const raw of lines) {
    if (errors.length >= 50) break;
    if (!raw.startsWith('WorkflowScript: ')) continue;
    const line = raw.slice(16, 616);
    const colon = line.indexOf(': ');
    if (colon < 1 || colon > 9 || !/^\d+$/.test(line.slice(0, colon))) continue;
    let message = line.slice(colon + 2).trimEnd();
    let row = Number(line.slice(0, colon));
    let column = null;
    const marker = message.lastIndexOf(' @ line ');
    if (marker >= 0) {
      const place = /^(\d{1,9}), column (\d{1,9})\.?$/.exec(message.slice(marker + 8));
      if (place) { row = Number(place[1]); column = Number(place[2]); message = message.slice(0, marker); }
    }
    errors.push({ line: row, column, message: message.slice(0, 300) });
  }
  return errors;
}

/** A queue item is this job's when its task's address says so: a job's own, or a Pipeline's "part of <job> #n". */
function queuedFor(item, jobBase) {
  const url = String(item.task?.url ?? '').replace(/^https?:\/\/[^/]+\//i, '');
  const wanted = jobBase.replace(/^\//, '');
  return url === `${wanted}/` || url.startsWith(`${wanted}/`);
}

function agentOf(one) {
  // The executors it has; a Pipeline's own bookkeeping runs on "one-off" ones that are not capacity.
  const executors = one.executors ?? [];
  const data = one.monitorData ?? {};
  let disk = null;
  let threshold = null;
  for (const [key, value] of Object.entries(data)) {
    if (/DiskSpaceMonitor$/.test(key) && value && typeof value.size === 'number') { disk = value.size; threshold = value.threshold ?? null; }
  }
  const diskFreeMB = disk === null ? null : Math.round(disk / 1048576);
  return {
    name: String(one.displayName ?? ''),
    offline: Boolean(one.offline),
    reason: String(one.offlineCauseReason ?? '').slice(0, 200),
    busy: executors.filter((slot) => slot.currentExecutable).length,
    total: one.numExecutors ?? 0,
    labels: (one.assignedLabels ?? []).map((label) => label.name).filter((labelName) => labelName && labelName !== one.displayName),
    diskFreeMB,
    diskLow: disk !== null && threshold !== null && disk < threshold,
  };
}

/** Seconds until some executor is expected to be free, from what is running and how long it usually takes. */
function soonestFree(computers, now) {
  let best = null;
  for (const one of computers) {
    if (one.offline) continue;
    const slots = one.executors ?? [];
    if (slots.length < (one.numExecutors ?? 0)) return 0;
    for (const slot of slots) {
      const run = slot.currentExecutable;
      if (!run) return 0;
      if (typeof run.timestamp !== 'number' || typeof run.estimatedDuration !== 'number' || run.estimatedDuration <= 0) continue;
      const left = Math.max(0, Math.round((run.timestamp + run.estimatedDuration - now) / 1000));
      if (best === null || left < best) best = left;
    }
  }
  return best;
}

function adviceFor(state, reasons, waitSeconds) {
  const first = reasons[0];
  if (state === 'disabled') return 'This job is disabled. Enable it in Jenkins to run it.';
  if (state === 'running' && !reasons.length) return 'It is running now.';
  if (state === 'idle') return 'Nothing is running or waiting for it.';
  if (!first) return '';
  if (first.fix) return first.fix;
  if (waitSeconds !== null && waitSeconds > 0) return `Nothing is wrong: it starts when an executor frees up, in about ${waitSeconds < 90 ? `${waitSeconds} s` : `${Math.round(waitSeconds / 60)} min`}.`;
  return first.text;
}

function parseValues(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/** The line of `around` that holds the term, or the start of it. */
function snippetOf(around, term) {
  const text = String(around ?? '');
  const at = term ? text.toLowerCase().indexOf(term) : -1;
  if (at < 0) return text.split('\n')[0].trim().slice(0, 240);
  const start = text.lastIndexOf('\n', at) + 1;
  const end = text.indexOf('\n', at);
  return text.slice(start, end < 0 ? text.length : end).trim().slice(0, 240);
}

module.exports = {
  Extras, reasonFrom, normalize, signatureOf, errorLines, errorWindow, extract, scriptsOf, decodeEntities, failingNodes, queuedFor, agentOf, soonestFree,
};
