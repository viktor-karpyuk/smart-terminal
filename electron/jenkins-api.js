'use strict';

/**
 * Talking to Jenkins.
 *
 * Plain HTTP against the JSON API, with an API token. Nothing here knows about
 * the app: `fetch` is handed in, so the same code runs against `net.fetch` in
 * the app and against a fake in a test.
 *
 * Decisions worth stating rather than discovering.
 *
 * **Names are never trusted as paths.** A job's name comes from a server other
 * people configure, and a folder called `..` or a job with a slash in it is
 * legal to type if not to create. Every segment that is turned into a URL goes
 * through `segment()`, which refuses anything that could stop being a name and
 * start being a route — the same worry `safeArg` has in kube.js.
 *
 * **Redirects are never followed.** The credentials are in a header, and what
 * a fetch does with a header at a redirect is its own business: Node's drops
 * `Authorization` when the origin changes, but Electron's `net.fetch` — the
 * one this runs on — forwards it to wherever it is sent (measured, not
 * assumed), and does not even say where it went (`response.url` is empty,
 * `redirected` false). So `redirect: 'manual'` is the only safe setting, and
 * what that does differs too: Node hands back the 3xx, Electron *throws*
 * "Redirect was cancelled" for every one. Both are the same fact here — the
 * server answered with a redirect — and are handled as one in `#request`.
 * **No cookies either** (`credentials: 'omit'`): Electron's fetch keeps a session cookie jar shared by every server and every user, and
 * Jenkins answers a login with one. Each request carries its own `Authorization` and nothing else, so a session that went stale
 * or belongs to somebody else's login cannot change who a request is made as. (A password then cannot write — Jenkins wants
 * its crumb tied to a session — and the error says to make an API token.)
 * That matters for the actions: a real Jenkins answers a successful `stop`
 * with a 302 back to the build's page, so a client that read the throw as a
 * failure would report an error for a build it had just stopped.
 *
 * **Nothing is read without a limit.** The server is somebody else's: a
 * body is capped, and the timeout covers reading it, not only the headers.
 *
 * **The rows are shaped here, not in the panel.** Jenkins answers with
 * everything it knows unless it is told what to leave out, and a server with a
 * few thousand jobs answers a careless request with megabytes. Every call
 * carries a `tree=` naming exactly the fields a row uses, and what crosses to
 * the panel is the row.
 */

const TIMEOUT = 20000;
/** Reading the whole job list of a big, busy Jenkins is a heavy question, and is allowed longer than a light one. */
const HEAVY_TIMEOUT = 60000;
/** The most JSON one answer may carry. A few thousand jobs is a couple of megabytes. */
const MAX_JSON = 24 * 1024 * 1024;
/** The most console one read may carry. A follower reads what was written since last time. */
const MAX_LOG_READ = 16 * 1024 * 1024;
/** How much of the end of a console is read when it is opened. */
const LOG_TAIL_BYTES = 400_000;
const MAX_SEGMENT = 500;
/** How far into a console opened mid-line to look for the start of the next line. */
const LINE_SEARCH = 8192;
const MAX_DEPTH = 32;
/** Rows an index keeps. A server past this is shown as far as it goes and says so. */
const MAX_ROWS = 20000;

const NOTE_OPEN = '\u001b[8mha:';
const NOTE_CLOSE = '\u001b[0m';
const NOTE_OPEN_BYTES = Buffer.from(NOTE_OPEN);
const NOTE_CLOSE_BYTES = Buffer.from(NOTE_CLOSE);

/** A job-like thing whose children are jobs: folders, and the multibranch kinds. */
const FOLDERISH = /(Folder|MultiBranchProject|OrganizationFolder)/;

const JOB_FIELDS =
  '_class,name,fullName,url,color,' +
  'lastBuild[number,result,building,timestamp,duration]';
/** Two levels in one request: a folder's children, and theirs. */
const TWO_LEVELS = `jobs[${JOB_FIELDS},jobs[${JOB_FIELDS},jobs[name]]]`;

const { AsyncLocalStorage } = require('node:async_hooks');
const lanes = new AsyncLocalStorage();
/** Run `fn` as background work (a history walk, a gap fill): what a person is waiting for goes first, and it never takes a place a person could. */
function background(fn) { return lanes.run({ lane: 'low' }, fn); }
/** Run `fn` as bulk work (reading the whole list of jobs, the stage of every running job): it waits for single questions, and leaves one place free for them. */
function bulk(fn) { return lanes.run({ lane: 'bulk' }, fn); }

/**
 * How many requests one Jenkins is asked at once, and how that follows how it copes.
 *
 * A place is held for ONE round trip (the request and its answer) and nothing else: nothing that holds a place ever waits
 * for another place, so there is nothing for places to deadlock on. Three kinds of asker, in this order: a person's single
 * question (`high`), bulk work (`bulk`: a whole list, many stage lookups), and background work (`low`: history). Bulk and
 * background leave a place free for a person whenever there is more than one, so a person is never behind a crawl.
 * Additive increase, multiplicative decrease on what was observed: a timeout, or a typical (median) latency over `slowMs`,
 * halves the number (never below `min`); a run of quick answers adds one, at most every few seconds.
 *
 * Nothing waits for ever: an asker queued longer than `maxWait` is turned away with a `slow` error, and a place held longer
 * than `maxHold` (a fetch that ignored its own timeout) is taken back and counted in `leaked`.
 */
class Limiter {
  constructor({ start = 4, min = 2, max = 6, slowMs = 4000, fastMs = 800, growEvery = 5000, maxWait = 30_000, now = Date.now } = {}) {
    Object.assign(this, { limit: start, min, max, slowMs, fastMs, growEvery, maxWait, now });
    this.active = 0;
    this.queues = { high: [], bulk: [], low: [] };
    this.samples = [];
    this.changed = 0;
    this.leaked = 0;
    this.turnedAway = 0;
  }

  /** `lane`: 'high' | 'bulk' | 'low' (or `true` for low). `maxHold`: how long the place may be held before it is taken back. */
  acquire(lane = 'high', { maxHold = 150_000, maxWait = this.maxWait } = {}) {
    const queue = this.queues[lane === true ? 'low' : lane] ?? this.queues.high;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, maxHold, timer: null };
      waiter.timer = setTimeout(() => {
        const at = queue.indexOf(waiter);
        if (at < 0) return;
        queue.splice(at, 1);
        this.turnedAway += 1;
        const error = new Error('Jenkins is too busy to be asked that right now');
        error.code = 'slow-wait';
        reject(error);
      }, maxWait);
      waiter.timer.unref?.();
      queue.push(waiter);
      this.#pump();
    });
  }

  #next() {
    const { high, bulk, low } = this.queues;
    if (high.length) return high.shift();
    // Bulk and background work leave the last place for a person, when there is more than one.
    if (bulk.length && this.active < Math.max(1, this.limit - 1)) return bulk.shift();
    if (low.length && !bulk.length && this.active < Math.max(1, this.limit - 1)) return low.shift();
    return null;
  }

  #pump() {
    while (this.active < this.limit) {
      const waiter = this.#next();
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.active += 1;
      let done = false;
      const release = () => {
        if (done) return;
        done = true;
        clearTimeout(hold);
        this.active = Math.max(0, this.active - 1);
        this.#pump();
      };
      // A fetch that never answers and never fails would keep its place for ever: it is taken back.
      const hold = setTimeout(() => { if (!done) { this.leaked += 1; release(); } }, waiter.maxHold);
      hold.unref?.();
      waiter.resolve(release);
    }
  }

  /** One answer, how long it took, and whether it was given up on. */
  record(ms, timedOut = false) {
    const now = this.now();
    this.samples.push(timedOut ? Infinity : ms);
    if (this.samples.length > 9) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (timedOut || (this.samples.length >= 4 && median > this.slowMs)) {
      if (this.limit > this.min && (timedOut || now - this.changed > 2000)) {
        this.limit = Math.max(this.min, Math.floor(this.limit / 2));
        this.changed = now;
        this.samples = [];
      }
    } else if (this.samples.length >= 6 && median < this.fastMs && this.limit < this.max && now - this.changed > this.growEvery) {
      this.limit += 1;
      this.changed = now;
    }
    this.#pump();
  }

  /** For a test or a log: where it stands. */
  state() {
    return { limit: this.limit, active: this.active, waiting: this.queues.high.length + this.queues.bulk.length + this.queues.low.length, leaked: this.leaked, turnedAway: this.turnedAway };
  }
}

class JenkinsError extends Error {
  /** `code` names a kind of failure a panel can act on (today: 'certificate'); `status` is the HTTP status, or 0. */
  constructor(message, status = 0, code = null) {
    super(message);
    this.name = 'JenkinsError';
    this.status = status;
    if (code) this.code = code;
  }
}

/** One piece of a path: a name, and nothing that could be read as a way out of it. */
function segment(value, what = 'name') {
  const text = String(value ?? '');
  if (!text.trim()) throw new JenkinsError(`${what} is missing`);
  if (text.length > MAX_SEGMENT) throw new JenkinsError(`${what} is longer than any Jenkins allows`);
  // eslint-disable-next-line no-control-regex
  if (/[\\/\u0000-\u001f\u007f]/.test(text) || text === '.' || text === '..') {
    // eslint-disable-next-line no-control-regex
    throw new JenkinsError(`${what} "${text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60)}" is not a name Jenkins could have`);
  }
  return text;
}

/**
 * One segment as it goes into a URL: a name, encoded like any other.
 *
 * A branch called `feature/x` in a multibranch project is a job whose NAME is the text `feature%2Fx` (a name cannot hold a
 * slash, so the plugin writes it that way), and its address is that name encoded: `feature%252Fx`. Jenkins decodes the
 * address once and finds the item by that name; `feature%2Fx` would be decoded to `feature/x`, which is not it (verified on
 * a real Jenkins 2.541.3: 200 at `%252F`, 404 at `%2F`). So a `%` is always encoded.
 */
function encoded(name) {
  return encodeURIComponent(name);
}

function segments(path, what) {
  const text = String(path ?? '').replace(/^\/+|\/+$/g, '');
  if (!text) return [];
  const parts = text.split('/');
  if (parts.length > MAX_DEPTH) throw new JenkinsError(`${what} is nested deeper than this app follows`);
  return parts;
}

/** `team/app/main` → `/job/team/job/app/job/main`. The empty path is the root. */
function jobPath(path) {
  return segments(path, 'job').map((one) => `/job/${encoded(segment(one, 'job name'))}`).join('');
}

