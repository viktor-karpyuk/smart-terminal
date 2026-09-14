'use strict';

const { DEPTHS, KINDS } = require('./review-rules');

/**
 * Code Reviewer: what is said to the model, word for word.
 *
 * The prompts are AI Code Reviewer's, carried over verbatim. They are in
 * Spanish because that is how they were written and tuned against real pull
 * requests; the language the model *answers* in is a setting, injected as
 * `language`. Rewording them would be re-tuning them, and that is not what a
 * clone is for.
 */

const FINDING_ITEM = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    line: { type: ['integer', 'null'] },
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
    category: { type: 'string', enum: ['FUNCTIONAL', 'BUG', 'DESIGN', 'CONVENTION'] },
    title: { type: 'string' },
    body: { type: 'string' },
    suggestion: { type: ['string', 'null'] },
  },
  required: ['file', 'severity', 'category', 'title', 'body'],
};

/**
 * The CLI validates against these and retries when the model strays, so findings
 * always arrive with a file. The line may be null: some remarks are about a whole
 * file, and forcing a number would invent a false anchor.
 */
const SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, findings: { type: 'array', items: FINDING_ITEM } },
  required: ['summary', 'findings'],
};

/** The same, plus a ruling on every earlier finding — one reading of the diff, not two. */
const INCREMENTAL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: FINDING_ITEM },
    carried: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['STILL_OPEN', 'FIXED', 'OBSOLETE'] },
          line: { type: ['integer', 'null'] },
          evidence: { type: 'string' },
        },
        required: ['id', 'verdict', 'evidence'],
      },
    },
  },
  required: ['summary', 'findings', 'carried'],
};

const RESOLUTION_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    mergeable: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          resolution: { type: 'string', enum: ['RESOLVED', 'PARTIAL', 'UNRESOLVED', 'WONT_FIX'] },
          evidence: { type: 'string' },
        },
        required: ['id', 'resolution', 'evidence'],
      },
    },
  },
  required: ['summary', 'mergeable', 'items'],
};

const FINAL_PASS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    mergeable: { type: 'boolean' },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, line: { type: ['integer', 'null'] }, title: { type: 'string' }, body: { type: 'string' } },
        required: ['file', 'title', 'body'],
      },
    },
  },
  required: ['summary', 'mergeable', 'blockers'],
};

