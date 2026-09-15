'use strict';

/**
 * Code Reviewer: every rule that decides something, and nothing that does anything.
 *
 * This is the part of the reviewer that was ported rule for rule from AI Code
 * Reviewer, the desktop app it clones. Each rule there cost a real mistake to
 * learn — a review that ran blind, a merge button that could never be pressed, a
 * PR reviewed twenty-five times end to end — and the comments say which. Keeping
 * them in one file with no process, no network and no database is what lets
 * `test/review-rules.test.js` hold every one of them still.
 */

// ---------------------------------------------------------------------------
// Depth and project kind
// ---------------------------------------------------------------------------

/**
 * How deep a review goes. The three levels do not only change the prompt: they
 * change which tools the subprocess is allowed and which model runs, because a
 * level that asks for depth without giving access to history deepens nothing.
 */
const DEPTHS = {
  LIGHT: {
    label: 'Light',
    blurb: 'Only the diff. Obvious blockers. Fast and cheap.',
    model: 'haiku',
    // Read-only git subcommands the model tries anyway are included: each denial
    // costs tokens retrying and buys no safety, because none of them writes.
    tools: ['Read', 'Grep', 'Glob', 'Bash(git diff *)', 'Bash(git rev-parse *)', 'Bash(git status *)', 'Bash(git ls-files *)'],
    instructions: [
      'PROFUNDIDAD: LIVIANA',
      'Mirá únicamente el diff. No abras el historial ni leas archivos completos, salvo que',
      'una parte del diff sea incomprensible sin ese contexto. Reportá sólo lo que frenaría',
      'el merge: bugs claros, agujeros de seguridad y violaciones explícitas de un CLAUDE.md.',
      'Máximo 3 hallazgos. Ante la duda, no lo reportes.',
    ].join('\n'),
  },
  INTERMEDIATE: {
    label: 'Intermediate',
    blurb: 'Diff plus whole files where needed. The default balance.',
    model: 'sonnet',
    tools: [
      'Read', 'Grep', 'Glob',
      'Bash(git diff *)', 'Bash(git show *)', 'Bash(git ls-tree *)', 'Bash(git rev-parse *)',
      'Bash(git status *)', 'Bash(git ls-files *)', 'Bash(git cat-file *)', 'Bash(git grep *)',
    ],
    instructions: [
      'PROFUNDIDAD: INTERMEDIA',
      'Leé el diff completo y, para lo que sea sutil, abrí el archivo entero en la rama del PR',
      'para ver el contexto que el diff recorta. Sumá a los bloqueantes: manejo de errores,',
      'casos borde, y consistencia con el código vecino. Hasta 6 hallazgos, priorizados.',
    ].join('\n'),
  },
  HEAVY: {
    label: 'Deep',
    blurb: 'Adds history, regressions and adversarial checking of every finding.',
    model: 'opus',
    tools: [
      'Read', 'Grep', 'Glob',
      'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)',
      'Bash(git blame *)', 'Bash(git ls-tree *)', 'Bash(git rev-parse *)',
      'Bash(git status *)', 'Bash(git ls-files *)', 'Bash(git cat-file *)', 'Bash(git grep *)',
      'Bash(git merge-base *)', 'Bash(git describe *)',
    ],
    instructions: [
      'PROFUNDIDAD: PROFUNDA',
      'Además de todo lo anterior:',
      '- Mirá el historial del código tocado (`git log`, `git blame`) y detectá si el cambio',
      '  revierte un fix anterior o rompe una invariante que un commit previo estableció.',
      '- Buscá interacciones que el diff no muestra: quién más llama a lo que cambió.',
      '- Si hay migraciones, compará su numeración contra la rama destino.',
      '- Antes de escribir cada hallazgo, intentá refutarlo. Si no resiste, descartalo.',
      'Sin tope de hallazgos, pero cada uno verificado contra el código, no inferido.',
    ].join('\n'),
  },
};

const KINDS = {
  BACKEND: {
    label: 'Backend / API',
    focus: [
      'TIPO DE PROYECTO: BACKEND / API',
      'Prestá atención especialmente a:',
      '- Transacciones e idempotencia: reintentos que duplican efectos, escrituras sin rollback.',
      '- Concurrencia: condiciones de carrera, locks, actualizaciones perdidas.',
      '- Aislamiento multi-tenant: consultas, índices y claves de caché sin el tenant.',
      '- Consultas: N+1, falta de índice, paginación hecha en memoria en vez de en SQL.',
      '- Migraciones: colisión de numeración contra la rama destino, cambios destructivos,',
      '  edición de una migración ya aplicada.',
      '- Dinero: precisión decimal, redondeo, monedas mezcladas.',
      '- Contratos de API: cambios incompatibles, códigos de estado, forma del error.',
      '- Llamadas externas: timeouts, reintentos, y qué pasa si el tercero responde a medias.',
    ].join('\n'),
  },
  FRONTEND_WEB: {
    label: 'Frontend web',
    focus: [
      'TIPO DE PROYECTO: FRONTEND WEB',
      'Prestá atención especialmente a:',
      '- Estado y renders: efectos que se disparan de más, dependencias mal declaradas, fugas.',
      '- Datos: paginación, filtrado y búsqueda hechos en el cliente sobre una colección',
      '  completa en vez de pedirlos al backend.',
      '- Errores de red: qué ve el usuario cuando falla, y si el estado queda consistente.',
      '- i18n: textos visibles hardcodeados en vez de pasar por el diccionario.',
      '- Accesibilidad: foco, roles, contraste, navegación por teclado.',
      '- Seguridad: HTML inyectado sin sanitizar, datos sensibles en el cliente.',
      '- Peso: imports que engordan el bundle, imágenes sin optimizar.',
    ].join('\n'),
  },
  MOBILE: {
    label: 'Mobile app',
    focus: [
      'TIPO DE PROYECTO: APP MOBILE',
      'Prestá atención especialmente a:',
      '- Offline: qué pasa sin conexión, si la mutación se encola y si se reintenta sola.',
      '- Ciclo de vida: trabajo que sigue tras salir de la pantalla, listeners sin soltar.',
      '- Permisos: pedidos en el momento correcto y con el camino de rechazo resuelto.',
      '- Recursos: batería, red y memoria; imágenes a resolución de pantalla, no la original.',
      '- Navegación y estados de carga: pantallas que quedan en blanco o en spinner infinito.',
      '- Almacenamiento local: qué se guarda en el dispositivo y si algo de eso es sensible.',
    ].join('\n'),
  },
  FULLSTACK: {
    label: 'Fullstack',
    focus: [
      'TIPO DE PROYECTO: FULLSTACK',
      'Cubrí backend y frontend, y sobre todo la costura entre los dos: contratos que cambian',
      'de un lado y no del otro, validación que existe sólo en el cliente, formas de error que',
      'el frontend no sabe interpretar, y estados que las dos capas modelan distinto.',
    ].join('\n'),
  },
  GENERIC: { label: 'Generic', focus: '' },
};

