'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { app } = require('electron');
const { worthSampling, normsFrom } = require('./history');

/**
 * Durable record of every session this app has ever run.
 *
 * The conversation itself stays where Claude Code writes it — a JSONL file — and
 * this database indexes it. That keeps the file small and avoids duplicating
 * megabytes, while still answering the questions a file tree cannot: when did this
 * session run, how long for, which account paid for it, where did it move to, and
 * which of the ones I closed can I pick back up.
 *
 * A session can opt in to having its transcript text stored here as well, which is
 * what makes searching *inside* past conversations possible.
 */
function parseTasks(raw) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function parseFindings(raw) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

class Database {
  constructor(file = path.join(app.getPath('userData'), 'smart-terminal.db')) {
    this.file = file;
    this.db = new DatabaseSync(file);
    // WAL means an abrupt exit loses at most the last transaction, not the file.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                TEXT PRIMARY KEY,
        profile_id        TEXT NOT NULL,
        profile_name      TEXT,
        claude_session_id TEXT,
        kind              TEXT NOT NULL,
        title             TEXT,
        start_cwd         TEXT NOT NULL,
        last_cwd          TEXT,
        started_at        INTEGER NOT NULL,
        ended_at          INTEGER,
        last_active_at    INTEGER,
        exit_code         INTEGER,
        resumed_from      TEXT,
        window_id         TEXT,
        group_id          TEXT,
        store_transcript  INTEGER NOT NULL DEFAULT 0,
        transcript_bytes  INTEGER
      );
      CREATE INDEX IF NOT EXISTS sessions_started  ON sessions (started_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_profile  ON sessions (profile_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_open     ON sessions (ended_at);

      CREATE TABLE IF NOT EXISTS extensions (
        id           TEXT PRIMARY KEY,
        name         TEXT,
        version      TEXT NOT NULL,
        installed_at INTEGER NOT NULL,
        updated_at   INTEGER,
        enabled      INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS session_compactions (
        session_id      TEXT NOT NULL,
        at              INTEGER NOT NULL,
        conversation_id TEXT,
        trigger         TEXT,
        pre_tokens      INTEGER NOT NULL DEFAULT 0,
        post_tokens     INTEGER NOT NULL DEFAULT 0,
        dropped_tokens  INTEGER NOT NULL DEFAULT 0,
        duration_ms     INTEGER NOT NULL DEFAULT 0,
        context_before  INTEGER NOT NULL DEFAULT 0,
        requests_before INTEGER NOT NULL DEFAULT 0,
        title           TEXT,
        last_prompt     TEXT,
        open_tasks      TEXT,
        PRIMARY KEY (session_id, at)
      );
      CREATE INDEX IF NOT EXISTS session_compactions_session ON session_compactions (session_id, at DESC);

      CREATE TABLE IF NOT EXISTS session_history (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      TEXT NOT NULL,
        conversation_id TEXT,
        at              INTEGER NOT NULL,
        requests        INTEGER NOT NULL DEFAULT 0,
        context_last    INTEGER NOT NULL DEFAULT 0,
        context_window  INTEGER NOT NULL DEFAULT 0,
        context_peak    INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0,
        effective_input INTEGER NOT NULL DEFAULT 0,
        compactions     INTEGER NOT NULL DEFAULT 0,
        auto_compactions INTEGER NOT NULL DEFAULT 0,
        latency_p50     INTEGER NOT NULL DEFAULT 0,
        latency_p95     INTEGER NOT NULL DEFAULT 0,
        errors          INTEGER NOT NULL DEFAULT 0,
        worst           TEXT
      );
      CREATE INDEX IF NOT EXISTS session_history_session ON session_history (session_id, at DESC);
      CREATE INDEX IF NOT EXISTS session_history_at ON session_history (at DESC);

      CREATE TABLE IF NOT EXISTS session_briefs (
        session_id  TEXT PRIMARY KEY,
        at          INTEGER NOT NULL,
        title       TEXT,
        last_prompt TEXT,
        cwd         TEXT,
        branch      TEXT,
        turns       INTEGER NOT NULL DEFAULT 0,
        open_tasks  TEXT,
        done_tasks  TEXT
      );

      CREATE TABLE IF NOT EXISTS session_stats (
        session_id      TEXT PRIMARY KEY,
        measured_at     INTEGER NOT NULL,
        requests        INTEGER NOT NULL DEFAULT 0,
        span_ms         INTEGER NOT NULL DEFAULT 0,
        context_window  INTEGER NOT NULL DEFAULT 0,
        context_peak    INTEGER NOT NULL DEFAULT 0,
        context_last    INTEGER NOT NULL DEFAULT 0,
        context_mean    INTEGER NOT NULL DEFAULT 0,
        turns_above     INTEGER NOT NULL DEFAULT 0,
        input_tokens    INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0,
        cache_write     INTEGER NOT NULL DEFAULT 0,
        cache_read      INTEGER NOT NULL DEFAULT 0,
        effective_input INTEGER NOT NULL DEFAULT 0,
        compactions     INTEGER NOT NULL DEFAULT 0,
        auto_compactions INTEGER NOT NULL DEFAULT 0,
        dropped_tokens  INTEGER NOT NULL DEFAULT 0,
        reprimed_tokens INTEGER NOT NULL DEFAULT 0,
        latency_p50     INTEGER NOT NULL DEFAULT 0,
        latency_p95     INTEGER NOT NULL DEFAULT 0,
        errors          INTEGER NOT NULL DEFAULT 0,
        worst           TEXT,
        findings        TEXT
      );
      CREATE INDEX IF NOT EXISTS session_stats_measured ON session_stats (measured_at DESC);

      CREATE TABLE IF NOT EXISTS groups (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        color       TEXT,
        font_size   INTEGER,
        arrangement TEXT,
        window_id   TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        at                INTEGER NOT NULL,
        reason            TEXT NOT NULL,
        claude_session_id TEXT,
        from_session_id   TEXT,
        to_session_id     TEXT,
        from_profile_id   TEXT,
        from_profile_name TEXT,
        to_profile_id     TEXT,
        to_profile_name   TEXT
      );
      CREATE INDEX IF NOT EXISTS handoffs_at ON handoffs (at DESC);

      CREATE TABLE IF NOT EXISTS transcript_chunks (
        id         INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        at         INTEGER,
        role       TEXT,
        text       TEXT,
        UNIQUE (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS chunks_session ON transcript_chunks (session_id, seq);

      CREATE TABLE IF NOT EXISTS session_messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        from_session  TEXT NOT NULL,
        to_session    TEXT NOT NULL,
        from_name     TEXT,
        body          TEXT NOT NULL,
        at            INTEGER NOT NULL,
        delivered_at  INTEGER,
        read_at       INTEGER
      );
      CREATE INDEX IF NOT EXISTS session_messages_to ON session_messages (to_session);

      CREATE TABLE IF NOT EXISTS windows (
        id          TEXT PRIMARY KEY,
        layout      TEXT,
        settings    TEXT,
        active_leaf TEXT,
        bounds      TEXT,
        groups      TEXT,
        minimized   TEXT,
        opened_at   INTEGER NOT NULL,
        closed_at   INTEGER,
        updated_at  INTEGER
      );
    `);
    this.#addSessionColumns();
    this.#migrateSingleWindow();
    this.#migrateChunkTable();
    this.#migrateSearchIndex();
  }

  /** Columns added after the first release; ALTER is the cheap path. */
  #addSessionColumns() {
    const present = new Set(
      this.db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name),
    );
    if (!present.has('window_id')) this.db.exec('ALTER TABLE sessions ADD COLUMN window_id TEXT');
    if (!present.has('group_id')) this.db.exec('ALTER TABLE sessions ADD COLUMN group_id TEXT');
    /*
     * What this session was running, and whether it should be started again.
     * Two columns because they answer different questions: the command is a
     * fact about the session, and bringing it back is a decision about it.
     */
    if (!present.has('last_command')) this.db.exec('ALTER TABLE sessions ADD COLUMN last_command TEXT');
    if (!present.has('resume_command')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN resume_command INTEGER DEFAULT 0');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS sessions_group ON sessions (group_id)');

    const windowColumns = new Set(
      this.db.prepare('PRAGMA table_info(windows)').all().map((column) => column.name),
    );
    if (windowColumns.size && !windowColumns.has('groups')) {
      this.db.exec('ALTER TABLE windows ADD COLUMN groups TEXT');
    }

    // The tabs a window set aside. They are not in its layout — that is the point
    // of minimizing — so without a column of their own they would be lost on the
    // next launch, which is the one failure this whole area exists to prevent.
    if (windowColumns.size && !windowColumns.has('minimized')) {
      this.db.exec('ALTER TABLE windows ADD COLUMN minimized TEXT');
    }

    // How a group was laid out, so closing it and bringing it back is not the same
    // as bringing back a pile of tabs that happen to share a name.
    const groupColumns = new Set(
      this.db.prepare('PRAGMA table_info(groups)').all().map((column) => column.name),
    );
    if (groupColumns.size && !groupColumns.has('arrangement')) {
      this.db.exec('ALTER TABLE groups ADD COLUMN arrangement TEXT');
    }
  }

  /**
   * The app used to have exactly one window, so its workspace lived in a single
   * row. That row becomes the first window, keeping the layout someone left open.
   */
  #migrateSingleWindow() {
    const legacy = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace'")
      .get();
    if (!legacy) return;

    const row = this.db.prepare('SELECT * FROM workspace WHERE id = 1').get();
    if (row) {
      const already = this.db.prepare('SELECT COUNT(*) AS n FROM windows').get().n;
      if (!already) {
        this.db
          .prepare(
            `INSERT INTO windows (id, layout, settings, active_leaf, opened_at, updated_at)
             VALUES ('main', ?, ?, ?, ?, ?)`,
          )
          .run(row.layout, row.settings, row.active_leaf, Date.now(), Date.now());
        this.db.prepare("UPDATE sessions SET window_id = 'main' WHERE window_id IS NULL").run();
      }
    }
    this.db.exec('DROP TABLE workspace');
  }

  /**
   * The first version of this table had no rowid alias, which an external-content
   * search index needs to point at. `CREATE TABLE IF NOT EXISTS` cannot change a
   * table that already exists, so an old one is rebuilt in place, keeping its rows.
   */
  #migrateChunkTable() {
    const columns = this.db.prepare('PRAGMA table_info(transcript_chunks)').all();
    if (columns.some((column) => column.name === 'id')) return;

    this.db.exec(`
      DROP TRIGGER IF EXISTS chunks_after_insert;
      DROP TRIGGER IF EXISTS chunks_after_delete;
      DROP TRIGGER IF EXISTS chunks_after_update;
      DROP TABLE IF EXISTS transcript_fts;

      ALTER TABLE transcript_chunks RENAME TO transcript_chunks_old;
      CREATE TABLE transcript_chunks (
        id         INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        at         INTEGER,
        role       TEXT,
        text       TEXT,
        UNIQUE (session_id, seq)
      );
      INSERT INTO transcript_chunks (session_id, seq, at, role, text)
        SELECT session_id, seq, at, role, text FROM transcript_chunks_old;
      DROP TABLE transcript_chunks_old;
      CREATE INDEX IF NOT EXISTS chunks_session ON transcript_chunks (session_id, seq);
      PRAGMA user_version = 1;
    `);
  }

  /**
   * The search index stores no text of its own: it points at `transcript_chunks`.
   *
   * The first shape kept a second copy of every message, which doubled what the
   * conversations cost on disk, and deleting one session's rows meant scanning the
   * whole index because FTS5 cannot index an UNINDEXED column. With external
   * content the text is stored once and triggers keep the two in step, so removing
   * a session is an indexed delete.
   */
  #migrateSearchIndex() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version >= 2) return;

    this.db.exec(`
      DROP TRIGGER IF EXISTS chunks_after_insert;
      DROP TRIGGER IF EXISTS chunks_after_delete;
      DROP TRIGGER IF EXISTS chunks_after_update;
      DROP TABLE IF EXISTS transcript_fts;

      CREATE VIRTUAL TABLE transcript_fts USING fts5(
        text,
        content = 'transcript_chunks',
        content_rowid = 'id',
        tokenize = 'porter'
      );

      CREATE TRIGGER chunks_after_insert AFTER INSERT ON transcript_chunks BEGIN
        INSERT INTO transcript_fts (rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER chunks_after_delete AFTER DELETE ON transcript_chunks BEGIN
        INSERT INTO transcript_fts (transcript_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER chunks_after_update AFTER UPDATE ON transcript_chunks BEGIN
        INSERT INTO transcript_fts (transcript_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO transcript_fts (rowid, text) VALUES (new.id, new.text);
      END;

      INSERT INTO transcript_fts (rowid, text) SELECT id, text FROM transcript_chunks;
      PRAGMA user_version = 2;
    `);
  }

  // --- sessions ------------------------------------------------------------

  /** Record a session as it starts. Re-running is harmless: the row is upserted. */
  openSession(session) {
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, profile_id, profile_name, claude_session_id, kind, title,
            start_cwd, last_cwd, started_at, last_active_at, resumed_from, window_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           profile_id        = excluded.profile_id,
           profile_name      = excluded.profile_name,
           claude_session_id = excluded.claude_session_id,
           last_active_at    = excluded.last_active_at,
           window_id         = COALESCE(excluded.window_id, sessions.window_id),
           ended_at          = NULL,
           exit_code         = NULL`,
      )
      .run(
        session.id,
        session.profileId,
        session.profileName ?? null,
        session.claudeSessionId ?? null,
        session.kind,
        session.title ?? null,
        session.startCwd,
        session.lastCwd ?? session.startCwd,
        session.startedAt ?? Date.now(),
        Date.now(),
        session.resumedFrom ?? null,
        session.windowId ?? null,
      );
  }

  updateSession(id, patch = {}) {
    const columns = {
      title: 'title',
      lastCwd: 'last_cwd',
      claudeSessionId: 'claude_session_id',
      profileId: 'profile_id',
      profileName: 'profile_name',
      storeTranscript: 'store_transcript',
      transcriptBytes: 'transcript_bytes',
      windowId: 'window_id',
      groupId: 'group_id',
      lastCommand: 'last_command',
      resumeCommand: 'resume_command',
    };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof patch[key] === 'boolean' ? Number(patch[key]) : patch[key]);
    }
    sets.push('last_active_at = ?');
    values.push(Date.now(), id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /** Mark a session finished. The row and its saved conversation are kept. */
  endSession(id, exitCode = null) {
    this.db
      .prepare('UPDATE sessions SET ended_at = ?, exit_code = ?, last_active_at = ? WHERE id = ? AND ended_at IS NULL')
      .run(Date.now(), exitCode, Date.now(), id);
  }

  /** Anything still marked open at startup died with the previous run. */
  closeStaleSessions() {
    const stale = this.db
      .prepare('SELECT id FROM sessions WHERE ended_at IS NULL')
      .all()
      .map((row) => row.id);
    if (stale.length) {
      this.db
        .prepare('UPDATE sessions SET ended_at = COALESCE(last_active_at, started_at) WHERE ended_at IS NULL')
        .run();
    }
    return stale;
  }

  getSession(id) {
    return decorate(this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
  }

  /**
   * History, newest first. `query` matches the name, folder or account; when
   * transcript search is on it also matches what was said inside stored sessions.
   */
  /**
   * The rows a window needs to come back: the sessions its layout names, plus
   * anything still filed under it. Asked for by id and uncapped on purpose —
   * `listSessions` hands back a page of recent history, and once history is
   * longer than that page an older session simply stops being offered, which the
   * renderer reads as "that pane is gone".
   */
  sessionsForRestore(ids = [], windowId = null) {
    const clauses = [];
    const values = [];
    if (ids.length) {
      clauses.push(`id IN (${ids.map(() => '?').join(',')})`);
      values.push(...ids);
    }
    if (windowId) {
      clauses.push('window_id = ?');
      values.push(windowId);
    }
    if (!clauses.length) return [];
    return this.db
      .prepare(`SELECT * FROM sessions WHERE ${clauses.join(' OR ')} ORDER BY started_at`)
      .all(...values)
      .map(decorate);
  }

  // --- extensions ------------------------------------------------------------

  /** What the person has decided about each extension. */
  installedExtensions() {
    return this.db
      .prepare('SELECT * FROM extensions ORDER BY id')
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        version: row.version,
        installedAt: row.installed_at,
        updatedAt: row.updated_at,
        enabled: row.enabled !== 0,
      }));
  }

  /** Install one, or move an installed one to a new version. */
  installExtension({ id, name, version }) {
    const at = Date.now();
    this.db
      .prepare(
        `INSERT INTO extensions (id, name, version, installed_at, updated_at, enabled)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(id, name ?? id, version, at, at);
  }

  removeExtension(id) {
    this.db.prepare('DELETE FROM extensions WHERE id = ?').run(id);
  }

  /** On without removing: the record of the decision stays either way. */
  enableExtension(id, on) {
    this.db.prepare('UPDATE extensions SET enabled = ? WHERE id = ?').run(on ? 1 : 0, id);
  }

  /**
   * The first run, and only the first.
   *
   * Everything that shipped with the app starts installed, because it was
   * working yesterday and an upgrade that quietly switches features off is an
   * upgrade that broke them. After that the table is the record of decisions,
   * and something new arriving in a later version is an offer rather than a
   * change made on somebody's behalf.
   */
  seedExtensions(builtIns) {
    const already = this.db.prepare('SELECT COUNT(*) AS n FROM extensions').get().n ?? 0;
    if (already > 0) return false;
    for (const manifest of builtIns) this.installExtension(manifest);
    return true;
  }

  /**
   * A session by any of the addresses the app hands out: its own id, the
   * conversation behind it, or its name — whether or not it is still running.
   *
   * The last part is the point. A session that has ended is not a session that
   * never existed, and telling those two apart is the difference between "that
   * is gone, open it again" and "there is no such thing", which sends whoever
   * asked round in circles.
   */
  findSession(query) {
    const wanted = String(query ?? '').trim();
    if (!wanted) return null;
    const row =
      this.db.prepare('SELECT * FROM sessions WHERE id = ? OR claude_session_id = ?').get(wanted, wanted) ??
      this.db
        .prepare('SELECT * FROM sessions WHERE LOWER(title) = LOWER(?) ORDER BY started_at DESC LIMIT 1')
        .get(wanted);
    return row ? decorate(row) : null;
  }

  listSessions({ query = '', profileId = null, includeOpen = true, limit = 200 } = {}) {
    const where = [];
    const values = [];

    if (!includeOpen) where.push('s.ended_at IS NOT NULL');
    if (profileId) {
      where.push('s.profile_id = ?');
      values.push(profileId);
    }

    let matchedIds = null;
    if (query.trim()) {
      const like = `%${query.trim()}%`;
      matchedIds = this.#searchTranscriptIds(query.trim());
      const clause = ['s.title LIKE ?', 's.start_cwd LIKE ?', 's.last_cwd LIKE ?', 's.profile_name LIKE ?'];
      values.push(like, like, like, like);
      if (matchedIds.length) {
        clause.push(`s.id IN (${matchedIds.map(() => '?').join(',')})`);
        values.push(...matchedIds);
      }
      where.push(`(${clause.join(' OR ')})`);
    }

    const rows = this.db
      .prepare(
        `SELECT s.* FROM sessions s
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY s.started_at DESC LIMIT ?`,
      )
      .all(...values, limit);

    const matched = new Set(matchedIds ?? []);
    return rows.map((row) => ({ ...decorate(row), matchedTranscript: matched.has(row.id) }));
  }

  #searchTranscriptIds(query) {
    try {
      return this.db
        .prepare(
          `SELECT DISTINCT c.session_id
           FROM transcript_fts f
           JOIN transcript_chunks c ON c.id = f.rowid
           WHERE f.transcript_fts MATCH ? LIMIT 400`,
        )
        .all(ftsQuery(query))
        .map((row) => row.session_id);
    } catch {
      return []; // a query FTS cannot parse just means no transcript hits
    }
  }

  /** Passages inside a stored conversation that match, for the history panel. */
  searchInSession(sessionId, query, limit = 5) {
    try {
      return this.db
        .prepare(
          `SELECT snippet(transcript_fts, 0, '[', ']', '…', 12) AS excerpt
           FROM transcript_fts f
           JOIN transcript_chunks c ON c.id = f.rowid
           WHERE f.transcript_fts MATCH ? AND c.session_id = ? LIMIT ?`,
        )
        .all(ftsQuery(query), sessionId, limit)
        .map((row) => row.excerpt);
    } catch {
      return [];
    }
  }

  // --- opt-in transcript storage -------------------------------------------

  /**
   * Store a session's conversation text so it can be searched later. Only rows
   * past what was already ingested are read, so this stays cheap as it grows.
   */
  ingestTranscript(sessionId, lines) {
    const start =
      this.db.prepare('SELECT COALESCE(MAX(seq), -1) AS seq FROM transcript_chunks WHERE session_id = ?').get(sessionId)
        .seq + 1;
    if (start >= lines.length) return 0;

    // The trigger mirrors each row into the search index, so this writes once.
    const insertChunk = this.db.prepare(
      'INSERT OR REPLACE INTO transcript_chunks (session_id, seq, at, role, text) VALUES (?, ?, ?, ?, ?)',
    );

    this.db.exec('BEGIN');
    try {
      for (let seq = start; seq < lines.length; seq += 1) {
        const entry = lines[seq];
        if (!entry) continue;
        insertChunk.run(sessionId, seq, entry.at ?? null, entry.role ?? null, entry.text);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.#refreshSize(sessionId);
    return lines.length - start;
  }

  /** The stored conversation, in order, for reading a past session back. */
  readTranscript(sessionId, limit = 2000) {
    return this.db
      .prepare('SELECT seq, at, role, text FROM transcript_chunks WHERE session_id = ? ORDER BY seq LIMIT ?')
      .all(sessionId, limit);
  }

  /**
   * Keep each session's size on its own row. Working it out on demand would mean
   * aggregating the transcript table every time the history is listed; maintaining
   * it here costs one indexed sum per ingest and makes the listing free.
   */
  #refreshSize(sessionId) {
    this.db
      .prepare(
        `UPDATE sessions
         SET transcript_bytes = (
           SELECT COALESCE(SUM(LENGTH(text)), 0) FROM transcript_chunks WHERE session_id = ?
         )
         WHERE id = ?`,
      )
      .run(sessionId, sessionId);
  }

  forgetTranscript(sessionId) {
    // Indexed by (session_id, seq); the trigger clears the search index with it.
    this.db.prepare('DELETE FROM transcript_chunks WHERE session_id = ?').run(sessionId);
    this.db
      .prepare('UPDATE sessions SET store_transcript = 0, transcript_bytes = 0 WHERE id = ?')
      .run(sessionId);
  }

  /** How much room the kept conversations take, for the warning to be concrete. */
  storageStats() {
    const chunks = this.db
      .prepare(
        `SELECT COUNT(*) AS entries,
                COALESCE(SUM(LENGTH(text)), 0) AS textBytes,
                COUNT(DISTINCT session_id) AS sessions,
                COALESCE(SUM(CASE WHEN role IN ('tool','result') THEN LENGTH(text) ELSE 0 END), 0) AS commandBytes
         FROM transcript_chunks`,
      )
      .get();
    const recording = this.db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE store_transcript = 1')
      .get().n;
    return { ...chunks, recording };
  }

  /** Drop every stored conversation, keeping the session index itself. */
  forgetAllTranscripts() {
    const { entries } = this.storageStats();
    this.db.exec('DELETE FROM transcript_chunks;');
    this.db.prepare('UPDATE sessions SET store_transcript = 0, transcript_bytes = 0').run();
    this.reclaim();
    return entries;
  }

  // --- handoffs ------------------------------------------------------------

  recordHandoff(entry) {
    this.db
      .prepare(
        `INSERT INTO handoffs
           (at, reason, claude_session_id, from_session_id, to_session_id,
            from_profile_id, from_profile_name, to_profile_id, to_profile_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        entry.reason ?? 'manual',
        entry.claudeSessionId ?? null,
        entry.fromSessionId ?? null,
        entry.toSessionId ?? null,
        entry.fromProfileId ?? null,
        entry.fromProfileName ?? null,
        entry.toProfileId ?? null,
        entry.toProfileName ?? null,
      );
  }

  listHandoffs(limit = 100) {
    return this.db.prepare('SELECT * FROM handoffs ORDER BY at DESC LIMIT ?').all(limit);
  }

  // --- how a session is behaving ---------------------------------------------

  /**
   * Keep the headline figures of one analysis.
   *
   * The transcript it was read from is the truth and stays on disk, so this is a
   * cache, not a record — one row per session, overwritten each time. What it
   * buys is comparison: a number is only alarming next to the others, and the
   * transcripts of finished sessions get archived or deleted while this does not.
   */
  saveStats(sessionId, verdict) {
    const auto = verdict.compactions.filter((c) => c.trigger === 'auto');
    this.db
      .prepare(
        `INSERT INTO session_stats
           (session_id, measured_at, requests, span_ms, context_window, context_peak,
            context_last, context_mean, turns_above, input_tokens, output_tokens,
            cache_write, cache_read, effective_input, compactions, auto_compactions,
            dropped_tokens, reprimed_tokens, latency_p50, latency_p95, errors, worst, findings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET
           measured_at = excluded.measured_at, requests = excluded.requests,
           span_ms = excluded.span_ms, context_window = excluded.context_window,
           context_peak = excluded.context_peak, context_last = excluded.context_last,
           context_mean = excluded.context_mean, turns_above = excluded.turns_above,
           input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
           cache_write = excluded.cache_write, cache_read = excluded.cache_read,
           effective_input = excluded.effective_input, compactions = excluded.compactions,
           auto_compactions = excluded.auto_compactions, dropped_tokens = excluded.dropped_tokens,
           reprimed_tokens = excluded.reprimed_tokens, latency_p50 = excluded.latency_p50,
           latency_p95 = excluded.latency_p95, errors = excluded.errors,
           worst = excluded.worst, findings = excluded.findings`,
      )
      .run(
        sessionId,
        Date.now(),
        verdict.requests,
        verdict.spanMs,
        verdict.context.window,
        verdict.context.peak,
        verdict.context.last,
        verdict.context.mean,
        verdict.context.turnsAbove,
        verdict.totals.input,
        verdict.totals.output,
        verdict.totals.cacheWrite,
        verdict.totals.cacheRead,
        verdict.effectiveInput,
        verdict.compactions.length,
        auto.length,
        auto.reduce((sum, c) => sum + c.droppedTokens, 0),
        verdict.reprimes.tokens,
        verdict.latency.p50,
        verdict.latency.p95,
        verdict.errors.length,
        verdict.findings[0]?.severity ?? null,
        JSON.stringify(verdict.findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title }))),
      );
  }

  /**
   * Keep what a session would need to be told if it had to start over.
   *
   * Written continuously rather than at the moment somebody restarts, because
   * the cases this exists for are exactly the ones where nothing can be read at
   * that moment: the app was killed, the transcript was deleted, the account was
   * signed out. A brief that is only made on demand is not there when it is
   * needed. One row per session, overwritten — this is the current state of a
   * session, not a history of it.
   */
  saveBrief(sessionId, entry) {
    this.db
      .prepare(
        `INSERT INTO session_briefs (session_id, at, title, last_prompt, cwd, branch, turns, open_tasks, done_tasks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET
           at = excluded.at, title = excluded.title, last_prompt = excluded.last_prompt,
           cwd = excluded.cwd, branch = excluded.branch, turns = excluded.turns,
           open_tasks = excluded.open_tasks, done_tasks = excluded.done_tasks`,
      )
      .run(
        sessionId,
        Date.now(),
        entry.title ?? null,
        entry.lastPrompt ?? null,
        entry.cwd ?? null,
        entry.branch ?? null,
        entry.turns ?? 0,
        JSON.stringify(entry.open ?? []),
        JSON.stringify(entry.done ?? []),
      );
  }

  /**
   * Keep a sample of how a session was doing, if this one is worth keeping.
   *
   * `session_stats` answers "how is it now" and is overwritten; this answers "how
   * has it been", which is the only way to compare anything. The two are separate
   * because they are asked at completely different rates and the first would be
   * useless as a log.
   *
   * Not every sweep: a session read three times a minute for a week is a quarter
   * of a million rows that all say the same thing. A sample is kept when the
   * conversation changed, when the verdict changed, or when enough time has
   * passed — which is `worthSampling` below, kept pure so the rule can be
   * argued with in a test rather than in production.
   */
  noteHistory(sessionId, verdict, conversationId = null) {
    const last = this.db
      .prepare('SELECT at, worst, conversation_id FROM session_history WHERE session_id = ? ORDER BY at DESC LIMIT 1')
      .get(sessionId);
    if (!worthSampling(last, { worst: verdict.findings[0]?.severity ?? null, conversationId }, Date.now())) return false;

    const auto = verdict.compactions.filter((c) => c.trigger === 'auto');
    this.db
      .prepare(
        `INSERT INTO session_history
           (session_id, conversation_id, at, requests, context_last, context_window, context_peak,
            output_tokens, effective_input, compactions, auto_compactions, latency_p50, latency_p95, errors, worst)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        conversationId ?? null,
        Date.now(),
        verdict.requests,
        verdict.context.last,
        verdict.context.window,
        verdict.context.peak,
        verdict.totals.output,
        verdict.effectiveInput,
        verdict.compactions.length,
        auto.length,
        verdict.latency.p50,
        verdict.latency.p95,
        verdict.errors.length,
        verdict.findings[0]?.severity ?? null,
      );
    return true;
  }

  /**
   * Keep what a compaction threw away, as it stood just before it happened.
   *
   * A compaction is the one thing in a session's life that removes rather than
   * adds, and the transcript afterwards has no memory of what was there — that
   * is the point of it. The pre/post token counts survive in the metadata, but
   * *what it was doing* does not, and that is the part somebody actually wants
   * when they ask what was lost.
   *
   * Written once. `OR IGNORE` on (session, when) because the transcript is read
   * again on every sweep and every read sees the same compactions.
   */
  noteCompaction(sessionId, entry, before = null, conversationId = null) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO session_compactions
           (session_id, at, conversation_id, trigger, pre_tokens, post_tokens, dropped_tokens,
            duration_ms, context_before, requests_before, title, last_prompt, open_tasks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        entry.at ?? 0,
        conversationId ?? null,
        entry.trigger ?? null,
        entry.preTokens ?? 0,
        entry.postTokens ?? 0,
        entry.droppedTokens ?? 0,
        entry.durationMs ?? 0,
        entry.contextBefore ?? 0,
        entry.requestsBefore ?? 0,
        before?.title ?? null,
        before?.lastPrompt ?? null,
        JSON.stringify(before?.open ?? []),
      );
  }

  /** When this session has compacted, so the same one is not written twice. */
  compactionTimes(sessionId) {
    return this.db
      .prepare('SELECT at FROM session_compactions WHERE session_id = ?')
      .all(sessionId)
      .map((row) => row.at);
  }

  /** Every compaction of a session, oldest first, with what it was doing at the time. */
  compactions(sessionId) {
    return this.db
      .prepare('SELECT * FROM session_compactions WHERE session_id = ? ORDER BY at ASC')
      .all(sessionId)
      .map((row) => ({ ...row, open_tasks: parseTasks(row.open_tasks) }));
  }

  /** How one session has been doing over time, oldest first — the shape of a chart. */
  history(sessionId, limit = 400) {
    return this.db
      .prepare('SELECT * FROM session_history WHERE session_id = ? ORDER BY at DESC LIMIT ?')
      .all(sessionId, limit)
      .reverse();
  }

  /**
   * What normal looks like across everything measured.
   *
   * Medians rather than averages: one session that ran for a week at nine
   * hundred thousand tokens would drag every average with it and make the rest
   * look fine by comparison, which is the opposite of useful.
   */
  norms() {
    const rows = this.db
      .prepare(
        `SELECT context_last, context_window, effective_input, output_tokens, requests, auto_compactions
           FROM session_stats WHERE requests > 0`,
      )
      .all();
    return normsFrom(rows);
  }

  /** What was last known about a session, in the shape the brief was built in. */
  getBrief(sessionId) {
    const row = this.db.prepare('SELECT * FROM session_briefs WHERE session_id = ?').get(sessionId);
    if (!row) return null;
    return {
      at: row.at,
      title: row.title,
      lastPrompt: row.last_prompt,
      cwd: row.cwd,
      branch: row.branch,
      turns: row.turns,
      open: parseTasks(row.open_tasks),
      done: parseTasks(row.done_tasks),
    };
  }

  /**
   * Every session measured so far, newest first — what "compared to the others"
   * is computed from, and what the fleet view lists.
   */
  listStats(limit = 200) {
    return this.db
      .prepare(
        `SELECT s.*, x.title, x.profile_name, x.start_cwd, x.started_at, x.ended_at
           FROM session_stats s LEFT JOIN sessions x ON x.id = s.session_id
          ORDER BY s.measured_at DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({ ...row, findings: parseFindings(row.findings) }));
  }

  // --- messages between sessions -------------------------------------------

  /**
   * A message waiting for its recipient.
   *
   * Queued before any attempt to deliver it, never after: a message typed into a
   * terminal and only then recorded is a message lost to any crash in between,
   * and the sender was already told it was sent.
   */
  queueMessage({ from, to, fromName, body }) {
    const at = Date.now();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO session_messages (from_session, to_session, from_name, body, at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(from, to, fromName ?? null, body, at);
    return Number(lastInsertRowid);
  }

  /**
   * Messages for one session, or for every session when `to` is null.
   *
   * `undeliveredOnly` is the delivery queue — what has not yet been typed into a
   * terminal. `unreadOnly` is the inbox as the session sees it: delivered counts
   * as read, because it is already in the conversation.
   */
  messagesFor(to = null, { undeliveredOnly = false, unreadOnly = false, limit = 200 } = {}) {
    const where = [];
    const values = [];
    if (to) {
      where.push('to_session = ?');
      values.push(to);
    }
    if (undeliveredOnly) where.push('delivered_at IS NULL');
    if (unreadOnly) where.push('read_at IS NULL AND delivered_at IS NULL');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM session_messages ${clause} ORDER BY at LIMIT ?`)
      .all(...values, limit)
      .map((row) => ({
        id: row.id,
        from: row.from_session,
        to: row.to_session,
        fromName: row.from_name,
        body: row.body,
        at: row.at,
        deliveredAt: row.delivered_at,
        readAt: row.read_at,
      }));
  }

  markMessagesDelivered(ids = []) {
    if (!ids.length) return;
    const now = Date.now();
    const statement = this.db.prepare(
      'UPDATE session_messages SET delivered_at = ?, read_at = COALESCE(read_at, ?) WHERE id = ?',
    );
    for (const id of ids) statement.run(now, now, id);
  }

  markMessagesRead(ids = []) {
    if (!ids.length) return;
    const now = Date.now();
    const statement = this.db.prepare('UPDATE session_messages SET read_at = ? WHERE id = ?');
    for (const id of ids) statement.run(now, id);
  }

  /** Anything still queued for a session that is gone would be delivered to nobody. */
  dropMessagesFor(sessionId) {
    this.db
      .prepare('DELETE FROM session_messages WHERE to_session = ? AND delivered_at IS NULL')
      .run(sessionId);
  }

  // --- workspace -----------------------------------------------------------

  saveWorkspace(windowId, { layout, settings, activeLeaf, bounds, groups, minimized }) {
    this.db
      .prepare(
        `INSERT INTO windows (id, layout, settings, active_leaf, bounds, groups, minimized, opened_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           layout = excluded.layout, settings = excluded.settings,
           active_leaf = excluded.active_leaf,
           bounds = COALESCE(excluded.bounds, windows.bounds),
           groups = COALESCE(excluded.groups, windows.groups),
           minimized = COALESCE(excluded.minimized, windows.minimized),
           closed_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        windowId,
        JSON.stringify(layout ?? null),
        JSON.stringify(settings ?? {}),
        activeLeaf ?? null,
        bounds ? JSON.stringify(bounds) : null,
        groups ? JSON.stringify(groups) : null,
        // An empty dock still has to be written, or restoring the last minimized
        // tab could never be recorded. Only an absent one is left as it was.
        minimized === undefined || minimized === null ? null : JSON.stringify(minimized),
        Date.now(),
        Date.now(),
      );
  }

  /**
   * Groups get a table of their own rather than living inside a window's saved
   * state. A group outlives the window that made it — that is what lets the whole
   * set be brought back from history after everything was closed.
   */
  saveGroups(windowId, groups) {
    const upsert = this.db.prepare(
      `INSERT INTO groups (id, name, color, font_size, arrangement, window_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, color = excluded.color,
         font_size = excluded.font_size, arrangement = excluded.arrangement,
         window_id = excluded.window_id, updated_at = excluded.updated_at`,
    );
    for (const group of groups ?? []) {
      upsert.run(
        group.id,
        group.name,
        group.color ?? null,
        group.fontSize ?? null,
        group.arrangement ?? null,
        windowId,
        Date.now(),
        Date.now(),
      );
    }
  }

  /**
   * Folders worked in lately, so opening somewhere familiar is a click. Ordered by
   * how recently, not how often: the last few places are what people reach for.
   */
  recentFolders(limit = 8) {
    return this.db
      .prepare(
        `SELECT COALESCE(last_cwd, start_cwd) AS cwd, MAX(COALESCE(last_active_at, started_at)) AS at
         FROM sessions
         WHERE cwd IS NOT NULL
         GROUP BY cwd
         ORDER BY at DESC
         LIMIT ?`,
      )
      .all(limit)
      .map((row) => row.cwd);
  }

  /** Every group, for the windows that all share them. */
  allGroups() {
    return this.db
      .prepare(
        'SELECT id, name, color, font_size AS fontSize, arrangement FROM groups ORDER BY created_at',
      )
      .all()
      .map((row) => ({ ...row, collapsed: false }));
  }

  /** Groups with what is left of them, newest activity first. */
  listGroups({ limit = 100 } = {}) {
    return this.db
      .prepare(
        `SELECT g.id, g.name, g.color, g.font_size AS fontSize, g.arrangement,
                COUNT(s.id)                                        AS members,
                SUM(CASE WHEN s.ended_at IS NULL THEN 1 ELSE 0 END) AS open,
                SUM(CASE WHEN s.claude_session_id IS NOT NULL THEN 1 ELSE 0 END) AS resumable,
                MAX(COALESCE(s.last_active_at, s.started_at))       AS lastActiveAt
         FROM groups g
         LEFT JOIN sessions s ON s.group_id = g.id
         GROUP BY g.id
         HAVING members > 0
         ORDER BY lastActiveAt DESC
         LIMIT ?`,
      )
      .all(limit);
  }

  /** Everything that belonged to a group, in the order it was started. */
  groupMembers(groupId) {
    return this.db
      .prepare('SELECT * FROM sessions WHERE group_id = ? ORDER BY started_at')
      .all(groupId)
      .map(decorate);
  }

  deleteGroup(groupId) {
    this.db.prepare('UPDATE sessions SET group_id = NULL WHERE group_id = ?').run(groupId);
    this.db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
  }

  closeWindow(windowId) {
    this.db.prepare('UPDATE windows SET closed_at = ? WHERE id = ?').run(Date.now(), windowId);
  }

  /** Windows that were open last time, so a launch brings them all back. */
  openWindows() {
    return this.db
      .prepare('SELECT id, bounds FROM windows WHERE closed_at IS NULL ORDER BY opened_at')
      .all()
      .map((row) => ({ id: row.id, bounds: safeParse(row.bounds) }));
  }

  loadWorkspace(windowId) {
    const row = this.db.prepare('SELECT * FROM windows WHERE id = ?').get(windowId);
    if (!row) return null;
    const parse = (value, fallback) => {
      try {
        return JSON.parse(value);
      } catch {
        return fallback;
      }
    };
    return {
      layout: parse(row.layout, null),
      settings: parse(row.settings, {}),
      activeLeaf: row.active_leaf,
      groups: parse(row.groups, []),
      minimized: parse(row.minimized, []) ?? [],
      updatedAt: row.updated_at,
    };
  }

  /**
   * Remove one session and everything attached to it. A running session is refused:
   * its row is the live record of a tab that is still on screen.
   */
  deleteSession(id) {
    const row = this.db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(id);
    if (!row) return false;
    if (row.ended_at === null) throw new Error('That session is still running');

    this.forgetTranscript(id);
    this.db.prepare('DELETE FROM handoffs WHERE from_session_id = ? OR to_session_id = ?').run(id, id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return true;
  }

  /**
   * Erase history. Running sessions are never touched — their rows are the live
   * record of what is on screen. Returns the ids removed so their saved
   * conversations can be cleaned up too.
   */
  clearHistory({ before = null } = {}) {
    const doomed = this.db
      .prepare(
        `SELECT id FROM sessions
         WHERE ended_at IS NOT NULL ${before ? 'AND started_at < ?' : ''}`,
      )
      .all(...(before ? [before] : []))
      .map((row) => row.id);

    for (const id of doomed) this.#eraseSession(id);
    this.reclaim();
    return doomed;
  }

  /** Keep history from growing without bound. */
  prune({ keepDays = 90, keepRows = 1000 } = {}) {
    const cutoff = Date.now() - keepDays * 86400000;
    const doomed = this.db
      .prepare(
        `SELECT id FROM sessions
         WHERE ended_at IS NOT NULL AND (started_at < ?
           OR id NOT IN (SELECT id FROM sessions ORDER BY started_at DESC LIMIT ?))`,
      )
      .all(cutoff, keepRows)
      .map((row) => row.id);

    for (const id of doomed) this.#eraseSession(id);
    return doomed;
  }

  /**
   * Everything belonging to one session, gone.
   *
   * In one place because it is the thing most easily got wrong: every table
   * added later — the messages, the monitor's readings, the brief — is another
   * row that outlives the session unless deleting remembers it, and orphans are
   * invisible until the database is twice the size it should be.
   */
  #eraseSession(id) {
    this.forgetTranscript(id);
    this.db.prepare('DELETE FROM handoffs WHERE from_session_id = ? OR to_session_id = ?').run(id, id);
    this.db.prepare('DELETE FROM session_messages WHERE from_session = ? OR to_session = ?').run(id, id);
    this.db.prepare('DELETE FROM session_stats WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM session_briefs WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM session_history WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM session_compactions WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  /**
   * How the database is doing.
   *
   * Three separate questions, and they are worth keeping apart. **Size** is what
   * it weighs and which tables account for it. **Waste** is the part of that
   * weight holding nothing — deleting rows only marks their pages reusable, so a
   * database that has had a lot deleted stays exactly as large as it was, and
   * that gap is the closest thing to "degraded" that SQLite has. **Rot** is rows
   * that outlived what they belonged to: a session deleted before this file knew
   * about a table leaves its readings behind, invisible until they are counted.
   *
   * `deep` runs SQLite's own integrity check, which reads every page — a second
   * or two on a large file, so it is asked for rather than assumed.
   */
  health({ deep = false } = {}) {
    const pageSize = this.db.prepare('PRAGMA page_size').get().page_size;
    const pageCount = this.db.prepare('PRAGMA page_count').get().page_count;
    const freelist = this.db.prepare('PRAGMA freelist_count').get().freelist_count;

    const count = (sql) => this.db.prepare(sql).get().n ?? 0;
    const tables = [
      { name: 'transcript_chunks', rows: count('SELECT COUNT(*) AS n FROM transcript_chunks'),
        bytes: this.db.prepare('SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM transcript_chunks').get().n },
      { name: 'sessions', rows: count('SELECT COUNT(*) AS n FROM sessions'), bytes: null },
      { name: 'session_messages', rows: count('SELECT COUNT(*) AS n FROM session_messages'),
        bytes: this.db.prepare('SELECT COALESCE(SUM(LENGTH(body)), 0) AS n FROM session_messages').get().n },
      { name: 'session_history', rows: count('SELECT COUNT(*) AS n FROM session_history'), bytes: null },
      { name: 'session_compactions', rows: count('SELECT COUNT(*) AS n FROM session_compactions'), bytes: null },
      { name: 'session_stats', rows: count('SELECT COUNT(*) AS n FROM session_stats'), bytes: null },
      { name: 'session_briefs', rows: count('SELECT COUNT(*) AS n FROM session_briefs'), bytes: null },
      { name: 'handoffs', rows: count('SELECT COUNT(*) AS n FROM handoffs'), bytes: null },
      { name: 'groups', rows: count('SELECT COUNT(*) AS n FROM groups'), bytes: null },
      { name: 'windows', rows: count('SELECT COUNT(*) AS n FROM windows'), bytes: null },
    ].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || b.rows - a.rows);

    const orphans = {
      chunks: count('SELECT COUNT(*) AS n FROM transcript_chunks WHERE session_id NOT IN (SELECT id FROM sessions)'),
      stats: count('SELECT COUNT(*) AS n FROM session_stats WHERE session_id NOT IN (SELECT id FROM sessions)'),
      briefs: count('SELECT COUNT(*) AS n FROM session_briefs WHERE session_id NOT IN (SELECT id FROM sessions)'),
      history: count('SELECT COUNT(*) AS n FROM session_history WHERE session_id NOT IN (SELECT id FROM sessions)'),
      messages: count(
        `SELECT COUNT(*) AS n FROM session_messages
          WHERE to_session NOT IN (SELECT id FROM sessions)`,
      ),
    };

    const day = 86400000;
    const sessions = {
      total: count('SELECT COUNT(*) AS n FROM sessions'),
      open: count('SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL'),
      ended: count('SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NOT NULL'),
      olderThan30: this.db
        .prepare('SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NOT NULL AND started_at < ?')
        .get(Date.now() - 30 * day).n,
      olderThan90: this.db
        .prepare('SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NOT NULL AND started_at < ?')
        .get(Date.now() - 90 * day).n,
      oldest: this.db.prepare('SELECT MIN(started_at) AS n FROM sessions').get().n ?? null,
    };

    let integrity = null;
    if (deep) {
      const answer = this.db.prepare('PRAGMA integrity_check').get();
      integrity = Object.values(answer ?? {})[0] ?? 'unknown';
    }

    return {
      pageSize,
      bytes: pageSize * pageCount,
      wasted: pageSize * freelist,
      pages: pageCount,
      freePages: freelist,
      tables,
      orphans,
      sessions,
      integrity,
      readAt: Date.now(),
    };
  }

  /**
   * Every table, with how many rows it holds and roughly what it weighs.
   *
   * The weight is the summed length of every value cast to text, which is an
   * estimate and not the page count — SQLite will not say what a table costs
   * without the `dbstat` module, which is not always compiled in. It is right
   * about which table is the big one, which is the question being asked.
   */
  tables() {
    const names = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((row) => row.name);

    return names.map((name) => {
      const columns = this.db.prepare(`PRAGMA table_info("${name}")`).all().map((row) => row.name);
      let rows = 0;
      let bytes = null;
      try {
        rows = this.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n ?? 0;
        if (columns.length && rows) {
          const sum = columns.map((column) => `COALESCE(LENGTH(CAST("${column}" AS TEXT)), 0)`).join(' + ');
          bytes = this.db.prepare(`SELECT COALESCE(SUM(${sum}), 0) AS n FROM "${name}"`).get().n ?? 0;
        }
      } catch {
        // A virtual table can refuse to be counted; it still belongs in the list.
      }
      return { name, rows, bytes, columns };
    });
  }

  /**
   * The rows of one table, a page at a time.
   *
   * The caller names a table and never writes SQL. That is not ceremony: an app
   * that will run a string from its own interface is one prompt injection away
   * from running a string from somewhere else, and there is no version of
   * "browse the database" that needs arbitrary statements. The name is checked
   * against the ones that actually exist, values go in as parameters, and the
   * only thing built by hand is a quoted identifier.
   */
  tableRows(name, { limit = 50, offset = 0, search = '', orderBy = null, descending = true } = {}) {
    const known = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name);
    if (!known) return { ok: false, error: `No table called ${name}.` };

    const columns = this.db.prepare(`PRAGMA table_info("${name}")`).all();
    const names = columns.map((row) => row.name);
    if (!names.length) return { ok: false, error: `${name} has no columns.` };

    // Sorting by whatever was asked for, but only if it is a real column.
    const order = orderBy && names.includes(orderBy) ? orderBy : null;
    const sort = order ? ` ORDER BY "${order}" ${descending ? 'DESC' : 'ASC'}` : '';

    const term = String(search ?? '').trim();
    const where = term
      ? ` WHERE ${names.map((column) => `COALESCE(CAST("${column}" AS TEXT), '') LIKE ?`).join(' OR ')}`
      : '';
    const params = term ? names.map(() => `%${term}%`) : [];

    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"${where}`).get(...params).n ?? 0;
    const page = this.db
      .prepare(`SELECT * FROM "${name}"${where}${sort} LIMIT ? OFFSET ?`)
      .all(...params, Math.min(200, Math.max(1, limit)), Math.max(0, offset));

    // Long values are cut here rather than in the interface: a transcript chunk
    // can be tens of kilobytes and there is no reason to move that across the
    // boundary to show forty characters of it.
    const rows = page.map((row) => {
      const out = {};
      for (const column of names) {
        const value = row[column];
        if (typeof value === 'string' && value.length > 300) {
          out[column] = { cut: true, text: value.slice(0, 300), length: value.length };
        } else {
          out[column] = value ?? null;
        }
      }
      return out;
    });

    return { ok: true, name, columns: names, rows, total, offset, limit };
  }

  /** One value in full, for when the cut-down version is not enough. */
  tableValue(name, column, rowid) {
    const known = this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
    if (!known) return null;
    const columns = this.db.prepare(`PRAGMA table_info("${name}")`).all().map((row) => row.name);
    if (!columns.includes(column)) return null;
    try {
      const row = this.db.prepare(`SELECT "${column}" AS value FROM "${name}" WHERE rowid = ?`).get(rowid);
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Do the tidying that was asked for, and say what it cost.
   *
   * Every operation is named by the caller. Nothing here runs on a timer or as a
   * side effect of looking: deleting somebody's history because a panel was
   * opened would be indefensible, however old the history.
   */
  maintain({
    orphans = false,
    olderThanDays = null,
    transcriptsOlderThanDays = null,
    historyOlderThanDays = null,
    checkpoint = false,
    optimize = false,
    rebuildSearch = false,
    reclaim = false,
  } = {}) {
    const before = this.health();
    const done = [];

    if (orphans) {
      const gone =
        this.db.prepare('DELETE FROM transcript_chunks WHERE session_id NOT IN (SELECT id FROM sessions)').run().changes +
        this.db.prepare('DELETE FROM session_stats WHERE session_id NOT IN (SELECT id FROM sessions)').run().changes +
        this.db.prepare('DELETE FROM session_briefs WHERE session_id NOT IN (SELECT id FROM sessions)').run().changes +
        this.db.prepare('DELETE FROM session_messages WHERE to_session NOT IN (SELECT id FROM sessions)').run().changes +
        this.db.prepare('DELETE FROM session_history WHERE session_id NOT IN (SELECT id FROM sessions)').run().changes;
      done.push({ op: 'orphans', rows: gone });
    }

    // Only conversations, keeping the sessions themselves: the index of what ran
    // when is small and worth keeping long after the transcripts are not.
    if (Number.isFinite(transcriptsOlderThanDays)) {
      const cutoff = Date.now() - transcriptsOlderThanDays * 86400000;
      const ids = this.db
        .prepare('SELECT id FROM sessions WHERE ended_at IS NOT NULL AND started_at < ? AND store_transcript = 1')
        .all(cutoff)
        .map((row) => row.id);
      for (const id of ids) this.forgetTranscript(id);
      done.push({ op: 'transcripts', rows: ids.length });
    }

    // Old readings, keeping the sessions themselves. A year of history is worth
    // having; three is a chart nobody scrolls to the start of.
    if (Number.isFinite(historyOlderThanDays)) {
      const cutoff = Date.now() - historyOlderThanDays * 86400000;
      const gone = this.db.prepare('DELETE FROM session_history WHERE at < ?').run(cutoff).changes;
      done.push({ op: 'history', rows: gone });
    }

    if (Number.isFinite(olderThanDays)) {
      const cutoff = Date.now() - olderThanDays * 86400000;
      const ids = this.db
        .prepare('SELECT id FROM sessions WHERE ended_at IS NOT NULL AND started_at < ?')
        .all(cutoff)
        .map((row) => row.id);
      for (const id of ids) this.#eraseSession(id);
      done.push({ op: 'sessions', rows: ids.length });
    }

    // Fold the write-ahead log back into the file. It grows while the app is
    // running and is only checkpointed when SQLite feels like it; a session left
    // open for days can carry a log larger than the database.
    if (checkpoint) {
      const before = this.#walBytes();
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      done.push({ op: 'checkpoint', rows: 0, bytes: Math.max(0, before - this.#walBytes()) });
    }

    // Let SQLite re-measure its own indexes. Cheap, and the thing that stops a
    // query plan chosen when the database was empty from being used on a
    // database that no longer is.
    if (optimize) {
      this.db.exec('ANALYZE');
      this.db.exec('PRAGMA optimize');
      done.push({ op: 'optimize', rows: 0 });
    }

    // The search index is derived, so it can always be thrown away and rebuilt —
    // which is the answer when searching stops finding things it should.
    if (rebuildSearch) {
      try {
        this.db.exec(`INSERT INTO transcript_fts (transcript_fts) VALUES ('rebuild')`);
        done.push({ op: 'search', rows: 0 });
      } catch (error) {
        done.push({ op: 'search', rows: 0, error: String(error?.message ?? error) });
      }
    }

    // Last, and only if asked: VACUUM rewrites the whole file, so it is the one
    // operation here whose cost is measured in seconds rather than milliseconds.
    if (reclaim) this.reclaim();

    const after = this.health();
    return { done, freed: Math.max(0, before.bytes - after.bytes), before, after };
  }

  /** The write-ahead log's size, which the database itself will not report. */
  #walBytes() {
    try {
      return require('node:fs').statSync(`${this.file}-wal`).size;
    } catch {
      return 0;
    }
  }

  /**
   * Hand freed pages back to the filesystem. Deleting rows only marks them reusable;
   * without this the file never shrinks, which reads as the deletion not working.
   */
  reclaim() {
    this.db.exec('VACUUM');
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  allSessionIds() {
    return this.db.prepare('SELECT id FROM sessions').all().map((row) => row.id);
  }

  close() {
    try {
      // Lets SQLite refresh its query plans from the statistics it gathered.
      this.db.exec('PRAGMA optimize');
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

function safeParse(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

/** Longevity is derived, so a running session reports its age so far. */
function decorate(row) {
  if (!row) return null;
  const endedAt = row.ended_at ?? null;
  return {
    id: row.id,
    profileId: row.profile_id,
    profileName: row.profile_name,
    claudeSessionId: row.claude_session_id,
    kind: row.kind,
    title: row.title,
    startCwd: row.start_cwd,
    lastCwd: row.last_cwd,
    startedAt: row.started_at,
    endedAt,
    lastActiveAt: row.last_active_at,
    exitCode: row.exit_code,
    resumedFrom: row.resumed_from,
    windowId: row.window_id,
    groupId: row.group_id,
    lastCommand: row.last_command ?? null,
    resumeCommand: Boolean(row.resume_command),
    storeTranscript: Boolean(row.store_transcript),
    transcriptBytes: row.transcript_bytes,
    open: endedAt === null,
    durationMs: (endedAt ?? Date.now()) - row.started_at,
  };
}

/** Make a plain phrase safe for FTS5, which treats punctuation as syntax. */
function ftsQuery(text) {
  const terms = text
    .split(/\s+/)
    .map((term) => term.replace(/["*]/g, ''))
    .filter(Boolean)
    .map((term) => `"${term}"*`);
  return terms.length ? terms.join(' AND ') : '""';
}

module.exports = { Database };
