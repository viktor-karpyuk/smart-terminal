'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { createHash, randomUUID } = require('node:crypto');

const { PtyManager, claudeLaunchLine } = require('./pty-manager');
const { readUsage } = require('./usage');
const { ProfileStore, discoverAccountDirs } = require('./profiles');
const { accountsRoot, authStatus, ensureConfigDir, invalidateAuthCache, suggestConfigDirs } = require('./auth');
const { JsonStore } = require('./store');
const { Database } = require('./database');
const { buildMenu } = require('./menu');
const { CwdWatcher } = require('./cwd-watcher');
const { ContextStore, transcriptPath, locateTranscript, readTurnState } = require('./context-store');
const { SessionMonitor } = require('./session-monitor');
const { summarise, oneLine } = require('./session-analysis');
const { Advisor } = require('./advisor');
const { render: renderBrief } = require('./session-brief');
const { RepoWatcher } = require('./repo-watcher');
const { discover, gallery, previewRules, withSources, panelViews, withPanelSources } = require('./extensions');
const { parseReport, replyFor, wantsBrief, compactionNote } = require('./hooks');
const { Autopilot, looksLikeADecision } = require('./autopilot');
const { tabsInLayout, minimizedIds, sessionsToRestore, unaccountedTabs } = require('./restore');
const { MessageBridge } = require('./message-bridge');
const { listDir, readTextFile, writeTextFile, FileWatcher } = require('./files');
const git = require('./git');
const { layout: layoutGraph } = require('./git-graph');

/**
 * What this build is. Written at package time, so the answer comes from the app
 * itself rather than from guessing at file dates in a release folder.
 */
const buildInfo = (() => {
  try {
    const stamped = require('./build-info.json');
    return { ...stamped, electron: process.versions.electron, node: process.versions.node };
  } catch {
    return {
      version: app.getVersion(),
      build: null,
      builtAt: null,
      electron: process.versions.electron,
      node: process.versions.node,
    };
  }
})();

const isDev = process.env.SMART_TERMINAL_DEV === '1';

// A separate profile directory lets a development copy run beside an installed
// one without the two fighting over the same sessions and database.
if (process.env.SMART_TERMINAL_USER_DATA) {
  app.setPath('userData', process.env.SMART_TERMINAL_USER_DATA);
}

/*
 * One database, one app.
 *
 * Installing a new build launches it while the old one is still up, and the two
 * share `smart-terminal.db`. The second copy reads the windows and sessions of
 * the first, and then the first writes its own shutdown over them: rows marked
 * ended, windows marked closed. A window marked closed does not come back, and
 * its sessions have nowhere to come back to — they survive only in History.
 * That is how a window's worth of live sessions was lost once.
 *
 * The lock file lives in `userData`, which was just repointed above, so a
 * development copy running on its own data directory still starts normally.
 */
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  // Not `app.quit()`: this copy has opened nothing, and quitting would run the
  // shutdown that is the whole problem.
  app.exit(0);
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

/** Every open window, by the id its workspace is stored under. */
const windows = new Map();
let profiles = null;
let workspace = null;
let ptys = null;
let cwdWatcher = null;
let adoptionSweep = null;
/** Quitting closes every window, but that is not the same as closing them. */
let isQuitting = false;
/** Set once the person has confirmed, so the question is asked exactly once. */
let quitConfirmed = false;
/** Windows allowed to close without asking again. */
const closingWindows = new Set();
/** Latest foreground reading per pty, so adoption can keep trying. */
const foregroundByPty = new Map();
/**
 * The last screen and the last output time per session, kept for anyone deciding
 * whether it is safe to type into one. Autopilot keeps its own copy for the
 * sessions it drives; a session can receive a message without being driven.
 */
const screenBySession = new Map();
const lastOutputBySession = new Map();
/** What the renderer last said about how far a session may reach. Narrow until told. */
let messagingReach = 'group';
let messages = null;
let advisor = null;
/** The account the advisor spends on. Null means whichever a session is using. */
let advisorProfileId = null;
/** Whether the monitor may put a note into a session that has gone badly wrong. */
let tellSessions = false;
/** sessionId -> when it was last told, so a bad session is not nagged. */
const told = new Map();
const TELL_COOLDOWN_MS = 30 * 60 * 1000;
let fileWatcher = null;
let mcpConfigPath = null;
/** The app's own plugin, handed to each session with `--plugin-dir`. */
let pluginPath = null;

/** Keeps sessions moving when the only thing stopping them is nobody saying "go". */
let autopilot = null;
/** Every pty this launch started, and the session it belongs to. */
const sessionByPty = new Map();
/** Mirrors the renderer's preference, so an adopted session starts recording too. */
let recordByDefault = true;
let context = null;
let db = null;
let monitor = null;
/**
 * Watches the working trees the app has open, so the Git panel is current
 * rather than merely recent. Built once and kept: it is counted per repository,
 * so two panels on the same one share a single watch.
 */
// One watcher for both the Git panel and the file tree: they are looking at the
// same folder, and a file appearing is news to each of them. Ref-counted inside,
// so either can hold the same root without blinding the other.
const repos = new RepoWatcher({ emit: (root, kind) => send('tree:changed', { root, kind }) });
/** App session ids whose processes this launch started, so quitting can close their rows. */
const liveSessions = new Set();
const usageCache = new Map();
const usageInFlight = new Map();
const USAGE_TTL = 5 * 60 * 1000;

