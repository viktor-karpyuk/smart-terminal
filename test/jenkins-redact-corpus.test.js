'use strict';

/**
 * The independent review's corpus, held as tests: what must be masked, and — as
 * important — what must be left exactly as it is.
 *
 * A net that masks too little leaks; a net that masks too much teaches people
 * to stop trusting it, and `Author: Jane Doe` turned into `Author: [REDACTED]
 * Doe` is how that starts. Both lists are here, and every false positive the
 * review found is a line in the second one.
 *
 * Nothing in this file is a token. Each one with the shape of a real credential
 * is put together when the test runs, from parts that are not that shape on
 * their own, so a secret scanner reading the repository finds nothing to stop
 * a push on.
 */

const test = require('node:test');
const assert = require('node:assert');

const { sanitize, safeText } = require('../electron/jenkins-redact');

/** Join parts at run time: `j('ghp', '_', 'x'.repeat(36))` is a token only once the test is running. */
const j = (...parts) => parts.join('');
const rep = (text, n) => text.repeat(n);
const b64 = (text) => Buffer.from(text).toString('base64');

/** A 32-character value that looks like nothing in particular: the thing that must not survive. */
const SEC = j('Zk9xP3rT7vLw2YdN8c', 'Hb5MnA4sUeX1gJ');
/** The 40-character secret half of an AWS key pair (AWS's own documentation example). */
const AWSK = j('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY');
const HEX32 = rep('0123456789abcdef', 2);
const GH = rep('A1b2C3d4E5', 4);

