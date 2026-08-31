'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const SNAPSHOT_INTERVAL = 8000;

/**
 * Claude Code stores a conversation as one JSONL file per session, under the
 * account's config dir, in a folder named after the working directory with every
 * slash turned into a dash.
 */
function projectFolder(cwd) {
  return cwd.replace(/\//g, '-');
}

function defaultConfigDir() {
  return path.join(os.homedir(), '.claude');
}

function transcriptPath({ configDir, cwd, claudeSessionId }) {
  const root = configDir || defaultConfigDir();
  return path.join(root, 'projects', projectFolder(cwd), `${claudeSessionId}.jsonl`);
}

function snapshotRoot() {
  return path.join(app.getPath('userData'), 'context-snapshots');
}

function snapshotPath(sessionId) {
  return path.join(snapshotRoot(), sessionId);
}

/**
 * Keeps a copy of every tracked session's conversation.
 *
 * The transcript is a plain local file with no account or organisation baked into
 * it, which is what makes moving a session between accounts possible at all: drop
 * the same file into another account's config dir and `claude --resume <id>` picks
 * the conversation up exactly where it stopped.
 */
function statTime(target) {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

const TOOL_RESULT_LIMIT = 4000;

/**
 * Turn one transcript row into the entries worth keeping.
 *
 * A conversation is not only its prose: what Claude decided to run, and what came
 * back, is most of what makes a session reconstructable later. Each block becomes
 * its own entry so a search can land on the exact part that matters.
 */
function entriesFrom(entry) {
  if (entry.type !== 'user' && entry.type !== 'assistant') return [];
  const at = Date.parse(entry.timestamp) || null;
  const content = entry.message?.content;

  if (typeof content === 'string') {
    const text = content.trim();
    return text ? [{ at, role: entry.type, text }] : [];
  }
  if (!Array.isArray(content)) return [];

  const out = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.trim()) out.push({ at, role: entry.type, text: block.trim() });
      continue;
    }
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'text' && block.text?.trim()) {
      out.push({ at, role: entry.type, text: block.text.trim() });
    } else if (block.type === 'thinking' && block.thinking?.trim()) {
      out.push({ at, role: 'thinking', text: block.thinking.trim() });
    } else if (block.type === 'tool_use') {
      out.push({ at, role: 'tool', text: `${block.name}\n${stringify(block.input)}` });
    } else if (block.type === 'tool_result') {
      const text = stringify(block.content);
      if (text) out.push({ at, role: 'result', text: text.slice(0, TOOL_RESULT_LIMIT) });
    }
  }
  return out;
}

function stringify(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : item?.text || stringify(item?.content)))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  try {
    return JSON.stringify(value, null, 1).slice(0, TOOL_RESULT_LIMIT);
  } catch {
    return '';
  }
}

/**
 * Transcripts are append-only JSONL, and a long conversation runs to megabytes.
 * Re-copying the whole file every few seconds is wasteful, so only the bytes past
 * what the snapshot already holds get appended. If the two ever disagree — the file
 * was rewritten, or the snapshot was touched — it falls back to a full copy.
 */
function copyAppendOnly(source, target, sourceSize) {
  let copied = 0;
  try {
    copied = fs.statSync(target).size;
  } catch {
    copied = 0;
  }

  if (copied === sourceSize) return;
  if (copied === 0 || copied > sourceSize) {
    fs.copyFileSync(source, target);
    return;
  }

  const handle = fs.openSync(source, 'r');
  try {
    const chunk = Buffer.allocUnsafe(sourceSize - copied);
    const read = fs.readSync(handle, chunk, 0, chunk.length, copied);
    fs.appendFileSync(target, read === chunk.length ? chunk : chunk.subarray(0, read));
  } finally {
    fs.closeSync(handle);
  }
}

class ContextStore {
  constructor(db = null) {
    this.db = db;
    this.tracked = new Map();
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.snapshotAll(), SNAPSHOT_INTERVAL);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  track(sessionId, coords) {
    if (!coords?.claudeSessionId || !coords.cwd) return;
    this.tracked.set(sessionId, { ...coords, lastMtime: 0 });
  }

