'use strict';

/**
 * Parameters that Jenkins works out when a form opens — the "Active Choices" plugin's reactive ones.
 *
 * `api/json` says only that they exist: a `DynamicReferenceParameter` (a block of HTML that depends on other
 * parameters) and a `CascadeChoiceParameter` (a list of choices that depends on other parameters). What they hold is
 * worked out by a script of the job *when the form is built*, so the only place it can be read is the form itself
 * (`/job/x/build`, which Jenkins answers with 405 and the form as the body), and what a change of a parameter does to
 * them is asked of an object Jenkins binds to that page (`/$stapler/bound/<id>/doUpdate`, then `getChoicesForUI`).
 *
 * Two things are held to here:
 *
 *  - **What the job's script made is somebody else's HTML.** It is never handed on as HTML: `toBlocks` reads it into
 *    text, tables and bold/code runs and drops everything else (scripts, styles, links, images, attributes), so the
 *    panel draws it with `textContent` and nothing in it can act.
 *  - **Nothing is asked of the page's own addresses.** The bound object's id is the only thing taken from the page, and
 *    only if it is a UUID; every path asked here is built from it.
 *
 * Everything is best effort: a Jenkins without the plugin, a plugin that changed, a script that failed — each ends in
 * `null`/an `errors` entry, and the caller keeps showing a plain field.
 */

const MAX_PAGE = 2 * 1024 * 1024;
const MAX_REPLY = 512 * 1024;
const SEPARATOR = '__LESEP__';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•', laquo: '«', raquo: '»', rarr: '→', larr: '←', check: '✓' };

function decode(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const clip = (text, n) => (String(text).length > n ? `${String(text).slice(0, n - 1)}…` : String(text));

/** The attributes of a tag's text (`class="a" data-x='b' hidden`), names lower-cased, values decoded. */
function attributesOf(raw) {
  const out = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw))) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

/** The pieces of some HTML: tags (with their attributes) and text. Comments are gone. */
function tokens(html) {
  const out = [];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<[^>]*>|([^<]+)/g;
  let m;
  while ((m = re.exec(String(html)))) {
    if (m[4] !== undefined) out.push({ text: m[4] });
    else if (m[2]) out.push({ tag: m[2].toLowerCase(), close: m[1] === '/', attrs: m[1] ? {} : attributesOf(m[3]), selfClosed: /\/\s*$/.test(m[3]) });
  }
  return out;
}