/** Reading-only or network is out of scope for a review at every level. */
const REVIEW_DENIED = ['Edit', 'Write', 'WebFetch', 'WebSearch'];

/**
 * A fix writes and reads, nothing more. `Task` is out on purpose: a finding is
 * small and subagents multiply the cost. `Bash` is in because compiling or
 * running a test is the only way the model can tell whether what it wrote holds.
 */
const FIX_TOOLS = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'TodoWrite'];

/**
 * What a fix cannot do even while fixing. Pushing is a person's decision;
 * `reset --hard` in a workshop holding the only copy of a fix is how it is lost;
 * and `git commit` is the tool's, because a clean tree is how the app decides
 * whether anything changed at all.
 */
const FIX_DENIED = ['Bash(git push *)', 'Bash(git commit *)', 'Bash(git reset --hard *)', 'WebFetch', 'WebSearch'];

const WEB_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'vue', 'svelte', 'css', 'scss', 'less', 'html']);
const BACKEND_EXT = new Set(['java', 'kt', 'go', 'rs', 'py', 'rb', 'cs', 'php', 'scala', 'sql']);
const MOBILE_EXT = new Set(['swift', 'dart', 'm', 'mm']);

/**
 * Paths that give mobile away even when the extension is shared. Deliberately
 * not `build.gradle` (every JVM project) nor `info.plist` (desktop packaging):
 * with those a dependency bump was classified as mobile.
 */
const MOBILE_HINTS = ['android/', '/ios/', 'androidmanifest.xml', 'pubspec.yaml', 'podfile', 'xcodeproj', 'react-native', 'capacitor', '/mobile/'];

/**
 * Words that earn the expensive review however small the change. Matched as
 * words, not substrings: `contains` sent `Author.kt` ("auth"), `SyntaxHighlighter`
 * ("tax"), `Acronym` ("cron") and `yarn.lock` ("lock") to Opus.
 */
const RISK_WORDS = new Set([
  'migration', 'migrations', 'schema', 'flyway', 'liquibase',
  'auth', 'authentication', 'authorization', 'security', 'password', 'token',
  'credential', 'credentials', 'crypto', 'secret', 'secrets',
  'payment', 'payments', 'invoice', 'billing', 'money', 'price', 'pricing', 'tax', 'fiscal',
  'concurrency', 'concurrent', 'transaction', 'transactional', 'lock', 'locking',
  'scheduler', 'cron', 'queue',
]);

const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock', 'gemfile.lock', 'poetry.lock', 'composer.lock', 'go.sum']);

/** A path split into words, camelCase included: AuthorService → author, service. */
function pathWords(path) {
  const words = new Set();
  for (const segment of String(path).split(/[/.\-_ ]/)) {
    for (const match of segment.matchAll(/[A-Za-z][a-z0-9]*|[0-9]+/g)) words.add(match[0].toLowerCase());
  }
  return words;
}

function isRisky(path) {
  const name = String(path).split('/').pop().toLowerCase();
  if (LOCKFILES.has(name)) return false;
  for (const word of pathWords(path)) if (RISK_WORDS.has(word)) return true;
  return false;
}

function extOf(path) {
  const name = String(path).split('/').pop();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function detectKind(files) {
  if (!files.length) return 'GENERIC';
  let web = 0;
  let backend = 0;
  let mobile = 0;
  for (const file of files) {
    const lower = file.path.toLowerCase();
    const ext = extOf(lower);
    const weight = Math.max(1, file.added + file.deleted);
    if (MOBILE_EXT.has(ext) || MOBILE_HINTS.some((hint) => lower.includes(hint))) mobile += weight;
    else if (WEB_EXT.has(ext)) web += weight;
    else if (BACKEND_EXT.has(ext)) backend += weight;
  }
  const total = web + backend + mobile;
  if (total === 0) return 'GENERIC';
  const webShare = web / total;
  const backendShare = backend / total;
  if (mobile / total >= 0.4) return 'MOBILE';
  // Fullstack only when both sides really weigh; one stray file does not count.
  if (webShare >= 0.25 && backendShare >= 0.25) return 'FULLSTACK';
  if (webShare > backendShare) return 'FRONTEND_WEB';
  if (backendShare > 0) return 'BACKEND';
  return 'GENERIC';
}

function detectDepth(files) {
  if (!files.length) return { depth: 'INTERMEDIATE', why: 'could not read the diff' };
  const lines = files.reduce((sum, file) => sum + file.added + file.deleted, 0);
  const risky = files.filter((file) => isRisky(file.path));
  // Risk beats size: a three-line migration can take a deploy down.
  if (risky.length) {
    return { depth: 'HEAVY', why: `touches ${risky.length} sensitive file(s), e.g. ${risky[0].path.split('/').pop()}` };
  }
  if (files.length >= 15 || lines >= 600) return { depth: 'HEAVY', why: `${files.length} files, ${lines} lines` };
  if (files.length <= 3 && lines <= 80) return { depth: 'LIGHT', why: `${files.length} files, ${lines} lines` };
  return { depth: 'INTERMEDIATE', why: `${files.length} files, ${lines} lines` };
}

function kindReason(files) {
  if (!files.length) return 'no files in the diff';
  const counts = new Map();
  for (const file of files) {
    const ext = extOf(file.path);
    if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([ext]) => `.${ext}`);
  return top.length ? top.join(', ') : `${files.length} files`;
}

/**
 * Depth and kind when the person left them on automatic. Everything comes from
 * the files the PR touches — a monorepo changes nature from PR to PR — and the
 * decision always carries its reason, so automatic is auditable, not magic.
 */
function plan(files, requestedDepth, requestedKind) {
  const auto = detectDepth(files);
  const kind = requestedKind || detectKind(files);
  const depth = requestedDepth || auto.depth;
  const parts = [];
  if (!requestedDepth) parts.push(`depth ${DEPTHS[depth].label.toLowerCase()} (${auto.why})`);
  if (!requestedKind) parts.push(`kind ${KINDS[kind].label} (${kindReason(files)})`);
  return { depth, kind, reason: parts.length ? `auto: ${parts.join(' · ')}` : 'profile set by hand' };
}

/** `git diff --numstat` output, with renames resolved to their new path. */
function parseNumstat(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 3) continue;
    out.push({ path: resolveRenamed(parts[2]), added: Number.parseInt(parts[0], 10) || 0, deleted: Number.parseInt(parts[1], 10) || 0 });
  }
  return out;
}

