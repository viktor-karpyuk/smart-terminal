'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** Subscribe helper that returns an unsubscribe function. */
function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

/** Which window this renderer is, passed in when the window was created. */
const windowId =
  process.argv.find((arg) => arg.startsWith('--smart-terminal-window='))?.split('=')[1] ?? 'main';

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  windowId,
  newWindow: () => ipcRenderer.send('window:new'),
  version: () => ipcRenderer.invoke('app:version'),

  pty: {
    create: (options) => ipcRenderer.invoke('pty:create', options),
    write: (id, data) => ipcRenderer.send('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('pty:kill', { id }),
    releaseOrphans: () => ipcRenderer.send('pty:release-orphans'),
    launchLine: (sessionId, profileId) =>
      ipcRenderer.invoke('pty:launch-line', { sessionId, profileId }),
    reassign: (sessionId, profileId) =>
      ipcRenderer.invoke('session:reassign', { sessionId, profileId }),
    onData: (handler) => on('pty:data', handler),
    onExit: (handler) => on('pty:exit', handler),
    onCwd: (handler) => on('pty:cwd', handler),
    onAdopted: (handler) => on('pty:adopted', handler),
    autopilot: (sessionId, on) => ipcRenderer.invoke('autopilot:set', { sessionId, on }),
    reportScreen: (sessionId, text) => ipcRenderer.send('autopilot:screen', { sessionId, text }),
    onAutopilot: (handler) => on('autopilot:state', handler),
  },

  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    save: (profile) => ipcRenderer.invoke('profiles:save', profile),
    remove: (id) => ipcRenderer.invoke('profiles:remove', id),
    discover: () => ipcRenderer.invoke('profiles:discover'),
    suggestConfigDirs: (name) => ipcRenderer.invoke('profiles:suggest-config-dirs', name),
    ensureConfigDir: (dir) => ipcRenderer.invoke('profiles:ensure-config-dir', dir),
  },

  auth: {
    status: (profile, force = false) => ipcRenderer.invoke('auth:status', { profile, force }),
  },

  usage: {
    read: (profileId, force = false) => ipcRenderer.invoke('usage:read', { profileId, force }),
  },

  context: {
    info: (sessionId) => ipcRenderer.invoke('context:info', sessionId),
    save: (sessionId) => ipcRenderer.invoke('context:save', sessionId),
    handoff: (payload) => ipcRenderer.invoke('context:handoff', payload),
    forget: (sessionId) => ipcRenderer.send('context:forget', sessionId),
    release: (sessionId) => ipcRenderer.send('context:release', sessionId),
  },

  groups: {
    list: () => ipcRenderer.invoke('groups:list'),
    save: (groups) => ipcRenderer.send('groups:save', groups),
    forget: (groupId) => ipcRenderer.send('groups:forget', groupId),
    onChanged: (handler) => on('groups:changed', handler),
  },

  sessions: {
    roster: () => ipcRenderer.invoke('sessions:roster'),
    stop: (sessionId) => ipcRenderer.invoke('sessions:stop', sessionId),
    onStopped: (handler) => on('session:stopped', handler),
    onRoster: (handler) => on('sessions:roster', handler),
    focusWindow: (windowId) => ipcRenderer.send('window:focus', windowId),
  },

  history: {
    sessions: (options) => ipcRenderer.invoke('db:sessions', options),
    session: (id) => ipcRenderer.invoke('db:session', id),
    handoffs: (limit) => ipcRenderer.invoke('db:handoffs', limit),
    carryOver: (sessionId, profileId) =>
      ipcRenderer.invoke('db:carry-over', { sessionId, profileId }),
    deleteSession: (sessionId) => ipcRenderer.invoke('db:delete-session', sessionId),
    clearHistory: (options) => ipcRenderer.invoke('db:clear-history', options),
    groups: (options) => ipcRenderer.invoke('db:groups', options),
    recentFolders: (limit) => ipcRenderer.invoke('db:recent-folders', limit),
    groupMembers: (groupId) => ipcRenderer.invoke('db:group-members', groupId),
    deleteGroup: (groupId) => ipcRenderer.invoke('db:delete-group', groupId),
    excerpts: (sessionId, query) => ipcRenderer.invoke('db:excerpts', { sessionId, query }),
    setStoreTranscript: (sessionId, enabled) =>
      ipcRenderer.invoke('db:store-transcript', { sessionId, enabled }),
    transcript: (sessionId, limit) => ipcRenderer.invoke('db:transcript', { sessionId, limit }),
    storage: () => ipcRenderer.invoke('db:storage'),
    setCommandOutput: (withCommands) => ipcRenderer.send('db:command-output', withCommands),
    setRecordDefault: (enabled) => ipcRenderer.send('db:record-default', enabled),
    forgetAllTranscripts: () => ipcRenderer.invoke('db:forget-all-transcripts'),
    rename: (sessionId, title) => ipcRenderer.send('db:rename', { sessionId, title }),
    updateCwd: (sessionId, cwd) => ipcRenderer.send('db:cwd', { sessionId, cwd }),
    endSession: (sessionId, exitCode) => ipcRenderer.send('db:end-session', { sessionId, exitCode }),
    recordHandoff: (entry) => ipcRenderer.send('db:handoff', entry),
  },

  workspace: {
    load: () => ipcRenderer.invoke('workspace:load'),
    save: (state) => ipcRenderer.send('workspace:save', state),
  },

  system: {
    pickDirectory: (startIn) => ipcRenderer.invoke('system:pick-directory', startIn),
    homedir: () => ipcRenderer.invoke('system:homedir'),
    paths: () => ipcRenderer.invoke('system:paths'),
    openExternal: (url) => ipcRenderer.send('system:open-external', url),
  },

  onMenuAction: (handler) => on('menu:action', handler),
});