const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'textarea', 'select', 'option', 'button', 'head', 'title']);
const BREAKS = new Set(['p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'hr', 'section', 'blockquote', 'dl', 'dt', 'dd']);
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'area', 'base', 'wbr', 'source']);
const BOLD = new Set(['b', 'strong', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const CODE = new Set(['code', 'tt', 'pre', 'kbd', 'samp']);
const DIM = /opacity\s*:\s*0?\.[0-9]+|color\s*:\s*(?:gr[ae]y|#(?:[6-9a-f]){3}(?:[6-9a-f]{3})?\b)/i;

const LIMITS = { blocks: 40, rows: 200, cells: 12, runs: 60, text: 600 };

/**
 * Some HTML as what is safe to show: `[{ type: 'text', runs, dim }, { type: 'table', head, rows }]`, where a cell is
 * `{ runs }` and a run is `{ t, b?, code? }`. Nothing of the markup survives but those three facts about the text.
 */
function toBlocks(html, { max = MAX_REPLY } = {}) {
  const blocks = [];
  const stack = [];
  let skip = 0;
  let runs = [];
  let table = null;
  let row = null;
  let cell = null;
  let paragraphDim = false;

  const target = () => (cell ? cell.runs : runs);
  const text = (raw) => {
    const t = decode(raw).replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ');
    if (!t || (t === ' ' && !target().length)) return;
    const list = target();
    const bold = stack.some((one) => BOLD.has(one.tag));
    const code = stack.some((one) => CODE.has(one.tag));
    const last = list[list.length - 1];
    if (last && Boolean(last.b) === bold && Boolean(last.code) === code) last.t = clip(last.t + t, LIMITS.text);
    else if (list.length < LIMITS.runs) list.push({ t: clip(t, LIMITS.text), ...(bold ? { b: true } : {}), ...(code ? { code: true } : {}) });
  };
  const trim = (list) => {
    while (list.length && !list[0].t.trim()) list.shift();
    while (list.length && !list[list.length - 1].t.trim()) list.pop();
    if (list.length) { list[0].t = list[0].t.replace(/^\s+/, ''); list[list.length - 1].t = list[list.length - 1].t.replace(/\s+$/, ''); }
    return list;
  };
  const flush = () => {
    if (cell) return;
    const list = trim(runs);
    if (list.length && blocks.length < LIMITS.blocks) blocks.push({ type: 'text', runs: list, ...(paragraphDim ? { dim: true } : {}) });
    runs = [];
    paragraphDim = false;
  };
  const endCell = () => {
    if (cell && row) { trim(cell.runs); if (row.cells.length < LIMITS.cells) row.cells.push(cell); }
    cell = null;
  };
  const endRow = () => {
    endCell();
    if (row && table && row.cells.length && table.rows.length < LIMITS.rows) table.rows.push(row);
    row = null;
  };
  const endTable = () => {
    endRow();
    if (table) {
      const headRow = table.rows.find((one) => one.cells.every((c) => c.th)) ?? null;
      const body = table.rows.filter((one) => one !== headRow);
      if ((headRow || body.length) && blocks.length < LIMITS.blocks) {
        blocks.push({ type: 'table', head: headRow ? headRow.cells.map((c) => ({ runs: c.runs })) : [], rows: body.map((r) => r.cells.map((c) => ({ runs: c.runs }))) });
      }
    }
    table = null;
  };

  for (const token of tokens(String(html).slice(0, max))) {
    if (token.text !== undefined) { if (!skip) text(token.text); continue; }
    const { tag } = token;
    if (token.close) {
      if (DROP.has(tag)) { if (skip) skip -= 1; continue; }
      if (skip) continue;
      // Close up to the nearest open tag of that name, so a stray end tag neither pops what it does not close nor leaves one open.
      const at = stack.map((one) => one.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      if (tag === 'table') { if (table && table.depth > 0) { table.depth -= 1; text(' '); } else endTable(); }
      else if (tag === 'tr' && table && table.depth === 0) endRow();
      else if ((tag === 'td' || tag === 'th') && table && table.depth === 0) endCell();
      else if (BREAKS.has(tag)) flush();
      continue;
    }
    if (DROP.has(tag)) { if (!token.selfClosed && !VOID.has(tag)) skip += 1; continue; }
    if (skip) continue;
    if (tag === 'table') {
      if (table) { table.depth += 1; continue; }
      flush();
      table = { rows: [], depth: 0 };
      continue;
    }
    if (table && table.depth === 0) {
      if (tag === 'tr') { endRow(); row = { cells: [] }; continue; }
      if (tag === 'td' || tag === 'th') {
        endCell();
        if (!row) row = { cells: [] };
        cell = { runs: [], th: tag === 'th' };
        stack.push({ tag });
        continue;
      }
      if (['thead', 'tbody', 'tfoot', 'caption', 'colgroup'].includes(tag)) continue;
    }
    if (BREAKS.has(tag)) {
      if (!cell) { flush(); paragraphDim = DIM.test(token.attrs.style ?? ''); }
      else if (tag === 'br' || tag === 'p' || tag === 'div' || tag === 'li') text(' ');
      if (tag === 'li' && !cell) text('• ');
    }
    if (tag === 'small' && !cell && !runs.length) paragraphDim = true;
    if (tag === 'img' || tag === 'input') continue;
    if (!VOID.has(tag) && !token.selfClosed) stack.push({ tag });
  }
  endTable();
  flush();
  return blocks;
}

/** What a block list says, as plain text: for a stale check and for the tests. */
function plainOf(blocks) {
  const runsText = (runs) => runs.map((r) => r.t).join('');
  return blocks.map((b) => (b.type === 'table'
    ? [b.head.map((c) => runsText(c.runs)).join(' | '), ...b.rows.map((r) => r.map((c) => runsText(c.runs)).join(' | '))].filter(Boolean).join('\n')
    : runsText(b.runs))).join('\n');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROXY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,80}$/;
const ELEMENT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,80}$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,100}$/;

/** The options of a `<select>`/radio list in a piece of HTML: `{ choices, selected }` or null if there are none. */
function optionsIn(html) {
  const choices = [];
  const labels = {};
  let selected = null;
  const ticked = [];
  let multiple = /<select\b[^>]*\bmultiple\b/i.test(html);
  const add = (value, label, on) => {
    const v = decode(value);
    if (choices.length >= 500 || choices.includes(v)) return;
    choices.push(clip(v, 200));
    const text = decode(label).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (text && text !== v) labels[clip(v, 200)] = clip(text, 200);
    if (on && selected === null) selected = clip(v, 200);
    if (on) ticked.push(clip(v, 200));
  };
  const optionRe = /<option\b([^>]*)>([\s\S]*?)(?:<\/option>|(?=<option\b)|(?=<\/select>))/gi;
  let m;
  while ((m = optionRe.exec(html))) {
    const attrs = attributesOf(m[1]);
    add(attrs.value ?? decode(m[2]), m[2], 'selected' in attrs);
  }
  if (!choices.length) {
    const radio = /<input\b([^>]*)>/gi;
    while ((m = radio.exec(html))) {
      const attrs = attributesOf(m[1]);
      if ((attrs.type === 'radio' || attrs.type === 'checkbox') && attrs.value !== undefined) {
        if (attrs.type === 'checkbox') multiple = true;
        add(attrs.value, attrs.value, 'checked' in attrs);
      }
    }
  }
  // A list that allows several is answered with the ticked ones, comma-separated, as the plugin's own form sends them.
  return choices.length ? { choices, selected: multiple && ticked.length ? ticked.join(',') : selected, labels, ...(multiple ? { multiple: true } : {}) } : null;
}

/** One value as Active Choices says it: `"x"`, or `"x:selected"` for the one that starts chosen. */
function choiceOf(raw) {
  const text = String(raw ?? '');
  const m = /^(.*?):selected(?::disabled)?$/s.exec(text);
  return { value: clip(m ? m[1] : text, 200), selected: Boolean(m) };
}

/**
 * The reactive parameters of a form page: `[{ name, kind: 'cascade' | 'reference', refs, id, proxy, view, initial }]`.
 * `initial` is what the form held when it was built — `{ choices, selected }` for a list, `{ blocks }` for a block.
 */
function parseForm(html) {
  const page = String(html ?? '').slice(0, MAX_PAGE);
  const found = [];
  const holder = /<span\b([^>]*\bclass\s*=\s*["'][^"']*\b(cascade-choice-parameter|dynamic-reference-parameter)-data-holder\b[^"']*["'][^>]*)>/gi;
  let m;
  while ((m = holder.exec(page))) {
    const attrs = attributesOf(m[1]);
    const name = attrs['data-name'];
    const proxy = attrs['data-proxy-name'];
    const id = attrs['data-param-name'] || attrs['data-random-name'];
    if (!PARAM_NAME.test(name ?? '') || !PROXY_NAME.test(proxy ?? '') || !ELEMENT_ID.test(id ?? '')) continue;
    const refs = String(attrs['data-referenced-parameters'] ?? '').split(',').map((one) => one.trim()).filter((one) => PARAM_NAME.test(one)).slice(0, 20);
    // The object Jenkins bound to this page for this parameter: its id is in the address of the script that makes the proxy.
    const bound = new RegExp(`\\$stapler/bound/script/\\$stapler/bound/([0-9a-fA-F-]{36})\\?var=${proxy}(?:&amp;|&)`).exec(page);
    const uuid = bound && UUID.test(bound[1]) ? bound[1].toLowerCase() : null;
    // What is in the form for it: from the element the plugin fills up to the area that says what is wrong with it.
    const start = page.indexOf(`id="${id}"`);
    const end = start >= 0 ? page.indexOf('validation-error-area', start) : -1;
    const region = start >= 0 ? page.slice(start, end > start ? end : start + 60_000) : '';
    const kind = m[2] === 'cascade-choice-parameter' ? 'cascade' : 'reference';
    let view = null;
    let initial = null;
    if (kind === 'cascade') {
      initial = optionsIn(region);
      view = 'choices';
    } else if (/id\s*=\s*["']formattedHtml_/.test(region) || /<ul\b/i.test(region)) {
      view = /id\s*=\s*["']formattedHtml_/.test(region) ? 'html' : 'list';
      initial = { blocks: toBlocks(region.replace(/^[^>]*>/, '')) };
    } else if (/id\s*=\s*["']inputElement_/.test(region)) {
      view = 'input';
      const input = /<input\b([^>]*\bid\s*=\s*["']inputElement_[^>]*)>/i.exec(region);
      const value = input ? attributesOf(input[1]).value ?? '' : '';
      initial = { blocks: value ? [{ type: 'text', runs: [{ t: clip(value, LIMITS.text) }] }] : [] };
    }
    found.push({ name, kind, refs, id, proxy, uuid, view, initial, multiple: Boolean(initial?.multiple) });
    if (found.length >= 30) break;
  }
  // A plain `ChoiceParameter` (Single Select) depends on nothing and has no data holder: its list is in the form, already made.
  const plain = /<div\b((?:[^>"']|"[^"]*"|'[^']*')*\bclass\s*=\s*["'][^"']*\bactive-choice\b[^"']*["'](?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  while (found.length < 30 && (m = plain.exec(page))) {
    const attrs = attributesOf(m[1]);
    const id = attrs.id;
    if (!ELEMENT_ID.test(id ?? '')) continue;
    const after = page.slice(m.index + m[0].length, m.index + m[0].length + 200_000);
    const named = /<input\b([^>]*\bname\s*=\s*["']name["'][^>]*)>/i.exec(after);
    const name = named ? attributesOf(named[1]).value : null;
    if (!PARAM_NAME.test(name ?? '') || found.some((one) => one.name === name)) continue;
    const end = after.search(/<\/select>|validation-error-area/i);
    const initial = optionsIn(end >= 0 ? after.slice(0, end + 9) : after.slice(0, 60_000));
    if (!initial) continue;
    found.push({ name, kind: 'choice', refs: [], id, proxy: null, uuid: null, view: 'choices', initial, multiple: Boolean(initial.multiple) });
  }
  return found;
}

/** `[cookie pairs]` out of the `Set-Cookie` headers of an answer: just `name=value`, which is all that is sent back. */
function cookiesOf(headers) {
  let raw = [];
  try {
    // Node hands the cookies back one by one; Electron's fetch joins them into one string with commas (measured). A comma
    // inside a cookie is only ever in a date (`Expires=Wed, 21 Oct`), which is never followed by `name=`.
    if (typeof headers?.getSetCookie === 'function') raw = headers.getSetCookie();
    else if (typeof headers?.get === 'function') raw = [String(headers.get('set-cookie') ?? '')];
    raw = raw.flatMap((one) => String(one).split(/,(?=\s*[A-Za-z0-9_.-]+=)/));
  } catch { raw = []; }
  return raw.map((one) => String(one).split(';')[0].trim()).filter((one) => /^[A-Za-z0-9_.-]+=[A-Za-z0-9_.%~+/=-]*$/.test(one)).slice(0, 10);
}

class ActiveChoices {
  constructor(api) {
    this.api = api;
  }

  /** The form page of a job, as the reactive parameters it holds, and the session it was made in. `null` when it has none. */
  async read(jobPath) {
    const reply = await this.api.rawGet(`${jobPath}/build?delay=0sec`, { accept: 'text/html', max: MAX_PAGE, allow: [405] });
    if (reply.tooBig) return null;
    const html = reply.bytes.toString('utf8');
    const params = parseForm(html);
    if (!params.length) return null;
    return { params, cookie: cookiesOf(reply.headers).join('; ') };
  }

  /** One call on a bound object: its answer as JSON. */
  async #call(param, session, crumb, method, args) {
    const headers = { ...(session.cookie ? { Cookie: session.cookie } : {}), ...(crumb ? { Crumb: crumb, 'Jenkins-Crumb': crumb } : {}) };
    const reply = await this.api.rawPost(`/$stapler/bound/${param.uuid}/${method}`, JSON.stringify(args), {
      read: 'bytes', max: MAX_REPLY, headers, contentType: 'application/x-stapler-method-invocation;charset=UTF-8', accept: 'application/json',
    });
    // `doUpdate` answers 204 with nothing: no body is an answer, not a failure.
    const body = reply.bytes.toString('utf8');
    if (!body.trim()) return null;
    try { return JSON.parse(body); } catch { throw new Error('Jenkins answered, but not with what the plugin sends'); }
  }

  /** The crumb the page's own script for a bound object carries: the one that is good for the session the page made. */
  async #crumbOf(param, session) {
    const reply = await this.api.rawGet(`/$stapler/bound/script/$stapler/bound/${param.uuid}?var=${param.proxy}&methods=doUpdate,getChoicesForUI,getChoicesAsStringForUI`, {
      accept: '*/*', max: 64 * 1024, headers: session.cookie ? { Cookie: session.cookie } : {},
    });
    const m = /makeStaplerProxy\(\s*(['"])[^'"]*\1\s*,\s*(['"])([^'"]*)\2/.exec(reply.bytes.toString('utf8'));
    return m && /^[\w-]{1,256}$/.test(m[3]) ? m[3] : '';
  }

  /**
   * What these parameters are for the values given: `{ NAME: { choices, selected, labels } | { blocks } | { error } }`.
   * Only the parameters a reactive one *names* are sent to it, so nothing else typed in the form leaves with the question.
   */
  async refresh(jobPath, values, { only = null } = {}) {
    const session = await this.read(jobPath);
    const out = {};
    if (!session) return out;
    // A parameter that another reactive one reads is asked first, so the one that reads it sees its new answer.
    const asked = session.params.filter((param) => param.uuid && param.view && (!only || only.includes(param.name))).sort((a, b) => Number(a.refs.includes(b.name)) - Number(b.refs.includes(a.name)));
    const current = { ...values };
    for (const param of asked) {
      try {
        const crumb = await this.#crumbOf(param, session);
        const sent = param.refs.map((name) => `${name}=${String(current[name] ?? '').replace(/__LESEP__|[\r\n]/g, ' ').slice(0, 500)}`).join(SEPARATOR);
        await this.#call(param, session, crumb, 'doUpdate', [sent]);
        if (param.kind === 'cascade') {
          const answer = await this.#call(param, session, crumb, 'getChoicesForUI', []);
          const values_ = Array.isArray(answer?.[0]) ? answer[0] : Array.isArray(answer) ? answer : null;
          if (!values_) throw new Error('Jenkins sent no choices');
          const parsed = values_.slice(0, 500).map(choiceOf);
          const choices = [...new Set(parsed.map((one) => one.value))];
          const labelsRaw = Array.isArray(answer?.[1]) ? answer[1] : [];
          const labels = {};
          parsed.forEach((one, i) => { const label = labelsRaw[i] === undefined ? '' : choiceOf(labelsRaw[i]).value; if (label && label !== one.value) labels[one.value] = label; });
          const ticked = parsed.filter((one) => one.selected).map((one) => one.value);
          out[param.name] = { choices, selected: param.multiple ? (ticked.join(',') || null) : (ticked[0] ?? null), labels, ...(param.multiple ? { multiple: true } : {}) };
          if (choices.length) current[param.name] = (param.multiple ? String(current[param.name] ?? '').split(',').every((one) => choices.includes(one)) : choices.includes(current[param.name])) ? current[param.name] : (out[param.name].selected ?? choices[0]);
        } else if (param.view === 'list') {
          const answer = await this.#call(param, session, crumb, 'getChoicesForUI', []);
          const items = Array.isArray(answer?.[0]) ? answer[0] : [];
          out[param.name] = { blocks: toBlocks(`<ul>${items.slice(0, 200).map((one) => `<li>${one}</li>`).join('')}</ul>`) };
        } else {
          const answer = await this.#call(param, session, crumb, 'getChoicesAsStringForUI', []);
          const raw = typeof answer === 'string' ? answer : answer === null || answer === undefined ? '' : JSON.stringify(answer);
          out[param.name] = { blocks: param.view === 'input' ? [{ type: 'text', runs: [{ t: clip(raw.replace(/^"|"$/g, ''), LIMITS.text) }] }] : toBlocks(raw) };
        }
      } catch (error) {
        out[param.name] = { error: clip(String(error?.message ?? error), 200) };
      }
    }
    return out;
  }
}

module.exports = { ActiveChoices, parseForm, toBlocks, plainOf, optionsIn, choiceOf, cookiesOf, SEPARATOR };