/** `QA/Smoke` → `/view/QA/view/Smoke`. */
function viewPath(path) {
  return segments(path, 'view').map((one) => `/view/${encoded(segment(one, 'view name'))}`).join('');
}

/** A server's address, reduced to the origin and path Jenkins is served from. */
function normalizeBase(value) {
  const raw = String(value ?? '').trim();
  let url;
  try {
    if (raw.length > 2048) throw new Error('long');
    url = new URL(raw);
  } catch {
    throw new JenkinsError('That is not an address. Use the one you open Jenkins at, like https://jenkins.example.com');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new JenkinsError('Jenkins has to be an http or https address');
  if (url.username || url.password) throw new JenkinsError('Put the user and token in their own fields, not in the address');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** What a job's `color` says, without the animation suffix. */
function statusOf(color, building = false) {
  const text = String(color ?? '');
  const running = building || text.endsWith('_anime');
  const base = text.replace(/_anime$/, '');
  let status = 'none';
  if (base === 'blue') status = 'success';
  else if (base === 'red') status = 'failed';
  else if (base === 'yellow') status = 'unstable';
  else if (base === 'aborted') status = 'aborted';
  else if (base === 'disabled') status = 'disabled';
  return { status, running };
}

/** A result as a status. Null while a build is still going. */
function resultStatus(result) {
  switch (result) {
    case 'SUCCESS': return 'success';
    case 'FAILURE': return 'failed';
    case 'UNSTABLE': return 'unstable';
    case 'ABORTED': return 'aborted';
    case 'NOT_BUILT': return 'none';
    default: return null;
  }
}

function buildRow(build) {
  if (!build) return null;
  const running = build.building === true;
  const row = {
    number: build.number,
    status: running ? 'running' : resultStatus(build.result) ?? 'none',
    running,
    timestamp: build.timestamp ?? null,
    duration: build.duration ?? 0,
  };
  // What Jenkins expects a running build to take, from its own history: what a progress bar needs.
  if (running && build.estimatedDuration > 0) row.estimated = build.estimatedDuration;
  return row;
}

/** A job as the panel's table and tree show it. */
function jobRow(job, parent = '') {
  const path = job.fullName || (parent ? `${parent}/${job.name}` : job.name);
  const folder = FOLDERISH.test(job._class ?? '') || Array.isArray(job.jobs);
  const { status, running } = statusOf(job.color, job.lastBuild?.building);
  return {
    kind: folder ? 'folder' : 'job',
    multibranch: /MultiBranch|OrganizationFolder/.test(job._class ?? ''),
    // Whether it can have stages at all: only a Pipeline job answers questions about them. Null when it was not said.
    flow: job._class ? /\.workflow\.job\.WorkflowJob$/.test(job._class) : null,
    name: job.name,
    path,
    status,
    running,
    description: String(job.description || '').slice(0, 300),
    health: job.healthReport?.[0]?.score ?? null,
    last: buildRow(job.lastBuild),
    // A folder's children are counted when they were asked for, not guessed at.
    count: Array.isArray(job.jobs) ? job.jobs.length : null,
  };
}

/**
 * A parameter's value, hidden when its name is the kind that is a secret.
 * Jenkins leaves a password parameter's value out altogether, so "there is
 * one, and it is hidden" is said here rather than as an empty cell.
 */
function parameterValue(name, value) {
  return /pass(word)?|secret|token|key|credential/i.test(String(name)) ? '••••••' : value;
}

// --- the console --------------------------------------------------------------

/**
 * Hidden annotations out of a console, in one pass.
 *
 * A regular expression with a lazy `[\s\S]*?` between the two markers looks
 * like the same thing and is not: on a megabyte of openers with no closer,
 * each opener scans to the end, and the console of a build that someone
 * wanted to hang the app with takes minutes. Here an opener with no closer
 * after it ends the search — every later one has no closer either — so it is
 * linear however the text is built.
 */
function stripNotes(text) {
  let out = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf(NOTE_OPEN, from);
    if (open < 0) break;
    const close = text.indexOf(NOTE_CLOSE, open + NOTE_OPEN.length);
    if (close < 0) break;
    out += text.slice(from, open);
    from = close + NOTE_CLOSE.length;
  }
  return out + text.slice(from);
}

/** What the page-oriented parts of a console body are cleaned of: annotations and the CR of every CRLF. */
function cleanText(text) {
  return stripNotes(text).replace(/\r\n/g, '\n');
}

/**
 * How many bytes at the end of a chunk are not safe to show yet.
 *
 * A console is read while it is being written, so a chunk can end anywhere:
 * inside an annotation, inside a multi-byte character, between the CR and the
 * LF of a line end, or partway through the bytes that start an annotation.
 * Showing any of those leaves a fragment that the next chunk cannot repair.
 */
function holdBack(bytes) {
  const end = bytes.length;
  let hold = 0;
  if (end && bytes[end - 1] === 0x0d) hold = 1;
  // A character cut in two.
  for (let back = 1; back <= 3 && back <= end; back += 1) {
    const b = bytes[end - back];
    if ((b & 0xc0) === 0x80) continue;                       // a continuation byte: keep looking for its lead
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (need > back) hold = Math.max(hold, back);
    break;
  }
  // An annotation opened and not closed.
  const open = bytes.lastIndexOf(NOTE_OPEN_BYTES);
  if (open >= 0 && bytes.indexOf(NOTE_CLOSE_BYTES, open) < 0) hold = Math.max(hold, end - open);
  // The first bytes of an opener, and no more yet.
  for (let len = Math.min(NOTE_OPEN_BYTES.length - 1, end); len >= 1; len -= 1) {
    if (bytes.subarray(end - len).equals(NOTE_OPEN_BYTES.subarray(0, len))) { hold = Math.max(hold, len); break; }
  }
  return hold;
}

/**
 * What a console read is turned into text by: annotations and CRs out, and
 * whatever is not yet safe to show kept for what comes next (see `holdBack`).
 * One of these is for one console and one direction of reading it.
 *
 * `dropToLine` is for a console opened in the middle: it begins at the next
 * line, unless there is none near, in which case this is one very long line
 * and what there is of it is shown.
 */
class LogCleaner {
  constructor({ dropToLine = false } = {}) {
    this.carry = Buffer.alloc(0);
    this.dropToLine = dropToLine;
  }

  /** What was held belongs to a console that is gone. */
  reset() {
    this.carry = Buffer.alloc(0);
  }

  /**
   * @param hold whether more may follow. At the very end it is false and everything is let out.
   * @returns {{ text: string, truncated: boolean }} `truncated` is true once, on the text that begins after the cut
   */
  push(bytes, hold) {
    const all = this.carry.length ? Buffer.concat([this.carry, bytes]) : bytes;
    const keep = hold ? holdBack(all) : 0;
    this.carry = keep ? Buffer.from(all.subarray(all.length - keep)) : Buffer.alloc(0);
    let text = cleanText(all.subarray(0, all.length - keep).toString('utf8'));
    let truncated = false;
    if (this.dropToLine) {
      const newline = text.indexOf('\n');
      if (newline >= 0 && newline < LINE_SEARCH) {
        text = text.slice(newline + 1);
        this.dropToLine = false;
        truncated = true;
      } else if (text.length >= LINE_SEARCH || !hold) {
        text = text.replace(/^\uFFFD{1,3}/, '');
        this.dropToLine = false;
        truncated = true;
      } else {
        // Not enough yet to tell where a line begins: everything read is kept for the next read.
        this.carry = Buffer.from(all);
        text = '';
      }
    }
    return { text, truncated };
  }
}

/**
 * A console followed from one place, as text.
 *
 * Stateful on purpose. The offsets Jenkins hands out (`X-Text-Size`) are
 * positions in the *file*, and the body it sends is not the file — every line
 * end becomes CRLF — so a body length can never be subtracted from an offset.
 * (The first version held an unfinished annotation back by lowering the
 * offset by its length in the body, and so re-read a few bytes of the line
 * before it, every time.) What is not yet safe to show is kept here instead,
 * and put in front of what comes next.
 */
class LogStream {
  constructor(api, path, number, { tailBytes = 0 } = {}) {
    this.api = api;
    this.path = path;
    this.number = number;
    this.tailBytes = tailBytes;
    this.offset = 0;
    this.cleaner = new LogCleaner();
    this.started = false;
    this.skipped = 0;
  }

  /** @returns {Promise<{ text: string, next: number, more: boolean, truncated: boolean, skipped: number }>} */
  async read() {
    if (!this.started) {
      this.started = true;
      if (this.tailBytes > 0) {
        const size = await this.api.logSize(this.path, this.number);
        // Open a very long console at its end: the beginning is one click away in Jenkins.
        if (size !== null && size > this.tailBytes) {
          this.offset = size - this.tailBytes;
          this.skipped = this.offset;
          this.cleaner = new LogCleaner({ dropToLine: true });
        }
      }
    }
    const read = await this.api.logRead(this.path, this.number, this.offset);
    // The log got shorter (rotated, or the build was replaced): what was held belongs to a console that is gone.
    if (read.next < this.offset) this.cleaner.reset();
    this.offset = read.next;
    const { text, truncated } = this.cleaner.push(read.bytes, read.more);
    return { text, next: this.offset, more: read.more, truncated, skipped: truncated ? this.skipped : 0 };
  }
}

/**
 * The body of a response, up to a limit.
 *
 * Streamed when the response can be, so a server that sends a gigabyte is
 * cut off at the limit instead of being held in memory first; a plain
 * `.text()` is the fallback for what is not a stream (and for a test's fake).
 */
async function readBytes(response, max, touch = () => {}) {
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      touch();
      if (done) break;
      size += value.length;
      if (size > max) {
        try { await reader.cancel(); } catch { /* it is being dropped either way */ }
        return { bytes: Buffer.concat(chunks), tooBig: true };
      }
      chunks.push(value);
    }
    return { bytes: Buffer.concat(chunks), tooBig: false };
  }
  const bytes = typeof response.arrayBuffer === 'function' ? Buffer.from(await response.arrayBuffer()) : Buffer.from(await response.text());
  return bytes.length > max ? { bytes: bytes.subarray(0, max), tooBig: true } : { bytes, tooBig: false };
}

/**
 * The body of a response, piece by piece, up to a limit: for what is too big to hold.
 * A response that is not a stream is handed over in slices, so a fake behaves like the real thing.
 */