  setRecording(sessionId, record, withCommands) {
    const coords = this.tracked.get(sessionId);
    if (!coords) return;
    coords.record = record;
    if (withCommands !== undefined) coords.withCommands = withCommands;
  }

  /** Apply a changed preference to every session already being followed. */
  setCommandOutput(withCommands) {
    for (const coords of this.tracked.values()) coords.withCommands = withCommands;
  }

  untrack(sessionId) {
    this.tracked.delete(sessionId);
  }

  snapshotAll() {
    for (const sessionId of this.tracked.keys()) {
      try {
        this.snapshot(sessionId);
      } catch {
        /* a transcript can be mid-write; the next tick picks it up */
      }
    }
  }

  /**
   * Copy the live transcript into the app's own store, if it changed.
   *
   * Only while the session is being recorded: a saved copy is conversation content
   * like any other, and keeping one after the switch is off would mean "delete
   * everything" quietly left files behind. Moving a session to another account does
   * not depend on it — that reads the account's own transcript, and only falls back
   * to the copy when one exists.
   */
  snapshot(sessionId, { force = false } = {}) {
    const coords = this.tracked.get(sessionId);
    if (!coords || !coords.record) return null;

    const source = transcriptPath(coords);
    let stat;
    try {
      stat = fs.statSync(source);
    } catch {
      return null;
    }
    if (!force && stat.mtimeMs === coords.lastMtime) return this.info(sessionId);

    const dir = snapshotPath(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${coords.claudeSessionId}.jsonl`);
    copyAppendOnly(source, target, stat.size);
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify(
        {
          sessionId,
          claudeSessionId: coords.claudeSessionId,
          cwd: coords.cwd,
          configDir: coords.configDir ?? null,
          profileId: coords.profileId ?? null,
          bytes: stat.size,
          savedAt: Date.now(),
        },
        null,
        2,
      ),
    );
    coords.lastMtime = stat.mtimeMs;
    // Recording rides along with the snapshot: the file has just changed, so this
    // is exactly the moment the new turns are on disk.
    if (coords.record && this.db) {
      try {
        this.ingestInto(this.db, sessionId);
      } catch {
        /* a malformed row must not stop the snapshot loop */
      }
    }
    return this.info(sessionId);
  }

  /**
   * Find the conversation a session is running but the app did not start.
   *
   * Typing `claude` into a tab yourself is the normal way to work, and until now
   * those sessions had no conversation the app knew about: they could not be
   * continued, moved to another account, or read back. The transcript is filed
   * under the folder Claude was launched in, so the newest one there that appeared
   * after the session opened is it.
   */
  adopt(sessionId, { configDir, cwd, startedAt, taken = new Set() }) {
    const dir = path.join(configDir || defaultConfigDir(), 'projects', projectFolder(cwd));
    let candidates;
    try {
      candidates = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => ({ id: name.replace(/\.jsonl$/, ''), file: path.join(dir, name) }))
        .map((entry) => ({ ...entry, at: statTime(entry.file) }))
        // Anything older than the session belongs to an earlier one, and anything
        // another session is already running is not this one's to claim.
        .filter((entry) => entry.at >= startedAt - 60000 && !taken.has(entry.id))
        .sort((a, b) => b.at - a.at);
    } catch {
      return null;
    }
    if (!candidates.length) return null;

    const found = candidates[0].id;
    const coords = this.tracked.get(sessionId);
    if (coords) {
      coords.claudeSessionId = found;
      coords.lastMtime = 0;
    }
    return found;
  }

  /** What we know about a session's saved context. */
  info(sessionId) {
    const coords = this.tracked.get(sessionId);
    const metaFile = path.join(snapshotPath(sessionId), 'meta.json');
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch {
      /* nothing saved yet */
    }
    let liveBytes = null;
    if (coords) {
      try {
        liveBytes = fs.statSync(transcriptPath(coords)).size;
      } catch {
        /* the session may not have written a turn yet */
      }
    }
    return { sessionId, tracked: Boolean(coords), meta, liveBytes };
  }

  /**
   * Place a session's conversation inside another account so it can be resumed
   * there. Returns the id to hand to `claude --resume`.
   */
  handoff(sessionId, { targetConfigDir, cwd }) {
    const coords = this.tracked.get(sessionId);
    if (!coords) throw new Error('That session is not being tracked');

    // Take a final copy first: the source is about to become the older half.
    this.snapshot(sessionId, { force: true });

    return this.carryOver({
      configDir: coords.configDir ?? null,
      cwd: cwd || coords.cwd,
      claudeSessionId: coords.claudeSessionId,
      targetConfigDir,
      fallback: path.join(snapshotPath(sessionId), `${coords.claudeSessionId}.jsonl`),
    });
  }

  /**
   * File a copy of one conversation under another account, so that account can
   * resume it. Transcripts carry no account of their own, which is what makes this
   * possible at all; what matters is only that the copy lands under the same
   * folder on the other side, or the resume there would look in the wrong place.
   *
   * Deliberately knows nothing about live sessions: a conversation closed weeks
   * ago moves the same way as one running right now.
   */
  carryOver({ configDir, cwd, claudeSessionId, targetConfigDir, fallback = null }) {
    const found = locateTranscript(configDir ?? null, claudeSessionId, [cwd]);
    const from = found ? found.file : fallback;
    if (!from || !fs.existsSync(from)) {
      throw new Error('No conversation has been saved for that session yet');
    }

    const workdir = found?.cwd || cwd;
    const target = transcriptPath({ configDir: targetConfigDir, cwd: workdir, claudeSessionId });
    if (path.resolve(target) === path.resolve(from)) {
      return { claudeSessionId, cwd: workdir, transcript: target };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(from, target);

    return { claudeSessionId, cwd: workdir, transcript: target };
  }

  /**
   * Copy a session's conversation into the database as searchable text. Only rows
   * past what is already stored are read, so this stays cheap as it grows.
   */
  ingestInto(db, sessionId) {
    const coords = this.tracked.get(sessionId);
    const file = coords
      ? transcriptPath(coords)
      : path.join(snapshotPath(sessionId), `${db.getSession(sessionId)?.claudeSessionId}.jsonl`);

    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      return 0;
    }

    const withCommands = coords?.withCommands ?? true;

    const rows = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        for (const row of entriesFrom(JSON.parse(line))) {
          // What a command printed is the bulk of a conversation's size, and the
          // part most people never read back. Dropping it keeps the thread intact
          // at a fraction of the space.
          if (!withCommands && (row.role === 'tool' || row.role === 'result')) continue;
          rows.push(row);
        }
      } catch {
        continue; // a half-written last line is normal while a session is live
      }
    }
    return db.ingestTranscript(sessionId, rows);
  }

  /**
   * Stop following a session, keeping its saved conversation. Closing a tab must
   * not destroy the context — reopening it later is the whole point.
   */
  release(sessionId) {
    this.untrack(sessionId);
  }

  /** Really delete a session's saved conversation. */
  forget(sessionId) {
    this.untrack(sessionId);
    fs.rmSync(snapshotPath(sessionId), { recursive: true, force: true });
  }

  /**
   * Drop every saved conversation except the ones still being written to. A live
   * session would recreate its copy within seconds anyway, so removing it would
   * only look like the deletion had failed.
   */
  forgetAllExcept(keepIds = []) {
    const keep = new Set(keepIds);
    let removed = 0;
    let entries;
    try {
      entries = fs.readdirSync(snapshotRoot(), { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || keep.has(entry.name)) continue;
      fs.rmSync(path.join(snapshotRoot(), entry.name), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  /** Saved conversations whose session no longer exists — crash leftovers. */
  sweepOrphans(knownIds) {
    return this.forgetAllExcept(knownIds);
  }

  /** What the saved copies weigh, so the count can include them. */
  diskUsage() {
    let bytes = 0;
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          try {
            bytes += fs.statSync(full).size;
          } catch {
            /* vanished mid-walk */
          }
        }
      }
    };
    walk(snapshotRoot());
    return bytes;
  }
}

/**
 * Find a conversation's transcript, wherever it was filed.
 *
 * A conversation belongs to the folder Claude was launched in, which is not always
 * where the shell ended up. Guessing one folder and giving up is how a resume
 * silently turns into a brand-new conversation and the old one is orphaned — so
 * the likely folders are tried first and then the account is searched, which is
 * exact because the id is unique.
 */
function locateTranscript(configDir, claudeSessionId, preferred = []) {
  for (const cwd of preferred) {
    if (!cwd) continue;
    const file = transcriptPath({ configDir, cwd, claudeSessionId });
    if (fs.existsSync(file)) return { file, cwd };
  }

  const root = path.join(configDir || defaultConfigDir(), 'projects');
  let folders;
  try {
    folders = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const file = path.join(root, folder, `${claudeSessionId}.jsonl`);
    if (!fs.existsSync(file)) continue;
    // The folder the caller guessed is the one thing we already know to be wrong —
    // it is why we are scanning. Read it from the transcript, else from the name
    // of the folder it is filed under.
    return { file, cwd: cwdFromTranscript(file) ?? cwdFromFolderName(folder) ?? null };
  }
  return null;
}

/** Every transcript row records the directory it ran in. */
/**
 * Claude files a conversation under the folder it ran in, with every `/` turned
 * into `-`. That is lossy — a folder whose own name has a dash is indistinguishable
 * from a separator — so rebuild the path by walking the disk and keeping whichever
 * reading actually exists.
 */
/**
 * What the last turn of a conversation is doing, read from its transcript.
 *
 * Three answers matter. `turn-finished` — the assistant stopped of its own accord
 * and the next move is the human's. `awaiting-decision` — it asked to use a tool
 * and no result has come back, which is the shape of a permission prompt sitting
 * on screen. `working` — anything else, including a transcript still being written.
 *
 * Entries that are neither user nor assistant (titles, modes, latches) are Claude's
 * own bookkeeping and say nothing about whose turn it is.
 */
function readTurnState(file, { tailBytes = 512 * 1024 } = {}) {
  let text;
  try {
    const { size } = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const from = Math.max(0, size - tailBytes);
      const buffer = Buffer.alloc(size - from);
      fs.readSync(fd, buffer, 0, buffer.length, from);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const turns = [];
  // The first line of a mid-file read is usually half an entry; JSON.parse drops it.
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'user' || entry.type === 'assistant') turns.push(entry);
  }
  if (!turns.length) return null;

  const blocks = (entry) => {
    const content = entry.message?.content;
    return Array.isArray(content) ? content : [];
  };

  const last = turns[turns.length - 1];
  const lastBlocks = blocks(last);

  if (last.type === 'assistant' && lastBlocks.some((b) => b.type === 'tool_use')) {
    const asking = lastBlocks.find((b) => b.type === 'tool_use')?.name ?? null;
    return { state: 'awaiting-decision', asking, id: last.uuid ?? null };
  }

  if (last.type === 'assistant' && last.message?.stop_reason === 'end_turn') {
    const said = lastBlocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join(' ');
    // Did anything actually happen since the human last spoke? A turn that only
    // talked is how a session looks when it has run out of work.
    let didWork = false;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const entry = turns[i];
      if (entry.type === 'user' && !blocks(entry).some((b) => b.type === 'tool_result')) break;
      if (blocks(entry).some((b) => b.type === 'tool_use')) {
        didWork = true;
        break;
      }
    }
    return { state: 'turn-finished', said, didWork, id: last.uuid ?? null };
  }

  return { state: 'working', id: last.uuid ?? null };
}

function cwdFromFolderName(folder) {
  const parts = folder.replace(/^-/, '').split('-');

  const walk = (base, index) => {
    if (index >= parts.length) return base;
    let name = '';
    for (let i = index; i < parts.length; i += 1) {
      name = name ? `${name}-${parts[i]}` : parts[i];
      const next = path.join(base, name);
      if (!fs.existsSync(next)) continue;
      const rest = walk(next, i + 1);
      if (rest) return rest;
    }
    return null;
  };

  return walk('/', 0);
}

function cwdFromTranscript(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n', 40)) {
      if (!line.trim()) continue;
      const cwd = JSON.parse(line).cwd;
      if (typeof cwd === 'string' && cwd.startsWith('/')) return cwd;
    }
  } catch {
    /* unreadable or half-written */
  }
  return null;
}

module.exports = {
  ContextStore,
  transcriptPath,
  projectFolder,
  snapshotRoot,
  locateTranscript,
  readTurnState,
};