/** [name, text, what must not appear]: masked by the net. `leak` defaults to the secret above. */
const MUST_MASK = [
  // ---- named secrets, as the first review had them
  ['export FOO_TOKEN', `export FOO_TOKEN=${SEC}`],
  ['DB_PASS', `DB_PASS=${SEC}`],
  ['DB_PWD', `DB_PWD=${SEC}`],
  ['AWS_SECRET_ACCESS_KEY', `AWS_SECRET_ACCESS_KEY=${AWSK}`, AWSK],
  ['aws cli configure', `aws_secret_access_key = ${AWSK}`, AWSK],
  ['aws json', `"SecretAccessKey": "${AWSK}"`, AWSK],
  ['Authorization lower', `authorization: bearer ${SEC}`],
  ['Authorization tab', `Authorization:\tBearer\t${SEC}`],
  ['curl -H token', `curl -H "Authorization: token ${SEC}" https://x`],
  ['X-API-Key', `X-API-Key: ${SEC}`],
  ['PRIVATE-TOKEN', `PRIVATE-TOKEN: ${SEC}`],
  ['yaml password', `password: ${SEC}`],
  ['yaml secret quoted', `secret: "${SEC}"`],
  ['json password', `{"password":"${SEC}"}`],
  ['json single quotes', `{'password': '${SEC}'}`],
  ['python dict', `{'Authorization': 'Bearer ${SEC}'}`],
  ['groovy map', `[password: '${SEC}']`],
  ['azure client secret', `AZURE_CLIENT_SECRET=${SEC}`],
  ['form body', `grant_type=client_credentials&client_secret=${SEC}`],
  ['cookie', `Cookie: JSESSIONID=${SEC}; other=1`],
  ['set -x export', `+ export 'DB_PASSWORD=${SEC}'`],
  ['--password flag', `--password ${SEC}`],
  ['--token=', `--token=${SEC}`],
  ['--api-key', `--api-key ${SEC}`],
  ['-storepass', `-storepass ${SEC} -keypass ${SEC}`],
  ['gradle signing', `-Psigning.password=${SEC}`],
  ['helm --set', `--set db.password=${SEC}`],
  ['terraform var', `-var 'db_password=${SEC}'`],
  ['twine', `TWINE_PASSWORD=${SEC}`],
  ['ansible', `ansible_become_pass: ${SEC}`],
  ['zero-width in the keyword', `pass${String.fromCharCode(0x200b)}word=${SEC}`],
  // ---- what the second review found missing
  ['curl -u', `curl -u admin:${SEC} https://x`],
  ['curl -u quoted', `curl -u 'admin:${SEC}' https://x`],
  ['curl --user', `curl --user admin:${SEC} https://x`],
  ['curl -u with a Jenkins token', `curl -u viktor:${j('11', HEX32)} http://j`, HEX32],
  ['docker login -p', `docker login -u me -p ${SEC} reg.io`],
  ['docker login set -x', `+ docker login -u me -p ${SEC}`],
  ['sshpass -p', `sshpass -p ${SEC} ssh x`],
  ['mysql -p<password>', `mysql -u root -p${SEC} db`],
  ['jenkins-cli -auth', `java -jar jenkins-cli.jar -auth viktor:${SEC} build x`],
  ['SIGNING_KEY', `SIGNING_KEY=${SEC}`],
  ['ENCRYPTION_KEY', `ENCRYPTION_KEY=${SEC}`],
  ['DEPLOY_KEY', `DEPLOY_KEY=${SEC}`],
  ['bare key=', `key=${SEC}`],
  ['_PSW (credentials binding)', `MY_CRED_PSW=${SEC}`],
  ['groovy assignment', `def pw = '${SEC}'`],
  ['sonar.login', `-Dsonar.login=${SEC}`],
  ['sonar.token', `-Dsonar.token=${SEC}`],
  ['identifier longer than 24 after the keyword', `token_for_the_deployment_system_of_prod_xyz=${SEC}`],
  ['identifier longer than 40 before the keyword', `${rep('a', 45)}_token=${SEC}`],
  ['a value that starts with a dollar sign is not a variable', `password=$${SEC}`],
  ['a value that starts with a bracket is not a placeholder', `password=<${SEC}`],
  ['maven xml', `<password>${SEC}</password>`],
  ['xml secret tag', `<apiKey>${SEC}</apiKey>`],
  ['escaped json inside a string', `{\\"password\\":\\"${SEC}\\"}`],
  ['url-encoded', `password%3D${SEC}`],
  ['url-encoded lower', `token%3d${SEC}&x=1`],
  ['yaml value on the next line', `db:\n  pass:\n    ${SEC}`],
  ['jenkins crumb', `Jenkins-Crumb: ${HEX32}`, HEX32],
  ['redis with no user', `redis://:${SEC}@host:6379`],
  ['url password with an @', `https://user:p@${SEC}@host.com/x`],
  ['url password with encoded chars', `git clone https://user:${SEC}%21@github.com/a/b`],
  ['aws secret next to its key id', `${j('AKIA', 'IOSFODNN7EXAMPLE')} ${AWSK}`, AWSK],
  ['aws "Secret Access Key:"', `Secret Access Key: ${AWSK}`, AWSK],
  ['aws id then secret on a csv line', `${j('AKIA', 'IOSFODNN7EXAMPLE')},${AWSK}`, AWSK],
  ['slack xapp', `${j('xapp', '-1-A0123456789-1234567890123-')}${HEX32}`, HEX32],
  ['gitlab glptt', `${j('glp', 'tt-')}${rep('abcdef1234', 4)}`, rep('abcdef1234', 4)],
  ['gitlab glrt', `${j('gl', 'rt-')}${rep('abcdef1234', 2)}`, rep('abcdef1234', 2)],
  ['gitlab glpat', `${j('gl', 'pat-')}${rep('abcDEF1234', 2)}`, rep('abcDEF1234', 2)],
  ['sonar squ_', `${j('sq', 'u_')}${rep('0123456789abcdef', 3)}`, rep('0123456789abcdef', 3)],
  ['sonar sqp_', `${j('sq', 'p_')}${rep('0123456789abcdef', 3)}`, rep('0123456789abcdef', 3)],
  ['google ya29', `${j('ya', '29.')}${SEC}${SEC}`],
  ['google refresh token', `${j('1/', '/0g')}${SEC}${SEC}`],
  ['vault token', `VAULT_TOKEN=${j('hv', 's.')}${SEC}`],
  ['twilio', `${j('S', 'K')}${HEX32}`, HEX32],
  ['mailgun', `${j('ke', 'y-')}${HEX32}`, HEX32],
  ['telegram bot', `${j('bot', '123456789:AAH')}${SEC}`],
  ['github token shorter than thirty', `${j('gh', 'p_')}${rep('A1b2C3d4E5', 2)}`, rep('A1b2C3d4E5', 2)],
  ['github actions token', `${j('gh', 's_')}${GH}`, GH],
  ['github token in a commit message', `Fix login (token ${j('gh', 'p_')}${GH})`, GH],
  ['x-access-token url', `https://x-access-token:${j('gh', 's_')}${GH}@github.com/o/r`, GH],
  ['npmrc _authToken', `//registry.npmjs.org/:_authToken=${SEC}`],
  ['docker config auth', `{"auths":{"reg.io":{"auth":"${b64(`me:${SEC}`)}"}}}`, b64(`me:${SEC}`)],
  ['kubeconfig token', `kubectl --token=${SEC} get pods`],
  // ---- a password may hold any character that is not a space
  ['password with a comma', `password=ab,cd${SEC}`],
  ['password with a semicolon', `password=ab;cd${SEC}`],
  ['password with an ampersand', `password=ab&cd${SEC}`],
  ['password with a parenthesis', `password=ab)cd${SEC}`],
  ['password with a quote', `password=ab"cd${SEC}`],
  ['password with a brace', `password=ab}cd${SEC}`],
  ['password in a jdbc url', `jdbc:sqlserver://h;user=sa;password=${SEC};`],
  // ---- command lines that print a secret before they use it
  ['echo into docker login', `echo ${SEC} | docker login -u me --password-stdin reg.io`],
  ['printf into podman login', `printf '%s' '${SEC}' | podman login --password-stdin reg.io`],
  // ---- a key row with no header, even alone
  ['an RSA key row', `MIIEowIBAAKCAQEA${SEC}${SEC}`],
  // ---- values too long to be held by a cap
  ['kubeconfig client-key-data, 4500 characters', `client-key-data: ${rep('QUJD', 1125)}END4500MARK`, 'END4500MARK'],
  ['json private_key, 4500 characters', `{"private_key": "${rep('Zm9v', 1125)}TAIL4500MARK"}`, 'TAIL4500MARK'],
  ['a very long token value', `API_TOKEN=${rep('a', 3000)}TAIL3000MARK`, 'TAIL3000MARK'],
];

