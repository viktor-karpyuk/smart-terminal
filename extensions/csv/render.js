/**
 * An extension that brings its own code.
 *
 * It is handed `{ path, text, dark }` and returns a complete HTML document. It
 * runs in a worker: no DOM, no modules, no way to reach the app, the disk or the
 * page it will be shown on — and what it returns is put in a frame that runs no
 * scripts. So the worst an extension can do to a document is describe it badly.
 *
 * The parsing is the whole reason this cannot be a manifest. A delimited file is
 * not "split on commas": a field can be quoted, a quoted field can contain the
 * delimiter, a newline, or an escaped quote, and every one of those appears in
 * the first real export anybody opens.
 */

/** The delimiter, taken from the name and checked against the first line. */
function delimiterFor(path, firstLine) {
  const extension = String(path || '').split('.').pop().toLowerCase();
  if (extension === 'tsv') return '\t';
  if (extension === 'psv') return '|';
  // A `.csv` written by a European spreadsheet is often semicolon-separated.
  // Believing the extension over the file would misread the whole thing.
  const counts = [',', ';', '\t', '|'].map((d) => [d, (firstLine.match(new RegExp(`\\${d}`, 'g')) || []).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

function parse(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        // Two quotes inside a quoted field are one literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.length > 1 || entry[0] !== '');
}

/** A header row is one where nothing looks like a number. */
function looksLikeHeader(row, next) {
  if (!row || !next) return false;
  const numeric = (value) => value !== '' && !Number.isNaN(Number(value.replace(/[, ]/g, '')));
  return !row.some(numeric) && next.some(numeric);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render({ path, text, dark }) {
  const lines = String(text ?? '');
  const firstLine = lines.split('\n', 1)[0] ?? '';
  const delimiter = delimiterFor(path, firstLine);
  const rows = parse(lines, delimiter);

  const ink = dark ? '#c0caf5' : '#2a2f3a';
  const paper = dark ? '#1a1b26' : '#ffffff';
  const rule = dark ? '#2c3049' : '#e3e6ee';
  const inset = dark ? '#20222f' : '#f4f6fa';
  const quiet = dark ? '#565f89' : '#8b93a7';
  const num = dark ? '#ff9e64' : '#b5540a';

  if (!rows.length) {
    return `<!doctype html><meta charset="utf-8"><body style="background:${paper};color:${quiet};font:13px system-ui;padding:20px">Nothing in this file.</body>`;
  }

  const header = looksLikeHeader(rows[0], rows[1]) ? rows[0] : null;
  const body = header ? rows.slice(1) : rows;
  const width = rows.reduce((widest, entry) => Math.max(widest, entry.length), 0);
  const numeric = (value) => value !== '' && !Number.isNaN(Number(value.replace(/[, ]/g, '')));

  const head = header
    ? `<thead><tr><th class="n"></th>${header
        .map((cell) => `<th>${escapeHtml(cell)}</th>`)
        .join('')}${'<th></th>'.repeat(Math.max(0, width - header.length))}</tr></thead>`
    : '';

  const rowsHtml = body
    .map((entry, index) => {
      const cells = [];
      for (let i = 0; i < width; i += 1) {
        const value = entry[i] ?? '';
        cells.push(`<td class="${numeric(value) ? 'num' : ''}">${escapeHtml(value)}</td>`);
      }
      return `<tr><td class="n">${index + 1}</td>${cells.join('')}</tr>`;
    })
    .join('');

  const name = delimiter === '\t' ? 'tab' : delimiter === '|' ? 'pipe' : delimiter === ';' ? 'semicolon' : 'comma';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: ${dark ? 'dark' : 'light'}; }
    body { margin: 0; background: ${paper}; color: ${ink}; font: 12.5px/1.5 "JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace; }
    .bar { padding: 6px 12px; border-bottom: 1px solid ${rule}; color: ${quiet}; font-size: 11px; position: sticky; top: 0; background: ${paper}; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid ${rule}; padding: 4px 10px; text-align: left; white-space: nowrap; }
    thead th { position: sticky; top: 28px; background: ${inset}; color: ${ink}; font-weight: 600; }
    td.num { text-align: right; color: ${num}; }
    .n { color: ${quiet}; text-align: right; user-select: none; width: 1%; background: ${inset}; }
    tr:hover td { background: ${inset}; }
  </style></head><body>
    <div class="bar">${body.length.toLocaleString()} rows · ${width} columns · ${name}-separated${header ? ' · first row read as a header' : ''}</div>
    <table>${head}<tbody>${rowsHtml}</tbody></table>
  </body></html>`;
}