async function streamBytes(response, max, onChunk, touch = () => {}) {
  let total = 0;
  const feed = async (chunk) => {
    total += chunk.length;
    if (total > max) return false;
    await onChunk(chunk);
    return true;
  };
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      touch();
      if (done) return { tooBig: false };
      if (!(await feed(value))) {
        try { await reader.cancel(); } catch { /* it is being dropped either way */ }
        return { tooBig: true };
      }
    }
  }
  const bytes = typeof response.arrayBuffer === 'function' ? Buffer.from(await response.arrayBuffer()) : Buffer.from(await response.text());
  for (let at = 0; at < bytes.length; at += 65536) {
    if (!(await feed(bytes.subarray(at, at + 65536)))) return { tooBig: true };
  }
  return { tooBig: false };
}

/** Why a request failed, in a few safe words: a code or a short phrase, never an address, a header or a stack. */
function reasonOf(error) {
  const text = String(error?.cause?.code ?? error?.code ?? error?.message ?? 'unknown');
  return text.replace(/[^\w .:/-]/g, '').slice(0, 80) || 'unknown';
}

const REDIRECT_CANCELLED = /redirect was cancelled/i;

/**
 * A failed TLS handshake is not "could not reach Jenkins": the server is there and its certificate is the problem, which a
 * person can do something about (look at it, and trust it for this server). Node says it in `cause.code`, Electron in the
 * message (`net::ERR_CERT_AUTHORITY_INVALID`).
 */
const CERT_UNKNOWN = /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|CERT_UNTRUSTED)$|ERR_CERT_AUTHORITY_INVALID|ERR_CERT_UNABLE_TO_CHECK|ERR_CERT_INVALID|ERR_CERT_REVOKED/;
const CERT_DATE = /^(CERT_HAS_EXPIRED|CERT_NOT_YET_VALID)$|ERR_CERT_DATE_INVALID/;
const CERT_NAME = /^(ERR_TLS_CERT_ALTNAME_INVALID|HOSTNAME_MISMATCH)$|ERR_CERT_COMMON_NAME_INVALID|ERR_CERT_NAME_INVALID/;

/** Why the certificate is refused, in words; null if the failure is not about a certificate. */
function certificateProblem(error) {
  const text = `${error?.cause?.code ?? ''} ${error?.code ?? ''} ${error?.message ?? ''} ${error?.cause?.message ?? ''}`;
  const hit = (re) => text.split(/\s+/).some((word) => re.test(word)) || re.test(text);
  if (hit(CERT_NAME)) return 'is for a different name than the address you typed';
  if (hit(CERT_DATE)) return 'has expired (or is not valid yet)';
  if (hit(CERT_UNKNOWN)) return 'is not signed by an authority this computer trusts (a self-signed or company certificate)';
  return null;
}

// --- pipeline stages ------------------------------------------------------------

/** The one step Jenkins runs for a stage that was skipped: nothing else is in it. */
const STAGE_NOOP = 'Get contextual object from internal APIs';
/** Stages whose start is within this of the other's end are in sequence, not side by side. */
const SEQUENCE_SLACK_MS = 5;

function stageStatus(value) {
  switch (value) {
    case 'SUCCESS': return 'success';
    case 'FAILED': return 'failed';
    case 'UNSTABLE': return 'unstable';
    case 'ABORTED': return 'aborted';
    case 'IN_PROGRESS': return 'running';
    case 'PAUSED_PENDING_INPUT': return 'paused';
    case 'NOT_EXECUTED': return 'skipped';
    default: return 'none';
  }
}

/** A stage as the Pipeline Stage View API sends it, as the panel draws it. */
function stageShape(raw) {
  const status = stageStatus(raw.status);
  return {
    name: String(raw.name ?? '').slice(0, 200),
    status,
    duration: raw.durationMillis ?? 0,
    start: raw.startTimeMillis ?? null,
    executed: status !== 'skipped',
    error: raw.error ? String(raw.error.message ?? raw.error.type ?? 'it failed').slice(0, 300) : null,
    paused: status === 'paused',
    input: null,
    parallel: false,
    // What it is worked out from, and not sent on:
    key: raw.error ? `${raw.error.type}\n${raw.error.message}` : null,
    nodes: Array.isArray(raw.stageFlowNodes) ? raw.stageFlowNodes.map((node) => String(node.name ?? '')) : null,
  };
}

function markSkipped(stage) {
  stage.status = 'skipped';
  stage.executed = false;
  // The error a skipped stage carries is the one that skipped it, not one of its own.
  stage.error = null;
}

/**
 * Which stages ran, which did not, and which ran side by side.
 *
 * After one stage fails, Jenkins carries its error onto every stage that was
 * skipped because of it and reports them all as FAILED, so a pipeline with one
 * problem shows three. There are two ways to tell. The exact one: with the
 * stage's steps in hand, a stage that was skipped contains nothing but the
 * step Jenkins runs for any skipped stage. The other, for when the steps are
 * not there: a stage that failed with exactly the error an earlier failed
 * stage had, and began only after that one ended. Two branches of a `parallel`
 * that fail together with the same message overlap in time and are both real,
 * which is what the second condition is for. (A stage that really did fail,
 * later, with the very same message, is the one case it gets wrong — which is
 * why the exact way is used whenever it can be.)
 */
function refineStages(stages, { heuristic = true } = {}) {
  for (const stage of stages) {
    if (stage.status !== 'skipped' && stage.nodes?.length && stage.nodes.every((name) => name === STAGE_NOOP)) markSkipped(stage);
  }
  if (heuristic) {
    const failures = [];
    for (const stage of stages) {
      if (stage.status !== 'failed' || !stage.key) continue;
      // With real steps of its own it failed for real, whatever its error says.
      if (stage.nodes?.length) { failures.push({ key: stage.key, end: (stage.start ?? 0) + stage.duration }); continue; }
      const cause = failures.find((one) => one.key === stage.key && stage.start !== null && stage.start >= one.end - SEQUENCE_SLACK_MS);
      if (cause) markSkipped(stage);
      else failures.push({ key: stage.key, end: (stage.start ?? 0) + stage.duration });
    }
  }
  // Side by side: running at the same time as another stage. The parent of a `parallel` ends where its branches begin and is not one of them.
  const ran = stages.filter((stage) => stage.executed && stage.start !== null && stage.duration > 0);
  for (const stage of ran) {
    const end = stage.start + stage.duration;
    stage.parallel = ran.some((other) => other !== stage && other.start < end - SEQUENCE_SLACK_MS && stage.start < other.start + other.duration - SEQUENCE_SLACK_MS);
  }
  for (const stage of stages) { delete stage.key; delete stage.nodes; }
  return stages;
}

/** The names of every stage across some runs, in pipeline order: the newest run's order, with what only older runs had put back where it was. */
function stageNames(runs) {
  const names = [];
  for (const run of runs) {
    let after = -1;
    for (const stage of run.stages) {
      const at = names.indexOf(stage.name);
      if (at >= 0) { after = at; continue; }
      names.splice(after + 1, 0, stage.name);
      after += 1;
    }
  }
  return names;
}

/** How long each stage usually takes: over the runs that finished, the times it ran and passed. */
function stageAverages(runs) {
  const sums = new Map();
  for (const run of runs) {
    if (run.running) continue;
    for (const stage of run.stages) {
      if (!stage.executed || stage.status !== 'success') continue;
      const one = sums.get(stage.name) ?? { total: 0, n: 0 };
      one.total += stage.duration;
      one.n += 1;
      sums.set(stage.name, one);
    }
  }
  return Object.fromEntries([...sums].map(([name, one]) => [name, Math.round(one.total / one.n)]));
}

class JenkinsApi {
  #authorization = '';

  /**
   * @param {{ base: string, user?: string, token?: string, fetch: typeof fetch, timeout?: number }} options
   */
  constructor({ base, user = '', token = '', fetch, timeout = TIMEOUT, pinned = false, limiter = null, crumbRetryMs = 45_000 }) {
    this.base = normalizeBase(base);
    /** Whether a certificate was trusted for this server: a failure then means it changed, which is worth saying. */
    this.pinned = pinned;
    // Kept in one private field, so no `JSON.stringify(api)` or log of this object can carry them.
    if (user || token) this.#authorization = `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
    this.fetch = fetch;
    this.timeout = timeout;
    /** What reading the whole job list may take: three times a light question (60 s by default). */
    this.heavyTimeout = timeout === TIMEOUT ? HEAVY_TIMEOUT : timeout * 3;
    this.crumbHeader = null;
    /** When the crumb could not be had for a reason that is not "there are none": it is asked for again after this long. */
    this.crumbFailedAt = 0;
    this.crumbRetryMs = crumbRetryMs;
    /** How many requests this Jenkins is asked at once, following how it copes (see Limiter). */
    this.limiter = new Limiter({ now: () => Date.now(), ...(limiter ?? {}) });
  }

  // --- the wire ---------------------------------------------------------------

