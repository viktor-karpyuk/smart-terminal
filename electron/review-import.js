'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Code Reviewer: bringing a person's AI Code Reviewer history across.
 *
 * The desktop app this clones keeps everything in one SQLite file and its forge
 * tokens encrypted with AES-256-GCM under a key kept *outside* that file, at
 * `~/.acr/master.key`. Because the reviewer's tables here use the same column
 * names, importing is a copy: repositories (their tokens decrypted with that key
 * and encrypted again with this app's own), reviews, findings, threads, replies,
 * fixes, approvals, guidelines, the PR cache and usage.
 *
 * The source is opened read-only and never written. Rows are inserted with their
 * original ids and `INSERT OR IGNORE`, so importing twice changes nothing the
 * second time. A repository already configured here (same provider, owner and
 * slug) is left as it is, together with everything that belongs to it: merging
 * two histories of one PR would make both wrong.
 */

function defaultSource() {
  const home = os.homedir();
  const dataDir =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'AICodeReviewer')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? home, 'AICodeReviewer')
        : path.join(home, '.local', 'share', 'ai-code-reviewer');
  return { dbFile: path.join(dataDir, 'acr.db'), keyFile: path.join(home, '.acr', 'master.key'), fixesDir: path.join(dataDir, 'fixes') };
}