/** `src/{old => new}/File.kt` and `old.kt => new.kt`, as the path that exists now. */
function resolveRenamed(raw) {
  if (!raw.includes(' => ')) return raw;
  const brace = /[{]([^{}]*) => ([^{}]*)[}]/.exec(raw);
  if (brace) return (raw.slice(0, brace.index) + brace[2] + raw.slice(brace.index + brace[0].length)).replace(/\/\//g, '/');
  return raw.slice(raw.indexOf(' => ') + 4);
}

// ---------------------------------------------------------------------------
// Scope: the whole branch, or only what arrived since the last review
// ---------------------------------------------------------------------------

/**
 * Whether this run can look only at what is new.
 *
 * Until AI Code Reviewer 37 every review read the whole branch, and one PR of
 * 23 commits was reviewed 25 times end to end — 60% of everything it spent.
 * `isAncestor` is `git merge-base --is-ancestor`: after a rebase or a force push
 * the reviewed commit is no longer in the history, `old..new` is garbage, and
 * the run falls back to full. When in doubt — the command fails — full as well:
 * a full review too many costs money, an incremental one over rewritten history
 * reviews the wrong code.
 */
async function decideScope({ previous, headSha, forceFull, isAncestor }) {
  if (forceFull) return { scope: 'FULL', reason: 'FORCED' };
  if (!previous) return { scope: 'FULL', reason: 'FIRST_REVIEW' };
  const since = previous.headSha;
  if (since === headSha) return { scope: 'FULL', reason: 'SAME_COMMIT' };
  if (!since || !headSha) return { scope: 'FULL', reason: 'FIRST_REVIEW' };
  let chains = false;
  try {
    chains = Boolean(await isAncestor(since, headSha));
  } catch {
    chains = false;
  }
  if (!chains) return { scope: 'FULL', reason: 'REWRITTEN_HISTORY' };
  return { scope: 'INCREMENTAL', reason: 'NEW_COMMITS', sinceSha: since, previousReviewId: previous.id };
}

// ---------------------------------------------------------------------------
// Reading what the model returned
// ---------------------------------------------------------------------------

const SEVERITIES = ['blocker', 'major', 'minor'];
const CATEGORIES = ['FUNCTIONAL', 'BUG', 'DESIGN', 'CONVENTION'];
const RESOLUTIONS = ['RESOLVED', 'PARTIAL', 'UNRESOLVED', 'WONT_FIX'];

/** The CLI validates against the schema, but a fenced block must not cost a whole review. */
function parseJsonLoose(raw) {
  if (raw && typeof raw === 'object') return raw;
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/^```json/, '')
    .replace(/^```/, '')
    .replace(/```$/, '')
    .trim();
  try {
    const value = JSON.parse(cleaned);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number.parseInt(String(value), 10);
  return Number.isFinite(number) ? number : null;
}

/**
 * Findings from a review's output. A finding with no file is dropped — it could
 * not be anchored anywhere — a missing severity is minor, and a category that is
 * not understood is null rather than invented: a made-up label reads as data.
 */
function parseFindings(raw) {
  const object = parseJsonLoose(raw);
  if (!object) return { summary: '', findings: [] };
  const findings = [];
  for (const item of Array.isArray(object.findings) ? object.findings : []) {
    if (!item || typeof item !== 'object') continue;
    const file = typeof item.file === 'string' ? item.file.trim() : '';
    if (!file) continue;
    const severity = SEVERITIES.includes(String(item.severity)) ? String(item.severity) : 'minor';
    const category = CATEGORIES.includes(String(item.category ?? '').toUpperCase()) ? String(item.category).toUpperCase() : null;
    const suggestion = typeof item.suggestion === 'string' && item.suggestion.trim() ? item.suggestion : null;
    findings.push({
      filePath: file,
      lineNo: intOrNull(item.line),
      severity,
      category,
      title: String(item.title ?? ''),
      body: String(item.body ?? ''),
      suggestion,
    });
  }
  return { summary: String(object.summary ?? ''), findings };
}

/**
 * The model's ruling on each earlier finding. Only ids that were sent count — an
 * invented id would move or close a finding nobody looked at — and a verdict that
 * is not understood is STILL_OPEN: open too long is fixed by looking, closed while
 * broken is found in production.
 */
function parseCarried(raw, validIds) {
  const object = parseJsonLoose(raw);
  if (!object) return [];
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(object.carried) ? object.carried : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id ?? '');
    if (!validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const verdict = ['STILL_OPEN', 'FIXED', 'OBSOLETE'].includes(item.verdict) ? item.verdict : 'STILL_OPEN';
    out.push({ id, verdict, line: intOrNull(item.line), evidence: String(item.evidence ?? '') });
  }
  return out;
}

/**
 * What happens to each earlier finding. The ones the model did not rule on are
 * carried forward open: if it forgets one, leaving it behind would make it vanish
 * from the screen with nobody having fixed it or decided to drop it.
 */
function carryPlan(previous, rulings) {
  const byId = new Map(rulings.map((ruling) => [ruling.id, ruling]));
  return previous.map((finding) => {
    const ruling = byId.get(finding.id);
    return { finding, verdict: ruling?.verdict ?? 'STILL_OPEN', line: ruling?.line ?? null, evidence: ruling?.evidence ?? null };
  });
}

function resolutionFrom(value) {
  const wanted = String(value ?? '').trim().toUpperCase();
  return RESOLUTIONS.includes(wanted) ? wanted : 'UNRESOLVED';
}

/** Verdicts on pending findings; ids that were not sent are ignored. */
function parseResolution(raw, pendingIds) {
  const object = parseJsonLoose(raw);
  if (!object) return { summary: '', mergeable: false, items: [] };
  const items = [];
  const seen = new Set();
  for (const item of Array.isArray(object.items) ? object.items : []) {
    const id = String(item?.id ?? '');
    if (!pendingIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, resolution: resolutionFrom(item.resolution), evidence: String(item.evidence ?? '') });
  }
  return { summary: String(object.summary ?? ''), mergeable: object.mergeable === true, items };
}

function parseFinalPass(raw) {
  const object = parseJsonLoose(raw);
  if (!object) return { summary: '', mergeable: false, blockers: [] };
  const blockers = (Array.isArray(object.blockers) ? object.blockers : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ file: String(item.file ?? ''), line: intOrNull(item.line), title: String(item.title ?? ''), body: String(item.body ?? '') }));
  return { summary: String(object.summary ?? ''), mergeable: object.mergeable === true, blockers };
}

function finalPassText(parsed) {
  let text = parsed.summary;
  for (const blocker of parsed.blockers) {
    text += `\n\n• ${blocker.file}${blocker.line !== null ? `:${blocker.line}` : ''} — ${blocker.title}\n  ${blocker.body}`;
  }
  return text;
}

function parseFix(raw) {
  const object = parseJsonLoose(raw);
  if (!object) return { fixed: false, summary: '', reason: '' };
  return { fixed: object.fixed === true, summary: String(object.summary ?? ''), reason: String(object.reason ?? '') };
}

// ---------------------------------------------------------------------------
// Words that get published
// ---------------------------------------------------------------------------

function isSpanish(language) {
  const lower = String(language ?? '').trim().toLowerCase();
  return !lower || lower.startsWith('es') || lower.startsWith('spa') || lower.startsWith('cast');
}

/** How a category is named in a published comment: a person reads it, not the app. */
function categoryWord(category, language) {
  const spanish = { FUNCTIONAL: 'funcional', BUG: 'bug', DESIGN: 'diseño', CONVENTION: 'convención' };
  const english = { FUNCTIONAL: 'functional', BUG: 'bug', DESIGN: 'design', CONVENTION: 'convention' };
  return (isSpanish(language) ? spanish : english)[category] ?? null;
}

/** The general comment, derived from the same findings that are anchored to the code. */
function renderMarkdown(summary, findings, language) {
  const spanish = isSpanish(language);
  if (!findings.length) {
    return `### Code review\n\n${summary || (spanish ? 'Sin observaciones. Revisé bugs y cumplimiento de CLAUDE.md.' : 'No findings. Checked for bugs and CLAUDE.md compliance.')}`;
  }
  let out = '### Code review\n\n';
  if (summary) out += `${summary}\n\n`;
  out += spanish
    ? `Encontré ${findings.length} ${findings.length === 1 ? 'problema' : 'problemas'}:\n\n`
    : `Found ${findings.length} ${findings.length === 1 ? 'issue' : 'issues'}:\n\n`;
  findings.forEach((finding, index) => {
    const anchor = finding.filePath + (finding.lineNo !== null && finding.lineNo !== undefined ? `:${finding.lineNo}` : '');
    const labels = [finding.severity, finding.category ? categoryWord(finding.category, language) : null].filter(Boolean);
    out += `${index + 1}. **${finding.title}** _(${labels.join(' · ')})_\n\n\`${anchor}\`\n\n${finding.body}\n\n`;
  });
  return out.trimEnd();
}

