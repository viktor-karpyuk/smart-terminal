'use strict';

/**
 * What is taken out of Jenkins' text before it reaches a model.
 *
 * A console is whatever anybody who could run a build printed, and a build
 * prints more than its author means to: an `env` dump, a failed `curl -v`, a
 * `docker login` that echoed, a connection string in a stack trace. Jenkins
 * masks the credentials it knows it injected; it cannot mask the ones a script
 * made up. This is the second net, and it sits on the app's side of the socket
 * — a rule enforced in the process the model can see is not a rule.
 *
 * **One door.** Everything a tool says goes through `safeText`, and it goes
 * through it whole, before anything is cut. The order is the point:
 *
 *   1. `strip`    makes the text inert and plain: escape sequences, console
 *                 annotations, controls, and the invisible characters
 *                 (zero-width, bidi overrides, soft hyphens, variation
 *                 selectors, the Unicode "tag" block) that let a line say one
 *                 thing to a person and another to a model — and that hide a
 *                 `-----BEGIN` from a pattern that looks for it.
 *   2. keys       a private key is masked as a block, line by line, with its
 *                 state carried across lines and across the pieces a huge
 *                 console is read in. A window cut from the result can begin
 *                 anywhere and never begins inside a key, because there is no
 *                 key left to begin inside. Lines keep their numbers.
 *   3. tokens     the shape of a known credential, a name that says what its
 *                 value is, a URL with a password in it.
 *
 * Cutting first and masking after is how the first version leaked: a window
 * that starts in the middle of a key has no header for a pattern to find.
 *
 * What it does NOT do, and why: it does not mask ordinary hashes, long hex ids
 * or base64 on their own. A commit SHA is the most useful string in a build
 * log and is indistinguishable from a key without context, so a secret is
 * recognised by its shape (a known prefix, a header, a URL with a password) or
 * by the NAME it is assigned to (`password=`, `"apiKey":`, `--token`). A secret
 * printed bare, with no name and no known shape, passes — except key material,
 * which has a shape of its own (rows of base64 as wide as a PEM), and is masked
 * wherever it turns up. That is the trade: a net that mangled every
 * 40-character string would make logs unreadable and teach people to stop
 * trusting it.
 *
 * A name is judged by its parts, not its letters. `API_TOKEN`, `clientSecret`
 * and `DB_PASSWORD` are secrets; `Author`, `passed`, `compass` and `Tokenizer`
 * merely contain the letters of one, and masking them would turn `Author: Jane
 * Doe` into noise and make "N secret-looking values were masked" mean nothing.
 *
 * Everything here is linear in the size of its input. The keyword scan finds
 * names first and looks only at the few characters around each hit; there is no
 * pattern that can backtrack across a megabyte, and the tests feed it
 * adversarial input to hold it to that.
 */

/** Input larger than this is handled in pieces: none of the rules above can see more than this at once. */
const MAX_INPUT = 4 * 1024 * 1024;
/** How big a piece is, when a text is handled in pieces. */
const PIECE = 1024 * 1024;

const mask = (kind, value) => `[REDACTED:${kind} len=${String(value).length}]`;
/** The same marker for something already measured. */
const maskLen = (kind, length) => `[REDACTED:${kind} len=${length}]`;

// --- making text inert ---------------------------------------------------------------

const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// Bounded, so an unterminated one cannot run to the end of the text.
const ANSI_OSC = /\u001b\][^\u0007\u001b]{0,2000}(?:\u0007|\u001b\\)?/g;
const ANSI_SHORT = /\u001b[@-Z\\-_]/g;
// Every control except newline and tab. A bare carriage return is a progress bar redrawing itself.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g;
/**
 * What cannot be seen and can be read: zero-width and joiner characters, the soft hyphen, bidi embeddings and overrides,
 * line and paragraph separators, filler characters (Hangul, Khmer, Braille blank), variation selectors including the
 * supplementary ones — a known way to carry text through a screen unseen — interlinear annotation marks, and the Unicode
 * tag block.
 */
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u17B4\u17B5\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFC\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
/** A console annotation that lost its escape bytes on the way. */
const NOTE_REMNANT = /\bha:\/{4}[A-Za-z0-9+/=]{16,}/g;

const NOTE_OPEN = '\u001b[8mha:';
const NOTE_CLOSE = '\u001b[0m';