/** Lines that are not secrets. Each stays exactly as it was, and nothing is said to have been masked. */
const MUST_LEAVE = [
  'Author: Jane Doe',
  'author=Ana R.',
  'git log --author=ana',
  'passed: 12',
  'Tests passed=12 failed=0',
  'compass=north',
  'Tokenizer: lexer',
  'pass: build.sh',
  'PASS: all 12 tests',
  'pass=true',
  'secret_name: db-creds',
  'token_name=deploy',
  'authorized_keys=/home/jenkins/.ssh/authorized_keys',
  'session_id: abc123',
  'cookie_name=sid',
  'pwd=/home/jenkins/workspace',
  'max_tokens=4096',
  'tokens=8',
  'Primary key: id',
  'primary_key=id',
  'sort_key=name',
  'foreign_key=user_id',
  'ssh -i /home/j/.ssh/id_rsa -o StrictHostKeyChecking=no host',
  'docker run -u root:root img',
  'chown -R jenkins:jenkins /var/jenkins_home',
  'keytool -keystore /tmp/store.jks -alias x',
  'password=****',
  'token: ******',
  'password: ${PASSWORD} token=$TOKEN pass=%PASS% secret: <your-secret> apikey={{ key }}',
  'Authorization: OK',
  'the password is wrong, token expired, authentication failed',
  'commit 3f786850e387550fdab836ed7e6dc881de23001b',
  `sha256 ${rep('e3b0c44298fc1c14', 4)} md5 9e107d9d372bb6826bd81d3542a419d6`,
  'sha1:da39a3ee5e6b4b0d3255bfef95601890afd80709 uuid 123e4567-e89b-12d3-a456-426614174000',
  'Started by user ana',
  'Download https://repo.maven.apache.org/maven2/org/x/y/1.0/y-1.0.jar (45 kB)',
  '/var/jenkins_home/workspace/team/app@2/target/classes/Foo.class',
  `ssh-rsa ${j('AAAAB3NzaC1yc2E', SEC)} me@x`,
  `${j('-----BEGIN CERTIFICATE', '-----')}\n${rep('MIICxjCCAa6gAwIBAgIJAKb3', 3)}\n${j('-----END CERTIFICATE', '-----')}`,
  'Cloning into repo... remote: Counting objects: 100% (42/42), done.',
  'Running on Jenkins in /var/jenkins_home/workspace/team/deploy',
  '[Pipeline] withCredentials\nMasking supported pattern matches of $PASSWORD',
  'Warning: A secret was passed to "sh" using Groovy String interpolation, which is insecure.',
  'Retrieving secret from vault: path=secret/data/app (not the value)',
];

test('what must be masked is masked, completely, and says so', () => {
  const missed = [];
  for (const [name, text, leak = SEC] of MUST_MASK) {
    const out = sanitize(text);
    const survives = out.text.includes(leak) || out.text.includes(leak.slice(0, 20));
    if (survives || out.count === 0) missed.push(`${name}${survives ? ' [LEAKS]' : ' [not counted]'}: ${out.text.slice(0, 90).replace(/\n/g, '⏎')}`);
  }
  assert.deepEqual(missed, []);
});

test('what is not a secret is left exactly as it was, and not counted as one', () => {
  const touched = [];
  for (const text of MUST_LEAVE) {
    const out = sanitize(text);
    if (out.text !== text || out.count !== 0) touched.push(`${JSON.stringify(text).slice(0, 80)} -> ${JSON.stringify(out.text).slice(0, 80)}`);
  }
  assert.deepEqual(touched, []);
});

test('the same two lists hold through safeText, which is what every tool answer goes through', () => {
  const bad = [];
  for (const [name, text, leak = SEC] of MUST_MASK) {
    const out = safeText(text);
    if (out.text.includes(leak) || out.text.includes(leak.slice(0, 20))) bad.push(name);
  }
  for (const text of MUST_LEAVE) if (safeText(text).text !== text) bad.push(`left: ${text.slice(0, 40)}`);
  assert.deepEqual(bad, []);
});

test('a value is masked whole, to its real end, however long', () => {
  const long = rep('Zm9v', 2500);
  const out = sanitize(`client-key-data: ${long}\nnext line stays`);
  assert.equal(out.text.includes('Zm9vZm9v'), false);
  assert.match(out.text, /\[REDACTED:secret-value len=10000\]\nnext line stays$/);
  const quoted = sanitize(`{"private_key": "${long}", "client_email": "a@b.c"}`);
  assert.equal(quoted.text.includes('Zm9vZm9v'), false);
  assert.match(quoted.text, /"client_email": "a@b\.c"\}$/, 'what comes after is left alone');
});

test('the mask counts what it took out, and what it left does not count', () => {
  assert.equal(sanitize(`a=1 password=${SEC} https://u:p4ssw0rd@h.com x=2`).count, 2);
  assert.equal(sanitize('Author: Jane Doe passed: 12 compass=north').count, 0);
});