/** One finding as an inline comment. The suggestion travels with it: that is who has to fix it. */
function findingComment(finding, language) {
  let body = '';
  if (finding.category) body += `_${categoryWord(finding.category, language)}_ · `;
  body += `**${finding.title}**\n\n${finding.body}`;
  if (finding.suggestion && finding.suggestion.trim()) {
    body += `\n\n**${isSpanish(language) ? 'Cómo se resolvería' : 'How it could be fixed'}**\n\n${finding.suggestion}`;
  }
  return body;
}

/**
 * What is said in a finding's thread when its fix was written.
 *
 * The summary is the model's — what changed and why — and everything else is a
 * template, because it states the tool's facts: the commit, and above all that
 * the commit is not on the branch yet. "Fixed" must never read as "pushed".
 */
function fixReply(finding, summary, sha, language) {
  const spanish = isSpanish(language);
  const detail = (String(summary ?? '').trim() || finding.title || '').slice(0, 2000);
  let body = `✅ **${spanish ? 'Arreglado' : 'Fixed'}**`;
  if (detail) body += `\n\n${detail}`;
  body += spanish
    ? `\n\n_Commit \`${sha.slice(0, 7)}\`, escrito por la review. Todavía no está en la rama: subirlo lo decide una persona._`
    : `\n\n_Commit \`${sha.slice(0, 7)}\`, written by the review. Not on the branch yet: pushing it is a person's call._`;
  return body;
}

/** The same notice with no thread to hang from: it has to stand on its own. */
function fixReplyStandalone(finding, summary, sha, language) {
  return `**${finding.title}**\n\n${fixReply(finding, summary, sha, language)}`;
}

function fixCommitMessage(finding, summary) {
  let message = `fix: ${finding.title.slice(0, 72)}\n\n`;
  if (summary && summary.trim()) message += `${summary.slice(0, 1000)}\n\n`;
  message += `Hallazgo ${finding.severity} en ${finding.filePath}${finding.lineNo ? `:${finding.lineNo}` : ''}\n`;
  message += 'Arreglado por la review, sin publicar. Revisá el diff antes de subirlo.';
  return message;
}

function fixResolutionNote(sha, summary) {
  const extra = String(summary ?? '').trim();
  return `Arreglado por la review en el commit ${sha.slice(0, 7)}.${extra ? ` ${extra}` : ''}`;
}

/** A follow-up is a template the person edits; paying a run to write "could you look?" makes no sense. */
function followUpText(finding, language) {
  return isSpanish(language)
    ? `Hola, ¿pudiste mirar esto? Sigue abierto: **${finding.title}**.`
    : `Hi, did you get a chance to look at this? It is still open: **${finding.title}**.`;
}

/** Bitbucket retired app passwords: an HTTPS origin cannot fetch any more, and the fix is one command. */
function fetchAdvice(output, repo) {
  if (!/CHANGE-3222|App passwords/.test(String(output))) return '';
  return (
    '\n\nThis clone\'s remote uses HTTPS with an app password, which Bitbucket retired. Switch it to SSH:\n' +
    `  git -C ${repo.localPath} remote set-url origin git@bitbucket.org:${repo.owner}/${repo.slug}.git`
  );
}

// ---------------------------------------------------------------------------
// What a finding, a reply and a PR are waiting for
// ---------------------------------------------------------------------------

