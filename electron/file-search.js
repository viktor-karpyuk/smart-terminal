'use strict';

/**
 * Searching inside the files of a folder, and replacing what was found — the
 * Search view of an editor.
 *
 * Which files: in a git checkout, the ones git would show (`ls-files`, tracked
 * and untracked, minus what is ignored), so a search never wades through
 * `build/` or `node_modules`. Outside one, a walk that skips dotted folders and
 * the usual heavy ones. Matching is always JavaScript's, in this process, so
 * the regex someone types means the same thing whichever way the files came.
 *
 * Bounded like the name search is: a time budget, a file budget and a match
 * budget, and `cut` says when any of them stopped it.
 */

const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { looksBinary, MAX_BYTES } = require('./files');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '__pycache__', '.venv', 'venv', 'target', 'vendor', '.gradle', '.idea', 'Pods', 'DerivedData', 'dist', 'build']);
const LINE_MAX = 240;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The pattern a search means, or an error to show in place of results. */
function buildPattern({ query, regex = false, caseSensitive = false, wholeWord = false }) {
  if (!query) return { error: null, pattern: null };
  let source = regex ? query : escapeRegex(query);
  if (wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return { error: null, pattern: new RegExp(source, `g${caseSensitive ? '' : 'i'}m`) };
  } catch (error) {
    return { error: `Not a valid regular expression: ${error.message}`, pattern: null };
  }
}

/**
 * A glob list, the way an editor's "files to include" box takes one:
 * comma-separated, `*` within a name, `**` across folders, and a pattern
 * without a slash matches a name anywhere (`*.ts`, `test`).
 */
function globMatcher(text) {
  const globs = String(text ?? '')
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean);
  if (!globs.length) return null;
  const tests = globs.map((glob) => {
    let body = '';
    for (let i = 0; i < glob.length; i += 1) {
      const char = glob[i];
      if (char === '*' && glob[i + 1] === '*') {
        body += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else if (char === '*') body += '[^/]*';
      else if (char === '?') body += '[^/]';
      else body += escapeRegex(char);
    }
    const anchored = glob.includes('/') ? `^${body.replace(/^\\\.\//, '')}(?:/.*)?$` : `(?:^|/)${body}(?:/.*)?$`;
    return new RegExp(anchored);
  });
  return (relative) => tests.some((test) => test.test(relative));
}

function gitFiles(root) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, maxBuffer: 256 * 1024 * 1024, timeout: 20000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        resolve([...new Set(String(stdout).split('\0').filter(Boolean))]);
      },
    );
  });
}

async function walkFiles(root, { maxFiles, deadline }) {
  const out = [];
  const queue = [''];
  while (queue.length && out.length < maxFiles && Date.now() < deadline) {
    const rel = queue.shift();
    let entries = [];
    try {
      entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(child);
      } else if (entry.isFile()) out.push(child);
    }
  }
  return out;
}

/** Each place on a line the pattern matched, as [start, end) pairs. */
function rangesIn(line, pattern) {
  const ranges = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    ranges.push([match.index, match.index + match[0].length]);
    if (ranges.length > 50) break;
  }
  return ranges;
}

/** A long line cut down to the part around its first match, ranges moved with it. */
function clip(line, ranges) {
  if (line.length <= LINE_MAX) return { text: line, ranges, offset: 0 };
  const start = Math.max(0, (ranges[0]?.[0] ?? 0) - 40);
  const text = line.slice(start, start + LINE_MAX);
  return {
    text,
    offset: start,
    ranges: ranges
      .map(([a, b]) => [a - start, Math.min(b - start, text.length)])
      .filter(([a, b]) => a >= 0 && b > a),
  };
}

async function searchInTree(root, options = {}, { maxFiles = 30000, maxMatches = 5000, perFile = 500, maxMs = 10000 } = {}) {
  const { pattern, error } = buildPattern(options);
  if (error) return { ok: false, error };
  if (!pattern) return { ok: true, files: [], matches: 0, cut: false };
  const deadline = Date.now() + maxMs;

  let files = await gitFiles(root);
  const fromGit = Boolean(files);
  if (!files) files = await walkFiles(root, { maxFiles, deadline });
  const include = globMatcher(options.include);
  const exclude = globMatcher(options.exclude);
  files = files.filter((rel) => (!include || include(rel)) && !(exclude && exclude(rel)));
  let cut = files.length > maxFiles;
  files = files.slice(0, maxFiles).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  const results = [];
  let matches = 0;
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      if (matches >= maxMatches || Date.now() > deadline) {
        cut = true;
        return;
      }
      const rel = files[next];
      next += 1;
      const full = path.join(root, rel);
      let buffer;
      try {
        const stat = await fsp.stat(full);
        if (!stat.isFile() || stat.size > MAX_BYTES) continue;
        buffer = await fsp.readFile(full);
      } catch {
        continue;
      }
      if (looksBinary(buffer)) continue;
      const text = buffer.toString('utf8');
      pattern.lastIndex = 0;
      if (!pattern.test(text)) continue;
      const lines = text.split(/\r?\n/);
      const found = [];
      for (let i = 0; i < lines.length && found.length < perFile; i += 1) {
        const ranges = rangesIn(lines[i], pattern);
        if (!ranges.length) continue;
        const clipped = clip(lines[i], ranges);
        found.push({ line: i + 1, column: ranges[0][0] + 1, text: clipped.text, ranges: clipped.ranges, count: ranges.length });
      }
      if (!found.length) continue;
      const count = found.reduce((sum, one) => sum + one.count, 0);
      matches += count;
      results.push({ path: full, relative: rel, matches: found, count });
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));

  results.sort((a, b) => a.relative.localeCompare(b.relative, undefined, { numeric: true, sensitivity: 'base' }));
  return { ok: true, files: results, matches, cut, fromGit };
}

/**
 * Replace every match in these files.
 *
 * Only files under `root`, and only text files: the list comes from the
 * renderer, so it is checked rather than trusted. `$1` and friends work in
 * regex mode; otherwise the replacement is taken literally.
 */
async function replaceInFiles(root, options = {}, files = []) {
  const { pattern, error } = buildPattern(options);
  if (error) return { ok: false, error };
  if (!pattern) return { ok: true, changed: [], replaced: 0 };
  const replacement = String(options.replacement ?? '');
  const base = path.resolve(root);
  const changed = [];
  const failed = [];
  let replaced = 0;
  for (const file of files) {
    const full = path.resolve(String(file));
    if (full !== base && !full.startsWith(base + path.sep)) {
      failed.push({ path: full, error: 'outside the folder' });
      continue;
    }
    try {
      const buffer = await fsp.readFile(full);
      if (buffer.length > MAX_BYTES || looksBinary(buffer)) continue;
      const text = buffer.toString('utf8');
      pattern.lastIndex = 0;
      const count = (text.match(pattern) ?? []).filter((one) => one.length > 0).length;
      // Regex mode gets String.replace's own `$1` expansion; plain text is taken as typed.
      const next = options.regex ? text.replace(pattern, replacement) : text.replace(pattern, () => replacement);
      if (!count || next === text) continue;
      await fsp.writeFile(full, next, 'utf8');
      changed.push(full);
      replaced += count;
    } catch (failure) {
      failed.push({ path: full, error: failure.message });
    }
  }
  return { ok: true, changed, replaced, failed };
}

module.exports = { searchInTree, replaceInFiles, buildPattern, globMatcher };