/** `IV(12) || ciphertext || tag(16)`, as the original's `Secrets` writes it. */
function decryptToken(blob, key) {
  const bytes = Buffer.from(blob);
  if (bytes.length <= 12 + 16) throw new Error('cipher too short');
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(bytes.length - 16);
  const body = bytes.subarray(12, bytes.length - 16);
  const decipher = crypto.createDecipheriv(`aes-${key.length * 8}-gcm`, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function encryptToken(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(`aes-${key.length * 8}-gcm`, key, iv);
  return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
}

/** Preferences worth carrying: the rest are window sizes and cards of screens that do not exist here. */
const PREFS = ['review.language', 'me.author', 'notify.enabled', 'auto.enabled', 'auto.interval.minutes', 'auto.max.per.cycle', 'followup.days', 'merge.strategy'];

/** Tables copied as they are, source → destination. Order matters for the foreign keys. */
const TABLES = [
  ['review', 'cr_review'],
  ['finding', 'cr_finding'],
  ['publication', 'cr_publication'],
  ['pr_comment', 'cr_pr_comment'],
  ['local_note', 'cr_local_note'],
  ['reply_draft', 'cr_reply_draft'],
  ['pr_approval', 'cr_pr_approval'],
  ['guideline', 'cr_guideline'],
  ['finding_fix', 'cr_finding_fix'],
  ['pr_cache_meta', 'cr_pr_meta'],
];

function columns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  } catch {
    return [];
  }
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

/**
 * What an import would bring, without bringing it. Opens nothing for writing.
 */
function inspect({ DatabaseSync, source = defaultSource() }) {
  if (!fs.existsSync(source.dbFile)) return { found: false, dbFile: source.dbFile };
  const db = new DatabaseSync(source.dbFile, { readOnly: true });
  try {
    const count = (table) => (tableExists(db, table) ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : 0);
    const repos = tableExists(db, 'repo')
      ? db.prepare('SELECT id, name, provider, owner, slug, local_path, token_cipher IS NOT NULL AS has_token, local_only FROM repo ORDER BY name').all()
      : [];
    return {
      found: true,
      dbFile: source.dbFile,
      keyFound: fs.existsSync(source.keyFile),
      repos: repos.map((repo) => ({ id: repo.id, name: repo.name, provider: repo.provider, owner: repo.owner, slug: repo.slug, localPath: repo.local_path, hasToken: Boolean(repo.has_token), localOnly: Boolean(repo.local_only) })),
      counts: { reviews: count('review'), findings: count('finding'), replies: count('reply_draft'), fixes: count('finding_fix'), guidelines: count('guideline') },
    };
  } finally {
    db.close();
  }
}

/**
 * Copy it across.
 *
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.target the app's own database
 * @param {import('./review-store').ReviewStore} options.store for encrypting tokens the app's way
 * @param {string[]} [options.repoIds] only these repositories; all when absent
 */
function importAll({ DatabaseSync, store, source = defaultSource(), repoIds = null }) {
  const found = inspect({ DatabaseSync, source });
  if (!found.found) throw new Error(`AI Code Reviewer's database was not found at ${source.dbFile}.`);
  const key = fs.existsSync(source.keyFile) ? fs.readFileSync(source.keyFile) : null;
  if (key && ![16, 24, 32].includes(key.length)) throw new Error(`The master key at ${source.keyFile} is ${key.length} bytes, which is not an AES key.`);
  const db = new DatabaseSync(source.dbFile, { readOnly: true });
  const target = store.db;
  const report = { repos: 0, skippedRepos: [], tokensUnreadable: [], rows: {}, prefs: 0 };
  try {
    const wanted = repoIds ? new Set(repoIds) : null;
    const imported = new Set();
    store.transaction(() => {
      for (const repo of db.prepare('SELECT * FROM repo').all()) {
        if (wanted && !wanted.has(repo.id)) continue;
        if (repo.local_only) {
          report.skippedRepos.push(`${repo.name}: a local folder with no forge, which this reviewer does not handle`);
          continue;
        }
        const clash = target.prepare('SELECT id FROM cr_repo WHERE (provider = ? AND owner = ? AND slug = ?) OR id = ?').get(repo.provider, repo.owner, repo.slug, repo.id);
        if (clash) {
          report.skippedRepos.push(`${repo.name}: already configured here`);
          continue;
        }
        let tokenCipher = null;
        if (repo.token_cipher) {
          try {
            if (!key) throw new Error('no master key');
            tokenCipher = store.secrets.encrypt(decryptToken(repo.token_cipher, key));
          } catch {
            report.tokensUnreadable.push(repo.name);
          }
        }
        target
          .prepare(
            `INSERT INTO cr_repo (id, name, provider, owner, slug, local_path, token_cipher, created_at, project_kind, default_depth, default_model,
               auto_review, skip_drafts, skip_titles, skip_authors, only_targets, reply_mode, hidden, fix_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            repo.id,
            repo.name,
            repo.provider,
            repo.owner,
            repo.slug,
            repo.local_path,
            tokenCipher,
            repo.created_at ?? new Date().toISOString(),
            repo.project_kind && !['AUTO', 'GENERIC'].includes(repo.project_kind) ? repo.project_kind : repo.project_kind === 'GENERIC' ? 'GENERIC' : null,
            repo.default_depth && repo.default_depth !== 'AUTO' ? repo.default_depth : null,
            repo.default_model && repo.default_model !== 'AUTO' ? repo.default_model : '',
            // Automatic modes come across switched off: they spend and they publish, and turning
            // them on in a second app is a decision to make there, not an inheritance.
            0,
            repo.skip_drafts ?? 1,
            repo.skip_titles ?? 'DO NOT MERGE,WIP',
            repo.skip_authors ?? '',
            repo.only_targets ?? '',
            repo.reply_mode === 'AUTO' ? 'DRAFT' : repo.reply_mode ?? 'DRAFT',
            repo.hidden ?? 0,
            repo.fix_mode === 'AUTO' ? 'MANUAL' : repo.fix_mode ?? 'MANUAL',
          );
        imported.add(repo.id);
        report.repos++;
      }

      const belongs = (row) => row.repo_id === null || row.repo_id === undefined ? !wanted : imported.has(row.repo_id);
      for (const [from, to] of TABLES) {
        if (!tableExists(db, from)) continue;
        const shared = columns(db, from).filter((column) => columns(target, to).includes(column));
        if (!shared.length) continue;
        const insert = target.prepare(`INSERT OR IGNORE INTO ${to} (${shared.join(', ')}) VALUES (${shared.map(() => '?').join(', ')})`);
        let copied = 0;
        for (const row of db.prepare(`SELECT * FROM ${from}`).all()) {
          if (!belongs(row)) continue;
          if (from === 'guideline' && row.repo_id === null && target.prepare('SELECT 1 FROM cr_guideline WHERE repo_id IS NULL AND name = ?').get(row.name)) continue;
          if (from === 'review' && row.status === 'RUNNING') row.status = 'FAILED';
          const result = insert.run(...shared.map((column) => (row[column] === undefined ? null : row[column])));
          copied += Number(result.changes);
        }
        report.rows[to] = copied;
      }

      // The PR cache: the open list, what was seen, and how the closed ones ended, folded into one table.
      const prs = new Map();
      const keyOf = (row) => `${row.repo_id}#${row.pr_id}`;
      if (tableExists(db, 'seen_pr')) {
        for (const row of db.prepare('SELECT * FROM seen_pr').all()) {
          if (imported.has(row.repo_id)) prs.set(keyOf(row), { repo_id: row.repo_id, pr_id: row.pr_id, title: row.title ?? '', author: row.author ?? '', first_seen_at: row.first_seen_at, state: 'OPEN' });
        }
      }
      if (tableExists(db, 'pr_cache')) {
        for (const row of db.prepare('SELECT * FROM pr_cache').all()) {
          if (!imported.has(row.repo_id)) continue;
          prs.set(keyOf(row), { ...(prs.get(keyOf(row)) ?? {}), ...row, state: 'OPEN' });
        }
      }
      if (tableExists(db, 'closed_pr')) {
        for (const row of db.prepare('SELECT * FROM closed_pr').all()) {
          if (!imported.has(row.repo_id)) continue;
          const current = prs.get(keyOf(row)) ?? { repo_id: row.repo_id, pr_id: row.pr_id };
          prs.set(keyOf(row), { ...current, state: row.state === 'MERGED' ? 'MERGED' : 'DECLINED', closed_at: row.closed_at });
        }
      }
      // A PR known only from its reviews still needs a row: its screen opens from one.
      for (const row of target.prepare('SELECT repo_id, pr_id, pr_title, head_sha, pr_author, MAX(created_at) AS at FROM cr_review GROUP BY repo_id, pr_id').all()) {
        if (!imported.has(row.repo_id) || prs.has(keyOf(row))) continue;
        prs.set(keyOf(row), { repo_id: row.repo_id, pr_id: row.pr_id, title: row.pr_title ?? '', author: row.pr_author ?? '', head_sha: row.head_sha ?? '', state: 'OPEN' });
      }
      const insertPr = target.prepare(
        `INSERT OR IGNORE INTO cr_pr (repo_id, pr_id, title, author, source, target, head_sha, comments, updated_on, created_on, url, is_draft, state, first_seen_at, closed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      let prRows = 0;
      for (const pr of prs.values()) {
        prRows += Number(
          insertPr.run(pr.repo_id, pr.pr_id, pr.title ?? '', pr.author ?? '', pr.source ?? '', pr.target ?? '', pr.head_sha ?? '', pr.comments ?? 0, pr.updated_on ?? '', pr.created_on ?? '', pr.url ?? '', pr.is_draft ?? 0, pr.state ?? 'OPEN', pr.first_seen_at ?? null, pr.closed_at ?? null).changes,
        );
      }
      report.rows.cr_pr = prRows;

      // Usage belongs to the accounts, not to a repository: it comes across whichever repositories were chosen.
      if (tableExists(db, 'cli_usage')) {
        const shared = columns(db, 'cli_usage').filter((column) => columns(target, 'cr_cli_usage').includes(column));
        const insert = target.prepare(`INSERT OR IGNORE INTO cr_cli_usage (${shared.join(', ')}) VALUES (${shared.map(() => '?').join(', ')})`);
        let copied = 0;
        for (const row of db.prepare('SELECT * FROM cli_usage').all()) copied += Number(insert.run(...shared.map((column) => row[column] ?? null)).changes);
        report.rows.cr_cli_usage = copied;
      }

      if (tableExists(db, 'pref')) {
        for (const row of db.prepare('SELECT k, v FROM pref').all()) {
          if (!PREFS.includes(row.k) || store.pref(row.k) !== null) continue;
          // Automatic mode is off after an import, for the same reason as the repositories' modes.
          store.setPref(row.k, row.k === 'auto.enabled' ? 'false' : row.v);
          report.prefs++;
        }
      }
    });
    report.fixesDir = source.fixesDir;
    return report;
  } finally {
    db.close();
  }
}

module.exports = { defaultSource, decryptToken, encryptToken, inspect, importAll, PREFS };