const FIX_SCHEMA = {
  type: 'object',
  properties: { fixed: { type: 'boolean' }, summary: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
  required: ['fixed', 'summary'],
};

/**
 * How much convention text goes in. Context is not free: a hundred-page
 * architecture guide would push the diff out, and the diff is what is reviewed.
 */
const MAX_GUIDELINES_CHARS = 60000;

const oneLine = (text, max) => String(text ?? '').replace(/\n/g, ' ').slice(0, max);
const anchorOf = (path, line) => `${path}${line !== null && line !== undefined ? `:${line}` : ''}`;
const blocks = (...parts) => parts.filter((part) => part && part.trim()).join('\n\n');

/**
 * The team's conventions, so a review does not report a decision already taken.
 * Global ones first, the repository's last: what is read last wins, so a
 * repository can contradict the general rule without editing it.
 */
function guidelinesSection(docs) {
  if (!docs || !docs.length) return '';
  let left = MAX_GUIDELINES_CHARS;
  let trimmed = 0;
  let body = '';
  for (const doc of docs) {
    if (left <= 0) {
      trimmed++;
      continue;
    }
    let content = String(doc.content ?? '');
    if (content.length > left) {
      trimmed++;
      content = `${content.slice(0, left)}\n[…recortado…]`;
    }
    left -= content.length;
    body += `\n### ${doc.name} (${doc.repoId ? 'este repositorio' : 'todos los repositorios'})\n${content}\n`;
  }
  const warning = trimmed > 0 ? `\n(Se recortaron ${trimmed} documento(s) por tamaño; puede faltar contexto.)\n` : '';
  return [
    'CONVENCIONES Y ARQUITECTURA DE ESTE EQUIPO',
    'Lo que sigue son decisiones ya tomadas, no sugerencias. NO las reportes como problemas:',
    'un nombre, una estructura o un patrón que las cumple está bien aunque vos harías otra cosa.',
    'Sí reportá el código que las CONTRADICE, citando cuál regla incumple.',
    'Cuando una regla de este repositorio contradiga una general, manda la del repositorio.',
  ].join('\n') + body + warning;
}

/** The thread as it stands, so the review does not repeat what was already said. */
function threadSection(comments) {
  if (!comments || !comments.length) return '';
  const items = comments
    .map((comment) => {
      const anchor = comment.inlinePath ? ` [${anchorOf(comment.inlinePath, comment.inlineLine)}]` : '';
      return `- ${comment.author}${anchor}: ${oneLine(comment.body, 400)}`;
    })
    .join('\n');
  return [
    'COMENTARIOS QUE YA ESTÁN EN EL PR',
    items,
    '',
    'No repitas ninguno de esos puntos. Si tu análisis coincide con uno ya planteado, omitilo:',
    'volver a decirlo es ruido. Sí podés contradecir uno si el código muestra lo contrario, y en',
    'ese caso explicá por qué.',
  ].join('\n');
}

function carriedSection(carried, language) {
  if (!carried || !carried.length) return '';
  const items = carried
    .map((finding) => {
      let item = `- id: ${finding.id}\n  archivo: ${anchorOf(finding.filePath, finding.lineNo)}\n  gravedad: ${finding.severity}\n  título: ${finding.title}\n  detalle: ${String(finding.body).slice(0, 600)}`;
      if (finding.publishedId) item += '\n  (ya publicado como comentario en el PR)';
      return item;
    })
    .join('\n\n');
  return [
    'HALLAZGOS DE LA REVIEW ANTERIOR — hay que dictaminar cada uno',
    'Estos se señalaron antes y quedaron abiertos. Para cada uno decidí, MIRANDO EL CÓDIGO,',
    `si sigue en pie, si se corrigió o si dejó de aplicar. Escribí en ${language}.`,
    '',
    items,
  ].join('\n');
}

const SUGGESTION_AND_CATEGORY = `CÓMO DEBERÍA RESOLVERSE
Cuando puedas, además de señalar el problema decí cómo se arregla, en el campo
\`suggestion\`. Señalar sin proponer deja todo el trabajo de pensar la solución del otro
lado, y muchas veces el que encontró el problema ya sabe cómo se resuelve.

- Concreto y mínimo: el cambio más chico que resuelve lo señalado, no un rediseño.
- Si es código, un bloque corto en Markdown con el lenguaje declarado. Nada de
  archivos enteros ni de pseudocódigo.
- Coherente con el código que está alrededor: mismas convenciones, mismos helpers.
- **Dejalo en null si no podés proponer algo que sostengas.** Una sugerencia inventada
  es peor que ninguna: hace perder tiempo a quien la lee y desprestigia al resto de la
  review. Si la decisión depende de contexto que no tenés —una regla de negocio, una
  preferencia del equipo— decilo en el \`body\` y no propongas.


CÓMO CLASIFICAR CADA HALLAZGO
Además de la gravedad, cada hallazgo lleva una **categoría**. Son ejes distintos: la
gravedad dice cuán urgente es, la categoría qué clase de problema es. Quien recibe el
comentario necesita las dos para saber qué hacer: lo funcional se arregla antes de
mergear, lo de diseño se conversa.

- "FUNCTIONAL": cambia o rompe el comportamiento que el negocio espera. Un cálculo que
  da otro resultado, una regla que deja de aplicarse, un estado que queda inconsistente.
- "BUG": defecto de código que se rompe con cierta entrada o en cierto estado —un nulo,
  un índice, una condición de carrera— sin que la regla de negocio esté mal pensada.
- "DESIGN": patrón, arquitectura, acoplamiento, lógica en la capa equivocada, algo que
  va a doler mantener. Incluye las buenas prácticas que pidan las convenciones.
- "CONVENTION": incumple una regla escrita en las convenciones del equipo, cuando el
  problema es la regla incumplida y no una consecuencia técnica.

**Si entra en varias, gana la primera de esa lista**: algo que rompe el negocio se
reporta como FUNCTIONAL aunque además sea un problema de diseño, porque eso es lo que
define qué hacer con él. No uses DESIGN para un bug ni BUG para algo que simplemente no
sigue una convención.`;

/** A full review: the whole branch against its target. */
function reviewPrompt({ pr, language, depth, kind, existing = [], guidelines = [] }) {
  const range = `origin/${pr.targetBranch}...origin/${pr.sourceBranch}`;
  return blocks(
    `Sos un revisor de código senior. Revisá el siguiente pull request y devolvé UNICAMENTE
el JSON que se describe al final — sin preámbulo, sin "acá está la review", sin texto
alrededor. Cada hallazgo se publica anclado a su archivo y su línea en el PR, así que
la ruta y el número tienen que ser exactos.

PULL REQUEST
- Título: ${pr.title}
- Autor: ${pr.author}
- Rama: ${pr.sourceBranch} -> ${pr.targetBranch}
- Commit head: ${pr.headSha}
- Rango del diff: ${range}

Los comandos de git de sólo lectura YA ESTAN AUTORIZADOS en esta sesión: corrélos sin
pedir permiso y sin avisar que no podrías. Si uno falla, mostrá el error exacto que
devolvió; no supongas que es un problema de permisos.

Empezá por \`git diff --stat ${range}\` para dimensionar el cambio antes de leer nada.
Si hay CLAUDE.md en la raíz o en los directorios afectados, leelos y verificá que el
cambio cumpla lo que dicen; cuando marques una violación, citá textualmente la regla.`,
    DEPTHS[depth].instructions,
    KINDS[kind].focus,
    guidelinesSection(guidelines),
    threadSection(existing),
    `${SUGGESTION_AND_CATEGORY}

QUÉ NO REPORTAR
- Problemas preexistentes en líneas que el PR no tocó.
- Cosas que un linter, el compilador o el type-checker ya detectan.
- Nitpicks de estilo que un ingeniero senior no marcaría.
- Falta de tests o documentación, salvo que un CLAUDE.md lo exija explícitamente.
- Hallazgos que no puedas verificar leyendo el código. Si no estás seguro, no lo pongas.

Es mucho mejor devolver dos hallazgos sólidos que ocho especulativos.

FORMATO DE SALIDA — JSON, sin texto alrededor
Devolvé un objeto con "summary" y "findings". Cada finding va anclado al código:

- "file": ruta EXACTA tal como aparece en el diff, relativa a la raíz del repo.
  No inventes rutas ni las abrevies.
- "line": el número de línea del LADO NUEVO del diff (el de la rama del PR), o null
  si la observación es del archivo entero y no de una línea puntual. Verificá el número
  contra el diff antes de escribirlo: un número equivocado ancla el comentario en otro
  lado. Si no estás seguro de la línea, poné null en vez de aproximar.
- "severity": "blocker" si frena el merge, "major" si hay que arreglarlo pero no frena,
  "minor" para lo menor.
- "category": "FUNCTIONAL", "BUG", "DESIGN" o "CONVENTION", según el criterio de arriba.
- "title": una línea, la afirmación concreta.
- "body": 2-4 oraciones en ${language} con el escenario de falla: con qué entrada o en qué
  situación se rompe y qué pasa como consecuencia. Markdown permitido.

"summary": una o dos oraciones en ${language} sobre el cambio en general. Si no encontraste
nada que valga la pena, devolvé "findings" vacío y decilo en el summary.

Ordená los findings del más grave al más leve.`,
  );
}

/**
 * A review of only what arrived after the previous one. It is given the whole
 * branch as well as the short range, and not by habit: a new change can break
 * something added three commits back. What is narrowed is what gets reported,
 * not what can be read.
 */
function incrementalPrompt({ pr, language, depth, kind, sinceSha, carried = [], existing = [], guidelines = [] }) {
  const full = `origin/${pr.targetBranch}...origin/${pr.sourceBranch}`;
  const fresh = `${sinceSha}..${pr.headSha}`;
  return blocks(
    `Sos un revisor de código senior. Este pull request YA SE REVISÓ antes: tu trabajo ahora
es mirar lo que llegó después y decidir qué pasó con lo que se había señalado. Devolvé
UNICAMENTE el JSON que se describe al final.

PULL REQUEST
- Título: ${pr.title}
- Autor: ${pr.author}
- Rama: ${pr.sourceBranch} -> ${pr.targetBranch}
- Commit head actual: ${pr.headSha}
- Último commit ya revisado: ${sinceSha}
- **Commits nuevos a revisar: ${fresh}**
- Rama completa, para contexto: ${full}

Los comandos de git de sólo lectura YA ESTAN AUTORIZADOS en esta sesión: corrélos sin
pedir permiso y sin avisar que no podrías. Si uno falla, mostrá el error exacto.

Empezá por \`git diff --stat ${fresh}\`: eso es lo que hay que revisar. Todo lo
anterior ya se revisó y no hace falta volver a mirarlo en busca de problemas nuevos.

PODÉS leer el resto de la rama —\`git diff ${full}\`, los archivos completos— y a
veces tenés que hacerlo: un cambio nuevo puede romper algo que se agregó antes, y eso
no se ve mirando sólo el diff corto. La regla no es qué podés leer sino qué reportás.`,
    DEPTHS[depth].instructions,
    KINDS[kind].focus,
    guidelinesSection(guidelines),
    threadSection(existing),
    carriedSection(carried, language),
    `QUÉ REPORTAR COMO HALLAZGO NUEVO
Sólo problemas introducidos por los commits nuevos (${fresh}), o problemas que esos
commits provocan en código anterior. Si algo ya estaba mal antes y sigue igual, no es
un hallazgo nuevo: o ya está en la lista de arriba, o se decidió no reportarlo.

QUÉ NO REPORTAR
- Problemas preexistentes en líneas que estos commits no tocaron.
- Repetir con otras palabras algo que ya está en la lista de hallazgos anteriores.
  Si sigue en pie, va como STILL_OPEN en "carried", no como hallazgo nuevo.
- Cosas que un linter, el compilador o el type-checker ya detectan.
- Nitpicks de estilo que un ingeniero senior no marcaría.
- Falta de tests o documentación, salvo que un CLAUDE.md lo exija explícitamente.
- Hallazgos que no puedas verificar leyendo el código.

FORMATO DE SALIDA — JSON, sin texto alrededor
Un objeto con "summary", "findings" y "carried".

"findings": sólo lo NUEVO, con el mismo formato de siempre:
- "file": ruta EXACTA como aparece en el diff, relativa a la raíz del repo.
- "line": línea del LADO NUEVO, o null si es del archivo entero. Verificá el número
  contra el diff: uno equivocado ancla el comentario en otro lado.
- "severity": "blocker" | "major" | "minor".
- "category": "FUNCTIONAL" | "BUG" | "DESIGN" | "CONVENTION", según el criterio de arriba.
- "title": una línea, la afirmación concreta.
- "body": 2-4 oraciones en ${language} con el escenario de falla.
- "suggestion": cómo se arregla, o null si no podés proponer algo que sostengas.

"carried": UNA entrada por cada hallazgo anterior de la lista, ninguno de más ni de
menos, usando su "id" tal cual:
- "verdict": "STILL_OPEN" si el problema sigue ahí; "FIXED" si los commits nuevos lo
  corrigieron; "OBSOLETE" si el código que lo motivaba ya no existe o cambió tanto que
  la observación dejó de aplicar.
- "line": si sigue abierto y el código se movió, la línea nueva. Null si no cambió o
  no aplica. Un hallazgo publicado quedó anclado a una línea que ahora puede ser otra.
- "evidence": qué miraste para decidirlo, citando el cambio concreto. **Que el autor
  haya dicho que lo arregló no es evidencia; el diff sí lo es.** Ante la duda,
  STILL_OPEN: cerrar algo que sigue roto es peor que dejarlo abierto de más.

"summary": una o dos oraciones en ${language} sobre lo que trajeron los commits nuevos.`,
  );
}

/**
 * Whether what we pointed out was fixed. The job is evidence, not opinion, and a
 * direct answer to a comment has to be judged — "not applicable because X" is the
 * only evidence there will ever be for some findings.
 */
function resolutionPrompt({ language, prTitle, range, items, thread }) {
  return `Sos un revisor senior verificando si las observaciones de una review anterior fueron
atendidas. Devolvé ÚNICAMENTE el JSON que se describe al final.

PULL REQUEST: ${prTitle}
CAMBIOS DESDE LA REVIEW: ${range}

Empezá por \`git diff --stat ${range}\` para ver qué se tocó desde entonces, y
después mirá el diff de los archivos que importan. Los comandos de git de sólo lectura ya
están autorizados.

OBSERVACIONES A VERIFICAR
${items}

${thread}

REGLAS
- Juzgá por el código, no por lo que alguien haya dicho. Que el autor conteste "ya está
  arreglado" no es evidencia; el diff sí lo es.
- **Pero una respuesta directa a un comentario hay que contestarla.** Cuando debajo de un
  hallazgo aparece una \`↳ RESPUESTA\`, alguien se tomó el trabajo de explicar qué pasa con
  eso, y hay que juzgar lo que dice:
  · "ya lo arreglé" → comprobalo en el código. Si el código no lo muestra, UNRESOLVED, y en
    \`evidence\` decí que la respuesta dice una cosa y el diff otra.
  · "no aplica porque X", "es a propósito", "se hace en otro PR" → si el motivo se sostiene
    con lo que ves, es WONT_FIX con el motivo en \`evidence\`. Estas no se arreglan nunca en
    este diff, y dejarlas como UNRESOLVED para siempre hace que el estado no signifique
    nada: nadie vuelve a mirar una lista que nunca se vacía.
  · Si la respuesta no alcanza para decidir, UNRESOLVED y pedí lo que falta.
- RESOLVED sólo si el cambio arregla lo señalado de verdad. Si atiende una parte, o lo
  mueve de lugar sin resolverlo, es PARTIAL.
- UNRESOLVED si el código sigue igual o el cambio no tiene que ver **y nadie explicó por
  qué**.
- En \`evidence\` citá lo concreto: archivo y línea, o el commit. Una frase, no un ensayo.
  Si es UNRESOLVED, decí qué falta hacer.
- \`mergeable\` es true sólo si TODAS son RESOLVED o WONT_FIX y no encontrás nada nuevo que frene el
  merge. Ante la duda, false: mergear de más no se puede deshacer.
- Escribí en ${language}.`;
}

/** The pending findings for a verification, each with the answers hanging from it. */
function resolutionItems(pending, comments) {
  const answers = new Map();
  for (const comment of comments) {
    if (comment.ours || !comment.parentId) continue;
    if (!answers.has(comment.parentId)) answers.set(comment.parentId, []);
    answers.get(comment.parentId).push(comment);
  }
  const items = pending
    .map((finding) => {
      const replies = (finding.publishedId ? answers.get(finding.publishedId) ?? [] : [])
        .map((reply) => `\n    ↳ RESPUESTA de ${reply.author}: ${oneLine(reply.body, 400)}`)
        .join('');
      return `- id=${finding.id} [${anchorOf(finding.filePath, finding.lineNo)}] (${finding.severity}) ${finding.title}: ${oneLine(finding.body, 400)}${replies}`;
    })
    .join('\n');
  const loose = comments.filter((comment) => !comment.ours && !comment.parentId);
  const thread = loose.length
    ? `OTROS COMENTARIOS DEL HILO (contexto, no evidencia)\n${loose.map((comment) => `- ${comment.author}: ${oneLine(comment.body, 300)}`).join('\n')}`
    : '';
  return { items, thread };
}

/**
 * The last look before merging. Not another review — a smaller, harder question —
 * and an empty answer is the expected one: a final pass that always finds
 * something would never let anything merge.
 */
function finalPassPrompt({ language, prTitle, range, discussed }) {
  return `Sos un revisor senior haciendo la última mirada antes de mergear un pull request. Devolvé
ÚNICAMENTE el JSON que se describe al final.

PULL REQUEST: ${prTitle}
Rango del diff: ${range}

Los comandos de git de sólo lectura ya están autorizados. Empezá por
\`git diff --stat ${range}\` y después mirá lo que importe.

${discussed}

QUÉ BUSCAR
Sólo lo que NO debería entrar a la rama destino tal como está:
- Bugs que se disparan en un caso concreto que puedas describir.
- Agujeros de seguridad o fugas de datos.
- Pérdida de datos, migraciones destructivas o irreversibles.
- Cambios incompatibles en un contrato que otros usan.
- Restos de depuración: credenciales, endpoints de prueba, código comentado que se coló.

QUÉ NO
- Nada de lo que ya se discutió arriba.
- Estilo, nombres, preferencias, cobertura de tests.
- Mejoras posibles. La pregunta no es si se puede mejorar sino si frena el merge.

REGLAS
- \`blockers\` vacío y \`mergeable\` true es la respuesta esperada de un PR sano. No busques
  algo para justificar la corrida.
- Cada bloqueante tiene que decir el caso concreto en el que rompe, con archivo y línea.
  Si no podés describir cómo falla, no es un bloqueante.
- Escribí en ${language}.`;
}

/**
 * Answering an answer to one of our comments. The point is not to defend the
 * finding but to check it again with what the person brings: a reviewer who
 * never concedes is noise.
 */
function replyPrompt({ language, prTitle, range, ourComment, theirAuthor, theirBody, filePath, lineNo }) {
  const anchored = filePath ? `Anclado en: ${anchorOf(filePath, lineNo)}` : '';
  return `Sos un revisor de código senior contestando en el hilo de un pull request.

PULL REQUEST: ${prTitle}
Rango del diff: ${range}
${anchored}

LO QUE COMENTAMOS NOSOTROS
${ourComment || '(no se conserva el texto original)'}

LO QUE RESPONDIÓ ${theirAuthor}
${theirBody}

QUÉ HACER
1. Verificá su respuesta CONTRA EL CÓDIGO, no contra tu memoria: leé el archivo y el diff.
2. Si tiene razón —total o parcialmente— decilo derecho y sin rodeos, y agradecé la
   corrección. Retractarse rápido vale más que defender un hallazgo flojo.
3. Si el código sigue mostrando el problema, sostenelo con evidencia concreta: archivo,
   línea y el escenario exacto en el que se rompe. Nada de "podría llegar a pasar".
4. Si su respuesta abre una pregunta que no podés resolver leyendo el código, decilo y
   preguntá lo puntual que falta.
5. Si lo que plantea es una decisión de producto o de criterio, no una cuestión técnica,
   reconocelo y dejá la decisión de su lado.

FORMATO
Devolvé SOLO el texto de la respuesta, en ${language}, en Markdown, sin preámbulo ni firma.
Breve: 2 a 6 oraciones. Es una respuesta en un hilo, no otra review.
Tono de par, no de auditor. Nada de condescendencia ni de disculpas de más.`;
}

/**
 * Fixing what another run found. Short, and nearly all limits: the real risk is
 * not that it fails to fix the thing but that it reorders imports and renames on
 * the way, leaving a diff nobody can review at a glance.
 */
function fixPrompt({ finding, prTitle, branch, language, guidelines = '', bus = '' }) {
  const lines = [
    'Sos el mismo revisor que encontró este problema. Ahora te toca arreglarlo.',
    '',
    'CONTEXTO',
    `- PR: ${prTitle}`,
    `- Rama: ${branch} (ya estás parado en ella, en una copia aparte del repositorio)`,
    '',
    'EL HALLAZGO',
    `- Archivo: ${anchorOf(finding.filePath, finding.lineNo)}`,
    `- Gravedad: ${finding.severity}`,
  ];
  if (finding.category) lines.push(`- Categoría: ${finding.category}`);
  lines.push(`- Título: ${finding.title}`, `- Detalle: ${finding.body}`);
  if (finding.suggestion && finding.suggestion.trim()) lines.push(`- Cómo se propuso resolverlo: ${finding.suggestion}`);
  if (finding.askedBy) lines.push(`- Lo pidió: ${finding.askedBy}, en un comentario del PR`);
  lines.push(
    '',
    'QUÉ TENÉS QUE HACER',
    '1. Leé el archivo y confirmá que el problema está y es el que dice.',
    '2. Arreglá SÓLO eso, con el cambio más chico que lo resuelva de verdad.',
    '3. Si el arreglo obliga a tocar otro archivo, tocalo, pero sólo lo necesario.',
    '',
    'LÍMITES',
    '- No reformatees, no reordenes imports, no renombres nada que no sea parte del arreglo.',
    '- No agregues dependencias nuevas.',
    '- No arregles otros problemas que veas de paso: cada hallazgo va en su propio commit.',
    '- No hagas commit ni push: de eso se encarga la herramienta.',
    '- Si el problema ya está resuelto, no aplica, o arreglarlo requiere una decisión',
    '  que no te corresponde, dejá el código como está y contestá con fixed=false y el',
    '  motivo. Un archivo tocado a medias es peor que uno sin tocar.',
  );
  if (guidelines.trim()) lines.push('', 'CONVENCIONES DEL EQUIPO (el arreglo tiene que respetarlas)', guidelines);
  if (bus.trim()) lines.push('', bus);
  lines.push(
    '',
    'RESPUESTA',
    'Devolvé el JSON del esquema: `fixed` si tocaste el código, `summary` con qué',
    `cambiaste y por qué (en ${language}, dos o tres líneas), \`files\` con los archivos`,
    'que tocaste, y `reason` sólo si no arreglaste nada.',
  );
  return lines.join('\n');
}

module.exports = {
  SCHEMA,
  INCREMENTAL_SCHEMA,
  RESOLUTION_SCHEMA,
  FINAL_PASS_SCHEMA,
  FIX_SCHEMA,
  MAX_GUIDELINES_CHARS,
  guidelinesSection,
  threadSection,
  carriedSection,
  reviewPrompt,
  incrementalPrompt,
  resolutionPrompt,
  resolutionItems,
  finalPassPrompt,
  replyPrompt,
  fixPrompt,
};
