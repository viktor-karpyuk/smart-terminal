'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { app } = require('electron');

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
class Database {
  constructor(file = path.join(app.getPath('userData'), 'smart-terminal.db')) {
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

      CREATE TABLE IF NOT EXISTS windows (
        id          TEXT PRIMARY KEY,
        layout      TEXT,
        settings    TEXT,
        active_leaf TEXT,
        bounds      TEXT,
        groups      TEXT,
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
    this.db.exec('CREATE INDEX IF NOT EXISTS sessions_group ON sessions (group_id)');

    const windowColumns = new Set(
      this.db.prepare('PRAGMA table_info(windows)').all().map((column) => column.name),
    );
    if (windowColumns.size && !windowColumns.has('groups')) {
      this.db.exec('ALTER TABLE windows ADD COLUMN groups TEXT');
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

  // --- workspace -----------------------------------------------------------

  saveWorkspace(windowId, { layout, settings, activeLeaf, bounds, groups }) {
    this.db
      .prepare(
        `INSERT INTO windows (id, layout, settings, active_leaf, bounds, groups, opened_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           layout = excluded.layout, settings = excluded.settings,
           active_leaf = excluded.active_leaf,
           bounds = COALESCE(excluded.bounds, windows.bounds),
           groups = COALESCE(excluded.groups, windows.groups),
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

    for (const id of doomed) {
      this.forgetTranscript(id);
      this.db.prepare('DELETE FROM handoffs WHERE from_session_id = ? OR to_session_id = ?').run(id, id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    }
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

    for (const id of doomed) {
      this.forgetTranscript(id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    }
    return doomed;
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