/** Jenkins' `ESC[8mha:…ESC[0m` annotations, cut out by searching rather than by a pattern that could run on. */
function stripNotes(text) {
  let at = text.indexOf(NOTE_OPEN);
  if (at === -1) return text;
  const parts = [];
  let from = 0;
  while (at !== -1) {
    parts.push(text.slice(from, at));
    const close = text.indexOf(NOTE_CLOSE, at);
    if (close === -1) {
      // Never closed: it ends where the line does.
      const end = text.indexOf('\n', at);
      from = end === -1 ? text.length : end;
      break;
    }
    from = close + NOTE_CLOSE.length;
    at = text.indexOf(NOTE_OPEN, from);
  }
  parts.push(text.slice(from));
  return parts.join('');
}

/** Text that cannot move a terminal, hide a line, or smuggle an instruction past a reader's eye. */
function strip(text) {
  let out = String(text ?? '');
  if (out.length > MAX_INPUT) out = out.slice(0, MAX_INPUT);
  return plain(out);
}

/** `strip` without the cap: for the pieces of a text that is handled in pieces. */
function plain(text) {
  return stripNotes(text)
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_SHORT, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(NOTE_REMNANT, '')
    .replace(CONTROLS, '')
    .replace(INVISIBLE, '');
}

// --- private keys --------------------------------------------------------------------

const BEGIN_KEY = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/i;
const END_KEY = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/i;
/** What a console puts in front of every line of a key: a clock, a bracketed tag, a date. */
const STAMP = /^(?:\[[^\]\n]{1,40}\]|\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?|\d{4}-\d{2}-\d{2}[T ][\d:.,Z+-]*)?[ \t]*/;
/** A row of base64 as wide as a PEM row (64, or 76 in MIME, up to 100) — and not a row of hex, which is a digest. */
const WIDE_BASE64 = /^[A-Za-z0-9+/]{48,100}={0,2}$/;
const ANY_BASE64 = /^[A-Za-z0-9+/]{4,}={0,2}$/;
const HEX_ONLY = /^[0-9a-fA-F]+$/;
/** The first bytes of an OpenSSH private key, base64: `openssh-key-v1`. */
const OPENSSH_BODY = /^b3BlbnNzaC1rZXktdjE/;
/** The first row of an RSA private key's DER, in base64: `MIIE` (a sequence of 1 to 2 KB), then plenty more. */
const RSA_ROW = /^MIIE[A-Za-z0-9+/]{44,}={0,2}$/;
/** A PEM header line inside the block: `Proc-Type: 4,ENCRYPTED`, `DEK-Info: AES-128-CBC,…`. */
const PEM_HEADER = /^[A-Za-z][A-Za-z-]{1,30}: /;
/** Cheap test for whether a text could hold any of this at all. */
const COULD_HOLD_KEY = /-----(?:BEGIN|END)|[A-Za-z0-9+/]{48}/i;

/** The most a block that never ends is allowed to mask: a 4096-bit key is about 3 KB, and a stray header is not the end of the log. */
const OPEN_LIMIT = 65_536;
/** The most lines above an END with no BEGIN that are taken to be its body. */
const BACK_LIMIT = 400;

const wideRow = (core) => WIDE_BASE64.test(core) && !HEX_ONLY.test(core);

/**
 * Mask private keys in a text, line by line, keeping every line where it was.
 *
 * `state` is carried by the caller from one piece of a huge text to the next:
 * `open` is whether the text begins inside a block. A block ends at its END
 * line, or at the first line that cannot be key material, or at a size limit —
 * whichever comes first — so a stray header costs a few lines and not the rest
 * of the log. An END with no BEGIN masks the rows above it (the text may start
 * in the middle of a key, as a step log cut by Jenkins does), and three rows of
 * wide base64 with no header at all are a key too.
 */