/** No longer waiting on anything of ours: published, or dropped on purpose. */
function settled(finding) {
  return Boolean(finding.publishedId || finding.dismissedAt || finding.closedAt);
}

function resolutionClosed(resolution) {
  return resolution === 'RESOLVED' || resolution === 'WONT_FIX';
}

/** Closed for good: dismissed, closed in conversation, or verified as fixed. */
function closed(finding) {
  return Boolean(finding.dismissedAt || finding.closedAt || (finding.publishedId && finding.resolution === 'RESOLVED'));
}

/** Published, alive, and without a verdict that already closes it. */
function needsVerdict(finding) {
  return Boolean(finding.publishedId && !finding.dismissedAt && !finding.closedAt && !resolutionClosed(finding.resolution));
}

function replySettled(reply) {
  return reply.status === 'PUBLISHED' || Boolean(reply.dismissedAt);
}

/** Open for carrying into the next review: not dismissed, not closed, not resolved. */
function openForCarry(finding) {
  return !finding.dismissedAt && !finding.closedAt && finding.resolution !== 'RESOLVED';
}

/**
 * Why a PR cannot be merged yet, or null.
 *
 * Merging is the one action that changes the repository with no way back, so
 * the conditions are explicit and shown. It takes counters, not lists, because
 * the PR list has counts and the PR screen has rows — and two rules for enabling
 * a merge would drift, and the one that relaxes cannot be undone.
 */
function mergeBlocker(counts) {
  if (!counts.prHeadSha) return 'The pull request is not loaded.';
  if (!counts.hasReview) return 'It has not been reviewed.';
  if (counts.pendingFindings > 0) return `${counts.pendingFindings} finding(s) not published or dismissed.`;
  if (counts.pendingNotes > 0) return `${counts.pendingNotes} note(s) not published.`;
  if (counts.pendingReplies > 0) return `${counts.pendingReplies} reply(ies) waiting for an answer.`;
  // New commits are required only when we asked for a change. A review that
  // published nothing asked for nothing, and demanding a commit would leave that
  // PR unmergeable forever.
  if (counts.published > 0 && counts.reviewHeadSha && counts.reviewHeadSha === counts.prHeadSha) {
    return 'No new commits since the review.';
  }
  // Published is not resolved: merging unverified is trusting that someone fixed it because they said so.
  if (counts.notResolved > 0) return `${counts.notResolved} published comment(s) not resolved.`;
  if (counts.notVerified > 0) return `${counts.notVerified} published comment(s) not verified.`;
  return null;
}

function mergeCounts({ pr, review, findings, notes, replies }) {
  const live = findings.filter((finding) => finding.publishedId && !finding.dismissedAt && !finding.closedAt);
  return {
    prHeadSha: pr?.headSha ?? null,
    reviewHeadSha: review?.headSha ?? null,
    hasReview: Boolean(review),
    pendingFindings: findings.filter((finding) => !settled(finding)).length,
    pendingNotes: notes.filter((note) => !note.publishedId).length,
    pendingReplies: replies.filter((reply) => !replySettled(reply)).length,
    published: live.length,
    notVerified: live.filter((finding) => !finding.resolution).length,
    notResolved: live.filter((finding) => finding.resolution && !resolutionClosed(finding.resolution)).length,
  };
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

const THREAD_ORDER = ['NEEDS_ANSWER', 'DRAFT_READY', 'NOT_FIXED', 'UNPUBLISHED', 'UNVERIFIED', 'OK'];

function descendants(rootId, children) {
  const out = [];
  const queue = [...(children.get(rootId) ?? [])];
  while (queue.length) {
    const comment = queue.shift();
    out.push(comment);
    queue.push(...(children.get(comment.commentId) ?? []));
  }
  return out.sort((a, b) => String(a.createdOn).localeCompare(String(b.createdOn)));
}

function childrenOf(comments) {
  const children = new Map();
  for (const comment of comments) {
    if (!comment.parentId) continue;
    if (!children.has(comment.parentId)) children.set(comment.parentId, []);
    children.get(comment.parentId).push(comment);
  }
  return children;
}

function daysBetween(from, today) {
  // "2026-09-14 14:20", as the forge rows are stored, is UTC with its zone trimmed off.
  const text = String(from);
  const start = Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text.replace(' ', 'T'));
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((today.getTime() - start) / 86400000));
}

/** One thread per finding: what we said, what they answered, what was prepared, where it stands. */
function buildConversation({ findings, comments, replies, today = new Date() }) {
  const byId = new Map(comments.map((comment) => [comment.commentId, comment]));
  const children = childrenOf(comments);
  const draftFor = new Map(replies.map((reply) => [reply.theirCommentId, reply]));

  const threads = findings.map((finding) => {
    const root = finding.publishedId ? byId.get(finding.publishedId) : null;
    const chain = finding.publishedId ? descendants(finding.publishedId, children) : [];
    const theirs = chain.filter((comment) => !comment.ours);
    const lastTheirs = theirs[theirs.length - 1] ?? null;
    let draft = lastTheirs ? draftFor.get(lastTheirs.commentId) : null;
    if (!draft) draft = theirs.map((comment) => draftFor.get(comment.commentId)).filter((reply) => reply && reply.status !== 'PUBLISHED').pop() ?? null;

    const unanswered = Boolean(lastTheirs) && (!draft || !replySettled(draft)) &&
      !chain.some((comment) => comment.ours && String(comment.createdOn) > String(lastTheirs.createdOn));

    let state;
    if (finding.dismissedAt || finding.closedAt) state = 'OK';
    else if (!finding.publishedId) state = 'UNPUBLISHED';
    else if (unanswered && !(draft?.body ?? '').trim()) state = 'NEEDS_ANSWER';
    else if (unanswered) state = 'DRAFT_READY';
    else if (finding.resolution && !resolutionClosed(finding.resolution)) state = 'NOT_FIXED';
    else if (!finding.resolution) state = 'UNVERIFIED';
    else state = 'OK';

    const lastOurs = [root, ...chain].filter((comment) => comment && comment.ours).map((comment) => String(comment.createdOn)).sort().pop();
    const waitingSince = unanswered || state === 'OK' ? null : [finding.followedUpAt, lastOurs].filter(Boolean).sort().pop() ?? null;

    return {
      findingId: finding.id,
      filePath: finding.filePath,
      lineNo: finding.lineNo,
      title: finding.title,
      severity: finding.severity,
      category: finding.category,
      question: root?.body ?? finding.body,
      suggestion: finding.suggestion,
      askedBy: finding.askedBy,
      entries: chain.map((comment) => ({ id: comment.commentId, author: comment.author, body: comment.body, ours: comment.ours, at: comment.createdOn })),
      draft,
      resolution: finding.resolution,
      resolutionNote: finding.resolutionNote,
      publishedUrl: finding.publishedUrl,
      state,
      waitingDays: waitingSince ? daysBetween(waitingSince, today) : null,
      followedUpAt: finding.followedUpAt,
    };
  });
  return threads.sort(
    (a, b) =>
      THREAD_ORDER.indexOf(a.state) - THREAD_ORDER.indexOf(b.state) ||
      String(a.filePath).localeCompare(String(b.filePath)) ||
      (a.lineNo ?? 0) - (b.lineNo ?? 0),
  );
}

