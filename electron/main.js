'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { randomUUID } = require('node:crypto');

const { PtyManager, claudeLaunchLine } = require('./pty-manager');
const { readUsage } = require('./usage');
const { ProfileStore, discoverAccountDirs } = require('./profiles');
const { accountsRoot, authStatus, ensureConfigDir, invalidateAuthCache, suggestConfigDirs } = require('./auth');
const { JsonStore } = require('./store');
const { Database } = require('./database');
const { buildMenu } = require('./menu');
const { CwdWatcher } = require('./cwd-watcher');
const { ContextStore, transcriptPath, locateTranscript, readTurnState } = require('./context-store');
const { Autopilot } = require('./autopilot');
const { tabsInLayout, sessionsToRestore, unaccountedTabs } = require('./restore');

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

/** Keeps sessions moving when the only thing stopping them is nobody saying "go". */
let autopilot = null;
/** Every pty this launch started, and the session it belongs to. */
const sessionByPty = new Map();
/** Mirrors the renderer's preference, so an adopted session starts recording too. */
let recordByDefault = true;
let context = null;
let db = null;
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

    const result = ptys.create({
      profile,
      cwd: workdir,
      kind,
      cols: options.cols,
      rows: options.rows,
      extraArgs,
      command: options.command || null,
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

  ipcMain.on('pty:write', (_e, { id, data }) => ptys.write(id, data));
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
    const rows = db.sessionsForRestore(tabsInLayout(stored.layout), windowId);
    const missing = unaccountedTabs(stored.layout, rows);
    if (missing.length) {
      console.log(`[workspace] ${missing.length} pane(s) name a session with no row left`);
    }
    return {
      layout: stored.layout,
      settings: stored.settings,
      groups: stored.groups ?? [],
      // Which sessions to bring back, and what each was in the middle of.
      sessions: sessionsToRestore({
        windowId,
        layout: stored.layout,
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
          handoffFrom: null,
        })),
    };
  });

  ipcMain.on('workspace:save', (event, state) => {
    const windowId = windowIdOf(event);
    if (!windowId) return;
    // Written on every change: a crash then costs at most the last few hundred ms.
    db.saveWorkspace(windowId, {
      layout: state.layout,
      settings: state.settings,
      activeLeaf: state.activeLeaf ?? null,
      groups: state.groups ?? [],
    });
    db.saveGroups(windowId, state.groups ?? []);
    for (const session of state.sessions ?? []) {
      db.updateSession(session.id, { groupId: session.groupId ?? null });
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
    if (removed) context.forget(sessionId);
    return removed;
  });
  ipcMain.handle('db:clear-history', (_e, options) => {
    const removed = db.clearHistory(options || {});
    // Their saved conversations go with them; nothing is left pointing at nothing.
    for (const id of removed) context.forget(id);
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
  ipcMain.on('db:rename', (_e, { sessionId, title }) => {
    db.updateSession(sessionId, { title });
    announceRoster();
  });
  ipcMain.on('db:end-session', (_e, { sessionId, exitCode }) => {
    liveSessions.delete(sessionId);
    autopilot?.forget(sessionId);
    for (const [ptyId, owner] of sessionByPty) if (owner === sessionId) sessionByPty.delete(ptyId);
    db.endSession(sessionId, exitCode ?? null);
    announceRoster();
  });
  ipcMain.on('db:handoff', (_e, entry) => db.recordHandoff(entry));

  ipcMain.on('autopilot:screen', (_e, { sessionId, text }) => autopilot.setScreen(sessionId, text));

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
      if (owner) autopilot.noteOutput(owner);
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
  context = new ContextStore(db);
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