/** Broadcast to every window; session events can concern any of them. */
function send(channel, payload) {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/** Menu commands act on the window in front. */
function sendToFocused(channel, payload) {
  const win = BrowserWindow.getFocusedWindow() ?? [...windows.values()][0];
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function windowIdOf(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  for (const [id, candidate] of windows) if (candidate === win) return id;
  return null;
}

function createWindow(windowId = randomUUID(), bounds = null) {
  const win = new BrowserWindow({
    ...(bounds ?? {}),
    width: bounds?.width ?? 1500,
    height: bounds?.height ?? 950,
    minWidth: 820,
    minHeight: 520,
    show: false,
    backgroundColor: '#11131a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The renderer needs to know which workspace it is showing.
      additionalArguments: [`--smart-terminal-window=${windowId}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // A terminal in a background pane must keep drawing its output; Chromium's
      // default throttling would stall rendering whenever the window loses focus.
      backgroundThrottling: false,
    },
  });

  windows.set(windowId, win);
  win.once('ready-to-show', () => win.show());

  if (isDev) {
    // Surface renderer errors in the terminal running `npm run dev`.
    win.webContents.on('console-message', (event) => {
      const level = ['debug', 'info', 'warning', 'error'][event.level] ?? event.level;
      console.log(`[renderer:${level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  const rememberBounds = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    db?.saveWorkspace(windowId, { ...(db.loadWorkspace(windowId) ?? {}), bounds: win.getBounds() });
  };
  win.on('resized', rememberBounds);
  win.on('moved', rememberBounds);

  win.on('close', (event) => {
    if (isQuitting || quitConfirmed || closingWindows.has(windowId)) return;
    const running = runningIn(windowId);
    if (!running.total) return;

    // preventDefault has to happen before the first await, or the window is gone.
    event.preventDefault();
    confirmClosing(win, running, 'window').then((confirmed) => {
      if (!confirmed) return;
      closingWindows.add(windowId);
      setImmediate(() => win.close());
    });
  });

  win.on('closed', () => {
    windows.delete(windowId);
    // A window the app took down on its way out is meant to come back next launch.
    if (isQuitting) return;
    // Closing a window ends its sessions; they are not coming back with it.
    for (const sessionId of [...liveSessions]) {
      if (db?.getSession(sessionId)?.windowId !== windowId) continue;
      liveSessions.delete(sessionId);
      db?.endSession(sessionId, null);
    }
    db?.closeWindow(windowId);
  });

  // Keep navigation inside the app; anything else opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

function registerIpc() {
  ipcMain.handle('pty:create', (_e, options = {}) => {
    const profile = profiles.get(options.profileId);
    if (!profile) throw new Error(`Unknown profile: ${options.profileId}`);
    const kind = options.kind || 'claude';
    const cwd = options.cwd || profile.cwd;

    // Pinning the conversation id up front makes the transcript path predictable,
    // which is what lets the app snapshot it and later move it to another account.
    const extraArgs = [...(options.extraArgs || [])];
    let resumeId = options.resumeSessionId || null;
    let workdir = cwd;
    if (resumeId) {
      // Resume has to run from the folder the conversation is filed under, and
      // that is not always where the shell was last seen. Losing track of it is
      // how a resume becomes a new, empty conversation.
      const found = locateTranscript(profile.configDir ?? null, resumeId, [cwd, options.startCwd]);
      if (found) {
        if (found.cwd && fs.existsSync(found.cwd)) workdir = found.cwd;
      } else {
        resumeId = null;
      }
    }
    if (kind === 'claude') {
      // Falling back from --resume must still claim the id, or the conversation
      // would get an id we do not know and become impossible to track.
      const pinned = options.resumeSessionId || options.claudeSessionId;
      if (resumeId) extraArgs.unshift('--resume', resumeId);
      else if (pinned) extraArgs.unshift('--session-id', pinned);
    }

    // The channel to the other sessions. Attached to every Claude session, not
    // only to grouped ones: a session can be put in a group at any time, and
    // adding its tools would otherwise mean restarting it. What it may reach is
    // decided when it asks, never here.
    if (kind === 'claude' && mcpConfigPath && options.sessionId) {
      extraArgs.push('--mcp-config', mcpConfigPath);
    }

    /*
      The app's own plugin, for this session only.

      `--plugin-dir` rather than anything installed: the hooks in it are part of
      the app and are versioned with it, so a session gets the ones that match
      the app it is running inside and nothing is left behind on the machine
      when the app is not there. Nobody has to install anything, and a session
      started outside the app is unaffected.
    */
    if (kind === 'claude' && pluginPath && options.sessionId) {
      extraArgs.push('--plugin-dir', pluginPath);
    }

    /*
      When Claude compacts by itself.

      The monitor could always say a session was filling up; this is the only
      thing that lets that be acted on rather than only reported. Validated
      here rather than trusted: this becomes a command-line argument, and the
      only shapes Claude accepts are `auto` or a token count.
    */
    if (kind === 'claude' && options.autocompact) {
      const wanted = String(options.autocompact).trim().toLowerCase();
      if (wanted === 'auto' || /^\d+k?$/.test(wanted)) extraArgs.push('--autocompact', wanted);
    }

    const result = ptys.create({
      profile,
      cwd: workdir,
      kind,
      cols: options.cols,
      rows: options.rows,
      extraArgs,
      command: options.command || null,
      env: {
        SMART_TERMINAL_SESSION_ID: options.sessionId || '',
        // How a hook finds its way home. The MCP server is told the same path
        // through its own config; a hook is a plain child of Claude, so the
        // only way it can be told is the environment the shell was given.
        SMART_TERMINAL_BRIDGE: socketPathFor(app.getPath('userData')),
      },
    });

    const claudeSessionId = options.resumeSessionId || options.claudeSessionId;
    if (options.sessionId) {
      liveSessions.add(options.sessionId);
      sessionByPty.set(result.id, options.sessionId);
      announceRoster();
      db.openSession({
        id: options.sessionId,
        profileId: profile.id,
        profileName: profile.name,
        claudeSessionId: claudeSessionId ?? null,
        kind,
        title: options.title ?? null,
        startCwd: result.cwd,
        resumedFrom: options.resumedFrom ?? null,
        windowId: windowIdOf(_e),
      });
    }
    if (kind === 'claude' && claudeSessionId && options.sessionId) {
      context.track(options.sessionId, {
        claudeSessionId,
        cwd: result.cwd,
        configDir: profile.configDir ?? null,
        profileId: profile.id,
        record: Boolean(options.record),
        withCommands: options.recordCommands !== false,
        ptyId: result.id,
      });
      if (options.record) db.updateSession(options.sessionId, { storeTranscript: true });
    }
    return result;
  });

  ipcMain.on('pty:write', (_e, { id, data }) => {
    // Typing is the cheapest possible hint that the picture is about to change,
    // and it is what lets the cwd watcher idle without anyone noticing.
    cwdWatcher?.wake();
    ptys.write(id, data);
  });
  ipcMain.on('pty:resize', (_e, { id, cols, rows }) => ptys.resize(id, cols, rows));
  ipcMain.on('pty:kill', (_e, { id }) => {
    cwdWatcher.forget(id);
    ptys.kill(id);
  });

  /**
   * The command to start Claude inside a session that already has a shell. The
   * choice between continuing a conversation and starting one belongs here: only
   * the main process can see whether a transcript was ever written.
   */
  ipcMain.handle('pty:launch-line', (_e, { sessionId, profileId }) => {
    const row = db.getSession(sessionId);
    if (!row) return null;
    // Running Claude as another account in a terminal that is already open: the
    // shell's environment was fixed when it was spawned, so the account has to
    // travel on the command line itself.
    // An account is only ever named explicitly to override the shell's own, so the
    // check is whether one was named — not whether it differs from the row, which
    // by now may already have been moved over.
    const asOther = Boolean(profileId);
    const profile = asOther ? profiles.exactly(profileId) : profiles.get(row.profileId);
    if (!profile) return null;

    // A conversation belongs to the account that holds it. Asking for a different
    // account means starting fresh, not carrying someone else's thread across.
    const conversation = asOther ? null : row.claudeSessionId;
    // Look for the transcript wherever it is filed, not only under the folder the
    // session is sitting in now. Guessing one folder and falling back to
    // `--session-id` hands the same id to a conversation that already exists —
    // which is how a thread gets abandoned without anything looking wrong.
    const found = conversation
      ? locateTranscript(profile.configDir ?? null, conversation, [row.lastCwd, row.startCwd])
      : null;

    const flag = conversation
      ? found
        ? ['--resume', conversation]
        : ['--session-id', conversation]
      : [];
    let line = claudeLaunchLine(profile, flag);

    if (asOther) {
      const overrides = { ...(profile.env || {}) };
      if (profile.configDir) overrides.CLAUDE_CONFIG_DIR = profile.configDir;
      else overrides.CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude');
      const prefix = Object.entries(overrides)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
        .join(' ');
      if (prefix) line = `${prefix} ${line}`;
    }

    // The line is typed into a shell that is sitting wherever it was left. A
    // resume run from the wrong folder finds no conversation, so walk there first.
    const workdir = found?.cwd && fs.existsSync(found.cwd) ? found.cwd : null;
    return workdir ? `cd ${JSON.stringify(workdir)} && ${line}` : line;
  });

  /**
   * Hand a session to another account without moving any conversation: the tab
   * keeps its place and its folder, and everything downstream — colour, tracking,
   * where an adopted conversation gets looked for — follows the new account.
   */
  ipcMain.handle('session:reassign', (_e, { sessionId, profileId }) => {
    const row = db.getSession(sessionId);
    const profile = profiles.exactly(profileId);
    if (!row || !profile) return false;
    // Only ever called for a tab with no conversation of its own — one that does
    // has to travel by handoff, or its thread would be orphaned on the old account.
    if (row.claudeSessionId) return false;
    db.updateSession(sessionId, { profileId, profileName: profile.name });
    context.untrack(sessionId);
    return true;
  });

  ipcMain.on('pty:release-orphans', (event) => {
    // This window's renderer reloaded, so the ptys it started are unreachable.
    // Another window's sessions are none of its business.
    const windowId = windowIdOf(event);
    for (const [ptyId, sessionId] of sessionByPty) {
      if (db.getSession(sessionId)?.windowId !== windowId) continue;
      ptys.kill(ptyId);
      sessionByPty.delete(ptyId);
      liveSessions.delete(sessionId);
      // Without this the row stays marked running for ever, and the history shows
      // sessions that no longer exist.
      db.endSession(sessionId, null);
    }
    announceRoster();
  });

  ipcMain.handle('usage:read', async (_e, { profileId, force } = {}) => {
    const profile = profiles.get(profileId);
    if (!profile) throw new Error(`Unknown account: ${profileId}`);

    const cached = usageCache.get(profileId);
    if (!force && cached && Date.now() - cached.readAt < USAGE_TTL) return cached;
    // Reading spawns a session, so concurrent asks share one read.
    if (usageInFlight.has(profileId)) return usageInFlight.get(profileId);

    const pending = readUsage(profile)
      .then((result) => {
        const stamped = { ...result, profileId, readAt: Date.now() };
        if (stamped.ok) usageCache.set(profileId, stamped);
        return stamped;
      })
      .finally(() => usageInFlight.delete(profileId));

    usageInFlight.set(profileId, pending);
    return pending;
  });

  /**
   * How a session is behaving: the token accounting, the context curve, and the
   * handful of findings that come out of them.
   *
   * The monitor is already reading these on its own, so the panel usually gets an
   * answer it has had for a while. `force` is Refresh — the one case where
   * someone is looking at the number and wants it re-read now.
   */
  ipcMain.handle('analysis:session', (_e, { sessionId, force = false } = {}) => {
    if (!sessionId) return null;
    return monitor.read(sessionId, { force });
  });

  /** Every session that has ever been measured — the monitor's fleet view. */
  ipcMain.handle('analysis:all', () => {
    try {
      return db.listStats();
    } catch {
      return [];
    }
  });

  /**
   * A read of one session from a model, rather than from arithmetic.
   *
   * Costs tokens — one short request — so it is never called on its own: only
   * when someone asks for it, on the account they chose, with a cooldown so a
   * panel left open cannot turn into a subscription.
   */
  ipcMain.handle('analysis:advice', async (_e, { sessionId, question = null, alongside = [], force = false } = {}) => {
    if (!sessionId || !advisor) return { ok: false, error: 'The advisor is not available.' };
    return advisor.ask(sessionId, { question, alongside, profileId: advisorProfileId, force });
  });

  /** Whatever the advisor last said, without asking it anything. */
  ipcMain.handle('analysis:advice-held', (_e, sessionId) => advisor?.peek(sessionId) ?? null);

  /**
   * Put a reading into the session it is about.
   *
   * The one thing here that acts rather than reports, so it happens only when
   * asked for by name. It goes through the message bridge, which delivers when
   * the session is next waiting at its prompt — never onto work in progress.
   */
  ipcMain.handle('analysis:tell', (_e, { sessionId, text } = {}) => {
    if (!messages) return { ok: false, error: 'Session messaging is not running.' };
    return messages.note(sessionId, text, { subject: 'this session' });
  });

  /**
   * What a session would be told if it started over, as the words to say to it.
   *
   * Read from the database rather than the transcript on purpose: this has to
   * answer for a session whose conversation is gone, which is most of the reason
   * it is kept at all.
   */
  ipcMain.handle('analysis:brief', (_e, sessionId) => {
    if (!sessionId) return null;
    const entry = db.getBrief(sessionId);
    if (!entry) return null;
    const row = db.getSession(sessionId);
    return {
      ...entry,
      text: renderBrief(entry, { command: row?.lastCommand ?? null, name: row?.title ?? null }),
    };
  });

  /** Say it to the session — used when one is restarted without its conversation. */
  ipcMain.handle('analysis:hand-over', (_e, { sessionId, text } = {}) => {
    if (!messages) return { ok: false, error: 'Session messaging is not running.' };
    return messages.handOver(sessionId, text);
  });

  /**
   * How the database is doing, with the file sizes the database itself cannot
   * see: the write-ahead log, and the snapshots kept beside it.
   */
  ipcMain.handle('db:health', (_e, { deep = false } = {}) => {
    const health = db.health({ deep });
    const file = path.join(app.getPath('userData'), 'smart-terminal.db');
    const sizeOf = (suffix) => {
      try {
        return fs.statSync(file + suffix).size;
      } catch {
        return 0;
      }
    };
    return {
      ...health,
      onDisk: sizeOf('') + sizeOf('-wal') + sizeOf('-shm'),
      walBytes: sizeOf('-wal'),
      snapshotBytes: context.diskUsage(),
    };
  });

  /** Every extension and where it stands, plus what the installed ones turn on. */
  ipcMain.handle('extensions:list', () => extensionState());

  ipcMain.handle('extensions:install', (_e, id) => {
    const found = builtInExtensions().find((manifest) => manifest.id === id);
    if (!found) return extensionState();
    db.installExtension(found);
    return sendExtensions();
  });

  ipcMain.handle('extensions:remove', (_e, id) => {
    db.removeExtension(id);
    return sendExtensions();
  });

  ipcMain.handle('extensions:enable', (_e, { id, on }) => {
    db.enableExtension(id, on !== false);
    return sendExtensions();
  });

  // Held while a panel has a repository open. Counted, so closing one of two
  // panels on the same repository does not blind the other.
  ipcMain.on('git:watch', (_e, root) => repos.watch(root));
  ipcMain.on('git:unwatch', (_e, root) => repos.release(root));

  /** Tidying, and only what was asked for. Never on a timer, never as a side effect. */
  ipcMain.handle('db:maintain', (_e, options = {}) => db.maintain(options ?? {}));

  /** Every table, with what it holds — the list a browser starts from. */
  ipcMain.handle('db:tables', () => {
    try {
      return db.tables();
    } catch {
      return [];
    }
  });

  /**
   * One page of one table.
   *
   * The renderer names a table; it never sends SQL. There is no version of
   * browsing a database that needs arbitrary statements, and an app that will
   * run a string from its own interface will run one from anywhere.
   */
  ipcMain.handle('db:table-rows', (_e, { name, limit, offset, search, orderBy, descending } = {}) => {
    if (!name) return { ok: false, error: 'No table named.' };
    try {
      return db.tableRows(name, { limit, offset, search, orderBy, descending });
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  /** One value in full, when the cut-down version in the grid is not enough. */
  ipcMain.handle('db:table-value', (_e, { name, column, rowid } = {}) => {
    try {
      return db.tableValue(name, column, rowid);
    } catch {
      return null;
    }
  });

  /**
   * Drop what was read for a session.
   *
   * Sent when a session is deliberately started over on a new conversation: what
   * was measured belongs to the one it replaced, and holding it even until the
   * next sweep means the panel reports the old session's trouble as the new
   * one's.
   */
  ipcMain.on('analysis:forget', (_e, sessionId) => monitor?.forget(sessionId));

  /** How one session has been doing over time, and what typical looks like. */
  ipcMain.handle('analysis:history', (_e, sessionId) => {
    if (!sessionId) return { samples: [], norms: null, compactions: [] };
    try {
      return { samples: db.history(sessionId), norms: db.norms(), compactions: db.compactions(sessionId) };
    } catch {
      return { samples: [], norms: null, compactions: [] };
    }
  });

  /** What the monitor is following right now, without re-reading anything. */
  ipcMain.handle('analysis:live', () => {
    const out = {};
    for (const sessionId of monitor.sessions()) {
      const verdict = monitor.peek(sessionId);
      if (verdict) out[sessionId] = verdict;
    }
    return out;
  });

  ipcMain.handle('context:info', (_e, sessionId) => context.info(sessionId));
  ipcMain.handle('context:save', (_e, sessionId) => context.snapshot(sessionId, { force: true }));
  ipcMain.handle('context:handoff', (_e, { sessionId, targetProfileId, cwd }) => {
    const target = profiles.get(targetProfileId);
    if (!target) throw new Error(`Unknown account: ${targetProfileId}`);
    if (target.configDir) ensureConfigDir(target.configDir);
    return context.handoff(sessionId, { targetConfigDir: target.configDir ?? null, cwd });
  });
  ipcMain.on('context:forget', (_e, sessionId) => context.forget(sessionId));
  ipcMain.on('context:release', (_e, sessionId) => context.release(sessionId));

  ipcMain.handle('profiles:list', () => profiles.list());
  ipcMain.handle('profiles:save', (_e, profile) => {
    profiles.save(profile);
    return profiles.list();
  });
  ipcMain.handle('profiles:remove', (_e, id) => profiles.remove(id));
  ipcMain.handle('profiles:discover', () => discoverAccountDirs());
  ipcMain.handle('profiles:suggest-config-dirs', (_e, name) => suggestConfigDirs(name));
  ipcMain.handle('profiles:ensure-config-dir', (_e, dir) => {
    ensureConfigDir(dir);
    invalidateAuthCache();
    return dir;
  });

  ipcMain.handle('auth:status', (_e, { profile, force } = {}) => authStatus(profile || {}, { force }));

  ipcMain.handle('workspace:load', (event) => {
    const windowId = windowIdOf(event);
    const stored = windowId ? db.loadWorkspace(windowId) : null;
    if (!stored?.layout) return workspace.get();
    // Asked for by id rather than by a page of history: the layout is the record
    // of what this window had, and a session it is not handed back is a pane the
    // renderer prunes out of the layout and then saves without.
    // The dock is asked for by the same call: a minimized session has no pane to
    // name it, so leaving it out here is the whole of losing it.
    const minimized = stored.minimized ?? [];
    const rows = db.sessionsForRestore(
      [...tabsInLayout(stored.layout), ...minimizedIds(minimized)],
      windowId,
    );
    const missing = unaccountedTabs(stored.layout, rows, minimized);
    if (missing.length) {
      console.log(`[workspace] ${missing.length} pane(s) name a session with no row left`);
    }
    return {
      layout: stored.layout,
      settings: stored.settings,
      groups: stored.groups ?? [],
      minimized,
      // Which sessions to bring back, and what each was in the middle of.
      sessions: sessionsToRestore({
        windowId,
        layout: stored.layout,
        minimized,
        rows,
        // Every window this launch is bringing back, so a session held by one of
        // the others is left to it instead of being started twice.
        openWindowIds: [...windows.keys()],
      }).map((row) => ({
          id: row.id,
          profileId: row.profileId,
          // Where the shell actually was, not where it started: a session that was
          // moved with `cd` belongs to that folder now, and its conversation is
          // filed under it too.
          cwd: row.lastCwd || row.startCwd,
          startCwd: row.startCwd,
          kind: row.kind,
          customTitle: row.title,
          claudeSessionId: row.claudeSessionId,
          groupId: row.groupId ?? null,
          // What it was running, and whether it was told to start that again.
          lastCommand: row.lastCommand ?? null,
          resumeCommand: row.resumeCommand ?? false,
          handoffFrom: null,
        })),
    };
  });

  ipcMain.on('workspace:save', (event, state) => {
    const windowId = windowIdOf(event);
    if (!windowId) return;
    // Reach is read at the moment a session asks, not when it started, so changing
    // it takes effect on every running session without restarting any of them.
    if (state.settings?.sessionMessaging) messagingReach = state.settings.sessionMessaging;
    // Same reason: the account the advisor spends on is read when it is asked.
    if ('advisorProfileId' in (state.settings ?? {})) advisorProfileId = state.settings.advisorProfileId;
    if ('tellSessions' in (state.settings ?? {})) tellSessions = Boolean(state.settings.tellSessions);
    // Written on every change: a crash then costs at most the last few hundred ms.
    db.saveWorkspace(windowId, {
      layout: state.layout,
      settings: state.settings,
      activeLeaf: state.activeLeaf ?? null,
      groups: state.groups ?? [],
      minimized: state.minimized ?? [],
    });
    db.saveGroups(windowId, state.groups ?? []);
    for (const session of state.sessions ?? []) {
      db.updateSession(session.id, { groupId: session.groupId ?? null });
    }
  });

  // --- the file tree and the editor -----------------------------------------
  //
  // Errors come back as values rather than as thrown exceptions: a folder that
  // cannot be read is something the tree has to draw, not something that should
  // reject a promise in the renderer and leave a pane blank.
  ipcMain.handle('files:list', async (_e, dir) => {
    try {
      return { ok: true, entries: await listDir(dir) };
    } catch (error) {
      return { ok: false, error: error.code === 'ENOENT' ? 'That folder is not there any more.' : error.message };
    }
  });

  ipcMain.handle('files:read', async (_e, file) => {
    try {
      return await readTextFile(file);
    } catch (error) {
      return { ok: false, error: error.code === 'ENOENT' ? 'That file is not there any more.' : error.message };
    }
  });

  ipcMain.handle('files:write', async (_e, { file, text, expectedMtimeMs = null, force = false }) => {
    try {
      return await writeTextFile(file, text, { expectedMtimeMs, force });
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.on('files:watch', (_e, { file, mtimeMs }) => fileWatcher?.watch(file, mtimeMs ?? 0));
  ipcMain.on('files:unwatch', (_e, { file }) => fileWatcher?.forget(file));
  // The tree, as opposed to a file that is open in the editor. A folder a panel
  // is showing has to notice a file appearing, being renamed or going away —
  // which the per-file poll cannot see, because it only knows about files
  // somebody already opened.
  ipcMain.on('files:watch-tree', (_e, root) => repos.watch(root));
  ipcMain.on('files:unwatch-tree', (_e, root) => repos.release(root));
  ipcMain.on('files:reveal', (_e, file) => shell.showItemInFolder(file));

  /*
   * Git, as one call with a name.
   *
   * The names are a fixed table rather than anything derived from the argument —
   * a renderer bug must not be able to reach a git subcommand nobody wrote a
   * handler for, and every one of these takes its arguments as an array that
   * never touches a shell.
   */
  const GIT = {
    root: (root) => git.repoRoot(root),
    status: async (root) => {
      const [state, unstaged, staged] = await Promise.all([
        git.status(root),
        git.stat(root, { staged: false }),
        git.stat(root, { staged: true }),
      ]);
      if (!state.ok) return state;
      // A file's line counts live in whichever diff it is actually in.
      for (const file of state.files) {
        const counts = staged[file.path] ?? unstaged[file.path] ?? null;
        file.added = counts?.added ?? null;
        file.removed = counts?.removed ?? null;
      }
      return state;
    },
    graph: async (root, { limit = 200 } = {}) => {
      const result = await git.log(root, { limit });
      if (!result.ok) return result;
      const { rows, width } = layoutGraph(result.commits);
      // The lane belongs beside its commit, not in a parallel array the renderer
      // has to keep lined up.
      return {
        ok: true,
        width,
        commits: result.commits.map((commit, index) => ({ ...commit, ...rows[index] })),
      };
    },
    refs: (root) => git.refs(root),
    compare: (root, { a, b }) => git.compare(root, a, b),
    commitFiles: (root, { sha }) => git.commitFiles(root, sha),
    head: (root) => git.head(root),
    diff: (root, options) => git.diff(root, options ?? {}),
    stage: (root, { paths }) => git.stage(root, paths),
    unstage: (root, { paths }) => git.unstage(root, paths),
    commit: (root, { message, amend }) => git.commit(root, message, { amend }),
    push: (root, options) => git.push(root, options ?? {}),
    pull: (root, options) => git.pull(root, options ?? {}),
    fetch: (root) => git.fetch(root),
    checkout: (root, { ref }) => git.checkout(root, ref),
    createBranch: (root, { name, from }) => git.createBranch(root, name, from),
    renameBranch: (root, { from, to }) => git.renameBranch(root, from, to),
    trackRemote: (root, { remote, local }) => git.trackRemote(root, remote, local),
    deleteBranch: (root, { name, force }) => git.deleteBranch(root, name, { force }),
    merge: (root, { ref }) => git.merge(root, ref),
    rebase: (root, { ref }) => git.rebase(root, ref),
    abortMerge: (root) => git.abortMerge(root),
    revert: (root, { sha }) => git.revertCommit(root, sha),
    stash: (root, { message }) => git.stashPush(root, message),
    stashPop: (root, { ref }) => git.stashPop(root, ref),
  };

  ipcMain.handle('git:call', async (_e, { name, root, args }) => {
    const handler = GIT[name];
    if (!handler) return { ok: false, error: `No such git action: ${name}` };
    if (!root) return { ok: false, error: 'No folder.' };
    try {
      const result = await handler(root, args ?? {});
      // The plain verbs come back as a run() result; give them all one shape.
      if (result && typeof result === 'object') return result;
      return { ok: true, value: result ?? null };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  ipcMain.handle('db:sessions', (_e, options) => db.listSessions(options || {}));
  ipcMain.handle('db:session', (_e, id) => db.getSession(id));
  ipcMain.handle('db:handoffs', (_e, limit) => db.listHandoffs(limit || 100));

  /**
   * Bring a closed session back on a different account: file a copy of its
   * conversation under that account first, so the resume there has something to
   * find. Answers with where the copy landed, since the folder the conversation
   * belongs to is not always the one the session was last seen in.
   */
  ipcMain.handle('db:carry-over', (_e, { sessionId, profileId }) => {
    const row = db.getSession(sessionId);
    const target = profiles.exactly(profileId);
    if (!row || !target) return null;

    const cwd = row.lastCwd || row.startCwd;
    if (!row.claudeSessionId) return { claudeSessionId: null, cwd };

    const source = profiles.get(row.profileId);
    try {
      return context.carryOver({
        configDir: source?.configDir ?? null,
        cwd,
        claudeSessionId: row.claudeSessionId,
        targetConfigDir: target.configDir ?? null,
      });
    } catch (error) {
      // Nothing was saved for it, so there is no conversation to carry. The
      // session can still come back on that account — just without its thread.
      console.log(`[db] nothing to carry over for ${sessionId.slice(0, 8)}: ${error.message}`);
      return { claudeSessionId: null, cwd };
    }
  });
  ipcMain.handle('db:groups', (_e, options) => db.listGroups(options || {}));
  ipcMain.handle('db:recent-folders', (_e, limit) => db.recentFolders(limit || 8));

  /**
   * Groups belong to the workspace, not to a window. Every window is told about
   * every change so a group made in one is usable from all of them.
   */
  ipcMain.handle('groups:list', () => db.allGroups());
  ipcMain.on('groups:save', (event, groups) => {
    db.saveGroups(windowIdOf(event), groups);
    send('groups:changed', db.allGroups());
  });
  ipcMain.on('groups:forget', (_e, groupId) => {
    db.deleteGroup(groupId);
    send('groups:changed', db.allGroups());
  });

  /** Everything running anywhere, so a window can show what the others hold. */
  ipcMain.handle('sessions:roster', () => roster());

  /**
   * End a session from anywhere, including a window that is not this one. The pty
   * is killed here and the owning window is told, so its tab goes with it rather
   * than being left behind pointing at a dead process.
   */
  ipcMain.handle('sessions:stop', (_e, sessionId) => {
    let stopped = false;
    for (const [ptyId, owner] of sessionByPty) {
      if (owner !== sessionId) continue;
      ptys.kill(ptyId);
      sessionByPty.delete(ptyId);
      stopped = true;
    }
    liveSessions.delete(sessionId);
    db.endSession(sessionId, null);
    send('session:stopped', { sessionId });
    announceRoster();
    return stopped;
  });
  ipcMain.on('window:focus', (_e, windowId) => {
    const win = windows.get(windowId);
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  ipcMain.handle('db:group-members', (_e, groupId) => db.groupMembers(groupId));
  ipcMain.handle('db:delete-group', (_e, groupId) => db.deleteGroup(groupId));
  ipcMain.handle('db:delete-session', (_e, sessionId) => {
    const removed = db.deleteSession(sessionId);
    // Its saved conversation goes with it; nothing is left pointing at nothing.
    if (removed) {
      context.forget(sessionId);
      monitor?.forget(sessionId);
    }
    return removed;
  });
  ipcMain.handle('db:clear-history', (_e, options) => {
    const removed = db.clearHistory(options || {});
    // Their saved conversations go with them; nothing is left pointing at nothing.
    for (const id of removed) {
      context.forget(id);
      monitor?.forget(id);
    }
    return removed.length;
  });
  ipcMain.handle('db:excerpts', (_e, { sessionId, query }) => db.searchInSession(sessionId, query));
  ipcMain.handle('db:store-transcript', (_e, { sessionId, enabled }) => {
    db.updateSession(sessionId, { storeTranscript: enabled });
    context.setRecording(sessionId, enabled);
    if (!enabled) db.forgetTranscript(sessionId);
    else context.ingestInto(db, sessionId);
    return db.getSession(sessionId);
  });
  ipcMain.on('db:command-output', (_e, withCommands) => context.setCommandOutput(withCommands));
  ipcMain.on('db:record-default', (_e, enabled) => {
    recordByDefault = enabled;
  });
  ipcMain.handle('db:storage', () => {
    const stats = db.storageStats();
    const file = path.join(app.getPath('userData'), 'smart-terminal.db');
    let onDisk = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        onDisk += fs.statSync(file + suffix).size;
      } catch {
        /* the wal and shm files only exist while the database is open */
      }
    }
    return { ...stats, onDisk, snapshotBytes: context.diskUsage() };
  });
  ipcMain.handle('db:forget-all-transcripts', () => {
    const removed = db.forgetAllTranscripts();
    for (const [id] of context.tracked) context.setRecording(id, false);
    // The saved JSONL copies are the other half of "stored"; leaving any behind
    // would mean the space never comes back. A session still recording will start
    // a fresh copy on its next turn, which is what recording means.
    const files = context.forgetAllExcept([]);
    return { entries: removed, snapshots: files };
  });
  ipcMain.handle('db:transcript', (_e, { sessionId, limit }) => db.readTranscript(sessionId, limit || 2000));
  ipcMain.on('db:cwd', (_e, { sessionId, cwd }) => db.updateSession(sessionId, { lastCwd: cwd }));
  ipcMain.on('db:resume-command', (_e, { sessionId, on }) => {
    db.updateSession(sessionId, { resumeCommand: on ? 1 : 0 });
  });

  ipcMain.on('db:rename', (_e, { sessionId, title }) => {
    db.updateSession(sessionId, { title });
    announceRoster();
  });
  ipcMain.on('db:end-session', (_e, { sessionId, exitCode }) => {
    liveSessions.delete(sessionId);
    autopilot?.forget(sessionId);
    // Anything still queued for it would be delivered to nobody.
    db.dropMessagesFor(sessionId);
    screenBySession.delete(sessionId);
    lastOutputBySession.delete(sessionId);
    for (const [ptyId, owner] of sessionByPty) if (owner === sessionId) sessionByPty.delete(ptyId);
    db.endSession(sessionId, exitCode ?? null);
    announceRoster();
  });
  ipcMain.on('db:handoff', (_e, entry) => db.recordHandoff(entry));

  ipcMain.on('autopilot:screen', (_e, { sessionId, text }) => {
    // Kept for the message bridge too: the screen is the only place some questions
    // ever appear, and typing a message into one of those answers it instead.
    screenBySession.set(sessionId, text || '');
    autopilot.setScreen(sessionId, text);
  });

  ipcMain.handle('autopilot:set', (_e, { sessionId, on }) => {
    autopilot.set(sessionId, Boolean(on));
    return autopilot.isOn(sessionId);
  });

  ipcMain.on('window:new', () => createWindow());
  ipcMain.handle('app:version', () => buildInfo);
  ipcMain.handle('system:homedir', () => os.homedir());
  ipcMain.handle('system:paths', () => ({ home: os.homedir(), accountsRoot: accountsRoot() }));
  ipcMain.handle('system:pick-directory', async (event, startIn) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender) ?? undefined, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: startIn || os.homedir(),
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.on('system:open-external', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

app.setAboutPanelOptions({
  applicationName: 'Smart Terminal',
  applicationVersion: `${buildInfo.version}${buildInfo.build ? ` (build ${buildInfo.build})` : ''}`,
  version: buildInfo.builtAt ? new Date(buildInfo.builtAt).toLocaleString() : '',
  credits: `Electron ${buildInfo.electron} · Node ${buildInfo.node}`,
});

if (isPrimaryInstance) app.whenReady().then(() => {
  profiles = new ProfileStore();
  db = new Database();
  // Anything still marked running belongs to a previous launch that did not get
  // to close cleanly; the rows are closed so their duration is not open-ended.
  const crashed = db.closeStaleSessions();
  if (crashed.length) console.log(`[db] closed ${crashed.length} session(s) left open by a previous run`);
  db.prune();

  workspace = new JsonStore('workspace.json', { layout: null, sessions: [], settings: {} });
  migrateWorkspaceIntoDb();
  retireLegacyWorkspace();
  ptys = new PtyManager((channel, payload) => {
    // Every chunk a session prints resets its quiet clock, which is how autopilot
    // tells a session that is still thinking from one that has stopped.
    if (channel === 'pty:data') {
      const owner = sessionByPty.get(payload.id);
      if (owner) {
        autopilot.noteOutput(owner);
        lastOutputBySession.set(owner, Date.now());
      }
    }
    send(channel, payload);
  });

  autopilot = new Autopilot({
    readTurn: (sessionId) => {
      const row = db.getSession(sessionId);
      if (!row?.claudeSessionId) return null;
      const profile = profiles.get(row.profileId);
      const found = locateTranscript(profile?.configDir ?? null, row.claudeSessionId, [
        row.lastCwd,
        row.startCwd,
      ]);
      return found ? readTurnState(found.file) : null;
    },
    send: (sessionId, text) => {
      for (const [ptyId, owner] of sessionByPty) {
        if (owner !== sessionId) continue;
        ptys.write(ptyId, text);
        return true;
      }
      return false;
    },
    isClaudeUp: (sessionId) => {
      for (const [ptyId, owner] of sessionByPty) {
        if (owner !== sessionId) continue;
        return Boolean(foregroundByPty.get(ptyId)?.foreground?.includes('claude'));
      }
      return false;
    },
    emit: (sessionId, state) => send('autopilot:state', { sessionId, ...state }),
  });
  cwdWatcher = new CwdWatcher(
    () => ptys.list(),
    (changes) => {
      for (const change of changes) {
        if (change.foreground) foregroundByPty.set(change.id, change);
        else foregroundByPty.delete(change.id);

        /*
         * Remember what a session is running, so it can be offered back after a
         * restart. Only something worth restarting: the shell itself is not a
         * command, and Claude is already brought back by its own machinery.
         */
        const owner = sessionByPty.get(change.id);
        if (owner && change.command && worthRemembering(change.foreground, change.command)) {
          db.updateSession(owner, { lastCommand: change.command });
        }
      }
      send('pty:cwd', changes);
    },
  );
  // Adoption is retried rather than done once: a conversation has no transcript
  // until its first turn, which is usually well after Claude starts.
  adoptionSweep = setInterval(() => {
    for (const change of foregroundByPty.values()) adoptStartedByHand(change);
  }, 5000);
  adoptionSweep.unref?.();
  cwdWatcher.start();
  startMessaging();
  fileWatcher = new FileWatcher((changes) => send('files:changed', changes));
  context = new ContextStore(db);
  // Watching how sessions behave is a separate job from keeping copies of them,
  // but it needs the same two things — where a transcript is, and which sessions
  // have one — so it is handed the store rather than working them out again.
  monitor = new SessionMonitor({
    context,
    db,
    conversationOf: (sessionId) => db.getSession(sessionId)?.claudeSessionId ?? null,
    emit: (sessionId, verdict) => {
      send('analysis:changed', { sessionId, verdict });
      tellIfSerious(sessionId, verdict);
    },
  });
  monitor.start();

  // What shipped with the app starts installed; after that the table is the
  // record of what was decided, and something new arriving later is an offer.
  try {
    db.seedExtensions(builtInExtensions());
  } catch {
    /* the gallery still works; nothing is on until it is chosen */
  }

  // Judgement, kept apart from measurement on purpose. One shot of `claude -p`
  // per reading: no conversation, so it cannot become the kind of session it is
  // there to warn about.
  advisor = new Advisor({
    profileFor: (profileId) => profiles.get(profileId ?? advisorProfileId ?? undefined) ?? null,
    verdictFor: (sessionId) => monitor.read(sessionId),
    nameFor: (sessionId) => db.getSession(sessionId)?.title ?? 'the session',
  });
  context.start();
  // Saved conversations whose session row is gone are dead weight from a crash.
  const orphans = context.sweepOrphans(db.allSessionIds());
  if (orphans) console.log(`[db] removed ${orphans} orphaned conversation copies`);

  registerIpc();
  buildMenu(sendToFocused, () => createWindow());

  // Bring back every window that was open, the way an editor does.
  const previous = db.openWindows();
  if (previous.length) previous.forEach(({ id, bounds }) => createWindow(id, bounds));
  else createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  ptys?.killAll();
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Open the channel sessions talk to each other on, and write the MCP config that
 * points them at it.
 *
 * The config is one static file for the whole app. It can be, because the only
 * thing that differs between sessions — which session this is — reaches the MCP
 * server through the environment it inherits. Attaching it to every Claude
 * session regardless of the current reach is deliberate: the reach is enforced
 * when a tool is called, so turning messaging on or off is immediate instead of
 * something that only applies to sessions started afterwards.
 */
function startMessaging() {
  const dir = app.getPath('userData');
  mcpConfigPath = path.join(dir, 'mcp-sessions.json');

  // Packaged, the app's own files live inside an asar that a plain-node child
  // cannot read, so the server script is unpacked beside it.
  const script = path.join(__dirname, 'group-mcp.js').replace(
    `app.asar${path.sep}`,
    `app.asar.unpacked${path.sep}`,
  );
  const socketPath = socketPathFor(dir);

  // Packaged, this lives inside the asar, which `node` in a hook cannot read —
  // the same reason the MCP server is unpacked beside it.
  const plugin = path.join(__dirname, '..', 'plugin').replace(
    `app.asar${path.sep}`,
    `app.asar.unpacked${path.sep}`,
  );
  pluginPath = fs.existsSync(path.join(plugin, '.claude-plugin', 'plugin.json')) ? plugin : null;
  if (!pluginPath) console.log('[hooks] the plugin folder is not there; sessions will run without it');

  try {
    fs.writeFileSync(
      mcpConfigPath,
      `${JSON.stringify(
        {
          mcpServers: {
            'smart-terminal': {
              command: process.execPath,
              args: [script],
              // Electron's own binary is the only node this app is sure to have.
              env: { ELECTRON_RUN_AS_NODE: '1', SMART_TERMINAL_BRIDGE: socketPath },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    console.log(`[messages] could not write the MCP config: ${error.message}`);
    mcpConfigPath = null;
  }

  messages = new MessageBridge({
    socketPath,
    reach: () => messagingReach,
    roster: liveRoster,
    write: (sessionId, text) => {
      for (const [ptyId, owner] of sessionByPty) {
        if (owner !== sessionId) continue;
        ptys.write(ptyId, text);
        return true;
      }
      return false;
    },
    isFree: sessionIsFree,
    onHook: (request) => handleHook(request),
    // Sessions the app knows but is not running. Without this, a message to a
    // session that has ended comes back as "no such session", which is false and
    // leaves the sender nothing to do but try again.
    lookup: (query) => {
      const row = db.findSession(query);
      return row ? { id: row.id, title: row.title, endedAt: row.endedAt ?? null } : null;
    },
    // A session asking how it is going gets the monitor's own reading, in prose.
    // Free to answer: the reading already exists, and nothing here is a request.
    health: (sessionId, { brief = false } = {}) => {
      const verdict = monitor?.read(sessionId);
      if (!verdict) return null;
      const name = db.getSession(sessionId)?.title ?? 'session';
      // Asking about yourself is worth the whole reading; asking about the others
      // is a roster, and six paragraphs of someone else's numbers is not one.
      return brief ? oneLine(verdict, name) : summarise(verdict, { name: 'You' });
    },
    store: {
      queue: (message) => db.queueMessage(message),
      pending: (to, options) => db.messagesFor(to, options),
      markDelivered: (ids) => db.markMessagesDelivered(ids),
      markRead: (ids) => db.markMessagesRead(ids),
    },
  });
  messages.start();
}

/**
 * Where the channel listens.
 *
 * A unix socket path is capped at around 104 bytes on macOS, and the cap counts
 * the whole path. The app's data directory is normally well inside it, but it is
 * chosen by whoever launches the app — the isolated-instance recipe points it at
 * a temp folder — and one character over the line makes `listen` fail with a bare
 * EINVAL, leaving every session with tools that cannot reach anything. So a long
 * one falls back to a short name in the temp directory, keyed by the data
 * directory it belongs to: two instances must never share a socket, or a session
 * in one would be addressable from the other.
 */
function socketPathFor(dir) {
  const preferred = path.join(dir, 'sessions.sock');
  if (Buffer.byteLength(preferred) <= 100) return preferred;
  const key = createHash('sha1').update(dir).digest('hex').slice(0, 10);
  const fallback = path.join(os.tmpdir(), `smart-terminal-${key}.sock`);
  console.log(`[messages] ${preferred} is too long for a socket; using ${fallback}`);
  return fallback;
}

/** Every live session, as the thing on the other end of the channel sees it. */
/**
 * Tell a session, in its own conversation, that it has gone badly wrong.
 *
 * Off unless asked for, because it writes into a running session — and even then
 * only for the worst grade of finding, at most twice an hour, and only through
 * the bridge, which waits until the session is at its prompt. The note names the
 * one finding and its fix; a session does not need the whole report to act.
 */
function tellIfSerious(sessionId, verdict) {
  if (!tellSessions || !messages) return;
  if (!verdict?.ok || verdict.worst !== 'high') return;
  const last = told.get(sessionId) ?? 0;
  if (Date.now() - last < TELL_COOLDOWN_MS) return;
  const finding = verdict.findings.find((entry) => entry.severity === 'high');
  if (!finding) return;
  told.set(sessionId, Date.now());
  messages.note(sessionId, `${finding.title}. ${finding.detail}\n\n${finding.suggestion}`, {
    subject: 'this session',
  });
}

/**
 * The extensions that came with the app.
 *
 * Read from disk on every ask rather than cached: in development the folder is
 * the repository, and having to restart the app to see a manifest you just
 * edited is exactly the friction that stops anyone writing one.
 */
function builtInExtensions() {
  const roots = [
    { root: path.join(app.getAppPath(), 'extensions'), builtIn: true },
    { root: path.join(app.getPath('userData'), 'extensions'), builtIn: false },
  ];
  const found = [];
  const seen = new Set();
  for (const { root, builtIn } of roots) {
    for (const manifest of discover(root, { builtIn })) {
      // The user's own copy of an id wins: it is the one they put there.
      if (seen.has(manifest.id)) continue;
      seen.add(manifest.id);
      found.push(manifest);
    }
  }
  return found;
}

/** The gallery, and the rules the renderer needs to act on it. */
function extensionState() {
  const rows = gallery(builtInExtensions(), db.installedExtensions());
  // The renderer needs the code, not a path to it: it runs in a worker built
  // from a blob, which has no filesystem to read one from.
  return {
    rows,
    previews: withSources(previewRules(rows)),
    panels: withPanelSources(panelViews(rows)),
  };
}

/** Answer the caller and tell every window, since this changes what files open as. */
function sendExtensions() {
  const state = extensionState();
  send('extensions:changed', state);
  return state;
}

/**
 * Claude just told us something. Do whatever that means, and answer.
 *
 * Everything here is best-effort and none of it may throw: the session is
 * waiting on this, and an exception in the app's bookkeeping must not be
 * something a person feels while working. The reply is the only part Claude
 * ever sees, and for three of the four events it is deliberately empty.
 */
function handleHook(request) {
  const report = parseReport(request);
  if (!report.ok) return { ok: false, error: report.error, reply: {} };

  // The app's own id where it has one; otherwise place the session by the
  // conversation, which is how a session somebody started by hand is found.
  let sessionId = report.session && db.getSession(report.session) ? report.session : null;
  if (!sessionId && report.conversation) {
    sessionId = liveRoster().find((entry) => entry.conversation === report.conversation)?.id ?? null;
  }
  if (!sessionId) return { ok: true, reply: {}, detail: 'not a session this app is following' };
  if (process.env.SMART_TERMINAL_DEV === '1') {
    console.log(`[hooks] ${report.event}${report.source ? ` (${report.source})` : ''} from ${sessionId.slice(0, 8)}`);
  }

  try {
    if (report.event === 'PreCompact') {
      // The moment, and only the moment. What was in the context is
      // reconstructed from the transcript afterwards and reconstructed exactly;
      // what cannot be had later is that this is happening *now*, whether it
      // was asked for, and what a manual compaction was told to keep.
      context?.snapshot(sessionId, { force: true });
      monitor?.read(sessionId, { force: true });
      pendingCompaction.set(sessionId, compactionNote(report));
    }

    if (report.event === 'Stop') {
      // A turn ended. The monitor reads on a timer and would have found this
      // within the sweep; being told means the reading is never stale at the
      // one moment somebody is most likely to be looking at it.
      monitor?.read(sessionId, { force: true });
    }

    if (report.event === 'SessionEnd') {
      context?.snapshot(sessionId, { force: true });
    }

    if (wantsBrief(report)) {
      const entry = db.getBrief(sessionId);
      const row = db.getSession(sessionId);
      const carried = renderBrief(entry, { name: row?.title ?? null, command: null });
      if (carried) {
        if (process.env.SMART_TERMINAL_DEV === '1') {
          console.log(`[hooks] handed ${sessionId.slice(0, 8)} its brief after ${report.source} (${carried.length} chars)`);
        }
        return {
          ok: true,
          reply: replyFor(report, carried),
          detail: `handed ${sessionId} its brief after ${report.source}`,
        };
      }
    }
  } catch (error) {
    // Said out loud in the log and nowhere else: the session carries on.
    console.log(`[hooks] ${report.event} for ${sessionId}: ${error.message}`);
  }

  return { ok: true, reply: {} };
}

/**
 * What a compaction was told, waiting for the transcript to catch up.
 *
 * `PreCompact` fires before the compaction is written down, so what it knows —
 * the trigger, the instructions — arrives before the row it belongs to exists.
 * It is held here until the monitor files that compaction.
 */
const pendingCompaction = new Map();

function liveRoster() {
  const groupNames = new Map(db.listGroups({ limit: 500 }).map((group) => [group.id, group.name]));
  const roster = [];
  for (const sessionId of liveSessions) {
    const row = db.getSession(sessionId);
    if (!row) continue;
    const cwd = row.lastCwd || row.startCwd || '';
    roster.push({
      id: sessionId,
      name: row.title || path.basename(cwd) || 'session',
      profile: profiles.get(row.profileId)?.name ?? 'account',
      cwd,
      // The conversation behind the session, so one session can point another at
      // an exact thread rather than describing it — and so anyone reading a
      // roster can match a tab to a transcript on disk.
      conversation: row.claudeSessionId ?? null,
      groupId: row.groupId ?? null,
      groupName: row.groupId ? (groupNames.get(row.groupId) ?? null) : null,
      state: describeSession(sessionId),
    });
  }
  return roster;
}

/** A short, honest word for what a session is doing, for the roster. */
function describeSession(sessionId) {
  if (!claudeIsUp(sessionId)) return 'not running Claude right now';
  if (Date.now() - (lastOutputBySession.get(sessionId) ?? 0) < 2500) return 'working';
  if (looksLikeADecision(screenBySession.get(sessionId))) return 'stopped, waiting on the user';
  const turn = turnStateOf(sessionId);
  if (turn?.state === 'awaiting-decision') return 'stopped, waiting on the user';
  if (turn?.state === 'turn-finished') return 'idle at its prompt';
  return 'busy';
}

function claudeIsUp(sessionId) {
  for (const [ptyId, owner] of sessionByPty) {
    if (owner !== sessionId) continue;
    return Boolean(foregroundByPty.get(ptyId)?.foreground?.includes('claude'));
  }
  return false;
}

function turnStateOf(sessionId) {
  const row = db.getSession(sessionId);
  if (!row?.claudeSessionId) return null;
  const profile = profiles.get(row.profileId);
  const found = locateTranscript(profile?.configDir ?? null, row.claudeSessionId, [
    row.lastCwd,
    row.startCwd,
  ]);
  return found ? readTurnState(found.file) : null;
}

/**
 * Whether a message may be typed into this session right now.
 *
 * Every one of these is a veto, and the order is the order autopilot learned:
 * the screen first, because a dialog leaves no trace in the transcript and
 * typing into one answers it rather than delivering anything.
 */
function sessionIsFree(sessionId) {
  if (!claudeIsUp(sessionId)) return false;
  // Still printing: the input box is not where the keystrokes would land.
  if (Date.now() - (lastOutputBySession.get(sessionId) ?? 0) < 2500) return false;
  if (looksLikeADecision(screenBySession.get(sessionId))) return false;
  return turnStateOf(sessionId)?.state === 'turn-finished';
}

/** One-time move of the old JSON workspace into the database. */
function migrateWorkspaceIntoDb() {
  if (db.openWindows().length) return;
  const legacy = workspace.get();
  if (!legacy?.layout) return;
  db.saveWorkspace('main', { layout: legacy.layout, settings: legacy.settings, activeLeaf: null });
  for (const session of legacy.sessions || []) {
    db.openSession({
      id: session.id,
      profileId: session.profileId,
      profileName: profiles.get(session.profileId)?.name ?? null,
      claudeSessionId: session.claudeSessionId ?? null,
      kind: session.kind,
      title: session.customTitle ?? null,
      startCwd: session.cwd,
    });
    db.endSession(session.id, null);
  }
  console.log('[db] migrated the previous workspace');
}

/**
 * Typing `claude` into a tab is the normal way to work, and the app has no hand in
 * it. Noticing that a session is running one lets it be treated like any other:
 * continued later, moved to another account, read back.
 */
function adoptStartedByHand({ id, cwd, foreground }) {
  if (!foreground || !foreground.includes('claude')) return;

  // A shell session is never "tracked" until it turns out to be running Claude,
  // so the pty has to be resolved from the launch record, not from tracking.
  const sessionId = sessionByPty.get(id);
  if (!sessionId) return;
  const row = db.getSession(sessionId);
  if (!row || row.claudeSessionId) return;

  const profile = profiles.get(row.profileId);
  const workdir = cwd || row.lastCwd || row.startCwd;
  const found = context.adopt(sessionId, {
    configDir: profile?.configDir ?? null,
    cwd: workdir,
    startedAt: row.startedAt,
    // Two sessions in the same folder would otherwise both claim the newest
    // transcript, and one conversation cannot belong to two terminals.
    taken: claimedConversations(sessionId),
  });
  if (!found) return;

  db.updateSession(sessionId, { claudeSessionId: found });
  // Now that there is a conversation, follow it like any other.
  context.track(sessionId, {
    claudeSessionId: found,
    cwd: workdir,
    configDir: profile?.configDir ?? null,
    profileId: row.profileId,
    record: Boolean(row.storeTranscript) || recordByDefault,
    withCommands: true,
    ptyId: id,
  });
  send('pty:adopted', { sessionId, claudeSessionId: found });
  console.log(`[db] adopted the conversation started by hand in ${sessionId.slice(0, 8)}`);
}

/** What is running, described the way it matters when deciding to close. */
function runningIn(windowId = null) {
  const rows = [...liveSessions]
    .map((id) => db.getSession(id))
    .filter((row) => row && (!windowId || row.windowId === windowId));
  return {
    total: rows.length,
    claude: rows.filter((row) => row.kind === 'claude' || row.claudeSessionId).length,
  };
}

/**
 * Closing takes running work down with it, so it is worth a question — but only
 * when there is something to lose. The wording says how much, and what survives:
 * the conversations are saved, which is the part people actually worry about.
 */
async function confirmClosing(parent, { total, claude }, scope) {
  const sessions = `${total} session${total === 1 ? '' : 's'}`;
  const kept =
    claude > 0
      ? `\n\nThe ${claude === total ? '' : `${claude} `}Claude conversation${claude === 1 ? '' : 's'} ${claude === 1 ? 'is' : 'are'} saved — you can continue ${claude === 1 ? 'it' : 'them'} later from History.`
      : '';

  const { response } = await dialog.showMessageBox(parent ?? undefined, {
    type: 'warning',
    buttons: [scope === 'window' ? 'Close window' : 'Quit', 'Keep working'],
    defaultId: 1,
    cancelId: 1,
    message:
      scope === 'window'
        ? `Close this window and end ${sessions}?`
        : `Quit and end ${sessions}?`,
    detail: `Whatever those terminals are running stops.${kept}`,
  });
  return response === 0;
}

/** Conversations already spoken for by another live session. */
function claimedConversations(exceptSessionId) {
  const claimed = new Set();
  for (const id of liveSessions) {
    if (id === exceptSessionId) continue;
    const conversation = db.getSession(id)?.claudeSessionId;
    if (conversation) claimed.add(conversation);
  }
  return claimed;
}

/** Live sessions across every window, for the lists that show more than one. */
function roster() {
  return [...liveSessions]
    .map((id) => db.getSession(id))
    .filter(Boolean)
    .map((row) => ({
      id: row.id,
      windowId: row.windowId,
      profileId: row.profileId,
      profileName: row.profileName,
      title: row.title,
      cwd: row.lastCwd || row.startCwd,
      kind: row.kind,
      groupId: row.groupId,
    }));
}

let rosterTimer = null;
/** Coalesced: a burst of session changes should cost one broadcast, not ten. */
function announceRoster() {
  clearTimeout(rosterTimer);
  rosterTimer = setTimeout(() => send('sessions:roster', roster()), 250);
}

/** Once migrated, the old JSON file is a stale second copy of the same data. */
function retireLegacyWorkspace() {
  const file = path.join(app.getPath('userData'), 'workspace.json');
  try {
    if (db.openWindows().length && fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      console.log('[db] removed the superseded workspace.json');
    }
  } catch {
    /* leaving it costs nothing but a few KB */
  }
}

app.on('before-quit', (event) => {
  if (!quitConfirmed) {
    const running = runningIn();
    if (running.total) {
      event.preventDefault();
      confirmClosing(BrowserWindow.getFocusedWindow(), running, 'app').then((confirmed) => {
        if (!confirmed) return;
        quitConfirmed = true;
        // Quitting again from inside a cancelled quit is ignored; letting the
        // current sequence unwind first makes the second one take.
        setImmediate(() => app.quit());
      });
      return;
    }
  }

  isQuitting = true;
  // Re-assert every window still on screen as open. Relying on the close handler
  // to skip itself is one flag away from losing a window on the next launch, and
  // a window that does not come back takes its whole layout with it.
  for (const [id, win] of windows) {
    if (win.isDestroyed()) continue;
    const stored = db?.loadWorkspace(id);
    db?.saveWorkspace(id, {
      layout: stored?.layout ?? null,
      settings: stored?.settings ?? {},
      activeLeaf: stored?.activeLeaf ?? null,
      groups: stored?.groups ?? [],
      minimized: stored?.minimized ?? [],
      bounds: win.getBounds(),
    });
  }

  // One last copy of every conversation before the processes go away.
  context?.snapshotAll();
  context?.stop();
  for (const sessionId of liveSessions) db?.endSession(sessionId, null);
  db?.close();
  clearInterval(adoptionSweep);
  cwdWatcher?.stop();
  ptys?.killAll();
});