function maskKeys(text, state, hit) {
  if (!state.open && !COULD_HOLD_KEY.test(text)) return text;
  const rows = text.split('\n');
  const out = new Array(rows.length);
  const cores = new Array(rows.length);
  let header = -1; // the row, in this text, where the block that is open began
  let headerPrefix = '';
  let chars = 0;
  let run = 0; // rows of wide base64 in a row, with no header
  let runStart = 0;

  const closeBlock = () => {
    if (header >= 0) out[header] = headerPrefix + maskLen('private-key', chars);
    state.open = false;
    header = -1;
  };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const core = row.slice(STAMP.exec(row)[0].length);
    cores[i] = core;

    if (state.open) {
      if (END_KEY.test(core)) {
        out[i] = '';
        chars += row.length + 1;
        closeBlock();
        continue;
      }
      if (core.trim() === '' || ANY_BASE64.test(core) || PEM_HEADER.test(core)) {
        out[i] = '';
        chars += row.length + 1;
        state.masked += row.length + 1;
        if (state.masked > OPEN_LIMIT) closeBlock();
        continue;
      }
      // Not key material: the block had no end. What it masked stays masked, and this row is read as it is.
      closeBlock();
    }

    const begin = BEGIN_KEY.exec(core);
    if (begin) {
      run = 0;
      headerPrefix = row.slice(0, row.length - core.length + begin.index);
      const after = core.slice(begin.index + begin[0].length);
      const end = END_KEY.exec(after);
      hit('private-key');
      if (end) {
        // A key on one line: `-----BEGIN …-----MIIE…-----END …-----`.
        out[i] = headerPrefix + maskLen('private-key', core.length - begin.index) + after.slice(end.index + end[0].length);
        continue;
      }
      state.open = true;
      state.masked = 0;
      header = i;
      // Counted as the block's own text: every later row adds its length and the newline before it.
      chars = core.length - begin.index;
      out[i] = `${headerPrefix}[REDACTED:private-key]`;
      continue;
    }

    if (END_KEY.test(core)) {
      // The end of a key whose beginning is not here: the rows above it, as far as they look like one, are its body.
      let k = i - 1;
      let top = i;
      let masked = row.length;
      while (k >= 0 && i - k <= BACK_LIMIT && (cores[k].trim() === '' || ANY_BASE64.test(cores[k]) || PEM_HEADER.test(cores[k])) && !String(out[k]).includes('[REDACTED:private-key')) {
        masked += rows[k].length + 1;
        out[k] = '';
        top = k;
        k -= 1;
      }
      // One marker: when the walk stopped at rows that were already masked (a run of key rows), they carry it.
      const above = k >= 0 ? String(out[k]) : '';
      const covered = above.includes('[REDACTED:private-key');
      if (top === i) out[i] = covered ? '' : maskLen('private-key', masked);
      else {
        out[top] = covered ? '' : maskLen('private-key', masked);
        out[i] = '';
      }
      hit('private-key');
      run = 0;
      continue;
    }

    out[i] = row;
    if (RSA_ROW.test(core)) {
      // The first row of a PKCS#1 or PKCS#8 RSA key, DER in base64: key material on its own, and what follows it is the rest.
      hit('private-key');
      out[i] = maskLen('private-key', row.length);
      run = 3;
      runStart = i;
      continue;
    }
    if (wideRow(core) || OPENSSH_BODY.test(core)) {
      if (run === 0) runStart = i;
      run += 1;
      if (run === 3) {
        // Three wide rows of base64 and no header: key material, wherever it came from.
        let total = 0;
        for (let k = runStart; k <= i; k += 1) {
          total += rows[k].length + 1;
          out[k] = '';
        }
        out[runStart] = maskLen('private-key', total);
        hit('private-key');
      } else if (run > 3) {
        out[i] = '';
      }
    } else if (run >= 3 && ANY_BASE64.test(core)) {
      // The short last row of the run.
      out[i] = '';
      run = 0;
    } else {
      run = 0;
    }
  }
  if (state.open) {
    // Still open at the end of this text (or of this piece): it is told how much has been masked so far.
    if (header >= 0) out[header] = headerPrefix + maskLen('private-key', chars);
    header = -1;
  }
  return out.join('\n');
}

// --- masking secrets -----------------------------------------------------------------

