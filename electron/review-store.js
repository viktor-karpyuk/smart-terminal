'use strict';

const { randomUUID } = require('node:crypto');
const rules = require('./review-rules');

/**
 * Code Reviewer: what it remembers, in the app's own database.
 *
 * One database, one app — the rule that keeps two copies of Smart Terminal from
 * writing over each other applies to this too, so the reviewer's tables live in
 * `smart-terminal.db` beside everything else, prefixed `cr_`. It is handed the
 * open `DatabaseSync` rather than opening one, which is also what lets the tests
 * give it an in-memory one.
 *
 * The columns are AI Code Reviewer's, name for name. That is deliberate: it is
 * what makes importing a person's whole review history a copy rather than a
 * translation, and it keeps the two schemas readable side by side.
 *
 * Migrations are forward-only. A published one is never edited; a new one is
 * appended. A database newer than the code refuses to open rather than being
 * written by code that does not know its shape.
 */

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS cr_repo (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, owner TEXT NOT NULL, slug TEXT NOT NULL,
     local_path TEXT NOT NULL, token_cipher TEXT, created_at TEXT NOT NULL,
     project_kind TEXT, default_depth TEXT, default_model TEXT NOT NULL DEFAULT '',
     auto_review INTEGER NOT NULL DEFAULT 0, skip_drafts INTEGER NOT NULL DEFAULT 1,
     skip_titles TEXT NOT NULL DEFAULT 'DO NOT MERGE,WIP', skip_authors TEXT NOT NULL DEFAULT '',
     only_targets TEXT NOT NULL DEFAULT '', reply_mode TEXT NOT NULL DEFAULT 'DRAFT',
     hidden INTEGER NOT NULL DEFAULT 0, fix_mode TEXT NOT NULL DEFAULT 'MANUAL',
     UNIQUE(provider, owner, slug)
   );
   CREATE TABLE IF NOT EXISTS cr_review (
     id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES cr_repo(id) ON DELETE CASCADE, pr_id INTEGER NOT NULL,
     pr_title TEXT NOT NULL DEFAULT '', head_sha TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, body TEXT, error TEXT,
     session_id TEXT, cost_usd REAL, published_url TEXT, created_at TEXT NOT NULL, finished_at TEXT,
     depth TEXT, project_kind TEXT, model TEXT, trigger_kind TEXT NOT NULL DEFAULT 'MANUAL',
     tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
     denied_tools TEXT, resolution_summary TEXT, resolution_at TEXT, resolution_head TEXT,
     final_pass_head TEXT, final_pass_summary TEXT, final_pass_blockers INTEGER,
     previous_review_id TEXT, since_sha TEXT, pr_author TEXT, plan_reason TEXT, account_name TEXT
   );
   CREATE INDEX IF NOT EXISTS cr_review_pr ON cr_review(repo_id, pr_id, created_at DESC);
   CREATE TABLE IF NOT EXISTS cr_finding (
     id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES cr_review(id) ON DELETE CASCADE,
     repo_id TEXT NOT NULL, pr_id INTEGER NOT NULL, file_path TEXT NOT NULL, line_no INTEGER,
     severity TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, published_id TEXT, created_at TEXT NOT NULL,
     published_url TEXT, dismissed_at TEXT, publish_error TEXT, resolution TEXT, resolution_note TEXT,
     followed_up_at TEXT, closed_at TEXT, suggestion TEXT, category TEXT, asked_by TEXT
   );
   CREATE INDEX IF NOT EXISTS cr_finding_pr ON cr_finding(repo_id, pr_id);
   CREATE INDEX IF NOT EXISTS cr_finding_review ON cr_finding(review_id);
   CREATE TABLE IF NOT EXISTS cr_publication (
     id TEXT PRIMARY KEY, review_id TEXT, repo_id TEXT NOT NULL, pr_id INTEGER NOT NULL,
     comment_id TEXT, url TEXT, body TEXT, published_at TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS cr_pr_comment (
     id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, pr_id INTEGER NOT NULL, comment_id TEXT NOT NULL,
     author TEXT NOT NULL, body TEXT NOT NULL, inline_path TEXT, inline_line INTEGER,
     is_deleted INTEGER NOT NULL DEFAULT 0, is_ours INTEGER NOT NULL DEFAULT 0, created_on TEXT NOT NULL DEFAULT '',
     synced_at TEXT NOT NULL, parent_id TEXT, UNIQUE(repo_id, pr_id, comment_id)
   );
   CREATE TABLE IF NOT EXISTS cr_local_note (
     id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, pr_id INTEGER NOT NULL, file_path TEXT NOT NULL, line_no INTEGER,
     side TEXT NOT NULL DEFAULT 'NEW', body TEXT NOT NULL, published_id TEXT, created_at TEXT NOT NULL, published_url TEXT
   );
   CREATE TABLE IF NOT EXISTS cr_reply_draft (
     id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, pr_id INTEGER NOT NULL, their_comment_id TEXT NOT NULL,
     their_author TEXT NOT NULL, their_body TEXT NOT NULL, our_comment_id TEXT, our_body TEXT,
     file_path TEXT, line_no INTEGER, body TEXT, status TEXT NOT NULL DEFAULT 'PENDING', error TEXT,
     published_id TEXT, published_url TEXT, cost_usd REAL, created_at TEXT NOT NULL, dismissed_at TEXT,
     UNIQUE(repo_id, pr_id, their_comment_id)
   );
   CREATE TABLE IF NOT EXISTS cr_pr (
     repo_id TEXT NOT NULL, pr_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '', head_sha TEXT NOT NULL DEFAULT '',
     comments INTEGER NOT NULL DEFAULT 0, updated_on TEXT NOT NULL DEFAULT '', created_on TEXT NOT NULL DEFAULT '',
     url TEXT NOT NULL DEFAULT '', is_draft INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'OPEN',
     description TEXT, first_seen_at TEXT, closed_at TEXT, fetched_at TEXT,
     PRIMARY KEY (repo_id, pr_id)
   );
   CREATE TABLE IF NOT EXISTS cr_pr_meta (repo_id TEXT PRIMARY KEY, etag TEXT, fetched_at TEXT, swept_at TEXT);
   CREATE TABLE IF NOT EXISTS cr_pr_approval (
     repo_id TEXT NOT NULL, pr_id INTEGER NOT NULL, approved_by TEXT NOT NULL, by_us INTEGER NOT NULL DEFAULT 0,
     approved_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'APPROVED', PRIMARY KEY (repo_id, pr_id, approved_by)
   );
   CREATE TABLE IF NOT EXISTS cr_pending_job (
     id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, pr_id INTEGER NOT NULL, depth TEXT, kind TEXT, model TEXT,
     auto INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(repo_id, pr_id)
   );
   CREATE TABLE IF NOT EXISTS cr_guideline (
     id TEXT PRIMARY KEY, repo_id TEXT, name TEXT NOT NULL, content TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
     source TEXT NOT NULL DEFAULT 'TYPED', created_at TEXT NOT NULL, linked_path TEXT, linked_hash TEXT
   );
   CREATE TABLE IF NOT EXISTS cr_finding_fix (
     id TEXT PRIMARY KEY, finding_id TEXT NOT NULL, review_id TEXT, repo_id TEXT NOT NULL, pr_id INTEGER NOT NULL,
     branch TEXT NOT NULL, state TEXT NOT NULL, sha TEXT, summary TEXT, error TEXT, session_id TEXT, cost_usd REAL,
     workspace TEXT, created_at TEXT NOT NULL, finished_at TEXT, returned_at TEXT, reply_id TEXT, reply_url TEXT, reply_error TEXT
   );
   CREATE INDEX IF NOT EXISTS cr_fix_pr ON cr_finding_fix(repo_id, pr_id);
   CREATE TABLE IF NOT EXISTS cr_cli_usage (
     id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, model TEXT, session_id TEXT, ok INTEGER NOT NULL,
     seconds INTEGER, tokens_in INTEGER, tokens_out INTEGER, cache_read INTEGER, cache_write INTEGER,
     cost_usd REAL, account_id TEXT
   );
   CREATE TABLE IF NOT EXISTS cr_pref (k TEXT PRIMARY KEY, v TEXT)`,
];

const now = () => new Date().toISOString();
const id = () => randomUUID();
const bool = (value) => (value ? 1 : 0);
const nul = (value) => (value === undefined || value === '' ? null : value);

function repoRow(row, decrypt) {
  if (!row) return null;
  let token = null;
  if (row.token_cipher) {
    try {
      token = decrypt(row.token_cipher);
    } catch {
      token = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    owner: row.owner,
    slug: row.slug,
    localPath: row.local_path,
    token,
    hasToken: Boolean(row.token_cipher),
    tokenUnreadable: Boolean(row.token_cipher) && token === null,
    createdAt: row.created_at,
    projectKind: row.project_kind || null,
    defaultDepth: row.default_depth || null,
    defaultModel: row.default_model || '',
    autoReview: Boolean(row.auto_review),
    skipDrafts: Boolean(row.skip_drafts),
    skipTitles: row.skip_titles ?? '',
    skipAuthors: row.skip_authors ?? '',
    onlyTargets: row.only_targets ?? '',
    replyMode: row.reply_mode || 'DRAFT',
    hidden: Boolean(row.hidden),
    fixMode: row.fix_mode || 'MANUAL',
  };
}

const reviewRow = (row) =>
  row && {
    id: row.id,
    repoId: row.repo_id,
    prId: Number(row.pr_id),
    prTitle: row.pr_title,
    headSha: row.head_sha,
    status: row.status,
    body: row.body,
    error: row.error,
    sessionId: row.session_id,
    costUsd: row.cost_usd,
    publishedUrl: row.published_url,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    depth: row.depth,
    projectKind: row.project_kind,
    model: row.model,
    trigger: row.trigger_kind,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    tokensCacheRead: row.tokens_cache_read,
    tokensCacheWrite: row.tokens_cache_write,
    deniedTools: row.denied_tools,
    resolutionSummary: row.resolution_summary,
    resolutionAt: row.resolution_at,
    resolutionHead: row.resolution_head,
    finalPassHead: row.final_pass_head,
    finalPassSummary: row.final_pass_summary,
    finalPassBlockers: row.final_pass_blockers,
    previousReviewId: row.previous_review_id,
    sinceSha: row.since_sha,
    prAuthor: row.pr_author,
    planReason: row.plan_reason,
    accountName: row.account_name,
  };

const findingRow = (row) =>
  row && {
    id: row.id,
    reviewId: row.review_id,
    repoId: row.repo_id,
    prId: Number(row.pr_id),
    filePath: row.file_path,
    lineNo: row.line_no ?? null,
    severity: row.severity,
    title: row.title,
    body: row.body,
    publishedId: row.published_id,
    createdAt: row.created_at,
    publishedUrl: row.published_url,
    dismissedAt: row.dismissed_at,
    publishError: row.publish_error,
    resolution: row.resolution,
    resolutionNote: row.resolution_note,
    followedUpAt: row.followed_up_at,
    closedAt: row.closed_at,
    suggestion: row.suggestion,
    category: row.category,
    askedBy: row.asked_by,
  };

const commentRow = (row) => ({
  commentId: row.comment_id,
  author: row.author,
  body: row.body,
  inlinePath: row.inline_path,
  inlineLine: row.inline_line ?? null,
  deleted: Boolean(row.is_deleted),
  ours: Boolean(row.is_ours),
  createdOn: row.created_on,
  parentId: row.parent_id,
});

const noteRow = (row) => ({
  id: row.id,
  repoId: row.repo_id,
  prId: Number(row.pr_id),
  filePath: row.file_path,
  lineNo: row.line_no ?? null,
  side: row.side,
  body: row.body,
  publishedId: row.published_id,
  publishedUrl: row.published_url,
  createdAt: row.created_at,
});

const replyRow = (row) =>
  row && {
    id: row.id,
    repoId: row.repo_id,
    prId: Number(row.pr_id),
    theirCommentId: row.their_comment_id,
    theirAuthor: row.their_author,
    theirBody: row.their_body,
    ourCommentId: row.our_comment_id,
    ourBody: row.our_body,
    filePath: row.file_path,
    lineNo: row.line_no ?? null,
    body: row.body,
    status: row.status,
    error: row.error,
    publishedId: row.published_id,
    publishedUrl: row.published_url,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
    dismissedAt: row.dismissed_at,
  };

const prRow = (row) =>
  row && {
    repoId: row.repo_id,
    id: Number(row.pr_id),
    title: row.title,
    author: row.author,
    sourceBranch: row.source,
    targetBranch: row.target,
    headSha: row.head_sha,
    commentCount: row.comments,
    updatedOn: row.updated_on,
    createdOn: row.created_on,
    url: row.url,
    isDraft: Boolean(row.is_draft),
    state: row.state,
    description: row.description ?? '',
    firstSeenAt: row.first_seen_at,
    closedAt: row.closed_at,
    fetchedAt: row.fetched_at,
  };

const fixRow = (row) =>
  row && {
    id: row.id,
    findingId: row.finding_id,
    reviewId: row.review_id,
    repoId: row.repo_id,
    prId: Number(row.pr_id),
    branch: row.branch,
    state: row.state,
    sha: row.sha,
    summary: row.summary,
    error: row.error,
    sessionId: row.session_id,
    costUsd: row.cost_usd,
    workspace: row.workspace,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    returnedAt: row.returned_at,
    replyId: row.reply_id,
    replyUrl: row.reply_url,
    replyError: row.reply_error,
  };

const guidelineRow = (row) => ({
  id: row.id,
  repoId: row.repo_id,
  name: row.name,
  content: row.content,
  enabled: Boolean(row.enabled),
  source: row.source,
  createdAt: row.created_at,
  linkedPath: row.linked_path,
  linkedHash: row.linked_hash,
});

class ReviewStore {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{encrypt: (text: string) => string, decrypt: (cipher: string) => string}} secrets
   */
  constructor(db, secrets) {
    this.db = db;
    this.secrets = secrets ?? { encrypt: (text) => Buffer.from(text).toString('base64'), decrypt: (cipher) => Buffer.from(cipher, 'base64').toString() };
    this.#migrate();
  }

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS cr_schema (version INTEGER NOT NULL)');
    let row = this.db.prepare('SELECT version FROM cr_schema').get();
    if (!row) {
      this.db.prepare('INSERT INTO cr_schema (version) VALUES (0)').run();
      row = { version: 0 };
    }
    if (row.version > MIGRATIONS.length) {
      throw new Error(`The Code Reviewer tables are at version ${row.version}, newer than this build knows (${MIGRATIONS.length}). Update Smart Terminal.`);
    }
    for (let version = row.version; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.prepare('UPDATE cr_schema SET version = ?').run(version + 1);
      });
    }
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  get(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  // --- preferences -------------------------------------------------------

  pref(key, fallback = null) {
    const row = this.get('SELECT v FROM cr_pref WHERE k = ?', key);
    return row ? row.v : fallback;
  }

  setPref(key, value) {
    if (value === null || value === undefined) this.run('DELETE FROM cr_pref WHERE k = ?', key);
    else this.run('INSERT INTO cr_pref (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', key, String(value));
  }

  prefs() {
    return Object.fromEntries(this.all('SELECT k, v FROM cr_pref').map((row) => [row.k, row.v]));
  }

  // --- repositories --------------------------------------------------------

  repos({ withHidden = true } = {}) {
    const rows = this.all(`SELECT * FROM cr_repo ${withHidden ? '' : 'WHERE hidden = 0'} ORDER BY name COLLATE NOCASE`);
    return rows.map((row) => repoRow(row, this.secrets.decrypt));
  }

  repo(repoId) {
    return repoRow(this.get('SELECT * FROM cr_repo WHERE id = ?', repoId), this.secrets.decrypt);
  }

  saveRepo(input) {
    const existing = input.id ? this.get('SELECT * FROM cr_repo WHERE id = ?', input.id) : null;
    const token = typeof input.token === 'string' && input.token.trim() ? this.secrets.encrypt(input.token.trim()) : existing?.token_cipher ?? null;
    const values = [
      String(input.name).trim(),
      input.localPath,
      token,
      nul(input.projectKind),
      nul(input.defaultDepth),
      input.defaultModel ?? '',
      bool(input.autoReview),
      bool(input.skipDrafts ?? true),
      input.skipTitles ?? 'DO NOT MERGE,WIP',
      input.skipAuthors ?? '',
      input.onlyTargets ?? '',
      input.replyMode ?? 'DRAFT',
      bool(input.hidden),
      input.fixMode ?? 'MANUAL',
    ];
    if (existing) {
      this.run(
        `UPDATE cr_repo SET name=?, local_path=?, token_cipher=?, project_kind=?, default_depth=?, default_model=?, auto_review=?,
           skip_drafts=?, skip_titles=?, skip_authors=?, only_targets=?, reply_mode=?, hidden=?, fix_mode=? WHERE id=?`,
        ...values,
        existing.id,
      );
      return this.repo(existing.id);
    }
    const repoId = input.id || id();
    this.run(
      `INSERT INTO cr_repo (name, local_path, token_cipher, project_kind, default_depth, default_model, auto_review, skip_drafts,
         skip_titles, skip_authors, only_targets, reply_mode, hidden, fix_mode, id, provider, owner, slug, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ...values,
      repoId,
      input.provider,
      String(input.owner).trim(),
      String(input.slug).trim(),
      input.createdAt ?? now(),
    );
    return this.repo(repoId);
  }

  setHidden(repoId, hidden) {
    this.run('UPDATE cr_repo SET hidden = ? WHERE id = ?', bool(hidden), repoId);
  }

  /** Everything the repository owns goes with it; cascades cover reviews and findings, the rest by hand. */
  deleteRepo(repoId) {
    this.transaction(() => {
      for (const table of ['cr_finding', 'cr_publication', 'cr_pr_comment', 'cr_local_note', 'cr_reply_draft', 'cr_pr', 'cr_pr_meta', 'cr_pr_approval', 'cr_pending_job', 'cr_guideline', 'cr_finding_fix']) {
        this.run(`DELETE FROM ${table} WHERE repo_id = ?`, repoId);
      }
      this.run('DELETE FROM cr_review WHERE repo_id = ?', repoId);
      this.run('DELETE FROM cr_repo WHERE id = ?', repoId);
    });
  }

  // --- pull requests ---------------------------------------------------------

  pr(repoId, prId) {
    return prRow(this.get('SELECT * FROM cr_pr WHERE repo_id = ? AND pr_id = ?', repoId, prId));
  }

  prs(repoId, { states } = {}) {
    const rows = this.all('SELECT * FROM cr_pr WHERE repo_id = ?', repoId).map(prRow);
    return states ? rows.filter((pr) => states.includes(pr.state)) : rows;
  }

  openPrs() {
    return this.all("SELECT p.* FROM cr_pr p JOIN cr_repo r ON r.id = p.repo_id WHERE p.state = 'OPEN'").map(prRow);
  }

  prMeta(repoId) {
    return this.get('SELECT * FROM cr_pr_meta WHERE repo_id = ?', repoId) ?? null;
  }

  /**
   * Store what the forge said about one PR. Returns true when the PR was never
   * seen before — the signal for "new PR" notifications — which is not the same
   * as "not in the table": a PR first stored as history is not news.
   */
  upsertPr(repoId, pr, { fetched = true } = {}) {
    const before = this.get('SELECT first_seen_at, state FROM cr_pr WHERE repo_id = ? AND pr_id = ?', repoId, pr.id);
    const stamp = now();
    this.run(
      `INSERT INTO cr_pr (repo_id, pr_id, title, author, source, target, head_sha, comments, updated_on, created_on, url, is_draft, state, description, first_seen_at, closed_at, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(repo_id, pr_id) DO UPDATE SET title=excluded.title, author=excluded.author, source=excluded.source, target=excluded.target,
         head_sha=CASE WHEN excluded.head_sha <> '' THEN excluded.head_sha ELSE cr_pr.head_sha END, comments=excluded.comments,
         updated_on=excluded.updated_on, created_on=CASE WHEN excluded.created_on <> '' THEN excluded.created_on ELSE cr_pr.created_on END,
         url=excluded.url, is_draft=excluded.is_draft, state=excluded.state,
         description=COALESCE(NULLIF(excluded.description, ''), cr_pr.description),
         closed_at=CASE WHEN excluded.state <> 'OPEN' THEN COALESCE(cr_pr.closed_at, excluded.closed_at) ELSE NULL END,
         fetched_at=excluded.fetched_at`,
      repoId,
      pr.id,
      pr.title ?? '',
      pr.author ?? '',
      pr.sourceBranch ?? '',
      pr.targetBranch ?? '',
      pr.headSha ?? '',
      Number(pr.commentCount ?? 0),
      pr.updatedOn ?? '',
      pr.createdOn ?? '',
      pr.url ?? '',
      bool(pr.isDraft),
      pr.state ?? 'OPEN',
      pr.description ?? '',
      stamp,
      pr.state && pr.state !== 'OPEN' ? stamp : null,
      fetched ? stamp : null,
    );
    return !before;
  }

  /**
   * A PR known as open that is missing from a fresh, non-empty open list was
   * closed somewhere else. How it ended is unknown, so it is declined unless the
   * forge said otherwise: "merged" by default would be a happy ending that may
   * not have happened. An empty list counts: the forge client throws on every
   * failure, so an empty answer here is a successful "nothing is open", never a
   * failure dressed as one. (The original ignored empty lists because its loader
   * could not tell the two apart, and a repository whose last PR closed kept it
   * open forever.) A 304 never reaches this — it carries no list at all.
   */
  reconcileOpen(repoId, openIds) {
    const known = this.all("SELECT pr_id FROM cr_pr WHERE repo_id = ? AND state = 'OPEN'", repoId).map((row) => Number(row.pr_id));
    const gone = known.filter((prId) => !openIds.includes(prId));
    for (const prId of gone) this.run("UPDATE cr_pr SET state = 'DECLINED', closed_at = COALESCE(closed_at, ?) WHERE repo_id = ? AND pr_id = ?", now(), repoId, prId);
    return gone.length;
  }

  setPrMeta(repoId, { etag, fetchedAt, sweptAt } = {}) {
    const current = this.prMeta(repoId) ?? {};
    this.run(
      'INSERT INTO cr_pr_meta (repo_id, etag, fetched_at, swept_at) VALUES (?,?,?,?) ON CONFLICT(repo_id) DO UPDATE SET etag=excluded.etag, fetched_at=excluded.fetched_at, swept_at=excluded.swept_at',
      repoId,
      etag === undefined ? current.etag ?? null : etag,
      fetchedAt === undefined ? current.fetched_at ?? null : fetchedAt,
      sweptAt === undefined ? current.swept_at ?? null : sweptAt,
    );
  }

  // --- approvals ------------------------------------------------------------

  syncApprovals(repoId, prId, pr) {
    this.transaction(() => {
      const stances = [
        ...(pr.approvedBy ?? []).map((who) => [who, 'APPROVED']),
        ...(pr.changesRequestedBy ?? []).map((who) => [who, 'CHANGES_REQUESTED']),
      ];
      const ours = new Set(this.all('SELECT approved_by FROM cr_pr_approval WHERE repo_id = ? AND pr_id = ? AND by_us = 1', repoId, prId).map((row) => row.approved_by));
      this.run('DELETE FROM cr_pr_approval WHERE repo_id = ? AND pr_id = ?', repoId, prId);
      for (const [who, state] of stances) {
        this.run('INSERT OR REPLACE INTO cr_pr_approval (repo_id, pr_id, approved_by, by_us, approved_at, state) VALUES (?,?,?,?,?,?)', repoId, prId, who, bool(ours.has(who)), now(), state);
      }
    });
  }

  recordStance(repoId, prId, who, state) {
    this.run('DELETE FROM cr_pr_approval WHERE repo_id = ? AND pr_id = ? AND by_us = 1', repoId, prId);
    this.run('INSERT OR REPLACE INTO cr_pr_approval (repo_id, pr_id, approved_by, by_us, approved_at, state) VALUES (?,?,?,1,?,?)', repoId, prId, who || 'us', now(), state);
  }

  clearOurStance(repoId, prId) {
    this.run('DELETE FROM cr_pr_approval WHERE repo_id = ? AND pr_id = ? AND by_us = 1', repoId, prId);
  }

  approvals(repoId, prId) {
    return this.all('SELECT * FROM cr_pr_approval WHERE repo_id = ? AND pr_id = ?', repoId, prId).map((row) => ({ who: row.approved_by, byUs: Boolean(row.by_us), state: row.state, at: row.approved_at }));
  }

  // --- reviews -------------------------------------------------------------

  review(reviewId) {
    return reviewRow(this.get('SELECT * FROM cr_review WHERE id = ?', reviewId));
  }

  reviewsFor(repoId, prId) {
    return this.all('SELECT * FROM cr_review WHERE repo_id = ? AND pr_id = ? ORDER BY created_at DESC', repoId, prId).map(reviewRow);
  }

  latestDone(repoId, prId) {
    return reviewRow(this.get("SELECT * FROM cr_review WHERE repo_id = ? AND pr_id = ? AND status = 'DONE' ORDER BY created_at DESC LIMIT 1", repoId, prId));
  }

  /** The review a PR's screen is about: the latest finished one, or failing that the latest of any kind. */
  currentReview(repoId, prId) {
    return this.latestDone(repoId, prId) ?? reviewRow(this.get('SELECT * FROM cr_review WHERE repo_id = ? AND pr_id = ? ORDER BY created_at DESC LIMIT 1', repoId, prId));
  }

  existsForHead(repoId, prId, headSha) {
    return Boolean(this.get('SELECT 1 FROM cr_review WHERE repo_id = ? AND pr_id = ? AND head_sha = ? LIMIT 1', repoId, prId, headSha));
  }

  doneForHead(repoId, prId, headSha) {
    return reviewRow(this.get("SELECT * FROM cr_review WHERE repo_id = ? AND pr_id = ? AND head_sha = ? AND status = 'DONE' ORDER BY created_at DESC LIMIT 1", repoId, prId, headSha));
  }

  startReview({ repoId, prId, prTitle, headSha, depth, kind, model, auto, previousReviewId, sinceSha, prAuthor, planReason }) {
    const reviewId = id();
    this.run(
      `INSERT INTO cr_review (id, repo_id, pr_id, pr_title, head_sha, status, created_at, depth, project_kind, model, trigger_kind, previous_review_id, since_sha, pr_author, plan_reason)
       VALUES (?,?,?,?,?,'RUNNING',?,?,?,?,?,?,?,?,?)`,
      reviewId,
      repoId,
      prId,
      prTitle ?? '',
      headSha ?? '',
      now(),
      depth ?? null,
      kind ?? null,
      model ?? null,
      auto ? 'AUTO' : 'MANUAL',
      previousReviewId ?? null,
      sinceSha ?? null,
      prAuthor ?? null,
      planReason ?? null,
    );
    return reviewId;
  }

  failReview(reviewId, message, status = 'FAILED') {
    this.run('UPDATE cr_review SET status = ?, error = ?, finished_at = ? WHERE id = ?', status, String(message ?? '').slice(0, 4000), now(), reviewId);
  }

  finishReview(reviewId, { body, sessionId, costUsd, tokensIn, tokensOut, cacheRead, cacheWrite, deniedTools, accountName }) {
    this.run(
      `UPDATE cr_review SET status = 'DONE', body = ?, session_id = ?, cost_usd = ?, tokens_in = ?, tokens_out = ?, tokens_cache_read = ?,
         tokens_cache_write = ?, denied_tools = ?, account_name = ?, finished_at = ?, error = NULL WHERE id = ?`,
      body,
      sessionId ?? null,
      costUsd ?? 0,
      tokensIn ?? 0,
      tokensOut ?? 0,
      cacheRead ?? 0,
      cacheWrite ?? 0,
      nul(deniedTools),
      accountName ?? null,
      now(),
      reviewId,
    );
  }

  saveReviewBody(reviewId, body) {
    this.run('UPDATE cr_review SET body = ? WHERE id = ?', body, reviewId);
  }

  markReviewPublished(reviewId, url) {
    this.run('UPDATE cr_review SET published_url = ? WHERE id = ?', url, reviewId);
  }

  /** The last inline comment went out: the review counts as published, or the PR keeps saying "to publish". */
  markPublishedIfComplete(reviewId, url) {
    const pending = this.get('SELECT COUNT(*) AS n FROM cr_finding WHERE review_id = ? AND published_id IS NULL AND dismissed_at IS NULL AND closed_at IS NULL', reviewId).n;
    if (pending === 0) this.run('UPDATE cr_review SET published_url = COALESCE(published_url, ?) WHERE id = ?', url, reviewId);
  }

  setResolutionSummary(reviewId, text, head) {
    this.run('UPDATE cr_review SET resolution_summary = ?, resolution_at = ?, resolution_head = ? WHERE id = ?', text, now(), head, reviewId);
  }

  setFinalPass(reviewId, head, summary, blockers) {
    this.run('UPDATE cr_review SET final_pass_head = ?, final_pass_summary = ?, final_pass_blockers = ? WHERE id = ?', head, summary, blockers, reviewId);
  }

  /** Reviews left RUNNING by a process that is gone: queued to resume, and marked failed so nothing waits on them. */
  orphanedRuns() {
    const rows = this.all("SELECT * FROM cr_review WHERE status = 'RUNNING'").map(reviewRow);
    for (const review of rows) {
      this.run(
        'INSERT INTO cr_pending_job (id, repo_id, pr_id, depth, kind, model, auto, attempts, created_at) VALUES (?,?,?,?,?,?,?,0,?) ON CONFLICT(repo_id, pr_id) DO NOTHING',
        id(),
        review.repoId,
        review.prId,
        review.depth,
        review.projectKind,
        review.model,
        bool(review.trigger === 'AUTO'),
        now(),
      );
      this.failReview(review.id, 'Smart Terminal closed while this review was running. It will be resumed.', 'FAILED');
    }
    return rows.length;
  }

  pendingJobs() {
    return this.all('SELECT * FROM cr_pending_job ORDER BY created_at');
  }

  bumpPendingJob(jobId) {
    this.run('UPDATE cr_pending_job SET attempts = attempts + 1 WHERE id = ?', jobId);
  }

  dropPendingJob(jobId) {
    this.run('DELETE FROM cr_pending_job WHERE id = ?', jobId);
  }

  // --- findings ------------------------------------------------------------

  finding(findingId) {
    return findingRow(this.get('SELECT * FROM cr_finding WHERE id = ?', findingId));
  }

  findingsForReview(reviewId) {
    return this.all('SELECT * FROM cr_finding WHERE review_id = ? ORDER BY CASE severity WHEN \'blocker\' THEN 0 WHEN \'major\' THEN 1 ELSE 2 END, file_path, line_no', reviewId).map(findingRow);
  }

  findingsForPr(repoId, prId) {
    return this.all('SELECT * FROM cr_finding WHERE repo_id = ? AND pr_id = ? ORDER BY created_at', repoId, prId).map(findingRow);
  }

  /** A rerun replaces what that run found — but never what somebody else asked for. */
  replaceFindings(reviewId, repoId, prId, findings) {
    this.transaction(() => {
      this.run('DELETE FROM cr_finding WHERE review_id = ? AND asked_by IS NULL', reviewId);
      for (const finding of findings) {
        this.run(
          'INSERT INTO cr_finding (id, review_id, repo_id, pr_id, file_path, line_no, severity, title, body, created_at, suggestion, category) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          id(),
          reviewId,
          repoId,
          prId,
          finding.filePath,
          finding.lineNo ?? null,
          finding.severity,
          finding.title,
          finding.body,
          now(),
          finding.suggestion ?? null,
          finding.category ?? null,
        );
      }
    });
  }

  /** Moves a still-open finding to the new review, re-anchored when its line moved. */
  carryForward(findingId, reviewId, line) {
    this.run('UPDATE cr_finding SET review_id = ?, line_no = COALESCE(?, line_no) WHERE id = ?', reviewId, line ?? null, findingId);
  }

  setResolution(findingId, resolution, note) {
    this.run('UPDATE cr_finding SET resolution = ?, resolution_note = ? WHERE id = ?', resolution, note ?? null, findingId);
  }

  closeFinding(findingId, closedFlag) {
    this.run('UPDATE cr_finding SET closed_at = ? WHERE id = ?', closedFlag ? now() : null, findingId);
  }

  dismissFinding(findingId, dismissed) {
    this.run('UPDATE cr_finding SET dismissed_at = ? WHERE id = ?', dismissed ? now() : null, findingId);
  }

  markFindingPublished(findingId, publishedId, url) {
    this.run('UPDATE cr_finding SET published_id = ?, published_url = ?, publish_error = NULL WHERE id = ?', publishedId, url, findingId);
  }

  failFindingPublish(findingId, message) {
    this.run('UPDATE cr_finding SET publish_error = ? WHERE id = ?', String(message).slice(0, 1000), findingId);
  }

  markFollowedUp(findingId) {
    this.run('UPDATE cr_finding SET followed_up_at = ? WHERE id = ?', now(), findingId);
  }

  updateFinding(findingId, { title, body, suggestion, severity }) {
    const current = this.finding(findingId);
    if (!current) return null;
    this.run(
      'UPDATE cr_finding SET title = ?, body = ?, suggestion = ?, severity = ? WHERE id = ?',
      title ?? current.title,
      body ?? current.body,
      suggestion === undefined ? current.suggestion : nul(suggestion),
      severity ?? current.severity,
      findingId,
    );
    return this.finding(findingId);
  }

  /**
   * Someone else's comment, taken on as a finding. Idempotent on the comment:
   * adopting twice gives back the first one. `published_id` points at *their*
   * comment, so the fix's reply lands in the thread where it was asked.
   */
  adoptComment(repoId, prId, reviewId, comment) {
    const existing = this.get('SELECT * FROM cr_finding WHERE repo_id = ? AND pr_id = ? AND published_id = ? AND asked_by IS NOT NULL', repoId, prId, comment.commentId);
    if (existing) return findingRow(existing);
    const title = (String(comment.body).split('\n').find((line) => line.trim()) ?? 'Request').trim().slice(0, 120);
    const findingId = id();
    this.run(
      'INSERT INTO cr_finding (id, review_id, repo_id, pr_id, file_path, line_no, severity, title, body, published_id, created_at, asked_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      findingId,
      reviewId,
      repoId,
      prId,
      comment.inlinePath ?? '',
      comment.inlineLine ?? null,
      'major',
      title,
      comment.body,
      comment.commentId,
      now(),
      comment.author,
    );
    return this.finding(findingId);
  }

  // --- publications, comments, notes -----------------------------------------

  recordPublication(reviewId, repoId, prId, commentId, url, body) {
    this.run('INSERT INTO cr_publication (id, review_id, repo_id, pr_id, comment_id, url, body, published_at) VALUES (?,?,?,?,?,?,?,?)', id(), reviewId, repoId, prId, commentId, url, body, now());
  }

  publications(repoId, prId) {
    return this.all('SELECT * FROM cr_publication WHERE repo_id = ? AND pr_id = ? ORDER BY published_at', repoId, prId).map((row) => ({ id: row.id, reviewId: row.review_id, commentId: row.comment_id, url: row.url, body: row.body, publishedAt: row.published_at }));
  }

  comments(repoId, prId) {
    return this.all('SELECT * FROM cr_pr_comment WHERE repo_id = ? AND pr_id = ? ORDER BY created_on', repoId, prId).map(commentRow);
  }

  /** Every id we published by any of the four roads: the general comment, a finding, a reply, a fix's notice. */
  ourCommentIds(repoId, prId) {
    const ids = new Set();
    for (const row of this.all('SELECT comment_id FROM cr_publication WHERE repo_id = ? AND pr_id = ? AND comment_id IS NOT NULL', repoId, prId)) ids.add(row.comment_id);
    for (const row of this.all('SELECT published_id FROM cr_finding WHERE repo_id = ? AND pr_id = ? AND published_id IS NOT NULL AND asked_by IS NULL', repoId, prId)) ids.add(row.published_id);
    for (const row of this.all('SELECT published_id FROM cr_local_note WHERE repo_id = ? AND pr_id = ? AND published_id IS NOT NULL', repoId, prId)) ids.add(row.published_id);
    for (const row of this.all('SELECT published_id FROM cr_reply_draft WHERE repo_id = ? AND pr_id = ? AND published_id IS NOT NULL', repoId, prId)) ids.add(row.published_id);
    for (const row of this.fixReplyIds(repoId, prId)) ids.add(row);
    return ids;
  }

  syncComments(repoId, prId, fetched, ours) {
    this.transaction(() => {
      const stamp = now();
      for (const comment of fetched) {
        this.run(
          `INSERT INTO cr_pr_comment (id, repo_id, pr_id, comment_id, author, body, inline_path, inline_line, is_deleted, is_ours, created_on, synced_at, parent_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(repo_id, pr_id, comment_id) DO UPDATE SET author=excluded.author, body=excluded.body, inline_path=excluded.inline_path,
             inline_line=excluded.inline_line, is_deleted=excluded.is_deleted, is_ours=MAX(cr_pr_comment.is_ours, excluded.is_ours),
             created_on=excluded.created_on, synced_at=excluded.synced_at, parent_id=excluded.parent_id`,
          id(),
          repoId,
          prId,
          comment.commentId,
          comment.author,
          comment.body,
          comment.inlinePath ?? null,
          comment.inlineLine ?? null,
          bool(comment.deleted),
          bool(ours.has(comment.commentId)),
          comment.createdOn ?? '',
          stamp,
          comment.parentId ?? null,
        );
      }
    });
  }

  notes(repoId, prId) {
    return this.all('SELECT * FROM cr_local_note WHERE repo_id = ? AND pr_id = ? ORDER BY file_path, line_no', repoId, prId).map(noteRow);
  }

  addNote(repoId, prId, filePath, lineNo, body) {
    const noteId = id();
    this.run('INSERT INTO cr_local_note (id, repo_id, pr_id, file_path, line_no, body, created_at) VALUES (?,?,?,?,?,?,?)', noteId, repoId, prId, filePath, lineNo ?? null, body, now());
    return noteRow(this.get('SELECT * FROM cr_local_note WHERE id = ?', noteId));
  }

  note(noteId) {
    const row = this.get('SELECT * FROM cr_local_note WHERE id = ?', noteId);
    return row ? noteRow(row) : null;
  }

  updateNote(noteId, body) {
    this.run('UPDATE cr_local_note SET body = ? WHERE id = ? AND published_id IS NULL', body, noteId);
  }

  deleteNote(noteId) {
    this.run('DELETE FROM cr_local_note WHERE id = ? AND published_id IS NULL', noteId);
  }

  markNotePublished(noteId, publishedId, url) {
    this.run('UPDATE cr_local_note SET published_id = ?, published_url = ? WHERE id = ?', publishedId, url, noteId);
  }

  // --- reply drafts ----------------------------------------------------------

  replies(repoId, prId) {
    return this.all('SELECT * FROM cr_reply_draft WHERE repo_id = ? AND pr_id = ? ORDER BY created_at', repoId, prId).map(replyRow);
  }

  reply(replyId) {
    return replyRow(this.get('SELECT * FROM cr_reply_draft WHERE id = ?', replyId));
  }

  registerReply(repoId, prId, entry) {
    const result = this.run(
      `INSERT INTO cr_reply_draft (id, repo_id, pr_id, their_comment_id, their_author, their_body, our_comment_id, our_body, file_path, line_no, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repo_id, pr_id, their_comment_id) DO NOTHING`,
      id(),
      repoId,
      prId,
      entry.theirCommentId,
      entry.theirAuthor,
      entry.theirBody,
      entry.ourCommentId ?? null,
      entry.ourBody ?? null,
      entry.filePath ?? null,
      entry.lineNo ?? null,
      now(),
    );
    return Number(result.changes) > 0;
  }

  saveReplyDraft(replyId, body, costUsd) {
    this.run("UPDATE cr_reply_draft SET body = ?, status = 'DRAFTED', error = NULL, cost_usd = COALESCE(?, cost_usd) WHERE id = ?", body, costUsd ?? null, replyId);
  }

  failReply(replyId, message) {
    this.run("UPDATE cr_reply_draft SET status = 'FAILED', error = ? WHERE id = ?", String(message).slice(0, 1000), replyId);
  }

  markReplyPublished(replyId, publishedId, url) {
    this.run("UPDATE cr_reply_draft SET status = 'PUBLISHED', published_id = ?, published_url = ? WHERE id = ?", publishedId, url, replyId);
  }

  dismissReply(replyId, dismissed) {
    this.run('UPDATE cr_reply_draft SET dismissed_at = ? WHERE id = ?', dismissed ? now() : null, replyId);
  }

  /** Replies registered against comments that turned out to be ours — a fix's own notice — are closed. */
  dismissRepliesTo(repoId, prId, commentIds) {
    for (const commentId of commentIds) {
      this.run('UPDATE cr_reply_draft SET dismissed_at = COALESCE(dismissed_at, ?) WHERE repo_id = ? AND pr_id = ? AND their_comment_id = ?', now(), repoId, prId, commentId);
    }
  }

  pendingReplies() {
    return this.all("SELECT * FROM cr_reply_draft WHERE status IN ('PENDING','FAILED') AND dismissed_at IS NULL ORDER BY created_at").map(replyRow);
  }

  // --- fixes -------------------------------------------------------------------

  fix(fixId) {
    return fixRow(this.get('SELECT * FROM cr_finding_fix WHERE id = ?', fixId));
  }

  fixesForPr(repoId, prId) {
    return this.all('SELECT * FROM cr_finding_fix WHERE repo_id = ? AND pr_id = ? ORDER BY created_at DESC', repoId, prId).map(fixRow);
  }

  startFix({ findingId, reviewId, repoId, prId, branch, workspace }) {
    const fixId = id();
    this.run("INSERT INTO cr_finding_fix (id, finding_id, review_id, repo_id, pr_id, branch, state, workspace, created_at) VALUES (?,?,?,?,?,?,'RUNNING',?,?)", fixId, findingId, reviewId, repoId, prId, branch, workspace, now());
    return fixId;
  }

  fixCommitted(fixId, sha, summary, sessionId, costUsd) {
    this.run("UPDATE cr_finding_fix SET state = 'COMMITTED', sha = ?, summary = ?, session_id = ?, cost_usd = ?, finished_at = ? WHERE id = ?", sha, summary, sessionId ?? null, costUsd ?? 0, now(), fixId);
  }

  fixNothing(fixId, reason, sessionId, costUsd) {
    this.run("UPDATE cr_finding_fix SET state = 'NOTHING', summary = ?, session_id = ?, cost_usd = ?, finished_at = ? WHERE id = ?", reason, sessionId ?? null, costUsd ?? 0, now(), fixId);
  }

  fixFailed(fixId, message, sessionId, costUsd) {
    this.run("UPDATE cr_finding_fix SET state = 'FAILED', error = ?, session_id = COALESCE(?, session_id), cost_usd = COALESCE(?, cost_usd), finished_at = ? WHERE id = ?", String(message).slice(0, 2000), sessionId ?? null, costUsd ?? null, now(), fixId);
  }

  fixReplied(fixId, replyId, url) {
    this.run('UPDATE cr_finding_fix SET reply_id = ?, reply_url = ?, reply_error = NULL WHERE id = ?', replyId, url, fixId);
  }

  fixReplyFailed(fixId, message) {
    this.run('UPDATE cr_finding_fix SET reply_error = ? WHERE id = ?', String(message).slice(0, 1000), fixId);
  }

  pendingReturn(repoId, prId) {
    return this.all("SELECT * FROM cr_finding_fix WHERE repo_id = ? AND pr_id = ? AND state = 'COMMITTED' AND returned_at IS NULL", repoId, prId).map(fixRow);
  }

  markReturned(repoId, prId) {
    this.run("UPDATE cr_finding_fix SET returned_at = ? WHERE repo_id = ? AND pr_id = ? AND state = 'COMMITTED' AND returned_at IS NULL", now(), repoId, prId);
  }

  fixReplyIds(repoId, prId) {
    return this.all('SELECT reply_id FROM cr_finding_fix WHERE repo_id = ? AND pr_id = ? AND reply_id IS NOT NULL', repoId, prId).map((row) => row.reply_id);
  }

  /** Fixes that were running when the app went away never finish; they are failed so they can be retried. */
  orphanedFixes() {
    return Number(this.run("UPDATE cr_finding_fix SET state = 'FAILED', error = 'Smart Terminal closed while this fix was running.', finished_at = ? WHERE state = 'RUNNING'", now()).changes);
  }

  // --- guidelines --------------------------------------------------------------

  guidelines(repoId) {
    return this.all('SELECT * FROM cr_guideline WHERE repo_id IS ? ORDER BY created_at', repoId ?? null).map(guidelineRow);
  }

  /** Global first, then the repository's: the last read wins, so a repository can overrule the general rule. */
  guidelinesForReview(repoId) {
    return [...this.guidelines(null), ...this.guidelines(repoId)].filter((doc) => doc.enabled && doc.content.trim());
  }

  saveGuideline({ id: guidelineId, repoId, name, content, enabled = true, source = 'TYPED', linkedPath = null, linkedHash = null }) {
    if (guidelineId && this.get('SELECT 1 FROM cr_guideline WHERE id = ?', guidelineId)) {
      this.run('UPDATE cr_guideline SET name = ?, content = ?, enabled = ?, source = ?, linked_path = ?, linked_hash = ? WHERE id = ?', name, content, bool(enabled), source, linkedPath, linkedHash, guidelineId);
      return guidelineId;
    }
    const newId = guidelineId || id();
    this.run('INSERT INTO cr_guideline (id, repo_id, name, content, enabled, source, created_at, linked_path, linked_hash) VALUES (?,?,?,?,?,?,?,?,?)', newId, repoId ?? null, name, content, bool(enabled), source, now(), linkedPath, linkedHash);
    return newId;
  }

  deleteGuideline(guidelineId) {
    this.run('DELETE FROM cr_guideline WHERE id = ?', guidelineId);
  }

  // --- usage -----------------------------------------------------------------------

  recordUsage(entry) {
    this.run(
      'INSERT INTO cr_cli_usage (id, at, kind, model, session_id, ok, seconds, tokens_in, tokens_out, cache_read, cache_write, cost_usd, account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id(),
      entry.at ?? now(),
      entry.kind ?? 'other',
      entry.model ?? null,
      entry.sessionId ?? null,
      bool(entry.ok),
      entry.seconds ?? 0,
      entry.tokensIn ?? 0,
      entry.tokensOut ?? 0,
      entry.cacheRead ?? 0,
      entry.cacheWrite ?? 0,
      entry.costUsd ?? 0,
      entry.accountId ?? null,
    );
  }

  /** The last five hours and the last seven days, by kind. "Billable" is input plus output; cache is shown apart. */
  usageSummary(at = Date.now()) {
    const windows = { fiveHours: new Date(at - 5 * 3600 * 1000).toISOString(), week: new Date(at - 7 * 86400 * 1000).toISOString() };
    const out = {};
    for (const [name, since] of Object.entries(windows)) {
      const rows = this.all(
        'SELECT kind, COUNT(*) AS runs, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(cache_read) AS cr, SUM(cache_write) AS cw, SUM(cost_usd) AS cost FROM cr_cli_usage WHERE at >= ? GROUP BY kind',
        since,
      );
      out[name] = rows.map((row) => ({ kind: row.kind, runs: row.runs, billable: (row.tin ?? 0) + (row.tout ?? 0), cache: (row.cr ?? 0) + (row.cw ?? 0), costUsd: row.cost ?? 0 }));
    }
    return out;
  }

  // --- what the board and the lists need, in few queries -----------------------------

  /**
   * Everything a list of PRs shows without loading each PR: per PR, the latest
   * finished review's head, finding counts, unresolved published ones, pending
   * replies, stances. One pass over a handful of grouped queries.
   */
  boardFacts(repoId = null) {
    const where = repoId ? 'WHERE repo_id = ?' : '';
    const params = repoId ? [repoId] : [];
    const key = (row) => `${row.repo_id}#${row.pr_id}`;
    const facts = new Map();
    const factFor = (row) => {
      const k = key(row);
      if (!facts.has(k)) facts.set(k, { reviewedSha: null, reviewId: null, reviewCost: 0, reviewAt: null, lastStatus: null, findingCount: 0, publishedCount: 0, toPublish: false, unresolved: 0, replied: false, approved: false, changesRequested: false, approvedByUs: false, changesRequestedByUs: false, pendingFindings: 0, pendingNotes: 0, pendingReplies: 0, notVerified: 0, notResolved: 0, publishedLive: 0, finalPassHead: null, finalPassBlockers: 0, totalCost: 0, pendingReturn: 0 });
      return facts.get(k);
    };
    for (const row of this.all(`SELECT repo_id, pr_id, SUM(cost_usd) AS cost, MAX(created_at) AS at FROM cr_review ${where} GROUP BY repo_id, pr_id`, ...params)) {
      const fact = factFor(row);
      fact.totalCost = row.cost ?? 0;
    }
    const latestDone = this.all(
      `SELECT r.* FROM cr_review r JOIN (SELECT repo_id, pr_id, MAX(created_at) AS at FROM cr_review WHERE status = 'DONE' ${repoId ? 'AND repo_id = ?' : ''} GROUP BY repo_id, pr_id) m
         ON m.repo_id = r.repo_id AND m.pr_id = r.pr_id AND m.at = r.created_at WHERE r.status = 'DONE'`,
      ...params,
    );
    const reviewIds = [];
    for (const row of latestDone) {
      const fact = factFor(row);
      fact.reviewedSha = row.head_sha;
      fact.reviewId = row.id;
      fact.reviewAt = row.created_at;
      fact.reviewCost = row.cost_usd ?? 0;
      fact.finalPassHead = row.final_pass_head;
      fact.finalPassBlockers = row.final_pass_blockers ?? 0;
      reviewIds.push(row.id);
    }
    const latestAny = this.all(
      `SELECT r.repo_id, r.pr_id, r.status FROM cr_review r JOIN (SELECT repo_id, pr_id, MAX(created_at) AS at FROM cr_review ${where} GROUP BY repo_id, pr_id) m
         ON m.repo_id = r.repo_id AND m.pr_id = r.pr_id AND m.at = r.created_at`,
      ...params,
    );
    for (const row of latestAny) factFor(row).lastStatus = row.status;
    if (reviewIds.length) {
      const doneSet = new Set(reviewIds);
      for (const row of this.all(`SELECT * FROM cr_finding ${where}`, ...params)) {
        const fact = factFor(row);
        const finding = findingRow(row);
        if (!doneSet.has(row.review_id)) continue;
        if (finding.askedBy) continue;
        fact.findingCount++;
        if (finding.publishedId) fact.publishedCount++;
        if (!rules.settled(finding)) {
          fact.pendingFindings++;
          fact.toPublish = true;
        }
        const live = finding.publishedId && !finding.dismissedAt && !finding.closedAt;
        if (live) {
          fact.publishedLive++;
          if (!finding.resolution) fact.notVerified++;
          else if (!rules.resolutionClosed(finding.resolution)) fact.notResolved++;
          if (!rules.resolutionClosed(finding.resolution)) fact.unresolved++;
        }
      }
    }
    for (const row of this.all(`SELECT repo_id, pr_id, COUNT(*) AS n FROM cr_local_note ${repoId ? 'WHERE repo_id = ? AND' : 'WHERE'} published_id IS NULL GROUP BY repo_id, pr_id`, ...params)) {
      factFor(row).pendingNotes = row.n;
    }
    for (const row of this.all(`SELECT repo_id, pr_id, COUNT(*) AS n FROM cr_reply_draft ${repoId ? 'WHERE repo_id = ? AND' : 'WHERE'} status <> 'PUBLISHED' AND dismissed_at IS NULL GROUP BY repo_id, pr_id`, ...params)) {
      const fact = factFor(row);
      fact.pendingReplies = row.n;
      fact.replied = row.n > 0;
    }
    for (const row of this.all(`SELECT * FROM cr_pr_approval ${where}`, ...params)) {
      const fact = factFor(row);
      if (row.state === 'APPROVED') {
        fact.approved = true;
        if (row.by_us) fact.approvedByUs = true;
      }
      if (row.state === 'CHANGES_REQUESTED') {
        fact.changesRequested = true;
        if (row.by_us) fact.changesRequestedByUs = true;
      }
    }
    for (const row of this.all(`SELECT repo_id, pr_id, COUNT(*) AS n FROM cr_finding_fix ${repoId ? 'WHERE repo_id = ? AND' : 'WHERE'} state = 'COMMITTED' AND returned_at IS NULL GROUP BY repo_id, pr_id`, ...params)) {
      factFor(row).pendingReturn = row.n;
    }
    return facts;
  }

  recentActivity(limit = 30) {
    const reviews = this.all('SELECT r.id, r.repo_id, r.pr_id, r.pr_title, r.status, r.created_at, r.finished_at, r.cost_usd, r.trigger_kind, p.name AS repo_name FROM cr_review r JOIN cr_repo p ON p.id = r.repo_id ORDER BY r.created_at DESC LIMIT ?', limit);
    return reviews.map((row) => ({ kind: 'review', repoId: row.repo_id, repoName: row.repo_name, prId: Number(row.pr_id), title: row.pr_title, status: row.status, at: row.finished_at ?? row.created_at, costUsd: row.cost_usd, trigger: row.trigger_kind }));
  }
}

module.exports = { ReviewStore, MIGRATIONS, repoRow, reviewRow, findingRow, commentRow, replyRow, prRow, fixRow };