  /**
   * One request, read to the end, inside one timeout.
   *
   * `read`: 'bytes' (the body, capped at `max`), or 'none' (a verb whose
   * answer is only its status). Returns `{ status, headers, bytes, tooBig }`.
   */
  async #request(path, init = {}, options = {}) {
    const lane = options.high ? 'high' : (lanes.getStore()?.lane ?? 'high');
    let release;
    try {
      release = await this.limiter.acquire(lane, { maxHold: ((options.timeout ?? this.timeout) * 2) + 5000 });
    } catch (error) {
      if (error?.code === 'slow-wait') throw new JenkinsError('Jenkins is busy with other questions of this app and could not be asked that in time', 0, 'slow');
      throw error;
    }
    const started = Date.now();
    let timedOut = false;
    try {
      return await this.#send(path, init, options);
    } catch (error) {
      timedOut = error?.code === 'timeout';
      throw error;
    } finally {
      release();
      // Only a read that was a question (not a console that is waited on) says how Jenkins copes.
      if (!options.onChunk) this.limiter.record(Date.now() - started, timedOut);
    }
  }

  async #send(path, init = {}, { read = 'bytes', max = MAX_JSON, onChunk = null, timeout = this.timeout } = {}) {
    const controller = new AbortController();
    // The time allowed is for Jenkins to answer, and then for the next piece of the answer: a console that goes on arriving is
    // not cut off for being long. Nothing goes on for ever: `hard` is the most a whole answer may take.
    let timer = setTimeout(() => controller.abort(), timeout);
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), timeout); };
    const hard = setTimeout(() => controller.abort(), Math.max(timeout * 10, 600_000));
    hard.unref?.();
    // A fetch that does not honour its abort would hold this for ever: when the time is up, it is given up on here.
    const gaveUp = new Promise((resolve, reject) => { controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    gaveUp.catch(() => {});
    const method = init.method ?? 'GET';
    try {
      // English, so that what Jenkins names things in (a step called "Get contextual object from internal APIs") is the same on every server.
      const headers = { Accept: 'application/json', 'Accept-Language': 'en', ...init.headers };
      if (this.#authorization) headers.Authorization = this.#authorization;
      let response;
      try {
        response = await Promise.race([this.fetch(`${this.base}${path}`, { ...init, headers, signal: controller.signal, redirect: 'manual', credentials: 'omit' }), gaveUp]);
      } catch (error) {
        if (controller.signal.aborted) throw new JenkinsError(`Jenkins did not answer within ${Math.round(timeout / 1000)} seconds`, 0, 'timeout');
        // Electron's way of saying "a redirect": it throws instead of returning the 3xx.
        if (REDIRECT_CANCELLED.test(String(error?.message ?? '')) || REDIRECT_CANCELLED.test(String(error?.cause?.message ?? ''))) {
          response = { status: 302, headers: { get: () => null }, body: null, text: async () => '' };
        } else {
          const problem = certificateProblem(error);
          if (problem) {
            throw new JenkinsError(
              this.pinned
                ? `The certificate of this Jenkins ${problem} — it is not the one you trusted for this server. Look at it again in the server's settings before trusting the new one`
                : `The certificate of this Jenkins ${problem}. If you know it is yours, look at it in the server's settings and trust it for this server`,
              0, 'certificate',
            );
          }
          throw new JenkinsError(`Could not reach Jenkins: ${reasonOf(error)}`);
        }
      }
      const status = response.status;
      if ((status >= 300 && status < 400) || status === 0) {
        // After a POST this is Jenkins sending you back to the page you were on, which is how it says it did it.
        if (method === 'POST') return { status: status || 302, headers: response.headers, bytes: Buffer.alloc(0), tooBig: false };
        const location = String(response.headers.get('location') ?? '');
        if (!location || /\/login\b|\/securityRealm\//.test(location)) {
          throw new JenkinsError('Jenkins sent the request to another page, most likely its login page — the user or token is not accepted, or the address has to be the one it redirects to', 401);
        }
        throw new JenkinsError('Jenkins answered with a redirect. Use the address it redirects to — this app does not follow redirects, so as to never hand your token to another address', 302);
      }
      // An answer that is an error is not read: its connection is given back at once, not when something collects it.
      if (status >= 400) { try { void response.body?.cancel?.()?.catch?.(() => {}); } catch { /* nothing to give back */ } }
      if (status === 401) throw new JenkinsError('Jenkins did not accept that user and token', 401);
      if (status === 403) {
        // Without credentials, a 403 is Jenkins asking who this is, not telling you what you may do.
        if (!this.#authorization) throw new JenkinsError('This Jenkins wants a user and an API token', 403);
        throw new JenkinsError(
          this.crumbHeader && Object.keys(this.crumbHeader).length
            ? 'Jenkins refused that. If the last field is your password rather than an API token, make a token in Jenkins and use that'
            : method === 'POST'
              ? 'Jenkins refused that. Either this user is not allowed to do it, or Jenkins wants a crumb it did not give (a login that is a password rather than an API token does that): check the permission, or use an API token'
              : 'Jenkins knows who you are but does not allow that',
          403,
        );
      }
      if (status === 404) throw new JenkinsError('Jenkins has nothing there', 404);
      if (status >= 400) throw new JenkinsError(`Jenkins answered ${status}`, status);
      if (read === 'none') {
        try { await response.body?.cancel?.(); } catch { /* nothing was wanted from it */ }
        return { status, headers: response.headers, bytes: Buffer.alloc(0), tooBig: false };
      }
      try {
        // Handed on as it arrives, for what is too big to hold: the time allowed still runs while it does.
        if (onChunk) {
          const { tooBig } = await Promise.race([streamBytes(response, max, onChunk, touch), gaveUp]);
          return { status, headers: response.headers, bytes: Buffer.alloc(0), tooBig };
        }
        const { bytes, tooBig } = await Promise.race([readBytes(response, max, touch), gaveUp]);
        return { status, headers: response.headers, bytes, tooBig };
      } catch (error) {
        if (controller.signal.aborted) throw new JenkinsError(`Jenkins stopped answering after ${Math.round(timeout / 1000)} seconds`, 0, 'timeout');
        throw new JenkinsError(`The answer from Jenkins was cut off: ${reasonOf(error)}`);
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(hard);
    }
  }

  async #json(path, options = {}) {
    const { bytes, tooBig } = await this.#request(path, {}, options);
    if (tooBig) throw new JenkinsError(`Jenkins sent more than ${Math.round(MAX_JSON / 1048576)} MB for one answer, which this app will not read`);
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new JenkinsError('That address answered, but not like Jenkins does. Is it the one you open Jenkins at?');
    }
  }

  async #crumb() {
    if (this.crumbHeader !== null && !(this.crumbFailedAt && Date.now() - this.crumbFailedAt >= this.crumbRetryMs)) return this.crumbHeader;
    try {
      const body = await this.#json('/crumbIssuer/api/json');
      // A header name from a server is a header name only if it looks like one.
      this.crumbHeader = /^[\w-]{1,64}$/.test(String(body.crumbRequestField)) && /^[\w-]{1,256}$/.test(String(body.crumb))
        ? { [body.crumbRequestField]: body.crumb }
        : {};
      this.crumbFailedAt = 0;
    } catch (error) {
      // No issuer (404) is an answer: this Jenkins needs no crumb, and that is kept. Anything else (a timeout, a 5xx, a busy
      // moment) says nothing about crumbs, and is remembered only for a little while.
      this.crumbHeader = {};
      this.crumbFailedAt = error?.status === 404 ? 0 : Date.now();
    }
    return this.crumbHeader;
  }

  /** Whether a refusal may be a crumb that was not had (or has gone stale): worth asking for one, once. */
  #crumbMayHelp(error) {
    return error.status === 403 && (Object.keys(this.crumbHeader ?? {}).length > 0 || this.crumbFailedAt > 0);
  }

  async #post(path, body) {
    const send = async () => this.#request(path, {
      method: 'POST',
      headers: { ...(await this.#crumb()), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body,
    }, { read: 'none' });
    try {
      return await send();
    } catch (error) {
      // A crumb goes stale when Jenkins restarts, or was never had: take a new one, once.
      if (this.#crumbMayHelp(error)) {
        this.crumbHeader = null;
        this.crumbFailedAt = 0;
        return send();
      }
      throw error;
    }
  }

  // --- raw access, for what is built on top of this (jenkins-extras.js) -------

  /**
   * Any page under the server, read to the end and capped: `{ status, headers, bytes, tooBig }`.
   * The path is the caller's, built with `jobPath`/`segment` — never from what a panel typed — and has to be one.
   */
  async rawGet(path, { max = MAX_JSON, accept = 'application/json' } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || /[\u0000-\u001f\u007f]/.test(path)) throw new JenkinsError('That is not a page of a Jenkins');
    return this.#request(path, { headers: { Accept: accept } }, { max });
  }

  /**
   * A form posted to any page under the server, with the crumb. By default only its status and headers come back
   * (what a form that redirects says); `read: 'bytes'` keeps the answer, capped at `max`.
   */
  async rawPost(path, body = '', { read = 'none', max = MAX_JSON } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || /[\u0000-\u001f\u007f]/.test(path)) throw new JenkinsError('That is not a page of a Jenkins');
    const send = async () => this.#request(path, {
      method: 'POST',
      headers: { ...(await this.#crumb()), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body,
    }, { read, max });
    try {
      return await send();
    } catch (error) {
      // A crumb goes stale when Jenkins restarts: take a new one, once.
      if (this.#crumbMayHelp(error)) {
        this.crumbHeader = null;
        this.crumbFailedAt = 0;
        return send();
      }
      throw error;
    }
  }

  // --- the server -------------------------------------------------------------

  /** Who this is, and what Jenkins it is: the answer that proves the credentials. */
  /**
   * Whether Jenkins answers at all: the smallest question there is, asked first in line. A slow answer to a heavy question
   * is not the same as a server that is not there, and this is what tells them apart.
   */
  async alive() {
    try {
      await this.#json('/api/json?tree=mode', { timeout: 10000, high: true });
      return true;
    } catch (error) {
      // Refusing us is an answer: the server is there.
      return error?.status >= 400 && error.status < 500;
    }
  }

  async ping() {
    const { bytes, headers } = await this.#request('/api/json?tree=nodeDescription,mode,useCrumbs');
    let body = {};
    try { body = JSON.parse(bytes.toString('utf8')); } catch { throw new JenkinsError('That address answered, but not like Jenkins does'); }
    let user = null;
    try { user = (await this.#json('/me/api/json?tree=fullName,id')).fullName ?? null; } catch { /* anonymous access */ }
    const version = String(headers.get('x-jenkins') ?? '').slice(0, 40) || null;
    return { version, user, description: String(body.nodeDescription ?? '').slice(0, 200) };
  }

  // --- jobs and folders -------------------------------------------------------

  /** What is directly inside a folder (or the root). */
  async children(path = '') {
    const body = await this.#json(`${jobPath(path)}/api/json?tree=jobs[${JOB_FIELDS},jobs[name]]`, { timeout: this.heavyTimeout });
    return (body.jobs ?? []).map((job) => jobRow(job, path));
  }

  /**
   * Every job under a folder, to any depth — what search and the smart views
   * are built from. A request returns two levels at once, so a server of a few
   * folders is one or two calls and not one per folder; the folders found
   * below that are read a few at a time. One a user may not read does not
   * blank the rest. The result stops at `maxRows`, and says so on `.truncated`.
   */
  async everything(path = '', { limit = 6, depth = 6, maxRows = MAX_ROWS } = {}) {
    const rows = [];
    rows.truncated = false;
    /** Folders that were there and could not be opened: what a count of jobs leaves out. */
    rows.unreadable = 0;
    let queue = [path];
    let level = 0;
    while (queue.length && level <= depth && !rows.truncated) {
      const batch = queue;
      queue = [];
      const found = await mapLimit(batch, limit, async (folder) => {
        try {
          const body = await this.#json(`${jobPath(folder)}/api/json?tree=${TWO_LEVELS}`, { timeout: this.heavyTimeout });
          return { folder, children: body.jobs ?? [] };
        } catch (error) {
          // A folder inside that this user may not open does not blank the rest; the front page itself not opening is the
          // answer to the whole question ("no access"), not an empty server.
          if (folder === path && level === 0) {
            if (error.status === 403 && !this.#authorization) throw error;
            if (error.status === 403) throw new JenkinsError('This user is not allowed to see the jobs on this Jenkins', 403);
            if (error.status === 404) throw new JenkinsError('That address answers, but is not the front page of a Jenkins — check the address', 404);
          }
          if (error.status === 403 || error.status === 404) { rows.unreadable += 1; return { folder, children: [] }; }
          throw error;
        }
      });
      for (const { folder, children } of found) {
        for (const child of children) {
          const row = jobRow(child, folder);
          // Its own children came with it: the rows below, and the folders to open next.
          if (row.kind === 'folder' && Array.isArray(child.jobs)) {
            for (const grand of child.jobs) {
              const grandRow = jobRow(grand, row.path);
              if (grandRow.kind === 'folder') queue.push(grandRow.path);
              pushRow(rows, grandRow, maxRows);
            }
          }
          pushRow(rows, row, maxRows);
        }
      }
      level += 2;
    }
    return rows;
  }

  /**
   * One job in full: its builds, its parameters, whether it can be run.
   *
   * `builds` is how many of the newest builds to list — as many as there are
   * numbers newer than what the caller already has, and no more, so that a job
   * with a thousand builds does not send forty of them every time it is
   * opened. `newest` is the number of the last one, listed or not.
   */
  async job(path, { builds = 40 } = {}) {
    const wanted = Math.min(100, Math.max(0, Math.floor(Number(builds)) || 0));
    const body = await this.#json(
      `${jobPath(path)}/api/json?tree=_class,name,fullName,description,buildable,inQueue,color,lastBuild[number],` +
      'property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]],' +
      'healthReport[score,description]' +
      (wanted ? `,builds[number,result,building,timestamp,duration]{0,${wanted}}` : ''),
    );
    const definitions = (body.property ?? []).flatMap((one) => one.parameterDefinitions ?? []).slice(0, 200);
    return {
      // The newest build it lists is the last one only if it lists any: `lastBuild` here is just its number.
      ...jobRow({ ...body, lastBuild: body.builds?.[0] }, path.split('/').slice(0, -1).join('/')),
      path,
      buildable: body.buildable !== false,
      inQueue: Boolean(body.inQueue),
      healthText: String(body.healthReport?.[0]?.description ?? '').slice(0, 300),
      parameters: definitions.map((one) => ({
        name: one.name,
        type: String(one.type ?? '').replace(/ParameterDefinition$/, '').toLowerCase() || 'string',
        description: String(one.description ?? '').slice(0, 500),
        // A password's default is never sent to the panel; Jenkins would not either.
        default: one.type === 'PasswordParameterDefinition' ? '' : (one.defaultParameterValue?.value ?? ''),
        choices: Array.isArray(one.choices) ? one.choices.slice(0, 500) : null,
        secret: one.type === 'PasswordParameterDefinition',
      })),
      builds: (body.builds ?? []).map(buildRow),
      newest: body.lastBuild?.number ?? null,
    };
  }

  /** The number of a job's newest build, or null: the smallest question that says how far it has got. */
  async lastNumber(path) {
    return (await this.#json(`${jobPath(path)}/api/json?tree=lastBuild[number]`)).lastBuild?.number ?? null;
  }

  /** One build in full: what started it, what changed, how far it got. */
  async build(path, number) {
    const n = buildNumber(number);
    const base = `${jobPath(path)}/${n}`;
    const body = await this.#json(
      `${base}/api/json?tree=number,result,building,timestamp,duration,estimatedDuration,displayName,description,` +
      'actions[causes[shortDescription],parameters[name,value]],' +
      'changeSets[items[commitId,msg,author[fullName]]{0,50}],' +
      'artifacts[fileName,relativePath]{0,200},builtOn',
    );
    const actions = body.actions ?? [];
    const stages = await this.#describe(base);
    // A running build has not skipped anything yet; a finished one with a single failure has nothing to correct.
    // With several, the console says exactly which never ran; without the console, the stages' own errors are a good guess.
    const several = !body.building && stages.filter((stage) => stage.status === 'failed').length > 1;
    const exact = several ? await this.#markSkipped(path, n, stages) : false;
    refineStages(stages, { heuristic: several && !exact });
    const paused = stages.find((stage) => stage.paused);
    const input = paused ? await this.pendingInput(path, n) : null;
    if (paused) paused.input = input;
    return {
      ...buildRow(body),
      path,
      name: String(body.displayName ?? `#${body.number}`).slice(0, 200),
      description: String(body.description ?? '').slice(0, 1000),
      estimated: body.estimatedDuration ?? 0,
      // How far a running build is, by Jenkins' own estimate of how long it takes: never full while it still runs.
      ...(body.building && body.estimatedDuration > 0 && body.timestamp ? { progress: Math.min(0.99, Math.max(0, (Date.now() - body.timestamp) / body.estimatedDuration)) } : {}),
      agent: body.builtOn || 'built-in',
      causes: actions.flatMap((one) => one.causes ?? []).map((one) => one.shortDescription).filter(Boolean).slice(0, 20),
      parameters: actions.flatMap((one) => one.parameters ?? []).map((one) => ({ name: one.name, value: parameterValue(one.name, one.value) })).slice(0, 200),
      changes: (body.changeSets ?? []).flatMap((set) => set.items ?? []).map((one) => ({
        id: String(one.commitId ?? '').slice(0, 8),
        message: String(one.msg ?? '').split('\n')[0].slice(0, 300),
        author: one.author?.fullName ?? '',
      })).slice(0, 100),
      artifacts: (body.artifacts ?? []).map((one) => ({ name: one.fileName, path: one.relativePath })),
      stages,
      input,
    };
  }

  /**
   * Stages the console says were skipped. Returns whether it could be read:
   * a reader that could not has not learned anything and falls back to guessing.
   */
  async #markSkipped(path, number, stages) {
    let text;
    try { text = (await new LogStream(this, path, number, { tailBytes: 2_000_000 }).read()).text; } catch { return false; }
    for (const [, name] of text.matchAll(/Stage "([^"\n]{1,200})" skipped due to/g)) {
      for (const stage of stages) if (stage.name === name && stage.status === 'failed') markSkipped(stage);
    }
    return true;
  }

  /** The stages of one build, from the Pipeline Stage View plugin. An empty list when it is not there. */
  async #describe(base) {
    try {
      const body = await this.#json(`${base}/wfapi/describe`);
      return (body.stages ?? []).slice(0, 200).map(stageShape);
    } catch {
      return [];
    }
  }

  /**
   * Which stages were executed in each of a job's last runs.
   *
   * From the Pipeline Stage View plugin's `wfapi/runs`, which sends the runs
   * newest first with their stages in one flat list: the branches of a
   * `parallel` come as stages of their own, side by side in time. Asked with
   * `fullStages` so that each stage's steps come too, which is how a stage
   * that was skipped is told from one that failed (see `refineStages`).
   * `since` keeps it to the runs wanted: on a job with a thousand builds an
   * unbounded call is a megabyte. Not a pipeline, or no plugin: `available`
   * is false and it is not an error.
   *
   * @param last the number of the job's newest build, when the caller already knows it
   */
  async stages(path, count = 10, { last = null } = {}) {
    const asked = Number(count);
    const wanted = Number.isFinite(asked) ? Math.min(30, Math.max(1, Math.floor(asked))) : 10;
    let newest = Number.isInteger(last) && last > 0 ? last : null;
    if (newest === null) {
      try { newest = await this.lastNumber(path); } catch (error) {
        if (error.status === 404) return { available: false, names: [], runs: [], averages: {} };
        throw error;
      }
    }
    const got = await this.runs(path, newest ? Math.max(1, newest - wanted + 1) : null);
    if (!got.available) return { available: false, names: [], runs: [], averages: {} };
    const runs = got.runs.slice(0, wanted);
    return { available: true, names: stageNames(runs), runs, averages: stageAverages(runs) };
  }

  /**
   * The runs of a pipeline from number `since` on — all of them, newest first —
   * with their stages (see `stages`). `available` is false for a job that is
   * not a pipeline, or has no plugin, or is not there.
   */
  async runs(path, since = null) {
    let raw;
    try {
      raw = await this.#json(`${jobPath(path)}/wfapi/runs?fullStages=true${since ? `&since=%23${Math.max(1, Math.floor(since))}` : ''}`);
    } catch (error) {
      if (error.status === 404) return { available: false, runs: [] };
      throw error;
    }
    if (!Array.isArray(raw)) return { available: false, runs: [] };
    const runs = raw.slice(0, 500).map((run) => {
      const stages = refineStages((run.stages ?? []).slice(0, 200).map(stageShape));
      const running = run.status === 'IN_PROGRESS' || run.status === 'PAUSED_PENDING_INPUT';
      // The stage API's words for a run (FAILED, not FAILURE). A run that was never executed is one that did not start: a script that would not compile.
      const word = stageStatus(run.status);
      const status = word === 'skipped' ? 'failed' : word;
      return {
        number: Number(run.id),
        status,
        running,
        timestamp: run.startTimeMillis ?? null,
        duration: run.durationMillis ?? 0,
        estimated: null,
        stages,
        input: null,
      };
    }).filter((run) => Number.isInteger(run.number));
    // Who is waiting for an answer is asked once for each run that is, not for all of them.
    for (const run of runs) {
      const paused = run.stages.find((stage) => stage.paused);
      if (!paused) continue;
      run.input = await this.pendingInput(path, run.number);
      paused.input = run.input;
    }
    return { available: true, runs };
  }

  /**
   * The stage a running build is in, and whether it has stages at all: a
   * freestyle job answers 404 to every question about them, which is worth
   * knowing once and not asking again every few seconds.
   *
   * @returns {{ pipeline: boolean, stage: string|null, input?: boolean }} `input`: a stage is paused for somebody to answer it.
   */
  async currentStageOf(path, number) {
    const n = buildNumber(number);
    try {
      const body = await this.#json(`${jobPath(path)}/${n}/wfapi/describe`);
      const live = (body.stages ?? []).filter((stage) => stage.status === 'IN_PROGRESS' || stage.status === 'PAUSED_PENDING_INPUT');
      return { pipeline: true, stage: live.length ? live.map((stage) => String(stage.name ?? '').slice(0, 100)).slice(0, 3).join(' · ') : null, input: live.some((stage) => stage.status === 'PAUSED_PENDING_INPUT') };
    } catch (error) {
      return { pipeline: error.status !== 404, stage: null };
    }
  }

  /**
   * How one build stands, and nothing else: the smallest question that says
   * whether a build that was running is still, and how it ended. Null if
   * Jenkins no longer has it.
   */
  async buildSummary(path, number) {
    const n = buildNumber(number);
    try {
      return buildRow(await this.#json(`${jobPath(path)}/${n}/api/json?tree=number,result,building,timestamp,duration`));
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Who the credentials are: `{ id, fullName }`, or null for anonymous access.
   * What "my builds" is measured against.
   */
  async me() {
    try {
      const body = await this.#json('/me/api/json?tree=id,fullName');
      return body.id ? { id: String(body.id).slice(0, 200), fullName: String(body.fullName ?? '').slice(0, 200) } : null;
    } catch (error) {
      if (error.status === 403 || error.status === 404 || error.status === 401) return null;
      throw error;
    }
  }

  /**
   * How a build ended, and who asked for it: the facts a notification is
   * judged from, in one small request. `users` are the ids of the people the
   * build says started it (its causes), which is what "mine" means. Null if
   * Jenkins no longer has the build.
   */
  async buildFacts(path, number) {
    const n = buildNumber(number);
    try {
      return factsOf(await this.#json(`${jobPath(path)}/${n}/api/json?tree=${FACTS}`));
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  /**
   * The builds of a job after number `after` that have finished, oldest first,
   * as facts: what a job did since it was last judged, including every build
   * that ended between two looks. At most `limit` (the newest of them) — a job
   * that ran a thousand times while nobody was looking is not told about each.
   */
  async buildsAfter(path, after = 0, limit = 20) {
    const wanted = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 20));
    const body = await this.#json(`${jobPath(path)}/api/json?tree=builds[${FACTS}]{0,${wanted}}`);
    return (body.builds ?? []).map(factsOf).filter((one) => one.number > after && !one.running).sort((a, b) => a.number - b.number);
  }

  /** The stage a running build is in now: its name, or null. Several side by side are named together. */
  async currentStage(path, number) {
    const n = buildNumber(number);
    try {
      const body = await this.#json(`${jobPath(path)}/${n}/wfapi/describe`);
      const live = (body.stages ?? []).filter((stage) => stage.status === 'IN_PROGRESS' || stage.status === 'PAUSED_PENDING_INPUT');
      return live.length ? live.map((stage) => String(stage.name ?? '').slice(0, 100)).slice(0, 3).join(' · ') : null;
    } catch {
      return null;
    }
  }

  /**
   * What a build that stopped to ask a question is asking, read and not answered: `{ message, id, ok, params }` or null.
   * `params` are the fields of the form (a plain "proceed" has none), a password's default never among what is sent.
   */
  async pendingInput(path, number) {
    const n = buildNumber(number);
    try {
      const actions = await this.#json(`${jobPath(path)}/${n}/wfapi/pendingInputActions`);
      const first = Array.isArray(actions) ? actions[0] : null;
      if (!first) return null;
      const params = (Array.isArray(first.inputs) ? first.inputs : []).slice(0, 50).map((one) => {
        const type = String(one.type ?? one.definition?.type ?? '').replace(/ParameterDefinition$/, '').toLowerCase() || 'string';
        const secret = type === 'password' || parameterValue(one.name, 'x') !== 'x';
        const def = one.definition ?? {};
        return {
          name: String(one.name ?? '').slice(0, 200),
          type,
          description: String(one.description ?? '').slice(0, 500),
          default: secret ? '' : String(def.defaultVal ?? def.defaultValue ?? ''),
          choices: Array.isArray(def.choices) ? def.choices.slice(0, 500).map(String) : null,
          secret,
        };
      });
      return { message: String(first.message ?? '').slice(0, 500), id: String(first.id ?? '').slice(0, 200), ok: String(first.proceedText ?? '').slice(0, 100), params };
    } catch {
      return null;
    }
  }

  /** Answer a pipeline's `input`: proceed (with the fields of its form, if it has any). `id` is what `pendingInput` said. */
  async inputSubmit(path, number, id, params = null) {
    const where = `${jobPath(path)}/${buildNumber(number)}`;
    const entries = Object.entries(params ?? {});
    const base = `${where}/input/${encodeURIComponent(segment(id, 'input id'))}`;
    let response;
    if (!entries.length) response = await this.#post(`${base}/proceedEmpty`);
    else {
      const form = new URLSearchParams();
      form.set('json', JSON.stringify({ parameter: entries.map(([name, value]) => ({ name: segment(name, 'field name'), value: String(value ?? '') })) }));
      form.set('proceed', 'Proceed');
      response = await this.#post(`${base}/submit`, form.toString());
    }
    return { ok: true, ...this.#answered(response, [where, jobPath(path)]) };
  }

  /** Abort a pipeline at its `input`: the build ends aborted. */
  async inputAbort(path, number, id) {
    const where = `${jobPath(path)}/${buildNumber(number)}`;
    const response = await this.#post(`${where}/input/${encodeURIComponent(segment(id, 'input id'))}/abort`);
    return { ok: true, ...this.#answered(response, [where, jobPath(path)]) };
  }

  /** Let a job be built again, or stop it from being: Jenkins' own disable/enable. */
  async setEnabled(path, enabled) {
    const clean = jobPath(path);
    if (!clean) throw new JenkinsError('job name is missing');
    const response = await this.#post(`${clean}/${enabled ? 'enable' : 'disable'}`);
    return { ok: true, ...this.#answered(response, [clean]) };
  }

  /**
   * Take an agent offline, with the reason everyone will see in Jenkins, or bring it back. Jenkins only has a toggle: the
   * caller says what it expects and this only toggles if the agent is not already so. The built-in node is `(built-in)`.
   */
  async setNodeOffline(name, offline, message = '') {
    const text = String(name ?? '').trim();
    const node = /^(built-?in( node)?|master|\(built-in\))$/i.test(text) ? '(built-in)' : segment(text, 'agent name');
    const url = `/computer/${node === '(built-in)' ? node : encodeURIComponent(node)}`;
    const now = await this.#json(`${url}/api/json?tree=offline,temporarilyOffline`).catch((error) => { if (error.status === 404) throw new JenkinsError('Jenkins has no agent by that name'); throw error; });
    // Only what a person set is a person's to undo: an agent that is offline because it is not connected cannot be toggled online.
    if (offline === Boolean(now.temporarilyOffline) || (!offline && !now.temporarilyOffline)) return { ok: true, changed: false };
    const reason = String(message ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    const response = await this.#post(`${url}/toggleOffline?offlineMessage=${encodeURIComponent(reason)}`);
    return { ok: true, changed: true, ...this.#answered(response, [url, '/computer']) };
  }

  /** Whether an agent is offline, and whether a person made it so — what a toggle is checked against. */
  async nodeState(name) {
    const text = String(name ?? '').trim();
    const node = /^(built-?in( node)?|master|\(built-in\))$/i.test(text) ? '(built-in)' : segment(text, 'agent name');
    const body = await this.#json(`/computer/${node === '(built-in)' ? node : encodeURIComponent(node)}/api/json?tree=offline,temporarilyOffline`);
    return { offline: Boolean(body.offline), temporarilyOffline: Boolean(body.temporarilyOffline) };
  }

  /**
   * The test report of a build (JUnit and the like): counts, and the failing cases with the first lines of why. Null if
   * the build has none (no plugin, or no tests); counts only if the report is more than this app reads.
   */
  async testReport(path, number) {
    const base = `${jobPath(path)}/${buildNumber(number)}/testReport/api/json`;
    let counts;
    try {
      counts = await this.#json(`${base}?tree=duration,failCount,passCount,skipCount`);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
    const out = {
      total: (counts.failCount ?? 0) + (counts.passCount ?? 0) + (counts.skipCount ?? 0),
      passed: counts.passCount ?? 0, failed: counts.failCount ?? 0, skipped: counts.skipCount ?? 0,
      duration: Math.round((counts.duration ?? 0) * 1000), failures: [], truncated: false,
    };
    if (!out.failed) return out;
    try {
      const body = await this.#json(`${base}?tree=suites[name,cases[className,name,status,age,errorDetails]]`);
      for (const suite of body.suites ?? []) {
        for (const one of suite.cases ?? []) {
          if (one.status !== 'FAILED' && one.status !== 'REGRESSION') continue;
          if (out.failures.length >= 50) { out.truncated = true; break; }
          out.failures.push({
            suite: String(one.className || suite.name || '').slice(0, 200),
            name: String(one.name ?? '').slice(0, 300),
            age: Number(one.age) || 0,
            status: one.status === 'REGRESSION' ? 'regression' : 'failed',
            error: String(one.errorDetails ?? '').split('\n').slice(0, 3).join('\n').slice(0, 400),
          });
        }
        if (out.truncated) break;
      }
    } catch { out.truncated = true; }
    return out;
  }

  /** The newest builds of a job with what changed in each: what a comparison of two builds is made of. */
  async buildsWithChanges(path, limit = 100) {
    const wanted = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 100));
    const body = await this.#json(`${jobPath(path)}/api/json?tree=builds[number,result,building,timestamp,duration,changeSets[items[commitId,msg,author[fullName]]{0,50}]]{0,${wanted}}`);
    return (body.builds ?? []).map((one) => ({
      ...buildRow(one),
      result: one.result ?? null,
      changes: (one.changeSets ?? []).flatMap((set) => set.items ?? []).map((item) => ({
        id: String(item.commitId ?? '').slice(0, 8), message: String(item.msg ?? '').split('\n')[0].slice(0, 300), author: item.author?.fullName ?? '',
      })).slice(0, 100),
    }));
  }

  // --- the console ------------------------------------------------------------

  /**
   * One read of the raw console from a file offset: the body as bytes, the
   * offset to ask from next (Jenkins' own `X-Text-Size`, a position in the
   * file) and whether Jenkins is still writing. A start past the end is not an
   * empty answer on a real Jenkins — it is the whole console from the top —
   * so a reader only ever asks from a number it was given.
   */
  async logRead(path, number, start = 0, { max = MAX_LOG_READ } = {}) {
    const n = buildNumber(number);
    // An integer however it was spelled: `1e21` would be written into the address as `1e+21`.
    const from = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(start)) || 0));
    const { bytes, headers, tooBig } = await this.#request(
      `${jobPath(path)}/${n}/logText/progressiveText?start=${from}`,
      { headers: { Accept: 'text/plain' } },
      { max },
    );
    if (tooBig) throw new JenkinsError(`That console grew by more than ${Math.round(max / 1048576)} MB in one go, which this app will not read. Open it in Jenkins`);
    const size = Number(headers.get('x-text-size'));
    return {
      bytes,
      next: Number.isFinite(size) && size >= 0 ? size : from + bytes.length,
      more: headers.get('x-more-data') === 'true',
    };
  }

  /** How long the console is, in the file's own bytes, without reading any of it. Null if Jenkins does not say. */
  async logSize(path, number) {
    const n = buildNumber(number);
    // A negative start is an empty answer with the size on it.
    const { headers } = await this.#request(`${jobPath(path)}/${n}/logText/progressiveText?start=-1`, { headers: { Accept: 'text/plain' } }, { max: 1024 });
    const size = Number(headers.get('x-text-size'));
    return Number.isFinite(size) && size >= 0 ? size : null;
  }

  /** A console to follow: `read()` returns what is new each time, and keeps what is not yet safe to show. */
  logStream(path, number, options = {}) {
    return new LogStream(this, path, number, options);
  }

  /**
   * The console from a byte offset on, cleaned, in one stateless read.
   * `next` is where to ask from the next time and `more` is whether Jenkins is
   * still writing. A caller that follows a build should use `logStream`: this
   * cannot carry an unfinished line over to the next read.
   */
  async log(path, number, start = 0) {
    const read = await this.logRead(path, number, start);
    const hold = read.more ? holdBack(read.bytes) : 0;
    // Nothing is carried over, so what is not safe to show is dropped — except a plain character, which is only cut in two.
    const keep = read.bytes.subarray(0, read.bytes.length - hold);
    return { text: cleanText(keep.toString('utf8')), next: read.next, more: read.more };
  }

  /**
   * A console from a file offset on, handed to `onText` as it arrives and
   * never held whole. `carry` is what an earlier read left unfinished (see
   * `holdBack`), to go in front; what this one leaves is returned for the
   * next — which is how a console is read in pieces, over hours, from where
   * it was last read and never from the start.
   *
   * @returns {{ next: number, more: boolean, carry: Buffer, truncated: boolean }}
   */
  async logPipe(path, number, { from = 0, carry = Buffer.alloc(0), dropToLine = false, max = MAX_LOG_READ, onText }) {
    const n = buildNumber(number);
    const start = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(from)) || 0));
    const cleaner = new LogCleaner({ dropToLine });
    cleaner.carry = carry;
    let truncated = false;
    let total = 0;
    const pass = async (text, cut) => {
      if (cut) truncated = true;
      if (text) await onText(text);
    };
    const { headers, tooBig } = await this.#request(
      `${jobPath(path)}/${n}/logText/progressiveText?start=${start}`,
      { headers: { Accept: 'text/plain' } },
      { max, onChunk: async (chunk) => { total += chunk.length; const out = cleaner.push(Buffer.from(chunk), true); await pass(out.text, out.truncated); } },
    );
    // Cut off at the limit: what was handed over is not the console, and saying nothing would make it look like one.
    if (tooBig) throw new JenkinsError(`That console grew by more than ${Math.round(max / 1048576)} MB in one go, which this app will not read. Open it in Jenkins`);
    const more = headers.get('x-more-data') === 'true';
    // Still being written: what is not yet safe to show waits for the next read. Finished: all of it goes out.
    const last = cleaner.push(Buffer.alloc(0), more);
    await pass(last.text, last.truncated);
    const size = Number(headers.get('x-text-size'));
    return { next: Number.isFinite(size) && size >= 0 ? size : start + total, more, carry: cleaner.carry, truncated };
  }

  /**
   * A console handed to `onText` as it arrives, cleaned, and never held whole:
   * for keeping one, where a 50 MB console must not become 50 MB in memory.
   * At most `tailBytes` of its end are read — a longer one begins at a line,
   * with `truncated` and `skipped` saying so.
   *
   * @returns {{ rawSize: number|null, truncated: boolean, skipped: number, next: number, more: boolean, carry: Buffer }}
   */
  async logToSink(path, number, { tailBytes, onText }) {
    const size = await this.logSize(path, number);
    const start = size !== null && size > tailBytes ? size - tailBytes : 0;
    // A little more than was asked for: the CRLFs of the body are not in the file's count.
    const read = await this.logPipe(path, number, { from: start, dropToLine: start > 0, max: tailBytes + tailBytes / 8 + 65536, onText });
    return { rawSize: size, truncated: read.truncated || start > 0, skipped: start, next: read.next, more: read.more, carry: read.carry };
  }

  /** The end of a console, from a clean line: what a brief and a first look need, however long it is. */
  async tail(path, number, bytes = LOG_TAIL_BYTES) {
    const stream = new LogStream(this, path, number, { tailBytes: bytes });
    const chunk = await stream.read();
    return { text: chunk.text, truncated: chunk.truncated, more: chunk.more, next: chunk.next };
  }

  // --- doing things -----------------------------------------------------------

  /**
   * Start a job. A job that takes parameters has to be started the other way
   * even with none given — Jenkins then uses their defaults — and one that
   * does not refuses the other way, so the caller says which it is.
   */
  async run(path, params = null, parameterized = false) {
    const clean = jobPath(path);
    if (!clean) throw new JenkinsError('job name is missing');
    let response;
    if (parameterized || (params && Object.keys(params).length)) {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(params ?? {})) form.set(segment(key, 'parameter name'), String(value ?? ''));
      response = await this.#post(`${clean}/buildWithParameters`, form.toString());
    } else {
      response = await this.#post(`${clean}/build`);
    }
    const location = String(response.headers.get('location') ?? '');
    const queued = /\/queue\/item\/(\d+)/.exec(location);
    // A redirect that is not to the queue item is Jenkins sending the request somewhere else — nearly always its login
    // page, when the session or the token is no longer good — and not a build that was queued.
    if (!queued && response.status >= 300 && response.status < 400) {
      throw new JenkinsError('Jenkins redirected the request instead of queuing it — most likely to its login page. Check the user and token, then try again', 401);
    }
    return { queued: queued ? Number(queued[1]) : null };
  }

  /**
   * Ask a running build to stop; `hard` is Jenkins' kill, for one that ignores
   * the request. A real Jenkins answers either with a redirect back to the
   * build, which is success.
   */
  async stop(path, number, { hard = false } = {}) {
    const n = buildNumber(number);
    const where = `${jobPath(path)}/${n}`;
    const response = await this.#post(`${where}/${hard ? 'kill' : 'stop'}`);
    return { ok: true, ...this.#answered(response, [where, jobPath(path)]) };
  }

  /**
   * What a POST that was answered with a redirect means. Jenkins says "done" by sending the person back to the page they
   * were on, so a redirect to a page of the same Jenkins under the thing acted on is a yes; one to its login page, or to
   * anywhere else, is a no; and one whose destination cannot be read (Electron throws instead of handing it over) is
   * not known — `unconfirmed`, for the caller to find out by looking.
   */
  #answered(response, under) {
    if (response.status < 300 || response.status >= 400) return {};
    const location = String(response.headers?.get?.('location') ?? '');
    if (!location) return { unconfirmed: true };
    let target;
    try { target = new URL(location, this.base); } catch { throw new JenkinsError('Jenkins did not confirm that — it sent the request somewhere unreadable, most likely because the login expired', 401); }
    const origin = new URL(this.base);
    const root = origin.pathname.replace(/\/+$/, '');
    const inside = target.origin === origin.origin && target.pathname.startsWith(root || '/') ? target.pathname.slice(root.length) || '/' : null;
    if (inside === null || /\/login\b|\/securityRealm\//.test(inside)) {
      throw new JenkinsError('Jenkins did not confirm that — it sent the request to another page, most likely because the login expired', 401);
    }
    const decoded = (text) => { try { return decodeURIComponent(text); } catch { return text; } };
    if (inside === '/' || inside.startsWith('/queue') || under.some((one) => decoded(inside).startsWith(decoded(one)))) return {};
    throw new JenkinsError('Jenkins did not confirm that — it sent the request to another page, most likely because the login expired', 401);
  }

  /** Take an item out of the queue. */
  async cancelQueued(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n < 0) throw new JenkinsError('queue item is missing');
    const response = await this.#post(`/queue/cancelItem?id=${n}`);
    return { ok: true, ...this.#answered(response, ['/queue']) };
  }

  // --- views ------------------------------------------------------------------

  /** The views Jenkins has, nested ones under the view that holds them, however deep. */
  async views() {
    const top = await this.#json('/api/json?tree=views[name,_class,description],primaryView[name]');
    const shape = async (view, parent, depth) => {
      const path = parent ? `${parent}/${view.name}` : view.name;
      const nested = /NestedView/.test(view._class ?? '');
      let inner = [];
      if (nested && depth < 6) {
        try { inner = (await this.#json(`${viewPath(path)}/api/json?tree=views[name,_class,description]`)).views ?? []; } catch { inner = []; }
      }
      return {
        name: String(view.name ?? '').slice(0, 200),
        path,
        nested,
        description: String(view.description ?? '').slice(0, 300),
        views: await mapLimit(inner.slice(0, 200), 4, (one) => shape(one, path, depth + 1)),
      };
    };
    const views = await mapLimit((top.views ?? []).slice(0, 500), 4, (one) => shape(one, '', 0));
    return { views, primary: top.primaryView?.name ?? null };
  }

  /** The jobs one view holds. A regex view is worked out by Jenkins; this only reads the answer. */
  async viewJobs(path) {
    const body = await this.#json(`${viewPath(path)}/api/json?tree=jobs[${JOB_FIELDS},jobs[name]]`, { timeout: this.heavyTimeout });
    return (body.jobs ?? []).slice(0, MAX_ROWS).map((job) => jobRow(job));
  }

  // --- the queue and the agents -----------------------------------------------

  async queue() {
    const body = await this.#json('/queue/api/json?tree=items[id,why,inQueueSince,stuck,blocked,buildable,task[name,fullName,url]]');
    return (body.items ?? []).slice(0, 1000).map((one) => ({
      id: one.id,
      path: one.task?.fullName ?? one.task?.name ?? '',
      why: String(one.why ?? '').slice(0, 300),
      since: one.inQueueSince ?? null,
      stuck: Boolean(one.stuck),
      blocked: Boolean(one.blocked),
    }));
  }

  async agents() {
    const body = await this.#json(
      '/computer/api/json?tree=computer[displayName,offline,temporarilyOffline,offlineCauseReason,numExecutors,assignedLabels[name],executors[currentExecutable[url]],oneOffExecutors[currentExecutable[url]]]',
    );
    return (body.computer ?? []).slice(0, 1000).map((one) => {
      const busy = [...(one.executors ?? []), ...(one.oneOffExecutors ?? [])].filter((slot) => slot.currentExecutable).length;
      return {
        name: String(one.displayName ?? '').slice(0, 200),
        offline: Boolean(one.offline),
        temporarilyOffline: Boolean(one.temporarilyOffline),
        reason: String(one.offlineCauseReason ?? '').slice(0, 300),
        executors: one.numExecutors ?? 0,
        busy,
        labels: (one.assignedLabels ?? []).map((label) => label.name).filter((name) => name && name !== one.displayName).slice(0, 50),
      };
    });
  }

  // --- history, for the dashboard (jenkins-metrics.js) ---------------------------

  /**
   * Every build running right now, and the agents they run on, from the one
   * place that knows about concurrent builds: the executors. A build waiting
   * outside any node (an `input`, a `sleep`) holds none, so a caller adds what
   * the index says is running. `serverDate` is Jenkins' own clock, read from the
   * answer's `Date` header: what makes "running for 4 minutes" right when the
   * two machines' clocks are not.
   */
  async running() {
    const slot = 'currentExecutable[url,number,timestamp,estimatedDuration]';
    const { bytes, headers, tooBig } = await this.#request(
      `/computer/api/json?tree=computer[displayName,offline,temporarilyOffline,offlineCauseReason,numExecutors,assignedLabels[name],executors[${slot}],oneOffExecutors[${slot}]]`,
    );
    if (tooBig) throw new JenkinsError('Jenkins sent more than this app will read about its agents');
    let body;
    try { body = JSON.parse(bytes.toString('utf8')); } catch { throw new JenkinsError('That address answered, but not like Jenkins does'); }
    const date = Date.parse(String(headers?.get?.('date') ?? ''));
    const builds = new Map();
    const agents = [];
    let busy = 0;
    let total = 0;
    for (const one of (body.computer ?? []).slice(0, 1000)) {
      const name = String(one.displayName ?? '').slice(0, 200);
      const slots = [...(one.executors ?? []).map((x) => ({ x, real: true })), ...(one.oneOffExecutors ?? []).map((x) => ({ x, real: false }))];
      let used = 0;
      for (const { x, real } of slots) {
        const exe = x?.currentExecutable;
        if (!exe) continue;
        if (real) used += 1;
        const at = buildAt(this.base, exe.url);
        if (!at) continue;
        const key = `${at.path}\n${at.number}`;
        const held = builds.get(key) ?? { path: at.path, number: at.number, timestamp: exe.timestamp ?? null, estimated: exe.estimatedDuration > 0 ? exe.estimatedDuration : null, agents: [] };
        if (!held.agents.includes(name)) (real ? held.agents.unshift(name) : held.agents.push(name));
        builds.set(key, held);
      }
      const offline = Boolean(one.offline);
      agents.push({
        name,
        offline,
        temporarilyOffline: Boolean(one.temporarilyOffline),
        reason: String(one.offlineCauseReason ?? '').slice(0, 300),
        executors: one.numExecutors ?? 0,
        busy: used,
        labels: (one.assignedLabels ?? []).map((label) => label.name).filter((label) => label && label !== one.displayName).slice(0, 50),
      });
      if (!offline) { busy += used; total += one.numExecutors ?? 0; }
    }
    return { serverDate: Number.isFinite(date) ? date : null, agents, builds: [...builds.values()].slice(0, 500), executors: { busy, total } };
  }

  /**
   * The newest builds of one job, with what started each: enough for a history
   * of runs. `limit` is how many, newest first.
   */
  async buildsOf(path, { limit = 30 } = {}) {
    const wanted = Math.min(500, Math.max(1, Math.floor(Number(limit)) || 30));
    const body = await this.#json(`${jobPath(path)}/api/json?tree=builds[${BUILD_HISTORY}]{0,${wanted}}`);
    return (body.builds ?? []).slice(0, wanted).map(historyRow);
  }

  /**
   * The newest builds of every job directly inside one folder, in one request.
   * Folders found there are not entered: the caller already knows the tree and
   * decides how fast to walk it.
   */
  async foldersBuilds(path = '', { limit = 30 } = {}) {
    const wanted = Math.min(500, Math.max(1, Math.floor(Number(limit)) || 30));
    const body = await this.#json(`${jobPath(path)}/api/json?tree=jobs[_class,name,fullName,builds[${BUILD_HISTORY}]{0,${wanted}}]`);
    const jobs = [];
    for (const job of (body.jobs ?? []).slice(0, MAX_ROWS)) {
      if (FOLDERISH.test(job._class ?? '') || !Array.isArray(job.builds)) continue;
      jobs.push({ path: job.fullName || (path ? `${path}/${job.name}` : job.name), builds: job.builds.slice(0, wanted).map(historyRow) });
    }
    return { jobs };
  }

  /**
   * Who the credentials are: the id Jenkins puts on what they start ("Started
   * by user ana"), and the name it shows. Null for an anonymous answer or one
   * that could not be read — "mine" then has nothing to match, and says so.
   */
  async whoami() {
    try {
      const body = await this.#json('/me/api/json?tree=id,fullName');
      return body.id ? { id: String(body.id).slice(0, 100), name: String(body.fullName ?? body.id).slice(0, 200) } : null;
    } catch {
      return null;
    }
  }

  /** What one build was started with: its parameters, a secret's value masked. */
  async buildParams(path, number) {
    const n = buildNumber(number);
    const body = await this.#json(`${jobPath(path)}/${n}/api/json?tree=actions[parameters[name,value]]`);
    return (body.actions ?? []).flatMap((one) => one.parameters ?? []).slice(0, 200)
      .map((one) => ({ name: String(one.name ?? '').slice(0, 100), value: parameterValue(one.name, one.value) }));
  }

  /** What changed in one build: who committed what. Small on purpose: it is asked for a handful of builds a page. */
  async buildChanges(path, number) {
    const n = buildNumber(number);
    const body = await this.#json(`${jobPath(path)}/${n}/api/json?tree=changeSets[items[commitId,msg,author[fullName]]{0,20}]`);
    return (body.changeSets ?? []).flatMap((set) => set.items ?? []).slice(0, 20).map((one) => ({
      id: String(one.commitId ?? '').slice(0, 8),
      message: String(one.msg ?? '').split('\n')[0].slice(0, 300),
      author: String(one.author?.fullName ?? '').slice(0, 200),
    }));
  }
}