/** Shapes with a prefix nobody else uses. Order does not matter; each is anchored on a literal. */
const SHAPES = [
  ['aws-access-key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['github-token', /github_pat_[A-Za-z0-9_]{20,}\b/g],
  ['gitlab-token', /gl(?:pat|ptt|rt|oas|imt|agent|cbt|soat|ft|dt)-[A-Za-z0-9_-]{16,}/g],
  ['slack-token', /xox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['slack-token', /xapp-[A-Za-z0-9-]{10,}/g],
  ['slack-webhook', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+/g],
  ['discord-webhook', /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/g],
  ['teams-webhook', /https:\/\/[\w.-]{1,100}\.webhook\.office\.com\/webhookb2\/[^\s"'<>]{1,400}/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{30,}\b/g],
  ['pypi-token', /\bpypi-[A-Za-z0-9_-]{40,}/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['google-oauth-token', /\bya29\.[A-Za-z0-9_-]{20,}/g],
  ['google-refresh-token', /\b1\/\/0[A-Za-z0-9_-]{30,}/g],
  ['stripe-key', /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g],
  ['sendgrid-key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
  ['docker-token', /\bdckr_pat_[A-Za-z0-9_-]{20,}/g],
  ['huggingface-token', /\bhf_[A-Za-z0-9]{30,}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['sonar-token', /\bsq[upa]_[0-9a-f]{40,}\b/g],
  ['twilio-key', /\bSK[0-9a-f]{32}\b/g],
  ['mailgun-key', /\bkey-[0-9a-f]{32}\b/g],
  ['telegram-token', /\bbot\d{6,}:AA[A-Za-z0-9_-]{30,}/g],
  ['vault-token', /\bhv[sb]\.[A-Za-z0-9_-]{20,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  // A Jenkins API token: the prefix `11` and 32 hex. Exactly 34 characters, so a 32-hex md5 or 40-hex sha1 is left alone.
  ['jenkins-token', /\b11[0-9a-f]{32}\b/g],
  ['azure-key', /\b(?:AccountKey|SharedAccessKey|SharedAccessSignature)=[^;\s"'<>]{8,}/gi],
];

/** An address's signature parameter: the name stays, the value goes. */
const SAS_SIGNATURE = /([?&](?:sig|X-Amz-Signature)=)([A-Za-z0-9%+/=]{20,})/g;

/** `Bearer abc…` and `Basic abc…` wherever they appear, headers or not. */
const AUTH_SCHEME = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/-]{12,}=*)/g;

/** `scheme://user:password@host`: the password goes, the rest of the address stays. The password may hold an `@`; the host is what follows the last one. */
const URL_PASSWORD = /\b([A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/)([^\s/@:?#]{0,200}):([^\s/?#]{1,500})@(?=[^\s@/]|$)/g;
/** `https://TOKEN@host`: a token used as the user name, as GitHub tokens are. */
const URL_TOKEN = /\b([A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/)([A-Za-z0-9_.~-]{20,200})@/g;

/** `<password>…</password>`, as Maven's settings and a lot of XML spell it. */
const XML_SECRET = /<(password|passwd|pwd|passphrase|secret|token|apikey|api-key|privatekey|private-key|credential|auth-token|client-secret)>([^<\n]{1,4000})<\/\1>/gi;

// Commands that take a credential on the command line without a keyword near it. Each looks only at its own line, a bounded
// distance from the command's name.
const CURL_USER = /\bcurl\b[^\n]{0,400}?[ \t](?:-u|--user|--proxy-user)(?:[ \t]+|=)("[^"\n]{1,500}"|'[^'\n]{1,500}'|[^\s'"]{1,500})/g;
const LOGIN_P = /\blogin\b[^\n]{0,300}?[ \t]-p(?:[ \t]+|=)("[^"\n]{1,500}"|'[^'\n]{1,500}'|[^\s'"]{1,500})/g;
/** `echo SECRET | docker login --password-stdin`: the secret is printed before it is piped, and is in the log as the argument of `echo`. */
const ECHO_LOGIN = /\b(?:echo|printf)\b[ \t]+(?:-[a-zA-Z]+[ \t]+)?(?:'%s'[ \t]+|"%s"[ \t]+)?("[^"\n]{1,500}"|'[^'\n]{1,500}'|[^\s|'"]{1,500})[ \t]*\|[^\n]{0,200}?\blogin\b[^\n]{0,200}?--password-stdin/g;
const SSHPASS = /\bsshpass\b[^\n]{0,100}?[ \t]-p[ \t]*("[^"\n]{1,500}"|'[^'\n]{1,500}'|\S{1,500})/g;
const MYSQL_P = /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]{0,300}?[ \t]-p(?=\S)("[^"\n]{1,500}"|'[^'\n]{1,500}'|\S{1,500})/g;
/** An access key id and, within a line of it, the 40 characters of its secret half. */
const AWS_PAIR = /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16})\b([^\n]{0,60}?)(?<![A-Za-z0-9/+=])([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/g;
const AWS_PHRASE = /(secret[ _-]?access[ _-]?key["']?[ \t]*[:=][ \t]*["']?)([A-Za-z0-9/+=]{40})/gi;

/**
 * Names that make the value after them a secret. Searched first (a literal
 * alternation scans in linear time); the characters around each hit are then
 * looked at by hand, so nothing ever backtracks.
 */
const KEYWORDS = /pass|pwd|pw|psw|secret|token|key|cred|auth|cookie|crumb|signature|bearer|login|connection[_-]?string/gi;

/** Whole-part names that are secrets. A name is split into parts first (`clientSecret` → client, secret), so `Author` is not `auth`. */
const SECRET_PART = new Set([
  'pass', 'password', 'passwd', 'passphrase', 'passcode', 'pwd', 'pw', 'psw', 'secret', 'secrets', 'token', 'apikey', 'credential',
  'credentials', 'cred', 'creds', 'auth', 'authorization', 'bearer', 'signature', 'cookie', 'crumb', 'storepass', 'keypass',
]);
/** Parts that are ambiguous — `pass: build.sh`, `auth: none` — and whose values are looked at harder. */
const WEAK_PART = new Set(['pass', 'pw', 'pwd', 'auth']);
/** Endings that make one word a secret by itself: `DBPASSWORD`, `authtoken`. */
const STRONG_ENDING = ['password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'credential', 'credentials', 'accesskey', 'privatekey', 'secretkey'];
/** What a name's last part says when it describes the secret rather than being it: `secret_name`, `token_url`, `password_file`. */
const DESCRIPTOR = new Set([
  'name', 'names', 'ref', 'path', 'file', 'dir', 'id', 'ids', 'type', 'kind', 'count', 'length', 'size', 'class', 'provider', 'manager',
  'store', 'policy', 'expiry', 'expires', 'ttl', 'url', 'uri', 'host', 'port', 'header', 'field', 'param', 'params', 'prefix', 'suffix',
  'format', 'mode', 'enabled', 'disabled', 'required', 'version', 'status', 'label', 'description', 'env', 'var', 'variable', 'source',
  'location', 'regex', 'pattern', 'rule', 'rules', 'scope', 'realm', 'user', 'username', 'flag', 'option', 'options', 'placeholder',
  'hint', 'help', 'stdin', 'prompt', 'file', 'filename', 'dirname', 'keys', 'timeout', 'attempts', 'retries', 'limit',
]);
/** `X_key` where X says it is not a credential. */
const KEY_BENIGN = new Set(['primary', 'foreign', 'sort', 'partition', 'cache', 'hash', 'routing', 'row', 'map', 'object', 'search', 'lookup', 'index', 'unique', 'composite', 'shard', 'group', 'order', 'public', 'natural', 'surrogate', 'dedupe', 'idempotency', 'message', 'storage']);
/** The first words of a `…_key` that is a credential. */
const KEY_SECRET_FIRST = new Set(['api', 'access', 'private', 'client', 'signing', 'encryption', 'deploy', 'master', 'license', 'secret', 'ssh', 'gpg', 'pgp', 'stripe', 'service', 'account', 'shared', 'subscription', 'admin', 'root', 'app', 'application', 'auth']);

/** A name's parts, lower-cased: `clientSecret` and `CLIENT_SECRET` and `client-secret` are client, secret. */
function partsOf(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((one) => one.toLowerCase());
}

/** Whether a name is a secret's, and how sure: `strong`, `weak` (look at the value), or `null` (not at all). */
function classify(name) {
  const parts = partsOf(name);
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  const before = parts[parts.length - 2];
  if (DESCRIPTOR.has(last) && !(last === 'id' && before === 'secret')) return null;
  let strength = null;
  for (const part of parts) {
    if (SECRET_PART.has(part)) {
      if (!WEAK_PART.has(part)) return 'strong';
      strength = 'weak';
    } else if (STRONG_ENDING.some((ending) => part.length > ending.length && part.endsWith(ending))) {
      return 'strong';
    }
  }
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i + 1] === 'key' && ['api', 'access', 'private', 'client', 'secret'].includes(parts[i])) return 'strong';
    if (parts[i] === 'connection' && parts[i + 1] === 'string') return 'strong';
  }
  // `-Dsonar.login=`: the letters before the dot are a flag's, so "sonar" is looked for at the end of a part.
  if (last === 'login' && parts.some((one) => one.endsWith('sonar'))) return 'strong';
  // `SIGNING_KEY`, `DEPLOY_KEY`, `ENCRYPTION_KEY`: a key by its last word, unless the word before says it is a database's.
  if (last === 'key' && parts.length > 1 && !KEY_BENIGN.has(before)) return KEY_SECRET_FIRST.has(before) ? 'strong' : 'weak';
  // A bare `key=`: a secret when its value looks like one.
  if (last === 'key' && parts.length === 1) return 'bare-key';
  return strength;
}

const isIdCode = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45;
const idAt = (text, i) => i >= 0 && i < text.length && isIdCode(text.charCodeAt(i));

/** What ends an unquoted value. */
const isStop = (code) =>
  code === 32 || code === 9 || code === 10 || code === 13 || code === 39 || code === 34 || code === 44 || code === 59 || code === 38 || code === 41 || code === 125 || code === 93 || code === 60 || code === 62;

/** The value that starts at `i`: quoted (plain or JSON-escaped), or up to the next separator. Always to its real end. */
function readValue(text, i, wholeWord = false) {
  const LIMIT = 1_048_576;
  if (text[i] === '\\' && (text[i + 1] === '"' || text[i + 1] === "'")) {
    // `{\"password\":\"x\"}`: a value quoted inside a string.
    const quote = `\\${text[i + 1]}`;
    const close = text.indexOf(quote, i + 2);
    const eol = text.indexOf('\n', i);
    const stop = close !== -1 && (eol === -1 || close < eol) ? close : eol === -1 ? text.length : eol;
    return { start: i + 2, end: Math.min(stop, i + 2 + LIMIT), quoted: true };
  }
  if (text[i] === '<') {
    // `<your-token>` is a placeholder and `<Zk9x…` is a password: read to the end of the word either way, to tell which.
    let k = i + 1;
    const max = Math.min(text.length, i + LIMIT);
    while (k < max && text.charCodeAt(k) !== 32 && text.charCodeAt(k) !== 9 && text.charCodeAt(k) !== 10 && text.charCodeAt(k) !== 13) k += 1;
    return { start: i, end: k, quoted: false };
  }
  const quote = text[i];
  if (quote === '"' || quote === "'") {
    const limit = Math.min(text.length, i + 1 + LIMIT);
    for (let j = i + 1; j < limit; j += 1) {
      const ch = text[j];
      if (ch === '\n') return { start: i + 1, end: j, quoted: true };
      if (ch === '\\' && quote === '"') {
        j += 1;
        continue;
      }
      if (ch === quote) return { start: i + 1, end: j, quoted: true };
    }
    return { start: i + 1, end: limit, quoted: true };
  }
  const limit = Math.min(text.length, i + LIMIT);
  let j = i;
  while (j < limit) {
    const code = text.charCodeAt(j);
    // A password may hold any character that is not a space: a comma, a semicolon, an ampersand, a bracket. Cutting it at one
    // masks its first part and shows the rest, so a name that is surely a secret's reads to the end of the word. A name that
    // may not be (`pass: all`) keeps the usual stops, because there the value is more often a word in a sentence.
    if (wholeWord ? code === 32 || code === 9 || code === 10 || code === 13 : isStop(code)) break;
    // A URL-encoded `&`.
    if (!wholeWord && code === 37 && text[j + 1] === '2' && text[j + 2] === '6') break;
    j += 1;
  }
  return { start: i, end: j, quoted: false };
}

const lineEnd = (text, i) => {
  const eol = text.indexOf('\n', i);
  return eol === -1 ? text.length : eol;
};

/** What a value that is not a secret looks like: a switch, a word for a result, something already masked. */
const BENIGN_VALUE = /^(?:true|false|null|none|nil|undefined|empty|yes|no|on|off|required|optional|string|ok|okay|all|any|fail|failed|failure|skip|skipped|success|succeeded|pending|running|done|error|denied|expired|invalid|missing|valid|enabled|disabled|unauthorized|forbidden|ready|n\/a|\*+|•+|x+|\.{3}|-)$/i;
/**
 * A reference to a variable, or a placeholder: `$TOKEN`, `${TOKEN}`, `%TOKEN%`, `<your-token>`, `{{ token }}`. A value that merely STARTS
 * with one of those characters is a password — and so is `$Zk9xP3rT7`: a variable is named in one case, a password is not.
 */
const REFERENCE = /^(?:\$\{?(?:[A-Z][A-Z0-9_]{0,40}|[a-z][a-z0-9_]{0,40})\}?|%[A-Za-z_][A-Za-z0-9_]*%|<[^<>\s]{1,40}>|\{\{[^{}]{0,60}\}?\}?)$/;
/** A path or a file name. */
const FILE_LIKE = /(?:^[/~]|^[A-Za-z]:\\|[/\\]|\.[A-Za-z0-9]{1,5}$)/;

/** `name = value` and `name: value` where the name says it is a secret. */
function redactNamed(text, hit) {
  KEYWORDS.lastIndex = 0;
  const parts = [];
  let from = 0;
  let match;
  while ((match = KEYWORDS.exec(text)) !== null) {
    const at = match.index;
    if (at < from) continue;
    // The identifier this keyword sits in: far enough to take in `token_for_the_deployment_system`, and no further.
    let left = at;
    while (left > 0 && left > at - 64 && idAt(text, left - 1)) left -= 1;
    let right = at + match[0].length;
    const identEnd = right + 64;
    while (right < text.length && right < identEnd && idAt(text, right)) right += 1;
    KEYWORDS.lastIndex = Math.max(KEYWORDS.lastIndex, right);

    const name = text.slice(left, right);
    const strength = classify(name);
    if (!strength) continue;
    // A command-line flag: the dashes are part of what was read as the name.
    const flag = name.startsWith('-');

    // An optional closing quote of the name (plain or escaped), then spaces, then the separator.
    let i = right;
    if (text[i] === '\\' && (text[i + 1] === '"' || text[i + 1] === "'")) i += 2;
    else if (text[i] === '"' || text[i] === "'") i += 1;
    while (text[i] === ' ' || text[i] === '\t') i += 1;
    let separator = null;
    if (text[i] === ':' || text[i] === '=') {
      separator = text[i];
      i += 1;
      if (text[i] === '>') i += 1;
    } else if (text[i] === '%' && /^%3[dDaA]/.test(text.slice(i, i + 3))) {
      // URL-encoded `=` and `:`.
      separator = text[i + 2] === 'D' || text[i + 2] === 'd' ? '=' : ':';
      i += 3;
    } else if (flag && i > right) {
      // `--password hunter2`: a flag takes its value after a space.
      separator = ' ';
    }
    if (!separator) continue;
    while (text[i] === ' ' || text[i] === '\t') i += 1;
    if (i >= text.length) continue;
    if (text[i] === '\n' || text[i] === '\r') {
      // `pass:` and the value on the next line, indented: YAML.
      if (separator !== ':') continue;
      let j = i + 1;
      const indentFrom = j;
      while (text[j] === ' ' || text[j] === '\t') j += 1;
      if (j - indentFrom < 2 || j >= text.length || text[j] === '\n' || text[j] === '-' || text[j] === '#') continue;
      i = j;
    }

    let { start, end, quoted } = readValue(text, i, strength === 'strong');
    // `Authorization: Bearer <token>`: the scheme is not the secret, what follows it is.
    const word = text.slice(start, end);
    if (!quoted && /^(?:bearer|basic|token|digest|negotiate|ntlm|apikey)$/i.test(word)) {
      let k = end;
      while (text[k] === ' ' || text[k] === '\t') k += 1;
      if (k > end && k < text.length && text[k] !== '\n') {
        const next = readValue(text, k, true);
        start = next.start;
        end = next.end;
        quoted = next.quoted;
      }
    }
    // A cookie header carries several values on one line, and all of them are the session.
    if (/cookie$/i.test(name) && separator === ':' && !quoted) end = lineEnd(text, start);
    // A connection string is several settings joined by semicolons, and every one of them is part of it.
    if (/connection[_-]?string$/i.test(name) && !quoted) end = lineEnd(text, start);

    const value = text.slice(start, end);
    const lower = name.toLowerCase();
    let benign =
      !value ||
      value.startsWith('[REDACTED') ||
      REFERENCE.test(value) ||
      BENIGN_VALUE.test(value) ||
      // A count or a limit: `max_tokens=4096`, `tokens=8`. A short number after `password` or `secret` is a weak password, and stays masked.
      (/^\d{1,6}$/.test(value) && !/pass|pwd|secret|credential|cookie|private|session/.test(lower));
    if (!benign && (strength === 'weak' || strength === 'bare-key')) {
      // `pass: build.sh`, `pwd=/home/jenkins/workspace`, `key=name`: look at what the value is.
      if (FILE_LIKE.test(value)) benign = true;
      else if (strength === 'bare-key' && !(value.length >= 16 && /[0-9]/.test(value) && /[A-Za-z]/.test(value))) benign = true;
      else if (value.length < 4) benign = true;
    }
    if (benign) {
      KEYWORDS.lastIndex = Math.max(KEYWORDS.lastIndex, end);
      continue;
    }
    parts.push(text.slice(from, start), mask('secret-value', value));
    hit('secret-value');
    from = end;
    KEYWORDS.lastIndex = Math.max(KEYWORDS.lastIndex, end);
  }
  if (!parts.length) return text;
  parts.push(text.slice(from));
  return parts.join('');
}

/** Everything that masks a token or a value, on text that has already been made inert and had its keys masked. */
function applyRules(input, hit) {
  let text = input;
  text = text.replace(XML_SECRET, (_all, tag, value) => {
    hit('xml-secret');
    return `<${tag}>${mask('secret-value', value)}</${tag}>`;
  });
  text = text.replace(URL_PASSWORD, (_all, scheme, user, password) => {
    hit('url-password');
    return `${scheme}${user}:${mask('password', password)}@`;
  });
  text = text.replace(URL_TOKEN, (_all, scheme, token) => {
    hit('url-token');
    return `${scheme}${mask('token', token)}@`;
  });
  // Each of these keeps everything but the credential, which is the last thing in the match — except a piped password, which is
  // the first (the argument of `echo`), and the rest of the match is the command it goes into.
  for (const [kind, pattern, first] of [['basic-auth', CURL_USER], ['login-password', LOGIN_P], ['sshpass-password', SSHPASS], ['mysql-password', MYSQL_P], ['piped-password', ECHO_LOGIN, true]]) {
    text = text.replace(pattern, (whole, credential) => {
      hit(kind);
      const at = first ? whole.indexOf(credential) : whole.length - credential.length;
      return whole.slice(0, at) + mask(kind, credential) + whole.slice(at + credential.length);
    });
  }
  text = text.replace(AWS_PAIR, (_all, id, between, secret) => {
    hit('aws-secret-key');
    return `${id}${between}${mask('aws-secret-key', secret)}`;
  });
  text = text.replace(AWS_PHRASE, (_all, head, secret) => {
    hit('aws-secret-key');
    return `${head}${mask('aws-secret-key', secret)}`;
  });
  for (const [kind, pattern] of SHAPES) {
    text = text.replace(pattern, (whole) => {
      hit(kind);
      return mask(kind, whole);
    });
  }
  text = text.replace(SAS_SIGNATURE, (_all, name, value) => {
    hit('sas-signature');
    return `${name}${mask('sas-signature', value)}`;
  });
  text = text.replace(AUTH_SCHEME, (_all, scheme, token) => {
    hit('auth-header');
    return `${scheme} ${mask('token', token)}`;
  });
  return redactNamed(text, hit);
}

function counter() {
  const kinds = {};
  let count = 0;
  return {
    hit: (kind) => {
      count += 1;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    },
    result: (text) => ({ text, count, kinds }),
  };
}

/**
 * Mask what looks like a secret. Returns the text, how many things were
 * masked, and what kind — enough to tell the reader that something was
 * taken out, never what. This is for a string; a console goes through
 * `safeText`, which also strips and carries a key's state through pieces.
 */
function redact(input) {
  const c = counter();
  let text = String(input ?? '');
  if (text.length > MAX_INPUT) text = text.slice(0, MAX_INPUT);
  text = maskKeys(text, { open: false, masked: 0 }, c.hit);
  return c.result(applyRules(text, c.hit));
}

/** Strip and redact: what a message or a name gets before a model reads it. */
function sanitize(input) {
  return redact(strip(input));
}

/**
 * THE way text reaches a model: all of it made inert, then every private key
 * masked, then every token, and only then handed to whatever will cut it into
 * windows, lines and snippets. A text too large to hold is read in pieces at
 * line boundaries, with the state of a key that was open carried from one piece
 * to the next, so a key that straddles a boundary is masked like any other.
 *
 * Lines are where they were: a masked key is a line of marker and blank lines
 * after it, so a number quoted from Jenkins or from the archive still points at
 * the same place.
 */
function safeText(input) {
  const raw = String(input ?? '');
  if (!raw) return { text: '', count: 0 };
  const c = counter();
  const state = { open: false, masked: 0 };
  const pieces = [];
  if (raw.length <= MAX_INPUT) pieces.push(raw);
  else {
    let at = 0;
    while (at < raw.length) {
      let cut = at + PIECE;
      if (cut >= raw.length) cut = raw.length;
      else {
        const eol = raw.indexOf('\n', cut);
        cut = eol === -1 ? raw.length : eol;
      }
      pieces.push(raw.slice(at, cut));
      at = cut + 1;
      if (cut === raw.length) break;
    }
  }
  const out = pieces.map((piece) => applyRules(maskKeys(plain(piece), state, c.hit), c.hit));
  return { text: out.join('\n'), count: c.result('').count };
}

/** Only the private keys, over a text of any size: `safeText` without the token rules. */
function redactBlocks(text) {
  return maskKeys(strip(text), { open: false, masked: 0 }, () => {});
}

/** A field name that is a secret whatever is in it. */
function secretField(field) {
  const kind = classify(field);
  return kind === 'strong' || kind === 'weak';
}

/**
 * Sanitize every string in a value, and mask the whole of any field named like
 * a secret. Strings are capped, depth is capped, and nothing but plain data
 * comes out: functions and symbols are dropped.
 */
function redactDeep(value, { maxDepth = 8, maxString = 20_000 } = {}) {
  let count = 0;
  const walk = (item, depth, field) => {
    if (item === null || item === undefined) return item;
    if (typeof item === 'string') {
      if (field && secretField(field) && item) {
        count += 1;
        return mask('field', item);
      }
      const clean = sanitize(item);
      count += clean.count;
      return clean.text.length > maxString ? `${clean.text.slice(0, maxString)}… [${clean.text.length - maxString} more characters]` : clean.text;
    }
    if (typeof item === 'number' || typeof item === 'boolean') return item;
    if (typeof item !== 'object') return undefined;
    if (depth >= maxDepth) return '[too deep]';
    if (Array.isArray(item)) return item.slice(0, 500).map((one) => walk(one, depth + 1, field));
    const out = {};
    for (const key of Object.keys(item).slice(0, 200)) {
      // Own keys only, and none that could reach the prototype.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const next = walk(item[key], depth + 1, key);
      if (next !== undefined) out[strip(key).slice(0, 200)] = next;
    }
    return out;
  };
  const result = walk(value, 0, '');
  return { value: result, count };
}

module.exports = { strip, redact, sanitize, safeText, redactDeep, redactBlocks, mask, MAX_INPUT, PIECE };