/**
 * Root comments somebody else wrote that are not threads of ours. Each can be
 * adopted as a finding and fixed; nothing is adopted while syncing, or every
 * "nice work" would count as pending before a merge.
 */
function foreignRequests({ findings, comments, ourName }) {
  const ourPublished = new Set(findings.filter((finding) => !finding.askedBy).map((finding) => finding.publishedId).filter(Boolean));
  const adopted = new Map(findings.filter((finding) => finding.askedBy && finding.publishedId).map((finding) => [finding.publishedId, finding.id]));
  const children = childrenOf(comments);
  const name = String(ourName ?? '').trim().toLowerCase();
  return comments
    .filter((comment) => !comment.parentId && !comment.ours && !comment.deleted && !ourPublished.has(comment.commentId) && !(name && comment.author.toLowerCase() === name))
    .map((comment) => {
      const entries = descendants(comment.commentId, children).map((reply) => ({ id: reply.commentId, author: reply.author, body: reply.body, ours: reply.ours, at: reply.createdOn }));
      return {
        commentId: comment.commentId,
        author: comment.author,
        filePath: comment.inlinePath,
        lineNo: comment.inlineLine,
        body: comment.body,
        at: comment.createdOn,
        entries,
        adoptedFindingId: adopted.get(comment.commentId) ?? null,
        needsAnswer: entries.length === 0 || !entries[entries.length - 1].ours,
      };
    })
    .sort((a, b) => Number(b.needsAnswer) - Number(a.needsAnswer) || String(b.at).localeCompare(String(a.at)));
}

/**
 * Which new comments are answers to ours. "Ours" is every id we published — the
 * general comment, an inline finding, a note, our own replies — plus anything the
 * sync already marked ours. An answer to an answer counts, or the conversation
 * would stop at its first turn.
 */
