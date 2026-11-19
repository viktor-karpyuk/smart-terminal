'use strict';

/**
 * What is taken out of Jenkins' text before a model reads it.
 *
 * Two things are checked and they pull against each other: a secret must not
 * get through, and an ordinary log must not be mangled. Every near-miss here is
 * a line somebody will really have in a console — a commit SHA, `max_tokens`,
 * `${PASSWORD}` — and each one is a promise that this net does not turn logs
 * into noise.
 */

/** Token-shaped fixtures are built from pieces so no source line looks like a real secret to a scanner. */
const j = (...parts) => parts.join('');
const test = require('node:test');
const assert = require('node:assert');

const { strip, redact, sanitize, redactDeep } = require('../electron/jenkins-redact');

const clean = (text) => sanitize(text).text;

/** The secret is gone, and something says it was there. */
function masked(text, secret) {
  const out = clean(text);
  assert.equal(out.includes(secret), false, `still there: ${out}`);
  assert.match(out, /\[REDACTED:/, `nothing says it was masked: ${out}`);
  return out;
}

test('named secrets: the value goes, the name stays', () => {
  assert.match(masked('password=hunter2', 'hunter2'), /^password=\[REDACTED:secret-value len=7\]$/);
  masked('DB_PASSWORD: s3cr3tvalue', 's3cr3tvalue');
  masked('export API_TOKEN="abc.def.ghi-123"', 'abc.def.ghi-123');
  masked("client_secret = 'zzzz1111yyyy'", 'zzzz1111yyyy');
  masked('{"apiKey": "k-12345678", "other": "fine"}', 'k-12345678');
  assert.match(clean('{"apiKey": "k-12345678", "other": "fine"}'), /"other": "fine"/, 'what is next to it is left alone');
  masked('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  masked('passwd => "letmein99"', 'letmein99');
  masked('connection_string=Server=db;User=sa;Password=Pa55w0rd!', 'Server=db;User=sa;Password=Pa55w0rd!'.split(';')[0]);
});

test('command-line flags take their value after a space or an equals sign', () => {
  assert.equal(clean('docker login --password hunter2 -u ana').includes('hunter2'), false);
  assert.equal(clean('mysql --user=a --password=zzz').includes('zzz'), false);
  assert.equal(clean('tool --api-key abc123def').includes('abc123def'), false);
  // The rest of the command is intact.
  assert.match(clean('docker login --password hunter2 -u ana'), / -u ana$/);
});

test('headers: the scheme stays, what follows it goes', () => {
  assert.match(masked('Authorization: Bearer abcdef1234567890abcdef', 'abcdef1234567890abcdef'), /Authorization: Bearer \[REDACTED/);
  masked('curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA==" https://x', 'dXNlcjpwYXNzd29yZA');
  masked(`> Bearer ${j('eyJ', 'hbGciOiJIUzI1NiJ9abcdefghij')}`, j('eyJ', 'hbGciOiJIUzI1NiJ9abcdefghij'));
  assert.equal(clean('Cookie: a=1; sessionid=zzzzzz').includes('zzzzzz'), false, 'a cookie header is all session');
  assert.equal(clean('Set-Cookie: SID=qwerty; Path=/').includes('qwerty'), false);
});

test('an address with a password in it keeps the address', () => {
  const out = masked('git clone https://ana:s3cret@git.example.com/team/app.git', 's3cret');
  assert.match(out, /https:\/\/ana:\[REDACTED:password len=6\]@git\.example\.com\/team\/app\.git/);
  masked('git push https://' + j('ghp', '_aaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaa') + '@github.com/x/y', '' + j('ghp', '_aaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaa') + '');
  // A plain address, and an address with a user but no password, are not secrets.
  assert.equal(clean('see https://github.com/x/y and ssh://git@host/repo'), 'see https://github.com/x/y and ssh://git@host/repo');
});

test('tokens with a shape of their own', () => {
  const corpus = {
    'AWS key': '' + j('AKI', 'AIOSFOD', 'NN7EXAMPLE') + '',
    'GitHub': '' + j('ghp', '_abcdefghijklmnop', 'qrstuvwxyz0123456789') + '',
    'GitHub fine-grained': '' + j('git', 'hub_pat_11ABCDEFG012345', '6789_abcdefghijklmnopqrstuv') + '',
    'GitLab': '' + j('glp', 'at-abcdefg', 'hij0123456789') + '',
    'Slack': '' + j('xox', 'b-1234567890', '12-abcdefghijkl') + '',
    'Slack webhook': 'https://hooks.slack.com/services/T0123ABCD/B0123ABCD/abcdefghijklmnop',
    'npm': '' + j('npm', '_abcdefghijklmnop', 'qrstuvwxyz0123456789') + '',
    'PyPI': j('pypi', '-', 'A'.repeat(60)),
    'Google': '' + j('AIz', 'aSyA-12345678901', '23456789012345678901') + '',
    'Stripe': '' + j('sk_', 'live_abcdefgh', 'ijklmnopqrstuvwx') + '',
    'SendGrid': '' + j('SG.', 'abcdefghijklmnopqrstuv.abcde', 'fghijklmnopqrstuvwxyz0123456789') + '',
    'Docker': j('dckr', '_pat_abcdefghijklmnopqrstuv'),
    'Hugging Face': j('hf', '_abcdefghijklmnopqrstuvwxyz0123456789'),
    'Anthropic': j('sk', '-ant-api03-abcdefghijklmnopqrstuvwxyz'),
    'OpenAI': j('sk', '-', 'a'.repeat(40)),
    'JWT': '' + j('eyJ', 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiI', 'xMjM0NTY3ODkwIn0.abcdefghijklmnop') + '',
    'Jenkins API token': j('11', '0123456789abcdef', '0123456789abcdef'),
    'Azure': 'DefaultEndpointsProtocol=https;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF==',
  };
  for (const [name, secret] of Object.entries(corpus)) {
    const out = clean(`before ${secret} after`);
    assert.equal(out.includes(secret.slice(-14)), false, `${name} got through: ${out}`);
    assert.match(out, /^before /, name);
  }
  // A signed address keeps its shape.
  const sas = clean('https://acct.blob.core.windows.net/c/x?sv=2020&sig=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789%2F%3D&se=1');
  assert.match(sas, /\?sv=2020&sig=\[REDACTED:sas-signature len=\d+\]&se=1/);
});

test('private keys, whole, even when the end is missing', () => {
  const key = '' + j('---', '--BEGIN RSA ', 'PRIVATE KEY-----') + '\nMIIEowIBAAKCAQEA\nabcdefghijklmnop\n-----END RSA PRIVATE KEY-----';
  const out = clean(`before\n${key}\nafter`);
  // The key's lines stay lines: a marker where it began, blank rows after it, so every line number is what it was.
  assert.equal(out, 'before\n[REDACTED:private-key len=' + key.length + ']\n\n\n\nafter');
  assert.equal(clean('x\n' + j('---', '--BEGIN OPENSS', 'H PRIVATE KEY-----') + '\nAAAAB3NzaC1yc2E\n\nnext paragraph').includes('AAAAB3'), false);
  // A key whose end was cut off by a truncated log: all of what is there is masked, and it is a limit, not "to the end of the text".
  const unterminated = clean(`${j('---', '--BEGIN PR', 'IVATE KEY-----')}\n${'A'.repeat(6_000)}`);
  assert.equal(unterminated.includes('AAAAAAAA'), false);
  assert.ok(unterminated.length < 200);
  const huge = clean(`${j('---', '--BEGIN PR', 'IVATE KEY-----')}\n${'A'.repeat(100_000)}`);
  assert.ok(huge.length < 100_000, 'masking an open-ended key does not swallow a whole megabyte');
  // A weak numeric password is still a password; a count is not.
  assert.equal(clean('password=123456').includes('123456'), false);
  assert.equal(clean('tokens=8 max_tokens=4096'), 'tokens=8 max_tokens=4096');
  // A public key and a certificate are not secrets.
  assert.equal(clean('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----').includes('MIIB'), true);
});

test('what looks like a secret but is not: left alone', () => {
  const ordinary = [
    'commit 3f786850e387550fdab836ed7e6dc881de23001b',
    'md5 9e107d9d372bb6826bd81d3542a419d6 sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'max_tokens=4096 token_count: 12 tokens=8',
    'password: ${PASSWORD} token=$TOKEN pass=%PASS% secret: <your-secret> apikey={{ key }}',
    'password=**** token: ******',
    'password: true  token: none  auth: ok  Authorization: OK',
    'the password is wrong, token expired, authentication failed',
    '/var/jenkins_home/workspace/team/app@2/target/classes/Foo.class',
    'Download https://repo.maven.apache.org/maven2/org/x/y/1.0/y-1.0.jar (45 kB)',
    'sha1:da39a3ee5e6b4b0d3255bfef95601890afd80709 uuid 123e4567-e89b-12d3-a456-426614174000',
    'Started by user ana',
    'eyJ is the start of a JWT but eyJ alone is not one',
  ];
  for (const line of ordinary) assert.equal(clean(line), line, `mangled: ${line}`);
});

test('a masked value says how long it was, and masking twice changes nothing', () => {
  const once = clean('password=hunter2 token: ' + j('ghp', '_abcdefghijklmnop', 'qrstuvwxyz0123456789') + '');
  assert.match(once, /len=7/);
  assert.match(once, /github-token len=40/);
  assert.equal(clean(once), once);
  const { count, kinds } = redact('a=1 password=x1y2z3 https://u:p4ss@h.com');
  assert.equal(count, 2);
  assert.deepEqual(Object.keys(kinds).sort(), ['secret-value', 'url-password']);
});

test('making text inert: escapes, annotations, controls and the characters that hide things', () => {
  assert.equal(strip('\u001b[31mred\u001b[0m and \u001b[1;32mgreen\u001b[0m'), 'red and green');
  assert.equal(strip('a\u001b]0;title\u0007b'), 'ab', 'a terminal title sequence');
  assert.equal(strip('x\u001b[8mha:////4FPuXvUOZZUpKahJ+pznEKm\u001b[0my'), 'xy', 'a console annotation');
  assert.equal(strip('x\u001b[8mha:////never closed\nnext line'), 'x\nnext line', 'an unclosed one ends with its line');
  assert.equal(strip('line\r\nnext\rbar'), 'line\nnext\nbar');
  assert.equal(strip('a\u0000b\u0007c\u001fd\u007fe'), 'abcde');
  // Zero-width, bidi overrides and Unicode tag characters: invisible to a reader, readable to a model.
  assert.equal(strip('ig​nore‮ previous⁦ ﻿instructions'), 'ignore previous instructions');
  assert.equal(strip(`ok${String.fromCodePoint(0xe0049)}${String.fromCodePoint(0xe0067)}ok`), 'okok');
  // Tabs and newlines are text.
  assert.equal(strip('a\tb\nc'), 'a\tb\nc');
  assert.equal(strip(null), '');
});

test('whole objects: strings are cleaned, secret-named fields are masked entire, shape is plain data', () => {
  const { value, count } = redactDeep({
    name: 'deploy',
    log: '\u001b[31mfailed\u001b[0m password=abc12345',
    token: 'a-token',
    nested: { Authorization: 'Bearer x', list: ['ok', { apiKey: 'k' }], fn() { return 1; } },
    n: 3,
    ok: true,
    __proto__: { evil: 1 },
  });
  assert.equal(value.name, 'deploy');
  assert.equal(value.log.includes('abc12345'), false);
  assert.equal(value.log.includes('\u001b'), false);
  assert.match(value.token, /^\[REDACTED:field len=7\]$/);
  assert.match(value.nested.Authorization, /REDACTED/);
  assert.match(value.nested.list[1].apiKey, /REDACTED/);
  assert.equal('fn' in value.nested, false, 'functions are not data');
  assert.equal(value.n, 3);
  assert.equal(Object.hasOwn(value, 'evil'), false);
  assert.ok(count >= 4);
  const deep = redactDeep({ a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } }, { maxDepth: 4 });
  assert.match(JSON.stringify(deep.value), /too deep/);
  const long = redactDeep({ s: 'x'.repeat(50_000) }, { maxString: 1000 });
  assert.ok(long.value.s.length < 1100 && long.value.s.includes('more characters'));
});

/** Run `fn` and return how long it took. Generous bounds: this is to catch a pattern that runs away, not to benchmark. */
function seconds(fn) {
  const at = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - at) / 1e9;
}

test('hostile text, megabytes of it, is handled in linear time', () => {
  const MB2 = 2_000_000;
  const cases = {
    dashes: '-'.repeat(MB2),
    keywords: 'password'.repeat(MB2 / 8),
    'name=': 'token='.repeat(MB2 / 6),
    'one long word': 'a'.repeat(MB2),
    'url without end': `https://${'a'.repeat(MB2 / 2)}:${'b'.repeat(MB2 / 2)}`,
    'colons': 'a:'.repeat(MB2 / 2),
    'many annotations': '\u001b[8mha:'.repeat(MB2 / 7),
    'many key headers': '' + j('---', '--BEGIN RSA ', 'PRIVATE KEY-----') + '\n'.repeat(MB2 / 32),
    'jwt prefixes': 'eyJ'.repeat(MB2 / 3),
    'bearer': 'Bearer '.repeat(MB2 / 7),
    'quotes': '"'.repeat(MB2),
    'osc': '\u001b]'.repeat(MB2 / 2),
    'many flags': '--password '.repeat(MB2 / 11),
    'base64 near a key': `secret=${'QUJD'.repeat(MB2 / 4)}`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const took = seconds(() => sanitize(text));
    assert.ok(took < 5, `${name} took ${took.toFixed(2)}s`);
  }
});

test('input beyond the cap is cut before anything is done to it', () => {
  const out = sanitize('a'.repeat(10_000_000));
  assert.ok(out.text.length <= 4 * 1024 * 1024);
});

// --- one door: safeText -------------------------------------------------------------------

const { safeText } = require('../electron/jenkins-redact');

const join = (...parts) => parts.join('');
const BEGIN = join('-----BEGIN RSA ', 'PRIVATE KEY-----');
const END = join('-----END RSA ', 'PRIVATE KEY-----');
/** A key as a console prints it: a header, `n` lines of body each beginning KEYBODY, an end. */
const pem = (n, { begin = BEGIN, end = END, prefix = '' } = {}) => [`${prefix}${begin}`, ...Array.from({ length: n }, (_, i) => `${prefix}KEYBODY${String(i).padStart(3, '0')}${'A'.repeat(56)}`), `${prefix}${end}`];
const lines = (n, word) => Array.from({ length: n }, (_, i) => `${word} ${i}`);
const visible = (text) => (text.match(/KEYBODY/g) ?? []).length;

test('safeText: strip, then keys, then tokens — and a window cut from what it returns holds no key', () => {
  const text = [...lines(10, 'pre'), ...pem(50), ...lines(30, 'post')].join('\n');
  const out = safeText(text).text;
  assert.equal(visible(out), 0);
  assert.match(out, /REDACTED:private-key/);
  // A window can begin anywhere in it, because there is nothing left to begin in the middle of.
  const all = out.split('\n');
  for (const [from, to] of [[0, 20], [15, 40], [30, 60], [55, 95], [60, 70]]) assert.equal(visible(all.slice(from, to).join('\n')), 0, `${from}-${to}`);
  // The lines are where they were: a number quoted from Jenkins still points at the same place.
  assert.equal(all.length, text.split('\n').length);
  assert.equal(all[0], 'pre 0');
  assert.equal(all[all.length - 1], 'post 29');
  assert.equal(all.indexOf('post 0'), text.split('\n').indexOf('post 0'));
});

test('safeText: a header disguised with an escape, a zero-width character or a homoglyph-free obfuscation is still a header', () => {
  const zwsp = String.fromCharCode(0x200b);
  const soft = String.fromCharCode(0xad);
  const bidi = String.fromCharCode(0x202e);
  for (const begin of [
    join('-----BEGIN RSA \u001b[0m', 'PRIVATE KEY-----'),
    join('-----BEGIN RSA PRIV', zwsp, 'ATE KEY-----'),
    join('-----BEGIN', soft, ' RSA PRIVATE KEY-----'),
    join(bidi, '-----BEGIN RSA PRIVATE KEY-----'),
    join('\u001b[1;31m-----BEGIN RSA PRIVATE KEY-----\u001b[0m'),
    join('-----begin rsa ', 'private key-----'),
    join('-----Begin Rsa ', 'Private Key-----'),
    join('-----BEGIN ENCRYPTED ', 'PRIVATE KEY-----'),
    join('-----BEGIN OPENSSH ', 'PRIVATE KEY-----'),
    join('-----BEGIN PGP PRIVATE KEY BLOCK-----'),
  ]) {
    const text = [...lines(3, 'pre'), ...pem(40, { begin }), ...lines(3, 'post')].join('\n');
    const out = safeText(text).text;
    assert.equal(visible(out), 0, JSON.stringify(begin));
    assert.match(out, /REDACTED:private-key/, JSON.stringify(begin));
  }
  // An end line spelled the same way does not keep the block open.
  const closed = safeText([...pem(5, { end: join('-----end rsa ', 'private key-----') }), 'after the key'].join('\n')).text;
  assert.match(closed, /after the key$/);
});

test('safeText: a key whose lines each carry a timestamp or a prefix, and one with Windows line ends', () => {
  const stamped = safeText(pem(40, { prefix: '[12:00:01] ' }).join('\n')).text;
  assert.equal(visible(stamped), 0);
  const jenkins = safeText(pem(40, { prefix: '12:00:01  ' }).join('\n')).text;
  assert.equal(visible(jenkins), 0);
  assert.equal(visible(safeText(pem(40).join('\r\n')).text), 0);
});

test('safeText: the end of a key whose beginning was cut off, and a body with no header at all', () => {
  // What Jenkins keeps of a long step log: the last 10 KB, which can start inside the key.
  const tail = [...pem(50).slice(30), ...lines(5, 'post')].join('\n');
  assert.equal(visible(safeText(tail).text), 0, 'an END line with no BEGIN masks the lines above it');
  assert.match(safeText(tail).text, /post 4$/);
  // No header and no end: three or more lines of base64 of PEM width are a key.
  const bare = [...lines(4, 'pre'), ...pem(20).slice(1, -1), ...lines(4, 'post')].join('\n');
  assert.equal(visible(safeText(bare).text), 0);
  assert.match(safeText(bare).text, /pre 3\n/);
  // OpenSSH bodies start with a fixed string.
  const sshRow = 'AAAAB3NzaC1yc2EAAAADAQABAAAB'.repeat(3);
  const ssh = ['x', join('b3BlbnNzaC1rZXktdjE', 'wQ'.repeat(28)), sshRow, sshRow, 'y'].join('\n');
  assert.equal(/AAAAB3NzaC1yc2E/.test(safeText(ssh).text), false);
  assert.match(safeText(ssh).text, /^x\n\[REDACTED:private-key len=\d+\]\n\n\ny$/);
  // Two lines of base64 are not a key, and a list of hashes is not base64: ordinary logs are left alone.
  const ordinary = [`${'a1b2c3d4'.repeat(8)}`, `${'e3b0c44298fc1c14'.repeat(4)}`, `${'0123456789abcdef'.repeat(4)}`, 'short line'].join('\n');
  assert.equal(safeText(ordinary).text, ordinary, 'hex digests, three in a row, are not a key');
  const two = ['x', 'Zm9v'.repeat(16), 'Zm9v'.repeat(16), 'y'].join('\n');
  assert.equal(safeText(two).text, two);
});

test('safeText: a block that never ends masks what looks like key and stops at what does not', () => {
  const text = [...lines(2, 'pre'), BEGIN, ...pem(10).slice(1, -1), 'BUILD FAILED: something broke', ...lines(3, 'post')].join('\n');
  const out = safeText(text).text;
  assert.equal(visible(out), 0);
  assert.match(out, /BUILD FAILED: something broke\npost 0\npost 1\npost 2$/, 'the log after it is still there');
  // Even so it is bounded: a stray header followed by a long run of key-like lines masks the run, not the world.
  const world = [BEGIN, ...Array.from({ length: 6000 }, () => 'A'.repeat(64)), 'the end of the log'].join('\n');
  assert.match(safeText(world).text, /the end of the log$/);
});

test('safeText: a console too large to hold in one piece is masked piece by piece, a key straddling a boundary included', () => {
  const filler = (n) => Array.from({ length: n }, (_, i) => `build output line ${i} ${'x'.repeat(40)}`).join('\n');
  // About 9 MB, with the key placed to cross the 4 MB and the 8 MB marks in turn.
  for (const at of [4_000_000, 4_194_000, 8_000_000, 8_388_000]) {
    const before = filler(Math.ceil(at / 70));
    const text = `${before}\n${pem(60).join('\n')}\n${filler(20_000)}`;
    const started = Date.now();
    const out = safeText(text).text;
    assert.equal(visible(out), 0, `at ${at}`);
    assert.equal(out.split('\n').length, text.split('\n').length, 'every line is still a line');
    assert.ok(Date.now() - started < 20_000, 'and it does not take for ever');
  }
  // A token on the far side of a boundary is masked too: the rules run on every piece.
  const far = `${filler(70_000)}\npassword=hunter2xx\n${filler(10)}`;
  assert.equal(safeText(far).text.includes('hunter2xx'), false);
});

test('safeText is idempotent and says how much it masked', () => {
  const text = [...lines(3, 'pre'), ...pem(10), `password=${'s3cr3tvalue'}`].join('\n');
  const once = safeText(text);
  assert.equal(safeText(once.text).text, once.text);
  assert.ok(once.count >= 2);
  assert.equal(safeText('nothing to hide here\n').count, 0);
  assert.deepEqual(safeText(''), { text: '', count: 0 });
  assert.deepEqual(safeText(null), { text: '', count: 0 });
});

test('safeText: the invisible characters a review found are all removed', () => {
  const marks = [0xad, 0x61c, 0x2028, 0x2029, 0x180e, 0x34f, 0x115f, 0x3164, 0xffa0, 0x17b4, 0xfe00, 0xfe0f, 0x2065, 0xfff9, 0xfffb, 0x2800].map((c) => String.fromCharCode(c));
  for (const mark of [...marks, String.fromCodePoint(0xe0100), String.fromCodePoint(0xe01ef)]) {
    assert.equal(safeText(`ig${mark}nore`).text, 'ignore', `U+${mark.codePointAt(0).toString(16)}`);
  }
});

test('safeText: hostile megabytes stay fast', () => {
  const cases = {
    'a stray header per line': `${BEGIN}\n`.repeat(60_000),
    'lowercase headers': `${join('-----begin rsa ', 'private key-----')}\n`.repeat(60_000),
    'ends without a beginning': `${END}\n`.repeat(60_000),
    'base64 lines': `${'Zm9v'.repeat(16)}\n`.repeat(30_000),
    'the keyword key': 'key '.repeat(500_000),
    'the keyword pass': 'pass'.repeat(500_000),
    'identifier-shaped words': 'abc_def.ghi-jkl '.repeat(120_000),
    'curl lines': 'curl -u a '.repeat(100_000),
    'yaml keys': 'password:\n  '.repeat(100_000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const started = process.hrtime.bigint();
    safeText(text);
    const took = Number(process.hrtime.bigint() - started) / 1e9;
    assert.ok(took < 8, `${name} took ${took.toFixed(1)}s`);
  }
});
