'use strict';

/**
 * A Jenkins with two Active Choices parameters, as far as the app can see it: the form page (answered 405, with the form
 * as the body, and a session cookie), the script that makes a bound object's proxy, and the bound object itself.
 * It is the shape the real one has — measured on a real Jenkins, not guessed — and it refuses what the real one refuses:
 * a call without the session cookie or without the crumb its script carried.
 */
const { JenkinsError } = require('../../electron/jenkins-api');

const UUID_BUMP = '11111111-2222-4333-8444-555555555555';
const UUID_VERSIONS = '66666666-7777-4888-9999-000000000000';

function fakeActiveChoices({ libs, tableHtml = null, down = false } = {}) {
  const model = {
    libs: libs ?? {
      common: { pom: '2.5.3', released: '2.5.3', bumps: ['POM (2.5.3)', 'MINOR', 'PATCH', 'MAJOR'] },
      'mongo-common': { pom: '2.3.0', released: '2.2.0', bumps: ['POM (2.3.0)', 'MINOR', 'PATCH', 'MAJOR'] },
    },
    session: 'JSESSIONID.test=SESSION-1',
    crumb: 'CRUMB-1',
    calls: [],
    pages: 0,
    down,
    failMethod: null,
    sent: {},
  };
  const table = (lib) => {
    if (tableHtml) return tableHtml(lib, model);
    const rows = Object.entries(model.libs).map(([name, one]) => `<tr style=''><td style='padding:3px 14px 3px 4px'><code>${name}</code></td><td><b>${one.pom}</b></td><td>${one.released}</td><td>${one.pom === one.released ? 'already released' : 'to release'}</td></tr>`).join('');
    const mine = model.libs[lib];
    return `<table style='border-collapse:collapse'><tr style='opacity:.6'><th align='left'>library</th><th>pom declares</th><th>latest released</th><th></th></tr>${rows}</table>`
      + `<p><b>${mine.pom === mine.released ? 'Nothing to release.' : 'Will release.'}</b> <code>${lib}</code> ${mine.pom} &amp; more.</p><div style='opacity:.6'>as of build #198</div>`;
  };
  const optionsOf = (lib) => model.libs[lib].bumps.map((one, i) => `<option value="${one}"${i === 0 ? ' selected' : ''}>${one}</option>`).join('');
  const page = () => `<html><body><div class="parameters">
<div class="jenkins-form-item tr "><div class="jenkins-form-label help-sibling">CURRENT_VERSIONS</div><div class="setting-main"><div id="choice-parameter-1-spinner" class="ac-spinner"></div><div name="parameter" id="choice-parameter-1" class=""><input name="name" type="hidden" value="CURRENT_VERSIONS"><div id="formattedHtml_choice-parameter-2">${table('common')}</div></div></div><div class="validation-error-area"></div></div>
<span data-referenced-parameters="LIB,BUMP,OVERWRITE" data-name="CURRENT_VERSIONS" data-param-name="choice-parameter-1" data-proxy-name="dynamicReferenceParameter_id1" class="dynamic-reference-parameter-data-holder"></span>
<script src='/adjuncts/c2cd4c5b/org/biouno/unochoice/DynamicReferenceParameter/dynamic-reference-parameter.js' type='text/javascript'></script><script src="/$stapler/bound/script/$stapler/bound/${UUID_VERSIONS}?var=dynamicReferenceParameter_id1&amp;methods=getChoicesAsStringForUI,doUpdate,getChoicesForUI" type="text/javascript"></script>
<div class="jenkins-form-item tr "><div class="jenkins-form-label help-sibling">LIB</div><div class="setting-main"><select name="value" class="jenkins-select__input"><option value="common">common</option><option value="mongo-common">mongo-common</option></select></div></div>
<div class="jenkins-form-item tr "><div class="jenkins-form-label help-sibling">BUMP</div><div class="setting-main"><div name="parameter" id="choice-parameter-3" class="active-choice"><input name="name" type="hidden" value="BUMP"><div class="jenkins-select ac-ignore"><select name="value" class="jenkins-select__input">${optionsOf('common')}</select></div></div></div><div class="validation-error-area"></div></div>
<span data-referenced-parameters="LIB" data-filterable="false" data-random-name="choice-parameter-3" data-filter-length="1" class="cascade-choice-parameter-data-holder" data-name="BUMP" data-param-name="choice-parameter-3" data-proxy-name="cascadeChoiceParameter_id2"></span>
<script src="/$stapler/bound/script/$stapler/bound/${UUID_BUMP}?var=cascadeChoiceParameter_id2&amp;methods=getChoicesForUI,doUpdate" type="text/javascript"></script>
</div></body></html>`;
  const reply = (body, extra = {}) => ({ status: 200, bytes: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), tooBig: false, headers: { get: () => null }, ...extra });
  const bound = { [UUID_BUMP]: { kind: 'cascade', lib: 'common' }, [UUID_VERSIONS]: { kind: 'reference', lib: 'common' } };
  const needSession = (headers = {}) => {
    if (headers.Cookie !== model.session) throw new JenkinsError('Jenkins has nothing there', 404);
  };
  const api = {
    async rawGet(path, opts = {}) {
      model.calls.push({ method: 'GET', path, opts });
      if (model.down) throw new JenkinsError('Could not reach Jenkins: ECONNREFUSED');
      if (/\/build\?delay=0sec$/.test(path)) {
        // Jenkins answers a GET of a parameterized job's build page with 405 and the form.
        if (!(opts.allow ?? []).includes(405)) throw new JenkinsError('Jenkins answered 405', 405);
        model.pages += 1;
        for (const id of Object.keys(bound)) bound[id].lib = 'common';
        return reply(page(), { status: 405, headers: { get: () => null, getSetCookie: () => [`${model.session}; Path=/; HttpOnly`] } });
      }
      const script = /^\/\$stapler\/bound\/script\/\$stapler\/bound\/([0-9a-f-]{36})\?var=(\w+)&methods=/.exec(path);
      if (script && bound[script[1]]) {
        needSession(opts.headers);
        return reply(`var ${script[2]}=makeStaplerProxy('/$stapler/bound/${script[1]}','${model.crumb}',['doUpdate','getChoicesForUI']);`);
      }
      throw new JenkinsError('Jenkins has nothing there', 404);
    },
    async rawPost(path, body, opts = {}) {
      model.calls.push({ method: 'POST', path, body, opts });
      if (model.down) throw new JenkinsError('Could not reach Jenkins: ECONNREFUSED');
      const m = /^\/\$stapler\/bound\/([0-9a-f-]{36})\/(\w+)$/.exec(path);
      if (!m || !bound[m[1]]) throw new JenkinsError('Jenkins has nothing there', 404);
      needSession(opts.headers);
      if (opts.headers.Crumb !== model.crumb) throw new JenkinsError('Jenkins refused that', 403);
      if (!/^application\/x-stapler-method-invocation/.test(opts.contentType ?? '')) throw new JenkinsError('Jenkins answered 415', 415);
      if (model.failMethod === m[2]) throw new JenkinsError('Jenkins answered 500', 500);
      const args = JSON.parse(body);
      const one = bound[m[1]];
      if (m[2] === 'doUpdate') {
        model.sent[m[1]] = args[0];
        const pairs = Object.fromEntries(String(args[0]).split('__LESEP__').filter(Boolean).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
        one.lib = pairs.LIB ?? 'common';
        one.pairs = pairs;
        // Measured on a real Jenkins: 204, and nothing in the body.
        return reply('', { status: 204 });
      }
      if (m[2] === 'getChoicesForUI') {
        const lib = model.libs[one.lib];
        if (!lib) return reply([[], []]);
        return reply([lib.bumps.map((b, i) => (i === 0 ? `${b}:selected` : b)), lib.bumps]);
      }
      if (m[2] === 'getChoicesAsStringForUI') return reply(JSON.stringify(table(one.lib)));
      throw new JenkinsError('Jenkins has nothing there', 404);
    },
    async job() {
      return { path: 'KUBRIK/TIMELOG/LIB RELEASE', parameters: [
        { name: 'CURRENT_VERSIONS', type: 'dynamicreferenceparameter', description: 'What releasing would publish.', default: '', choices: null, secret: false },
        { name: 'LIB', type: 'choice', description: 'Library.', default: '', choices: ['common', 'mongo-common'], secret: false },
        { name: 'BUMP', type: 'cascadechoiceparameter', description: 'What to do with the pom.', default: '', choices: null, secret: false },
        { name: 'OVERWRITE', type: 'choice', description: 'Re-publish.', default: '', choices: ['NO', 'YES'], secret: false },
      ], builds: [], newest: null };
    },
  };
  return { api, model, UUID_BUMP, UUID_VERSIONS, page };
}

module.exports = { fakeActiveChoices, UUID_BUMP, UUID_VERSIONS };