function repliesToUs(thread, ourIds) {
  const ids = new Set(ourIds);
  for (const comment of thread) if (comment.ours) ids.add(comment.commentId);
  if (!ids.size) return [];
  const byId = new Map(thread.map((comment) => [comment.commentId, comment]));
  return thread
    .filter((comment) => comment.parentId && ids.has(comment.parentId) && !comment.ours)
    .map((comment) => {
      const ours = byId.get(comment.parentId);
      return {
        theirCommentId: comment.commentId,
        theirAuthor: comment.author,
        theirBody: comment.body,
        ourCommentId: comment.parentId,
        ourBody: ours?.body ?? null,
        filePath: comment.inlinePath ?? ours?.inlinePath ?? null,
        lineNo: comment.inlineLine ?? ours?.inlineLine ?? null,
      };
    });
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * How ready a PR is, as a number that can be taken apart. Closed items count as
 * done rather than disappearing: removing them made a PR with every finding fixed
 * read 0%, because the final pass was the only item left.
 */
function readiness({ pr, review, threads, findings, finalPassDone, finalPassBlockers }) {
  if (!pr || !review) return { percent: 0, items: [{ key: 'noReview', label: 'No review yet', weight: 1, done: false }] };
  if (pr.state && pr.state !== 'OPEN') return { percent: 100, items: [{ key: 'notOpen', label: 'Not open', weight: 1, done: true }] };
  const items = [];
  const shut = (finding) => resolutionClosed(finding.resolution) || Boolean(finding.closedAt);
  const published = findings.filter((finding) => finding.publishedId && !finding.dismissedAt);
  for (const finding of published) {
    items.push({ key: 'finding', label: 'Published comment resolved', weight: 3, done: shut(finding), detail: `${finding.filePath.split('/').pop()}${finding.lineNo ? `:${finding.lineNo}` : ''}` });
  }
  for (const finding of findings.filter((item) => !item.publishedId && !item.dismissedAt)) {
    items.push({ key: 'unpublished', label: 'Finding published or dismissed', weight: 1, done: shut(finding), detail: finding.filePath.split('/').pop() });
  }
  const unanswered = threads.filter((thread) => thread.state === 'NEEDS_ANSWER' || thread.state === 'DRAFT_READY').length;
  if (unanswered > 0) items.push({ key: 'replies', label: 'Replies answered', weight: 2 * unanswered, done: false, detail: String(unanswered) });
  if (published.length) {
    items.push({
      key: 'newCommits',
      label: 'New commits after the comments',
      weight: 3,
      // With every comment closed the question is answered: the app's fixes live in
      // your clone until somebody pushes them.
      done: published.every(shut) || !review.headSha || review.headSha !== pr.headSha,
    });
  }
  items.push({
    key: finalPassBlockers > 0 ? 'finalPassBlockers' : 'finalPass',
    label: finalPassBlockers > 0 ? 'Final pass found blockers' : 'Final pass on this commit',
    weight: 4,
    done: Boolean(finalPassDone) && finalPassBlockers === 0,
    detail: finalPassBlockers > 0 ? String(finalPassBlockers) : '',
  });
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  const done = items.filter((item) => item.done).reduce((sum, item) => sum + item.weight, 0);
  // Rounded down unless everything is done: 99.6% cannot show as 100.
  const percent = total === 0 || done === total ? 100 : Math.floor((done * 100) / total);
  return { percent, items };
}

// ---------------------------------------------------------------------------
// The board: what each PR is waiting for
// ---------------------------------------------------------------------------

const FLAGS = {
  REVIEWING: { label: 'Reviewing', mine: false },
  FIXING: { label: 'Fixing', mine: false },
  UNREVIEWED: { label: 'Not reviewed', mine: true },
  STALE: { label: 'New commits', mine: true },
  TO_PUBLISH: { label: 'To publish', mine: true },
  PARTIAL: { label: 'Partly published', mine: true },
  AWAITING_THEM: { label: 'Waiting on them', mine: false },
  REPLIED: { label: 'Replied', mine: true },
  TO_VERIFY: { label: 'To verify', mine: true },
  APPROVED: { label: 'Approved', mine: false },
  CHANGES_REQUESTED: { label: 'Changes requested', mine: false },
  DRAFT: { label: 'Draft', mine: false },
  MERGED: { label: 'Merged', mine: false },
  DECLINED: { label: 'Declined', mine: false },
};

/**
 * One PR's flags. Nothing that claims work applies to a closed PR — nobody can
 * publish there or wait for an answer — which is where half the noise of a board
 * that ignored it came from.
 */
function prFlags(pr, facts) {
  const flags = [];
  const isClosed = pr.state && pr.state !== 'OPEN';
  if (pr.state === 'MERGED') flags.push('MERGED');
  else if (isClosed) flags.push('DECLINED');
  if (pr.isDraft) flags.push('DRAFT');
  if (facts.approved) flags.push('APPROVED');
  if (facts.changesRequested) flags.push('CHANGES_REQUESTED');
  if (facts.reviewing) flags.push('REVIEWING');
  if (facts.fixing) flags.push('FIXING');
  if (!isClosed) {
    const newCode = Boolean(facts.reviewedSha && pr.headSha && facts.reviewedSha !== pr.headSha);
    if (!facts.reviewedSha && !facts.reviewing) flags.push('UNREVIEWED');
    else if (newCode) flags.push('STALE');
    if (facts.toPublish) flags.push(facts.publishedCount > 0 && facts.publishedCount < facts.findingCount ? 'PARTIAL' : 'TO_PUBLISH');
    if (facts.replied) flags.push('REPLIED');
    if (facts.unresolved > 0) {
      // Waiting on them only if nothing of yours is pending: with unanswered replies the ball is yours.
      if (!facts.replied) flags.push('AWAITING_THEM');
      if (newCode || facts.replied) flags.push('TO_VERIFY');
    }
  }
  return flags;
}

function rowRank(flags) {
  if (flags.includes('MERGED') || flags.includes('DECLINED')) return 3;
  if (flags.some((flag) => FLAGS[flag]?.mine)) return 0;
  if (flags.includes('REVIEWING') || flags.includes('FIXING')) return 1;
  return 2;
}

/** Whether an automatic sweep skips a PR, and why. */
function skipReason(repo, pr) {
  if (repo.skipDrafts && pr.isDraft) return 'draft';
  const title = String(pr.title ?? '').toLowerCase();
  for (const word of csv(repo.skipTitles)) if (title.includes(word.toLowerCase())) return `title contains "${word}"`;
  const author = String(pr.author ?? '').toLowerCase();
  if (csv(repo.skipAuthors).some((name) => name.toLowerCase() === author)) return `author ${pr.author} is skipped`;
  const targets = csv(repo.onlyTargets);
  if (targets.length && !targets.includes(pr.targetBranch)) return `target ${pr.targetBranch} is not reviewed automatically`;
  return null;
}

function csv(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Whether verifying is worth a run now, and why not when it is not. The sweep
 * comes round every few minutes and each verification costs a run, so the real
 * question is when *not* to: never on the same code twice, but always when
 * somebody answered.
 */
function verificationNeed({ pr, review, findings, repliesPending = 0 }) {
  if (pr.state && pr.state !== 'OPEN') return { needed: false, why: 'not open' };
  if (!review || review.status !== 'DONE') return { needed: false, why: 'no finished review' };
  const pending = findings.filter(needsVerdict).length;
  if (pending === 0) return { needed: false, why: 'nothing pending' };
  const noNewCode = !pr.headSha || pr.headSha === review.headSha;
  const alreadyHere = review.resolutionHead === pr.headSha;
  if (repliesPending > 0 && (noNewCode || alreadyHere)) return { needed: true, pending, becauseOfReplies: true };
  if (noNewCode) return { needed: false, why: 'no new commits' };
  if (alreadyHere) return { needed: false, why: 'already verified on this commit' };
  return { needed: true, pending, becauseOfReplies: repliesPending > 0 };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * One file's unified diff as numbered lines. Numbering matters more than it
 * looks: an inline comment anchors on the new side, and a wrong number puts it
 * on another line of the PR. Lines before any hunk get no number at all.
 */
function parseDiff(raw) {
  const out = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const rows = String(raw ?? '').split('\n');
  // The newline that ends the last line is not a line of context of its own.
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  for (const line of rows) {
    if (line.startsWith('@@')) {
      inHunk = true;
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        oldNo = Number(match[1]);
        newNo = Number(match[2]);
      }
      out.push({ kind: 'HUNK', oldNo: null, newNo: null, text: line });
    } else if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity |rename )/.test(line) || !inHunk) {
      out.push({ kind: 'META', oldNo: null, newNo: null, text: line });
    } else if (line.startsWith('+')) {
      out.push({ kind: 'ADDED', oldNo: null, newNo: newNo++, text: line.slice(1) });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'REMOVED', oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
    } else {
      out.push({ kind: 'CONTEXT', oldNo: oldNo++, newNo: newNo++, text: line.startsWith(' ') ? line.slice(1) : line });
    }
  }
  return out;
}

/** `git log` records split on the unit and record separators. */
function parseLog(text) {
  return String(text ?? '')
    .split('\u001e')
    .map((record) => record.replace(/^[\n\r ]+|[\n\r ]+$/g, ''))
    .filter(Boolean)
    .map((record) => record.split('\u001f'))
    .filter((fields) => fields.length >= 4)
    .map((fields) => ({ sha: fields[0], author: fields[1], date: fields[2], subject: fields[3], body: (fields[4] ?? '').trim() }));
}