/** What a build's history row asks Jenkins for: its times, its result, where it ran and what started it. */
const BUILD_HISTORY =
  // No `estimatedDuration`: Jenkins works it out for each build by reading the ones before it, and a history is hundreds of them. A
  // running build has its estimate from the executors that run it.
  'number,result,building,timestamp,duration,builtOn,' +
  'actions[causes[shortDescription,userId,upstreamProject,upstreamBuild]]';

function historyRow(build) {
  const row = buildRow(build);
  return {
    ...row,
    estimated: build.estimatedDuration > 0 ? build.estimatedDuration : null,
    agent: String(build.builtOn ?? '').slice(0, 200) || null,
    causes: (build.actions ?? []).flatMap((one) => one.causes ?? []).slice(0, 5).map((one) => ({
      text: String(one.shortDescription ?? '').slice(0, 200),
      user: one.userId ? String(one.userId).slice(0, 100) : null,
      upstream: one.upstreamProject ? String(one.upstreamProject).slice(0, 300) : null,
    })),
  };
}

/**
 * Which build an executor's address is, relative to this server: `…/job/a/job/b/12/`
 * is job `a/b`, number 12. Names stay as the rest of the app spells them — a
 * `%2F` in a branch name is kept, everything else decoded — so the path is the
 * same one the index has.
 */
function buildAt(base, url) {
  let pathname;
  try {
    const parsed = new URL(String(url ?? ''));
    pathname = parsed.pathname;
    const prefix = new URL(base).pathname.replace(/\/+$/, '');
    if (prefix && pathname.startsWith(`${prefix}/`)) pathname = pathname.slice(prefix.length);
  } catch {
    return null;
  }
  const match = /^((?:\/job\/[^/]+)+)\/(\d+)\/?$/.exec(pathname);
  if (!match) return null;
  const parts = match[1].split('/job/').slice(1).map((one) => {
    try { return decodeURIComponent(one.replace(/%2f/gi, '\u0001')).replace(/\u0001/g, '%2F'); } catch { return null; }
  });
  if (parts.some((one) => !one)) return null;
  return { path: parts.join('/'), number: Number(match[2]) };
}

/** What is asked of a build to judge it: its end, its time, and who started it. */
const FACTS = 'number,result,building,timestamp,duration,queueId,actions[causes[userId]]';

function factsOf(build) {
  const row = buildRow(build);
  const users = [];
  for (const action of build.actions ?? []) for (const cause of action?.causes ?? []) if (cause?.userId) users.push(String(cause.userId).slice(0, 200));
  // `result` as Jenkins says it: a finished build with none is one that did not get to run (NOT_BUILT), which is not the same as one still going.
  return { ...row, result: build.result ?? null, queueId: build.queueId ?? null, users: [...new Set(users)].slice(0, 20) };
}

function pushRow(rows, row, maxRows) {
  if (rows.length >= maxRows) { rows.truncated = true; return; }
  rows.push(row);
}

function buildNumber(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 2_000_000_000) throw new JenkinsError('build number is missing');
  return n;
}

/** `map` with at most `limit` in flight. Order of the results is the order of the input. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = { bulk, Limiter, background, HEAVY_TIMEOUT, certificateProblem,
  JenkinsApi, JenkinsError, LogStream, segment, jobPath, viewPath, normalizeBase, statusOf, resultStatus, jobRow, buildRow,
  stripNotes, cleanText, holdBack, LogCleaner, stageNames, stageAverages, buildAt, FOLDERISH, MAX_JSON, MAX_LOG_READ, LOG_TAIL_BYTES, MAX_ROWS,
};