/** A filesystem-safe name for a workshop folder. */
function slug(name) {
  return (
    String(name ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'repo'
  );
}

/**
 * A forge or git failure, in words a person can act on. The raw text — status,
 * body, the long 401 explanation — stays available as the detail; this is the
 * one line that goes on a card.
 */
function readableError(message) {
  const text = String(message ?? '');
  const status = /HTTP (\d{3})/.exec(text)?.[1];
  if (status === '404') return 'Not found: the repository does not exist, or the token cannot see it.';
  if (status === '401') return 'Authentication failed. Bitbucket also answers 401 when it rate-limits, so retry before replacing the token.';
  if (status === '403') return /rate limit/i.test(text) ? 'Rate limited by the provider. Try again in a few minutes.' : 'The token is not allowed to do that.';
  if (status === '429') return 'Rate limited by the provider. Try again in a few minutes.';
  if (status && status.startsWith('5')) return `The provider failed (HTTP ${status}). Usually temporary.`;
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|timeout/i.test(text)) return 'Could not reach the provider. Check the connection.';
  return text.replace(/^\[[^\]]*\]\s*/, '').split('\n')[0].slice(0, 200) || 'It failed without saying why.';
}

/**
 * The one thing to do next on a PR, so a person does not have to read the
 * readiness list and the merge gate and work it out. In order of who is waiting:
 * a review that is running, a PR nobody reviewed, new commits, findings not yet
 * published, answers owed, verdicts owed, the author's turn, the final pass, and
 * then the merge.
 */
function nextStep({ pr, review, findings = [], notes = [], threads = [], running = [], finalPassDone = false, finalPassBlockers = 0, mergeBlocker = null }) {
  if (!pr) return { kind: 'act', action: 'load', title: 'Load the pull request', detail: 'It is not in the local copy yet.' };
  if (pr.state && pr.state !== 'OPEN') return { kind: 'done', title: `This pull request is ${String(pr.state).toLowerCase()}`, detail: 'Nothing is waiting here.' };
  const busy = running.find((run) => run.kind === 'review' || run.kind === 'verify' || run.kind === 'final');
  if (busy) return { kind: 'wait', title: { review: 'A review is running', verify: 'Verifying the comments', final: 'The final pass is running' }[busy.kind], detail: 'This page updates when it ends.' };
  if (!review) return { kind: 'act', action: 'run-review', title: 'Review this pull request', detail: 'Nobody has reviewed it yet.' };
  const own = findings.filter((finding) => !finding.askedBy);
  const unpublished = own.filter((finding) => !settled(finding)).length + notes.filter((note) => !note.publishedId).length;
  const newCode = Boolean(review.headSha && pr.headSha && review.headSha !== pr.headSha);
  if (unpublished) return { kind: 'act', action: 'publish-all', title: `Publish ${unpublished} finding${unpublished === 1 ? '' : 's'}`, detail: 'Or dismiss the ones that should not go out. The author sees nothing until then.' };
  const answers = threads.filter((thread) => thread.state === 'NEEDS_ANSWER' || thread.state === 'DRAFT_READY').length;
  if (answers) return { kind: 'act', action: 'tab-conversation', title: `Answer ${answers} repl${answers === 1 ? 'y' : 'ies'}`, detail: 'Someone answered your comments.' };
  const pending = own.filter(needsVerdict).length;
  if (newCode && pending) return { kind: 'act', action: 'verify', title: 'Verify the new commits', detail: `${pending} published comment${pending === 1 ? '' : 's'} may be addressed by them.` };
  if (newCode) return { kind: 'act', action: 'run-review', title: 'Review what is new', detail: 'Commits arrived since the last review.' };
  if (pending) return { kind: 'wait', title: 'Waiting for the author', detail: `${pending} published comment${pending === 1 ? ' is' : 's are'} open and no new commits arrived.` };
  if (finalPassBlockers > 0 && finalPassDone) return { kind: 'warn', action: 'final-pass', title: `The final pass found ${finalPassBlockers} blocker${finalPassBlockers === 1 ? '' : 's'}`, detail: 'Read them before merging, or run it again after the fix.' };
  if (!finalPassDone) return { kind: 'act', action: 'final-pass', title: 'Run the final pass', detail: 'The last look before merging, on this exact commit.' };
  if (mergeBlocker) return { kind: 'warn', action: 'merge-open', title: 'Almost ready to merge', detail: mergeBlocker };
  return { kind: 'act', action: 'merge-open', title: 'Ready to merge', detail: 'Everything is published, answered and verified.' };
}

/**
 * The comment on the PR that is this finding, published — by this app before
 * it lost track, or by AI Code Reviewer running beside it. Recognised by what
 * every road that publishes a finding writes: a root comment on the same file
 * whose text carries the title in bold. The line is not required to match: a
 * comment Bitbucket re-anchored after a push is still the same comment.
 *
 * Without this the finding reads as unpublished, the Code tab offers to publish
 * it, and pressing the button posts the same comment a second time.
 */
function matchPublished(finding, comments) {
  const title = String(finding.title ?? '').trim();
  if (!title) return null;
  const bold = `**${title}**`;
  return (
    comments.find((comment) => {
      if (comment.parentId || comment.deleted) return false;
      const body = String(comment.body ?? '');
      if (!body.includes(bold)) return false;
      // An inline comment on the file, or — for a finding with no line — the general comment that names it.
      if (comment.inlinePath) return comment.inlinePath === finding.filePath;
      return !finding.lineNo && body.startsWith(`\`${finding.filePath}\``);
    }) ?? null
  );
}

/** Age urgency marks, as the PR list shows them. */
function ageMark(days) {
  if (days >= 90) return '▲▲▲';
  if (days >= 14) return '▲▲';
  if (days >= 7) return '▲';
  if (days >= 3) return '•';
  return '';
}

module.exports = {
  DEPTHS,
  KINDS,
  REVIEW_DENIED,
  FIX_TOOLS,
  FIX_DENIED,
  FLAGS,
  THREAD_ORDER,
  pathWords,
  isRisky,
  detectKind,
  detectDepth,
  plan,
  parseNumstat,
  resolveRenamed,
  decideScope,
  parseJsonLoose,
  parseFindings,
  parseCarried,
  carryPlan,
  parseResolution,
  parseFinalPass,
  finalPassText,
  parseFix,
  isSpanish,
  categoryWord,
  renderMarkdown,
  findingComment,
  fixReply,
  fixReplyStandalone,
  fixCommitMessage,
  fixResolutionNote,
  followUpText,
  fetchAdvice,
  settled,
  closed,
  needsVerdict,
  replySettled,
  openForCarry,
  resolutionClosed,
  mergeBlocker,
  mergeCounts,
  buildConversation,
  foreignRequests,
  repliesToUs,
  readiness,
  prFlags,
  rowRank,
  skipReason,
  csv,
  verificationNeed,
  parseDiff,
  parseLog,
  slug,
  ageMark,
  daysBetween,
  readableError,
  nextStep,
  matchPublished,
};
