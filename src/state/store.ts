import { create } from 'zustand';
import { FOLLOW_APP, resolveTerminalTheme } from '../terminals/themes';
import { generateSessionName } from '../lib/names';
import { arrangeGroup, moveGroupTo } from './groups';
import { closePane, movePane, panePlace, restorePaneAt, splitEmpty, splitOffTabs, swapPanes } from './layout';
import { GIT_TAB } from './types';
import type {
  Advice,
  MonitorPanel,
  Panel,
  SessionAnalysis,
  Buffer,
  FilePanel,
  GitView,
  GroupArrangement,
  MinimizedSection,
  MinimizedTab,
  PendingClose,
  SessionGroup,
} from './types';
import type { DropSide, LayoutNode, Profile, Session, SessionKind, Settings } from './types';
import type { AuthStatus, DirEntry, GitBranch, GitCommit, GitFile, GitResult, UsageReport } from '../global';
import {
  allLeaves,
  allTabs,
  dropTab,
  evenOut,
  findLeaf,
  keepOnly,
  leafOfTab,
  makeLeaf,
  setActiveTab,
  setSizes,
  splitLeaf,
  removeTab,
  insertTab,
} from './layout';
import {
  applyAppearance,
  setTerminalFontSize,
  announce,
  disposeTerminal,
  focusTerminal,
  getTerminal,
  readTail,
  writeToTerminal,
} from '../terminals/registry';

const DEFAULT_SETTINGS: Settings = {
  fontSize: 13,
  fontFamily: '"JetBrains Mono", "SF Mono", Menlo, "Fira Code", ui-monospace, monospace',
  sidebarVisible: true,
  sidebarWidth: 260,
  cursorBlink: true,
  scrollback: 20000,
  autoHandoff: true,
  defaultProfileId: null,
  recordConversations: true,
  recordCommandOutput: true,
  limitPattern:
    'usage limit reached|reached your usage limit|limit will reset|out of (?:credits|usage)|rate limit exceeded',
  theme: 'system',
  terminalPalette: FOLLOW_APP,
  terminalOverrides: {},
  sessionMessaging: 'group',
  fileIcons: 'colour',
  folderColour: '#7aa2f7',
  folderStyle: 'open-shut',
  sidebarShowSessions: true,
  sidebarShowFolders: true,
  sidebarSessionsCollapsed: false,
  sidebarFoldersCollapsed: false,
  sidebarOrder: ['sessions', 'folders'],
  sidebarSectionSizes: { sessions: 1, folders: 1 },
  sessionAlerts: true,
  sessionSuggestions: true,
  advisorProfileId: null,
  tellSessions: false,
};

/**
 * The file panel with this id, or null.
 *
 * A section can hold a folder or the monitor, and almost every caller wants the
 * first. Narrowing here rather than at each of twenty call sites keeps the check
 * in one place, and keeps a monitor tab from ever being read as a folder.
 */
export function asFilePanel(panel: Panel | undefined | null): FilePanel | null {
  return panel?.kind === 'files' ? panel : null;
}

/** What to call a section holding a panel — the dock and the tab strip both ask. */
export function panelLabel(panel: Panel | undefined | null): string {
  if (panel?.kind === 'monitor') return 'Monitor';
  const root = panel?.kind === 'files' ? panel.root : '';
  return root.split('/').filter(Boolean).pop() ?? 'section';
}

/** Whether the interface is currently dark, resolving `system` against the OS. */
export function isDarkAppearance(theme: Settings['theme']) {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function currentTerminalTheme(settings: Settings) {
  return resolveTerminalTheme(
    settings.terminalPalette,
    settings.terminalOverrides,
    isDarkAppearance(settings.theme),
  );
}

/** Recent output per session, so a limit notice split across chunks is still matched. */
const outputTails = new Map<string, string>();
const TAIL = 512;

/**
 * The limit pattern is tested against every frame of terminal output, so it is
 * compiled once per distinct pattern instead of once per frame.
 */
let compiledLimit: { source: string; regex: RegExp | null } = { source: '', regex: null };
function limitRegex(source: string): RegExp | null {
  if (compiledLimit.source !== source) {
    let regex: RegExp | null = null;
    try {
      regex = new RegExp(source, 'i');
    } catch {
      regex = null; // a hand-edited pattern that does not compile just disables the check
    }
    compiledLimit = { source, regex };
  }
  return compiledLimit.regex;
}

/** ptyId -> sessionId. A session keeps its identity across restarts; the pty does not. */
const ptyIndex = new Map<string, string>();
const busyTimers = new Map<string, number>();
/** Poll timers watching for a `claude auth login` to complete, keyed by profile id. */
const loginPolls = new Map<string, number>();
/** How often to ask again whether each account is signed in. The check is local and cheap. */
const AUTH_RECHECK_EVERY = 5 * 60 * 1000;

/** React StrictMode mounts effects twice in dev; the workspace must only boot once. */
let initStarted = false;

/** One repository's picture, refreshed rather than assumed to still be true. */
interface RepoState {
  loading: boolean;
  error: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  files: GitFile[];
  commits: GitCommit[];
  graphWidth: number;
  current: string | null;
  local: GitBranch[];
  remote: Array<{ name: string; sha: string; date: string }>;
  tags: Array<{ name: string; sha: string; date: string }>;
  stashes: Array<{ ref: string; subject: string; date: string }>;
  /** What a long-running verb is doing, and what it said when it finished. */
  busy: string | null;
  notice: { kind: 'ok' | 'warn' | 'bad'; text: string } | null;
}

interface State {
  ready: boolean;
  profiles: Profile[];
  sessions: Record<string, Session>;
  layout: LayoutNode;
  activeLeafId: string;
  /** The session in front, for anything that should follow where you are working. */
  activeSessionId: string | null;
  zoomedLeafId: string | null;
  settings: Settings;
  homedir: string;
  profileEditorOpen: boolean;
  launcherOpen: boolean;
  findOpenFor: string | null;
  renamingSessionId: string | null;
  /** Session currently being dragged, or null. Panes watch this to arm their drop overlay. */
  draggingSessionId: string | null;
  /** Group currently being dragged as a unit, or null. */
  draggingGroupId: string | null;
  /**
   * A whole section in flight, or null. Held here rather than in the pane that
   * started it: every *other* pane has to arm its drop layer, and only the one
   * being dragged would know otherwise.
   */
  draggingPaneId: string | null;
  /** Who each profile is signed in as, keyed by profile id. */
  authByProfile: Record<string, AuthStatus>;
  /** The open session context menu. Held here so one instance serves every list. */
  contextMenu: { sessionId: string; x: number; y: number } | null;
  /** Plan limits per account, and which reads are in flight. */
  usageByProfile: Record<string, UsageReport>;
  usageLoading: Record<string, boolean>;
  usagePanelOpen: boolean;
  /** The latest reading for each session, kept current by the monitor. */
  analysisBySession: Record<string, SessionAnalysis>;
  /** What the advisor last said about a session, and whether it is being asked. */
  adviceBySession: Record<string, Advice>;
  adviceAsking: Record<string, boolean>;
  /** Characters kept per open session, refreshed as they are recorded. */
  sessionSizes: Record<string, number>;
  /** Named sets of sessions that belong to the same piece of work, shared by every window. */
  groups: SessionGroup[];
  historyOpen: boolean;
  appearanceOpen: boolean;
  /** Session waiting on a close confirmation, if any. */
  pendingClose: PendingClose | null;
  /** Tabs set aside into the dock, in the order they were put there. */
  minimized: MinimizedTab[];
  /** Whole sections set aside, each remembering where it was. */
  minimizedSections: MinimizedSection[];
  /** Panels that are not sessions: a folder, its editor, and its repository. */
  panels: Record<string, Panel>;
  /**
   * What git last told us, per repository. Held apart from the panels so two
   * panels on the same repository never disagree about what is changed.
   */
  repos: Record<string, RepoState>;
  /** Open files, by path. Shared by every panel showing the same file. */
  buffers: Record<string, Buffer>;
  /** Folder listings, by path. Kept so re-opening a folder does not flicker. */
  dirs: Record<string, { entries: DirEntry[]; error: string | null; loading: boolean }>;

  init(): Promise<void>;
  newSession(options?: {
    profileId?: string;
    kind?: SessionKind;
    cwd?: string;
    leafId?: string;
    side?: DropSide;
    focus?: boolean;
    title?: string;
    resumeSessionId?: string;
    resumedFrom?: string;
    groupId?: string | null;
    handoffFrom?: { profileId: string; at: number } | null;
    lastCommand?: string | null;
    resumeCommand?: boolean;
  }): Promise<string | null>;
  closeSession(sessionId: string): void;
  restartSession(sessionId: string, options?: { fresh?: boolean }): Promise<void>;
  duplicateSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string | null): void;
  focusSession(sessionId: string, options?: { startClaude?: boolean }): void;
  setActiveLeaf(leafId: string): void;
  moveTab(tabId: string, targetLeafId: string, side: DropSide, index?: number): void;
  reorderTab(tabId: string, targetLeafId: string, index: number): void;
  splitActive(direction: 'row' | 'column'): Promise<void>;
  closePane(leafId: string): void;
  /** Put one section where another is, and the other where this one was. */
  swapSections(a: string, b: string): void;
  /** Take a whole section and put it on one side of another. */
  moveSection(paneId: string, targetLeafId: string, side: 'left' | 'right' | 'top' | 'bottom'): void;
  resizeSplit(splitId: string, sizes: number[]): void;
  evenSplits(): void;
  toggleZoom(): void;
  /** Maximize a named pane, from its own frame rather than from the title bar. */
  toggleZoomOf(leafId: string): void;
  minimizeSession(sessionId: string): void;
  /** Open a folder as a tab: tree on the left, whatever you open on the right. */
  openFilePanel(options?: { leafId?: string; side?: DropSide; root?: string; sessionId?: string }): string | null;
  closePanel(panelId: string): void;
  togglePanelTerminal(panelId: string): Promise<void>;
  setPanelTerminalHeight(panelId: string, height: number): void;
  setPanelRoot(panelId: string, root: string): void;
  /** Open Git in the content row, beside the files. */
  openGit(panelId: string): Promise<void>;
  closeGit(panelId: string): void;
  setGitView(panelId: string, view: GitView): void;
  patchPanel(panelId: string, patch: Partial<FilePanel>): void;
  refreshRepo(root: string, what?: 'status' | 'graph' | 'refs' | 'all'): Promise<void>;
  gitDo(root: string, name: string, args?: unknown, label?: string): Promise<GitResult>;
  focusPanel(leafId: string, panelId: string): void;
  loadDir(path: string): Promise<void>;
  toggleDir(panelId: string, path: string): void;
  openFile(panelId: string, path: string): Promise<void>;
  closeFile(panelId: string, path: string): void;
  setActiveFile(panelId: string, path: string): void;
  editBuffer(path: string, text: string): void;
  saveBuffer(path: string, options?: { force?: boolean }): Promise<boolean>;
  revertBuffer(path: string): void;
  sendSelectionTo(sessionId: string, path: string, text: string, from: number, to: number): void;
  minimizeSection(leafId: string): void;
  restoreSection(id: string): void;
  minimizeGroup(groupId: string): void;
  restoreMinimized(sessionId: string): void;
  restoreMinimizedGroup(groupId: string): void;
  focusDirection(direction: 'left' | 'right' | 'up' | 'down'): void;
  cycleTab(delta: number): void;
  sendInput(sessionId: string, data: string): void;
  notifyResize(sessionId: string, cols: number, rows: number): void;
  markActivity(sessionId: string): void;
  setTitle(sessionId: string, title: string): void;
  updateSettings(patch: Partial<Settings>): void;
  saveProfile(profile: Partial<Profile>): Promise<void>;
  removeProfile(id: string): Promise<void>;
  setProfileEditorOpen(open: boolean): void;
  setLauncherOpen(open: boolean): void;
  setFindOpenFor(sessionId: string | null): void;
  setRenamingSessionId(sessionId: string | null): void;
  setDraggingSessionId(sessionId: string | null): void;
  setDraggingGroupId(groupId: string | null): void;
  setDraggingPaneId(leafId: string | null): void;
  openContextMenu(sessionId: string, x: number, y: number): void;
  closeContextMenu(): void;
  refreshAuth(profileId: string, force?: boolean): Promise<AuthStatus | null>;
  refreshAllAuth(force?: boolean): Promise<void>;
  startLogin(profileId: string): Promise<void>;
  refreshUsage(profileId: string, force?: boolean): Promise<void>;
  refreshAllUsage(force?: boolean): Promise<void>;
  setUsagePanelOpen(open: boolean): void;
  openMonitor(sessionId?: string | null): void;
  setMonitorSession(panelId: string, sessionId: string | null): void;
  refreshAnalysis(sessionId: string, force?: boolean): Promise<void>;
  askAdvisor(sessionId: string, options?: { question?: string; force?: boolean }): Promise<void>;
  tellSession(sessionId: string, text: string): Promise<void>;
  setRecording(sessionId: string, recording: boolean): Promise<void>;
  refreshSessionSizes(): Promise<void>;
  createGroup(name: string, sessionIds: string[]): string;
  updateGroup(groupId: string, patch: Partial<Omit<SessionGroup, 'id'>>): void;
  updateSessionLook(sessionId: string, patch: Partial<Pick<Session, 'color' | 'fontSize'>>): void;
  setAutopilot(sessionId: string, on: boolean): Promise<void>;
  /** Type a command into a session and send it. */
  runCommandIn(sessionId: string, command: string): void;
  /** Whether this session starts its last command again when it comes back. */
  setResumeCommand(sessionId: string, on: boolean): void;
  dismissCommandOffer(sessionId: string): void;
  removeGroupOnly(groupId: string): void;
  assignToGroup(sessionId: string, groupId: string | null): void;
  arrangeGroupAs(groupId: string, arrangement: GroupArrangement): void;
  moveGroup(groupId: string, targetLeafId: string, side: DropSide): void;
  groupSection(groupId: string): string | null;
  membersOf(groupId: string): string[];
  reconcileGroup(tabId: string): void;
  addToGroup(sessionId: string, groupId: string): void;
  restoreGroup(groupId: string, arrangement?: GroupArrangement): Promise<number>;
  setHistoryOpen(open: boolean): void;
  setAppearanceOpen(open: boolean): void;
  reopenSession(historyId: string, asProfileId?: string): Promise<string | null>;
  runClaudeIn(sessionId: string, profileId?: string): void;
  pickConversationIn(sessionId: string): void;
  requestClose(sessionId: string): void;
  requestCloseGroup(groupId: string): void;
  confirmClose(): void;
  cancelClose(): void;
  inspectForLimit(sessionId: string, chunk: string): void;
  handoffSession(sessionId: string, targetProfileId: string): Promise<string | null>;
  pickFallbackProfile(sessionId: string): Profile | null;
  dismissLimit(sessionId: string): void;
}

/** Hand the main process what this session is showing, straight from its terminal. */
function reportScreen(sessionId: string) {
  window.api.pty.reportScreen(sessionId, readTail(sessionId, 60));
}

let persistTimer: number | undefined;
function schedulePersist(get: () => State) {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    const { layout, sessions, settings, minimized, minimizedSections, panels } = get();
    // A minimized tab is not in the layout, so its descriptor has to be gathered
    // from the dock too — otherwise it comes back as an id with nothing behind it
    // and is dropped as a pane that cannot be revived.
    // A section set aside holds tabs that are in neither the layout nor the dock,
    // so its descriptors have to be gathered too or they come back as ids with
    // nothing behind them.
    const saving = [
      ...allTabs(layout),
      ...minimized.map((entry) => entry.sessionId),
      ...minimizedSections.flatMap((entry) => entry.tabs),
    ];
    window.api.workspace.save({
      layout,
      settings,
      activeLeaf: get().activeLeafId,
      groups: get().groups,
      minimized,
      sections: minimizedSections,
      // Only the panels the layout still names; one closed a moment ago is gone.
      panels: [...allTabs(layout), ...minimizedSections.flatMap((entry) => entry.tabs)]
        .map((id) => panels[id])
        .filter(Boolean),
      sessions: saving
        .map((id) => sessions[id])
        .filter(Boolean)
        .map(
          ({
            id,
            profileId,
            cwd,
            kind,
            customTitle,
            claudeSessionId,
            handoffFrom,
            groupId,
            color,
            fontSize,
            autopilot,
          }) => ({
            id,
            profileId,
            cwd,
            kind,
            customTitle,
            claudeSessionId,
            handoffFrom,
            groupId,
            color,
            fontSize,
            autopilot,
          }),
        ),
    });
  }, 400);
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  profiles: [],
  sessions: {},
  layout: makeLeaf(),
  activeLeafId: '',
  activeSessionId: null,
  zoomedLeafId: null,
  settings: DEFAULT_SETTINGS,
  homedir: '',
  profileEditorOpen: false,
  launcherOpen: false,
  findOpenFor: null,
  renamingSessionId: null,
  draggingSessionId: null,
  draggingGroupId: null,
  draggingPaneId: null,
  authByProfile: {},
  contextMenu: null,
  usageByProfile: {},
  usageLoading: {},
  usagePanelOpen: false,
  analysisBySession: {},
  adviceBySession: {},
  adviceAsking: {},
  sessionSizes: {},
  groups: [],
  historyOpen: false,
  appearanceOpen: false,
  pendingClose: null,
  minimized: [],
  minimizedSections: [],
  panels: {},
  repos: {},
  buffers: {},
  dirs: {},

  async init() {
    if (initStarted) return;
    initStarted = true;
    const [profiles, saved, homedir] = await Promise.all([
      window.api.profiles.list(),
      window.api.workspace.load(),
      window.api.system.homedir(),
    ]);

    // A fresh renderer owns no pty: anything still running belongs to a previous
    // load of this window and would otherwise linger unreachable.
    window.api.pty.releaseOrphans();

    const settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
    const baseLayout = saved.layout ?? makeLeaf();
    const baseMinimized = (saved.minimized ?? []).filter((entry) => entry?.sessionId);
    // A panel is a tab with no session behind it, so it has to be put back before
    // anything prunes the layout — otherwise its tab looks like a dead session.
    const baseSections = (saved.sections ?? []).filter((entry) => entry?.id && entry.tabs?.length);
    const basePanels = Object.fromEntries(
      (saved.panels ?? [])
        .filter((panel) => panel?.id)
        // A panel's terminal did not survive the restart, whatever the saved id
        // says. Clearing it here is what lets the panel come back open and start
        // a fresh shell, instead of showing a slot with nothing behind it.
        .map((panel) => [panel.id, panel.kind === 'files' ? { ...panel, terminalId: null } : panel]),
    );
    set({
      profiles,
      settings,
      homedir,
      layout: baseLayout,
      minimized: baseMinimized,
      minimizedSections: baseSections,
      panels: basePanels,
      activeLeafId: allLeaves(baseLayout)[0]?.id ?? '',
      ready: true,
    });

    window.api.pty.onData(({ id, data }) => {
      const sessionId = ptyIndex.get(id);
      if (!sessionId) return;
      writeToTerminal(sessionId, data);
      get().markActivity(sessionId);
      get().inspectForLimit(sessionId, data);
    });

    /*
     * A file the editor has open changed on disk — almost always a session that
     * has just rewritten it.
     *
     * With nothing unsaved, the editor simply takes it: there is nothing to
     * decide, and an editor showing a stale file is worse than one that moves.
     * With an edit in the buffer, nothing is touched and the panel is given both
     * versions to offer — choosing for the person is the one thing that would
     * lose work here.
     */
    window.api.files.onChanged((changes) => {
      for (const change of changes) {
        const buffer = get().buffers[change.path];
        if (!buffer || buffer.loading) continue;
        if (Math.abs(buffer.mtimeMs - change.mtimeMs) <= 1) continue;
        if (change.gone) {
          set((prev) => ({
            buffers: { ...prev.buffers, [change.path]: { ...prev.buffers[change.path], error: 'This file is gone.' } },
          }));
          continue;
        }
        if (buffer.text !== buffer.savedText) {
          window.api.files.read(change.path).then((result) => {
            if (!result.ok) return;
            set((prev) => ({
              buffers: {
                ...prev.buffers,
                [change.path]: {
                  ...prev.buffers[change.path],
                  conflict: { text: result.text ?? '', mtimeMs: result.mtimeMs ?? 0 },
                },
              },
            }));
          });
          continue;
        }
        window.api.files.read(change.path).then((result) => {
          if (!result.ok) return;
          set((prev) => ({
            buffers: {
              ...prev.buffers,
              [change.path]: {
                ...prev.buffers[change.path],
                text: result.text ?? '',
                savedText: result.text ?? '',
                mtimeMs: result.mtimeMs ?? 0,
                reloadedAt: Date.now(),
                error: null,
              },
            },
          }));
        });
      }
    });

    // What the monitor has already worked out, then every change it notices. A
    // window that opens late is as informed as one that was there all along.
    window.api.analysis.live().then((live) => {
      if (live && Object.keys(live).length) {
        set((state) => ({ analysisBySession: { ...live, ...state.analysisBySession } }));
      }
    });
    window.api.analysis.onChanged(({ sessionId, verdict }) => {
      set((state) => ({ analysisBySession: { ...state.analysisBySession, [sessionId]: verdict } }));
    });

    // Groups and the session roster belong to the workspace, not to this window.
    window.api.groups.list().then((groups) => set({ groups }));
    window.api.groups.onChanged((groups) => set({ groups }));

    // A session can be ended from another window; the one holding it has to let go.
    window.api.sessions.onStopped(({ sessionId }) => {
      if (get().sessions[sessionId]) get().closeSession(sessionId);
    });

    window.api.pty.onCwd((changes) => {
      set((state) => {
        let sessions = state.sessions;
        for (const { id, cwd, foreground, command } of changes) {
          const sessionId = ptyIndex.get(id);
          const session = sessions[sessionId ?? ''];
          if (!sessionId || !session) continue;

          const movedTo = cwd && cwd !== session.cwd ? cwd : null;
          if (!movedTo && session.foreground === foreground && session.lastCommand === (command ?? session.lastCommand)) {
            continue;
          }

          if (sessions === state.sessions) sessions = { ...sessions };
          sessions[sessionId] = {
            ...session,
            foreground,
            // Remembered here as well as in the database, so the offer after a
            // restart and the menu entry both have something to name.
            ...(command ? { lastCommand: command } : {}),
            ...(movedTo ? { cwd: movedTo } : {}),
          };
          // The database is what the next launch restores from, so where the
          // session moved to has to reach it, not just the screen.
          if (movedTo) window.api.history.updateCwd(sessionId, movedTo);
        }
        return sessions === state.sessions ? state : { sessions };
      });
      schedulePersist(get);
    });

    window.api.pty.onAdopted(({ sessionId, claudeSessionId }) => {
      set((state) =>
        state.sessions[sessionId]
          ? {
              sessions: {
                ...state.sessions,
                [sessionId]: { ...state.sessions[sessionId], claudeSessionId, recording: true },
              },
            }
          : state,
      );
      schedulePersist(get);
    });

    window.api.pty.onAutopilot(({ sessionId, on, state, asking }) => {
      set((prev) =>
        prev.sessions[sessionId]
          ? {
              sessions: {
                ...prev.sessions,
                [sessionId]: {
                  ...prev.sessions[sessionId],
                  autopilot: on,
                  autopilotState: state,
                  autopilotAsking: asking ?? null,
                  // A session that needs you is worth a mark in the tab strip even
                  // when you are looking at another pane.
                  unread:
                    state === 'waiting-for-you'
                      ? leafOfTab(get().layout, sessionId)?.active !== sessionId
                      : prev.sessions[sessionId].unread,
                },
              },
            }
          : prev,
      );
    });

    window.api.pty.onExit(({ id, exitCode }) => {
      const sessionId = ptyIndex.get(id);
      if (!sessionId) return;
      ptyIndex.delete(id);
      announce(
        sessionId,
        `\r\n\x1b[38;5;244m── session ended (exit ${exitCode}) · Cmd+R to restart ──\x1b[0m\r\n`,
      );
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: state.sessions[sessionId]
            ? { ...state.sessions[sessionId], status: 'exited', exitCode, busy: false }
            : state.sessions[sessionId],
        },
      }));
    });

    // Bring the saved workspace back to life: same panes, same profiles, fresh processes.
    // Docked sessions are restored exactly like the ones in panes: they are still
    // running work, and the only difference is that no pane is showing them.
    const wanted = new Set([
      ...allTabs(baseLayout),
      ...baseMinimized.map((entry) => entry.sessionId),
      ...baseSections.flatMap((entry) => entry.tabs),
    ]);
    const restorable = (saved.sessions || []).filter((s) => wanted.has(s.id));
    if (restorable.length) {
      for (const descriptor of restorable) {
        const profile =
          profiles.find((p) => p.id === descriptor.profileId) ?? profiles[0];
        await spawnInto(set, get, {
          sessionId: descriptor.id,
          profile,
          kind: descriptor.kind,
          cwd: descriptor.cwd,
          startCwd: descriptor.startCwd,
          customTitle: descriptor.customTitle,
          groupId: descriptor.groupId ?? null,
          color: descriptor.color ?? null,
          fontSize: descriptor.fontSize ?? null,
          autopilot: descriptor.autopilot ?? false,
          // Pick the same conversation back up. The main process falls back to a
          // fresh one if no transcript was ever written for it.
          ...(descriptor.claudeSessionId && descriptor.kind === 'claude'
            ? { resumeSessionId: descriptor.claudeSessionId }
            : {}),
          handoffFrom: descriptor.handoffFrom ?? null,
          lastCommand: descriptor.lastCommand ?? null,
          resumeCommand: descriptor.resumeCommand ?? false,
        });

        /*
         * What it was running. Started again only if this session was told to;
         * otherwise it is offered, because the app cannot tell `npm run local`
         * from a migration and should not guess which one it is looking at.
         */
        const line = descriptor.lastCommand?.trim();
        if (line) {
          if (descriptor.resumeCommand) {
            // After the shell has drawn its prompt; a line typed before that is
            // typed into nothing.
            window.setTimeout(() => get().runCommandIn(descriptor.id, line), 2500);
          } else {
            set((state) =>
              state.sessions[descriptor.id]
                ? {
                    sessions: {
                      ...state.sessions,
                      [descriptor.id]: { ...state.sessions[descriptor.id], offerCommand: line },
                    },
                  }
                : state,
            );
          }
        }
      }
      const alive = new Set([...Object.keys(get().sessions), ...Object.keys(get().panels)]);
      set((state) => ({
        layout: keepOnly(state.layout, alive),
        // The dock is pruned by the same rule as the panes: an entry whose session
        // never came back is a button with nothing behind it.
        minimized: state.minimized.filter((entry) => alive.has(entry.sessionId)),
        minimizedSections: state.minimizedSections
          .map((entry) => ({ ...entry, tabs: entry.tabs.filter((tab) => alive.has(tab)) }))
          .filter((entry) => entry.tabs.length > 0),
      }));
    }

    // A workspace whose tabs are all in the dock is not an empty one, and giving
    // it an unasked-for session would be a surprise on top of a restart.
    // Re-open the folders the panels had, the files they were showing, and ask
    // git again for anything a Git tab was looking at.
    for (const any of Object.values(get().panels)) {
      const panel = asFilePanel(any);
      if (!panel) continue;
      if (panel.gitRoot) get().refreshRepo(panel.gitRoot, 'all');
      for (const dir of panel.expanded) get().loadDir(dir);
      if (panel.active) get().openFile(panel.id, panel.active);
      for (const file of panel.open) if (file !== panel.active) get().openFile(panel.id, file);
    }

    if (
      !allTabs(get().layout).length &&
      !get().minimized.length &&
      !get().minimizedSections.length &&
      profiles.length
    ) {
      await get().newSession({ kind: 'claude' });
    }

    window.api.history.setRecordDefault(settings.recordConversations);
    get().refreshAllAuth();
    // Asked again now and then, not only at startup. This runs while a restored
    // workspace is spawning every one of its sessions, and a check that loses
    // that race used to leave the account marked signed out for the life of the
    // window — with the usage gauge and panel blank and no way to retry.
    window.setInterval(() => get().refreshAllAuth(true), AUTH_RECHECK_EVERY);
    get().refreshSessionSizes();
    window.setInterval(() => get().refreshSessionSizes(), 20000);
  },

  async newSession(options = {}) {
    const state = get();
    const profile =
      state.profiles.find((p) => p.id === options.profileId) ??
      state.profiles.find((p) => p.id === state.settings.defaultProfileId) ??
      state.profiles[0];
    if (!profile) return null;

    const sessionId = crypto.randomUUID();
    const cwd = options.cwd || profile.cwd || state.homedir;
    const kind = options.kind || 'claude';

    const targetLeafId = options.leafId || state.activeLeafId || allLeaves(state.layout)[0]?.id;
    const side = options.side || 'center';

    set((prev) => {
      let layout = prev.layout;
      const leafExists = targetLeafId && findLeaf(layout, targetLeafId);
      if (!leafExists) {
        const leaf = makeLeaf([sessionId]);
        return { layout: leaf, activeLeafId: leaf.id };
      }
      if (side === 'center') {
        layout = insertTab(layout, targetLeafId, sessionId);
        return { layout, activeLeafId: targetLeafId };
      }
      const direction = side === 'left' || side === 'right' ? 'row' : 'column';
      const result = splitLeaf(layout, targetLeafId, direction, sessionId);
      // A maximized pane covers the whole workspace, so a new pane behind it would
      // be invisible and splitting would look broken. Creating one leaves zoom.
      return { layout: result.root, activeLeafId: result.leafId, zoomedLeafId: null };
    });

    // A fresh session gets a name of its own; a continued or carried-over one keeps
    // the name it already had.
    const title =
      options.title ??
      (options.resumeSessionId
        ? null
        : generateSessionName(Object.values(state.sessions).map((s) => s.customTitle)));

    await spawnInto(set, get, {
      sessionId,
      profile,
      kind,
      cwd,
      customTitle: title,
      resumeSessionId: options.resumeSessionId,
      resumedFrom: options.resumedFrom,
      groupId: options.groupId ?? null,
      handoffFrom: options.handoffFrom ?? null,
    });
    if (options.focus !== false) get().focusSession(sessionId);
    schedulePersist(get);
    return sessionId;
  },

  closeSession(sessionId) {
    const session = get().sessions[sessionId];
    if (session?.ptyId) {
      window.api.pty.kill(session.ptyId);
      ptyIndex.delete(session.ptyId);
    }
    disposeTerminal(sessionId);
    outputTails.delete(sessionId);
    window.clearTimeout(busyTimers.get(sessionId));
    busyTimers.delete(sessionId);
    // Closing a sign-in tab means the sign-in was abandoned; stop polling for it.
    if (session?.kind === 'login') {
      window.clearInterval(loginPolls.get(session.profileId));
      loginPolls.delete(session.profileId);
    }
    // The conversation is kept so the session can be picked up again later.
    window.api.context.release(sessionId);
    window.api.history.endSession(sessionId, session?.exitCode ?? null);
    set((state) => {
      const sessions = { ...state.sessions };
      delete sessions[sessionId];
      const layout = removeTab(state.layout, sessionId);
      const leaves = allLeaves(layout);
      const activeLeafId = leaves.some((l) => l.id === state.activeLeafId)
        ? state.activeLeafId
        : (leaves[0]?.id ?? '');
      return {
        sessions,
        layout,
        activeLeafId,
        zoomedLeafId: leaves.some((l) => l.id === state.zoomedLeafId) ? state.zoomedLeafId : null,
        // A closed tab leaves the dock as well, or it stays there as a button
        // pointing at a session that is gone.
        minimized: state.minimized.filter((entry) => entry.sessionId !== sessionId),
        minimizedSections: state.minimizedSections
          .map((entry) => ({ ...entry, tabs: entry.tabs.filter((tab) => tab !== sessionId) }))
          .filter((entry) => entry.tabs.length > 0),
      };
    });
    schedulePersist(get);
  },

  /**
   * Start a session again.
   *
   * Two doors, and the difference is the whole point. By default it resumes the
   * conversation — Claude comes back with the thing itself, which no summary can
   * match. `fresh` is the other case: a session whose context has grown until
   * carrying it is the problem, or one whose conversation cannot be resumed at
   * all. That one starts a new conversation and opens it with the brief the
   * monitor has been keeping, which arrives once Claude is up and waiting.
   */
  async restartSession(sessionId, { fresh = false } = {}) {
    const state = get();
    const session = state.sessions[sessionId];
    if (!session) return;

    // Asked for before anything is killed: once the session is gone its
    // transcript may be unreadable, and the answer would arrive too late.
    const brief = fresh && session.kind === 'claude' ? await window.api.analysis.brief(sessionId) : null;
    if (session.ptyId) {
      window.api.pty.kill(session.ptyId);
      ptyIndex.delete(session.ptyId);
    }
    getTerminal(sessionId)?.term.reset();
    const profile = state.profiles.find((p) => p.id === session.profileId) ?? state.profiles[0];
    await spawnInto(set, get, {
      sessionId,
      profile,
      kind: session.kind,
      cwd: session.cwd || session.startCwd,
      customTitle: session.customTitle,
      startCwd: session.startCwd,
      // Pick the conversation back up instead of throwing it away — unless the
      // whole point of this restart was to leave it behind.
      ...(!fresh && session.claudeSessionId && session.kind === 'claude'
        ? { resumeSessionId: session.claudeSessionId }
        : {}),
      handoffFrom: session.handoffFrom,
    });
    get().focusSession(sessionId);

    // Delivered through the same queue as a message between sessions, so it
    // lands when Claude is at its prompt rather than into whatever it is
    // printing while it starts up.
    if (brief?.text) window.api.analysis.handOver(sessionId, brief.text);
  },

  async duplicateSession(sessionId) {
    const session = get().sessions[sessionId];
    if (!session) return;
    const leaf = leafOfTab(get().layout, sessionId);
    await get().newSession({
      profileId: session.profileId,
      kind: session.kind,
      cwd: session.cwd,
      leafId: leaf?.id,
      side: 'center',
    });
  },

  renameSession(sessionId, title) {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...state.sessions[sessionId], customTitle: title },
      },
    }));
    // The name has to reach the database too: that is where the workspace is read
    // back from on the next launch, so a rename kept only in memory is lost.
    window.api.history.rename(sessionId, title);
    schedulePersist(get);
  },

  /**
   * Bring a session into view. Coming to one from a list is also a request to use
   * it, so a Claude session found sitting at a bare prompt is started — its Claude
   * having exited is not a state anyone chose to be in.
   */
  focusSession(sessionId, options = {}) {
    set({ activeSessionId: sessionId });
    const session = get().sessions[sessionId];
    if (options.startClaude && session && isIdleClaudeSession(session)) {
      get().runClaudeIn(sessionId);
    }

    const leaf = leafOfTab(get().layout, sessionId);
    set((state) => ({
      layout: leaf ? setActiveTab(state.layout, leaf.id, sessionId) : state.layout,
      activeLeafId: leaf?.id ?? state.activeLeafId,
      sessions: state.sessions[sessionId]
        ? { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], unread: false } }
        : state.sessions,
    }));
    // Let the pane mount before handing it the caret.
    requestAnimationFrame(() => focusTerminal(sessionId));
    schedulePersist(get);
  },

  setActiveLeaf(leafId) {
    // Moving to another pane while one is maximized shows the one you moved to.
    const active = findLeaf(get().layout, leafId)?.active ?? null;
    set((state) => ({
      activeLeafId: leafId,
      activeSessionId: active,
      zoomedLeafId: state.zoomedLeafId && state.zoomedLeafId !== leafId ? leafId : state.zoomedLeafId,
    }));
    if (active) requestAnimationFrame(() => focusTerminal(active));
  },

  moveTab(tabId, targetLeafId, side, index) {
    set((state) => {
      const layout = dropTab(state.layout, tabId, targetLeafId, side, index);
      const leaf = leafOfTab(layout, tabId);
      return {
        layout,
        activeLeafId: leaf?.id ?? state.activeLeafId,
        zoomedLeafId: side === 'center' ? state.zoomedLeafId : null,
      };
    });
    get().reconcileGroup(tabId);
    get().focusSession(tabId);
    schedulePersist(get);
  },

  reorderTab(tabId, targetLeafId, index) {
    set((state) => {
      const selected = findLeaf(state.layout, targetLeafId)?.active ?? tabId;
      const moved = insertTab(removeTab(state.layout, tabId), targetLeafId, tabId, index, false);
      return { layout: setActiveTab(moved, targetLeafId, selected) };
    });
    get().reconcileGroup(tabId);
    schedulePersist(get);
  },

  /** Splitting makes room; what goes in it is the next decision, not this one. */
  async splitActive(direction) {
    const state = get();
    const leaf = findLeaf(state.layout, state.activeLeafId) ?? allLeaves(state.layout)[0];
    if (!leaf) return;
    set((prev) => {
      const result = splitEmpty(prev.layout, leaf.id, direction);
      return { layout: result.root, activeLeafId: result.leafId, zoomedLeafId: null };
    });
    schedulePersist(get);
  },

  /** Undo a split. Only for a pane with nothing in it; sessions are closed one by one. */
  closePane(leafId) {
    const leaf = findLeaf(get().layout, leafId);
    if (!leaf || leaf.tabs.length) return;
    set((state) => {
      const layout = closePane(state.layout, leafId);
      const leaves = allLeaves(layout);
      return {
        layout,
        activeLeafId: leaves.some((l) => l.id === state.activeLeafId)
          ? state.activeLeafId
          : (leaves[0]?.id ?? ''),
      };
    });
    schedulePersist(get);
  },

  setDraggingPaneId(leafId) {
    set({ draggingPaneId: leafId });
  },

  /**
   * Relocate a section beside another, keeping it one section.
   *
   * The other half of dropping a section: the middle of a pane means "trade
   * places with this", and an edge means "go there". Both are moves of the whole
   * thing — its tabs stay together either way, which is what makes a section a
   * section rather than a pile of tabs.
   */
  moveSection(paneId, targetLeafId, side) {
    if (paneId === targetLeafId) return;
    set((state) => ({ layout: movePane(state.layout, paneId, targetLeafId, side), draggingPaneId: null }));
    // The pane it landed in is a new one; focus whatever is now in front there.
    const moved = get().layout;
    const leaf = allLeaves(moved).find((entry) => entry.active && findLeaf(moved, entry.id));
    if (leaf) set({ activeLeafId: leaf.id });
    schedulePersist(get);
  },

  swapSections(a, b) {
    if (a === b) return;
    set((state) => ({ layout: swapPanes(state.layout, a, b), activeLeafId: b, draggingPaneId: null }));
    schedulePersist(get);
  },

  resizeSplit(splitId, sizes) {
    set((state) => ({ layout: setSizes(state.layout, splitId, sizes) }));
    schedulePersist(get);
  },

  evenSplits() {
    set((state) => ({ layout: evenOut(state.layout) }));
    schedulePersist(get);
  },

  toggleZoom() {
    set((state) => ({
      zoomedLeafId: state.zoomedLeafId ? null : state.activeLeafId,
    }));
  },

  /**
   * The same thing, aimed at a named pane. The title bar's button can only ever
   * mean "whichever pane is active", which is a detour when the section you want
   * to fill the screen is the one already under the pointer.
   */
  toggleZoomOf(leafId) {
    set((state) => ({
      zoomedLeafId: state.zoomedLeafId === leafId ? null : leafId,
      activeLeafId: leafId,
    }));
  },

  /**
   * Set a tab aside. Nothing about the session changes — it keeps running, keeps
   * its conversation, keeps its place in history. What it gives up is its pane,
   * and an emptied pane is pruned, which is how the space goes back to the panes
   * around it.
   */
  /**
   * Set one tab aside, whatever kind it is.
   *
   * Named for sessions because that is what it was first for, but a folder is a
   * tab in the same strip and there is no reason it should be the one thing that
   * can only be closed. Everything below this works on tab ids, so widening the
   * guard is the whole change.
   */
  minimizeSession(sessionId) {
    const state = get();
    if (!state.sessions[sessionId] && !state.panels[sessionId]) return;
    if (state.minimized.some((entry) => entry.sessionId === sessionId)) return;
    const from = leafOfTab(state.layout, sessionId);

    set((prev) => {
      const layout = removeTab(prev.layout, sessionId);
      const leaves = allLeaves(layout);
      return {
        layout,
        minimized: [
          ...prev.minimized,
          {
            sessionId,
            leafId: from?.id ?? null,
            groupId: prev.sessions[sessionId]?.groupId ?? null,
          },
        ],
        activeLeafId: leaves.some((leaf) => leaf.id === prev.activeLeafId)
          ? prev.activeLeafId
          : (leaves[0]?.id ?? ''),
        // The pane may have been the maximized one, and a maximized pane that no
        // longer exists leaves the workspace showing nothing at all.
        zoomedLeafId: leaves.some((leaf) => leaf.id === prev.zoomedLeafId)
          ? prev.zoomedLeafId
          : null,
      };
    });
    schedulePersist(get);
  },

  /**
   * Set a whole section aside, and remember where it was.
   *
   * Not the same as setting its tabs aside one at a time: a section has a place —
   * beside something, on a side, at a width — and keeping that is what makes
   * bringing it back an undo rather than a guess.
   */
  /**
   * Type a command into a session and send it.
   *
   * The Return goes separately, for the reason autopilot learned the hard way: a
   * shell takes the text and the newline in one write as a paste, and anything
   * TUI-shaped in the way swallows it. The pause is what makes it a line.
   */
  runCommandIn(sessionId, command) {
    const line = command.trim();
    if (!line) return;
    get().focusSession(sessionId);
    get().sendInput(sessionId, line);
    window.setTimeout(() => get().sendInput(sessionId, '\r'), 700);
    set((state) =>
      state.sessions[sessionId]
        ? { sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], offerCommand: null } } }
        : state,
    );
  },

  /**
   * Whether this session starts its command again by itself.
   *
   * Per session, and off unless asked: `npm run local` coming back is a
   * convenience, and a migration coming back is a disaster. The app cannot tell
   * them apart, so the person says which is which — once, per session.
   */
  setResumeCommand(sessionId, on) {
    set((state) =>
      state.sessions[sessionId]
        ? { sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], resumeCommand: on } } }
        : state,
    );
    window.api.history.setResumeCommand(sessionId, on);
  },

  dismissCommandOffer(sessionId) {
    set((state) =>
      state.sessions[sessionId]
        ? { sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], offerCommand: null } } }
        : state,
    );
  },

  minimizeSection(leafId) {
    const state = get();
    const leaf = findLeaf(state.layout, leafId);
    if (!leaf || !leaf.tabs.length) return;

    const place = panePlace(state.layout, leafId);
    // What to call it down there: the group if one owns the whole pane, else
    // whatever is in front of it.
    const owner = state.sessions[leaf.tabs[0]]?.groupId ?? null;
    const whole = owner && leaf.tabs.every((id) => state.sessions[id]?.groupId === owner);
    const group = whole ? state.groups.find((entry) => entry.id === owner) : null;
    const front = leaf.active ?? leaf.tabs[0];
    const label =
      group?.name ??
      state.sessions[front]?.customTitle ??
      state.sessions[front]?.title ??
      panelLabel(state.panels[front]);

    set((prev) => {
      const layout = closePane(prev.layout, leafId);
      const leaves = allLeaves(layout);
      return {
        layout,
        minimizedSections: [
          ...prev.minimizedSections,
          {
            id: crypto.randomUUID(),
            tabs: [...leaf.tabs],
            active: leaf.active,
            anchorTabId: place.anchorTabId,
            anchorTabs: place.anchorTabs,
            side: place.side,
            share: place.share,
            label,
            colour: group?.color ?? prev.sessions[front]?.color ?? null,
            at: Date.now(),
          },
        ],
        activeLeafId: leaves.some((entry) => entry.id === prev.activeLeafId)
          ? prev.activeLeafId
          : (leaves[0]?.id ?? ''),
        zoomedLeafId: leaves.some((entry) => entry.id === prev.zoomedLeafId) ? prev.zoomedLeafId : null,
      };
    });
    schedulePersist(get);
  },

  /** Put a section back where it was, with everything it was holding. */
  restoreSection(id) {
    const state = get();
    const section = state.minimizedSections.find((entry) => entry.id === id);
    if (!section) return;

    // Anything closed while it was away simply is not in it any more.
    const alive = section.tabs.filter((tab) => state.sessions[tab] || state.panels[tab]);
    if (!alive.length) {
      set((prev) => ({ minimizedSections: prev.minimizedSections.filter((entry) => entry.id !== id) }));
      return;
    }

    const fallback = state.activeLeafId || allLeaves(state.layout)[0]?.id || '';
    const result = restorePaneAt(
      state.layout,
      alive,
      alive.includes(section.active ?? '') ? section.active : alive[0],
      {
        anchorTabId: section.anchorTabId,
        // Absent on a section set aside before the app knew to remember the
        // whole block; the restore falls back to the single tab in that case.
        anchorTabs: section.anchorTabs ?? [],
        side: section.side,
        share: section.share,
      },
      fallback,
    );

    set((prev) => ({
      layout: result.root,
      activeLeafId: result.leafId,
      minimizedSections: prev.minimizedSections.filter((entry) => entry.id !== id),
      zoomedLeafId: prev.zoomedLeafId ? result.leafId : null,
    }));
    const front = alive.includes(section.active ?? '') ? section.active : alive[0];
    if (front && get().sessions[front]) get().focusSession(front);
    schedulePersist(get);
  },

  /** Set aside a group wherever its sessions happen to be sitting. */
  minimizeGroup(groupId) {
    for (const sessionId of get().membersOf(groupId)) get().minimizeSession(sessionId);
  },

  /**
   * Open a folder as a tab of its own.
   *
   * It goes into the layout exactly where a new session would, and from that
   * moment the app treats it like any other tab — which is the entire reason it
   * is a tab and not a panel bolted to the side of the window.
   */
  openFilePanel(options = {}) {
    const state = get();
    const session = options.sessionId ? state.sessions[options.sessionId] : null;
    // No root means the folder has not been chosen yet, and the panel opens on a
    // chooser. Opening straight into somebody's home folder is a worse guess than
    // asking, and the folders worth offering are the ones sessions are in.
    const root = options.root || session?.cwd || '';

    const panelId = crypto.randomUUID();
    const panel: FilePanel = {
      id: panelId,
      kind: 'files',
      root,
      followsSessionId: options.sessionId ?? null,
      expanded: root ? [root] : [],
      treeWidth: 236,
      open: [],
      active: null,
      gitOpen: false,
      gitRoot: null,
      gitView: 'changes',
      gitGrouping: 'directory',
      gitCollapsed: [],
      message: '',
      amend: false,
      selectedSha: null,
      selectedPath: null,
      selectedBranch: null,
      terminalId: null,
      terminalOpen: false,
      terminalHeight: 220,
    };

    const targetLeafId = options.leafId || state.activeLeafId || allLeaves(state.layout)[0]?.id;
    const side = options.side || 'center';

    set((prev) => {
      const panels = { ...prev.panels, [panelId]: panel };
      let layout = prev.layout;
      if (!targetLeafId || !findLeaf(layout, targetLeafId)) {
        const leaf = makeLeaf([panelId]);
        return { panels, layout: leaf, activeLeafId: leaf.id };
      }
      if (side === 'center') {
        layout = insertTab(layout, targetLeafId, panelId);
        return { panels, layout, activeLeafId: targetLeafId };
      }
      const direction = side === 'left' || side === 'right' ? 'row' : 'column';
      const result = splitLeaf(layout, targetLeafId, direction, panelId);
      return { panels, layout: result.root, activeLeafId: result.leafId, zoomedLeafId: null };
    });

    if (root) get().loadDir(root);
    schedulePersist(get);
    return panelId;
  },

  /**
   * Open or shut the terminal under a panel's editor.
   *
   * Opening starts a shell in the folder the tree is rooted at — which is the
   * whole point of having it here rather than in a tab of its own: the terminal
   * you want when looking at a folder is the one already standing in it.
   */
  async togglePanelTerminal(panelId) {
    const panel = asFilePanel(get().panels[panelId]);
    if (!panel) return;

    if (panel.terminalId) {
      get().closeSession(panel.terminalId);
      set((prev) => {
        const current = asFilePanel(prev.panels[panelId]);
        if (!current) return prev;
        return {
          panels: { ...prev.panels, [panelId]: { ...current, terminalId: null, terminalOpen: false } },
        };
      });
      schedulePersist(get);
      return;
    }

    const state = get();
    const profile =
      state.profiles.find((p) => p.id === state.settings.defaultProfileId) ?? state.profiles[0];
    if (!profile) return;

    const sessionId = crypto.randomUUID();
    // Straight to `spawnInto`, never `newSession`: this session must not go into
    // the layout. It is part of the panel, and a tab appearing for it would be a
    // second copy of the same terminal in a place nobody put it.
    await spawnInto(set, get, {
      sessionId,
      profile,
      kind: 'shell',
      cwd: panel.root || profile.cwd || state.homedir,
      customTitle: 'Terminal',
    });

    set((prev) => {
      const current = asFilePanel(prev.panels[panelId]);
      if (!current) return prev;
      return {
        panels: { ...prev.panels, [panelId]: { ...current, terminalId: sessionId, terminalOpen: true } },
      };
    });
    schedulePersist(get);
  },

  setPanelTerminalHeight(panelId, height) {
    set((prev) => {
      const panel = asFilePanel(prev.panels[panelId]);
      if (!panel) return prev;
      return {
        panels: { ...prev.panels, [panelId]: { ...panel, terminalHeight: Math.round(height) } },
      };
    });
    schedulePersist(get);
  },

  closePanel(panelId) {
    const panel = get().panels[panelId];
    if (!panel) return;
    // Its terminal goes with it: nothing else can reach that session, so leaving
    // it running would be a shell nobody can see and nobody can stop.
    const shell = asFilePanel(panel)?.terminalId;
    if (shell) get().closeSession(shell);
    // Its buffers are not closed with it: another panel may be showing the same
    // file, and an unsaved edit must never be discarded by closing a view of it.
    set((prev) => {
      const panels = { ...prev.panels };
      delete panels[panelId];
      const layout = removeTab(prev.layout, panelId);
      const leaves = allLeaves(layout);
      return {
        panels,
        layout,
        activeLeafId: leaves.some((leaf) => leaf.id === prev.activeLeafId)
          ? prev.activeLeafId
          : (leaves[0]?.id ?? ''),
        zoomedLeafId: leaves.some((leaf) => leaf.id === prev.zoomedLeafId) ? prev.zoomedLeafId : null,
        minimized: prev.minimized.filter((entry) => entry.sessionId !== panelId),
      };
    });
    schedulePersist(get);
  },

  /** Bring a panel's tab to the front of its pane. */
  focusPanel(leafId, panelId) {
    set((state) => ({ layout: setActiveTab(state.layout, leafId, panelId), activeLeafId: leafId }));
    schedulePersist(get);
  },

  /**
   * Open Git as a tab in the content row.
   *
   * It is pointed at the repository the folder is *in*: a session working in
   * `src/state` still wants the whole repository's changes, and a view rooted
   * halfway down one hides things.
   */
  async openGit(panelId) {
    const panel = filesPanel(get(), panelId);
    if (!panel) return;
    let gitRoot = panel.gitRoot;
    if (!gitRoot && panel.root) {
      const found = await window.api.git.call('root', panel.root);
      gitRoot = typeof found.value === 'string' ? found.value : null;
    }
    get().patchPanel(panelId, { gitOpen: true, gitRoot, active: GIT_TAB });
    if (gitRoot) get().refreshRepo(gitRoot, 'all');
  },

  /** Close it, and land back on whatever file was open behind it. */
  closeGit(panelId) {
    const panel = filesPanel(get(), panelId);
    if (!panel) return;
    get().patchPanel(panelId, {
      gitOpen: false,
      active: panel.active === GIT_TAB ? (panel.open[panel.open.length - 1] ?? null) : panel.active,
    });
  },

  setGitView(panelId, view) {
    const panel = filesPanel(get(), panelId);
    if (!panel) return;
    get().patchPanel(panelId, { gitView: view });
    // Each view is a different question for git; ask it when it is opened rather
    // than keeping all three answers fresh for a panel nobody is looking at.
    if (panel.gitRoot) {
      get().refreshRepo(panel.gitRoot, view === 'history' ? 'graph' : view === 'branches' ? 'refs' : 'status');
    }
  },

  patchPanel(panelId, patch) {
    set((prev) => {
      const panel = filesPanel(prev, panelId);
      return panel ? { panels: { ...prev.panels, [panelId]: { ...panel, ...patch } } } : prev;
    });
    schedulePersist(get);
  },

  /**
   * Ask git again.
   *
   * Always after a verb, and on opening a view — never trusting the last answer,
   * because a session in the same folder commits and branches without telling
   * anyone, and a panel showing a stale picture is worse than a slow one.
   */
  async refreshRepo(root, what = 'status') {
    if (!root) return;
    const base: RepoState = get().repos[root] ?? {
      loading: false, error: null, branch: null, upstream: null, ahead: 0, behind: 0,
      detached: false, files: [], commits: [], graphWidth: 1, current: null,
      local: [], remote: [], tags: [], stashes: [], busy: null, notice: null,
    };
    set((prev) => ({ repos: { ...prev.repos, [root]: { ...base, loading: true } } }));

    const wants = (kind: string) => what === 'all' || what === kind;
    const [status, graph, refs] = await Promise.all([
      wants('status') ? window.api.git.call('status', root) : Promise.resolve(null),
      wants('graph') ? window.api.git.call('graph', root, { limit: 200 }) : Promise.resolve(null),
      wants('refs') ? window.api.git.call('refs', root) : Promise.resolve(null),
    ]);

    set((prev) => {
      const current = prev.repos[root] ?? base;
      const error = [status, graph, refs].find((r) => r && !r.ok)?.error ?? null;
      return {
        repos: {
          ...prev.repos,
          [root]: {
            ...current,
            loading: false,
            error,
            ...(status?.ok
              ? {
                  branch: status.branch ?? null,
                  upstream: status.upstream ?? null,
                  ahead: status.ahead ?? 0,
                  behind: status.behind ?? 0,
                  detached: status.detached ?? false,
                  files: status.files ?? [],
                }
              : {}),
            ...(graph?.ok ? { commits: graph.commits ?? [], graphWidth: graph.width ?? 1 } : {}),
            ...(refs?.ok
              ? {
                  current: refs.current ?? null,
                  local: refs.local ?? [],
                  remote: refs.remote ?? [],
                  tags: refs.tags ?? [],
                  stashes: refs.stashes ?? [],
                }
              : {}),
          },
        },
      };
    });
  },

  /**
   * Run one git verb and say what happened.
   *
   * A failure keeps git's own words. Every paraphrase this could write — "push
   * failed" — throws away the line that says *why*, which is the only part that
   * tells someone what to do next.
   */
  async gitDo(root, name, args, label) {
    set((prev) =>
      prev.repos[root]
        ? { repos: { ...prev.repos, [root]: { ...prev.repos[root], busy: label ?? name, notice: null } } }
        : prev,
    );
    const result = await window.api.git.call(name, root, args);
    set((prev) =>
      prev.repos[root]
        ? {
            repos: {
              ...prev.repos,
              [root]: {
                ...prev.repos[root],
                busy: null,
                notice: result.ok
                  ? { kind: 'ok', text: `${label ?? name} — done.` }
                  : { kind: 'bad', text: result.error ?? 'git failed' },
              },
            },
          }
        : prev,
    );
    await get().refreshRepo(root, 'all');
    return result;
  },

  /** Point an open panel at another folder, keeping the files already open. */
  setPanelRoot(panelId, root) {
    if (!root) return;
    set((prev) => {
      const panel = filesPanel(prev, panelId);
      return panel
        ? { panels: { ...prev.panels, [panelId]: { ...panel, root, expanded: [root] } } }
        : prev;
    });
    get().loadDir(root);
    schedulePersist(get);
  },

  async loadDir(path) {
    if (get().dirs[path]?.loading) return;
    set((prev) => ({
      dirs: { ...prev.dirs, [path]: { entries: prev.dirs[path]?.entries ?? [], error: null, loading: true } },
    }));
    const result = await window.api.files.list(path);
    set((prev) => ({
      dirs: {
        ...prev.dirs,
        [path]: {
          entries: (result.entries ?? []) as DirEntry[],
          error: result.ok ? null : (result.error ?? 'Could not read that folder.'),
          loading: false,
        },
      },
    }));
  },

  toggleDir(panelId, path) {
    const panel = filesPanel(get(), panelId);
    if (!panel) return;
    const open = panel.expanded.includes(path);
    set((prev) => {
      const current = filesPanel(prev, panelId);
      if (!current) return prev;
      return {
        panels: {
          ...prev.panels,
          [panelId]: {
            ...current,
            expanded: open
              ? current.expanded.filter((entry) => entry !== path)
              : [...current.expanded, path],
          },
        },
      };
    });
    if (!open) get().loadDir(path);
    schedulePersist(get);
  },

  async openFile(panelId, path) {
    if (!filesPanel(get(), panelId)) return;

    set((prev) => {
      const current = filesPanel(prev, panelId);
      if (!current) return prev;
      return {
        panels: {
          ...prev.panels,
          [panelId]: {
            ...current,
            open: current.open.includes(path) ? current.open : [...current.open, path],
            active: path,
          },
        },
      };
    });

    // Already loaded, and possibly edited — re-reading would throw that away.
    if (get().buffers[path]) return;

    set((prev) => ({
      buffers: {
        ...prev.buffers,
        [path]: {
          path,
          text: '',
          savedText: '',
          mtimeMs: 0,
          conflict: null,
          reloadedAt: null,
          loading: true,
          error: null,
          readOnly: false,
        },
      },
    }));

    const result = await window.api.files.read(path);
    set((prev) => ({
      buffers: {
        ...prev.buffers,
        [path]: {
          ...prev.buffers[path],
          text: result.text ?? '',
          savedText: result.text ?? '',
          mtimeMs: result.mtimeMs ?? 0,
          loading: false,
          error: result.ok ? null : (result.error ?? 'Could not open that file.'),
          readOnly: !result.ok,
        },
      },
    }));
    if (result.ok) window.api.files.watch(path, result.mtimeMs ?? 0);
    schedulePersist(get);
  },

  closeFile(panelId, path) {
    set((prev) => {
      const panel = filesPanel(prev, panelId);
      if (!panel) return prev;
      const open = panel.open.filter((entry) => entry !== path);
      const at = Math.min(panel.open.indexOf(path), open.length - 1);
      return {
        panels: {
          ...prev.panels,
          [panelId]: {
            ...panel,
            open,
            active: panel.active === path ? (open[at] ?? null) : panel.active,
          },
        },
      };
    });
    // The buffer only goes when no panel is showing it any more — and never while
    // it holds an edit nobody has saved.
    const stillOpen = Object.values(get().panels).some(
      (panel) => panel.kind === 'files' && panel.open.includes(path),
    );
    const buffer = get().buffers[path];
    if (!stillOpen && buffer && buffer.text === buffer.savedText) {
      window.api.files.unwatch(path);
      set((prev) => {
        const buffers = { ...prev.buffers };
        delete buffers[path];
        return { buffers };
      });
    }
    schedulePersist(get);
  },

  setActiveFile(panelId, path) {
    set((prev) => {
      const panel = filesPanel(prev, panelId);
      return panel ? { panels: { ...prev.panels, [panelId]: { ...panel, active: path } } } : prev;
    });
    schedulePersist(get);
  },

  editBuffer(path, text) {
    set((prev) =>
      prev.buffers[path]
        ? { buffers: { ...prev.buffers, [path]: { ...prev.buffers[path], text, reloadedAt: null } } }
        : prev,
    );
  },

  /**
   * Write the buffer back — over the version it was read from, and no other.
   *
   * The main process compares modification times and refuses a write whose file
   * has moved on. That refusal is not an error to report and forget: it is a
   * session having edited this file while it was open here, and it becomes the
   * conflict the panel shows.
   */
  async saveBuffer(path, options = {}) {
    const buffer = get().buffers[path];
    if (!buffer || buffer.loading || buffer.readOnly) return false;
    if (!options.force && buffer.text === buffer.savedText && !buffer.conflict) return true;

    const text = buffer.text;
    const result = await window.api.files.write(path, text, {
      expectedMtimeMs: buffer.mtimeMs,
      force: options.force === true,
    });

    if (result.conflict) {
      set((prev) => ({
        buffers: {
          ...prev.buffers,
          [path]: {
            ...prev.buffers[path],
            conflict: { text: result.text ?? '', mtimeMs: result.mtimeMs ?? 0 },
          },
        },
      }));
      return false;
    }
    if (!result.ok) {
      set((prev) => ({
        buffers: { ...prev.buffers, [path]: { ...prev.buffers[path], error: result.error ?? 'Could not save.' } },
      }));
      return false;
    }

    set((prev) => ({
      buffers: {
        ...prev.buffers,
        [path]: {
          ...prev.buffers[path],
          savedText: text,
          mtimeMs: result.mtimeMs ?? 0,
          conflict: null,
          error: null,
        },
      },
    }));
    window.api.files.watch(path, result.mtimeMs ?? 0);
    return true;
  },

  /** Throw the edit away and take what is on disk. */
  async revertBuffer(path) {
    const result = await window.api.files.read(path);
    if (!result.ok) return;
    set((prev) =>
      prev.buffers[path]
        ? {
            buffers: {
              ...prev.buffers,
              [path]: {
                ...prev.buffers[path],
                text: result.text ?? '',
                savedText: result.text ?? '',
                mtimeMs: result.mtimeMs ?? 0,
                conflict: null,
                error: null,
              },
            },
          }
        : prev,
    );
    window.api.files.watch(path, result.mtimeMs ?? 0);
  },

  /**
   * Put a piece of a file into a session's prompt.
   *
   * The one thing this editor can do that no other editor can: the session it
   * goes to is already working in this folder, so the reference is enough — the
   * lines are named rather than pasted, and Claude reads them itself.
   */
  sendSelectionTo(sessionId, path, text, from, to) {
    const relative = path.startsWith(`${get().sessions[sessionId]?.cwd ?? ''}/`)
      ? path.slice((get().sessions[sessionId]?.cwd ?? '').length + 1)
      : path;
    const where = from === to ? `${relative}:${from}` : `${relative}:${from}-${to}`;
    get().focusSession(sessionId);
    get().sendInput(sessionId, `@${where} `);
    void text;
  },

  restoreMinimized(sessionId) {
    restoreTabs(set, get, [sessionId]);
  },

  /** A group went into the dock as one thing, so it comes back as one thing. */
  restoreMinimizedGroup(groupId) {
    restoreTabs(
      set,
      get,
      get()
        .minimized.filter((entry) => entry.groupId === groupId)
        .map((entry) => entry.sessionId),
    );
  },

  focusDirection(direction) {
    const state = get();
    const current = document.querySelector<HTMLElement>(`[data-leaf-id="${state.activeLeafId}"]`);
    if (!current) return;
    const from = current.getBoundingClientRect();
    const fromX = from.left + from.width / 2;
    const fromY = from.top + from.height / 2;

    let best: { id: string; score: number } | null = null;
    for (const leaf of allLeaves(state.layout)) {
      if (leaf.id === state.activeLeafId) continue;
      const el = document.querySelector<HTMLElement>(`[data-leaf-id="${leaf.id}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const dx = r.left + r.width / 2 - fromX;
      const dy = r.top + r.height / 2 - fromY;
      const along = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
      if (along <= 1) continue;
      const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
      const score = along + across * 2;
      if (!best || score < best.score) best = { id: leaf.id, score };
    }
    if (best) get().setActiveLeaf(best.id);
  },

  cycleTab(delta) {
    const state = get();
    const leaf = findLeaf(state.layout, state.activeLeafId);
    if (!leaf || leaf.tabs.length < 2) return;
    const at = leaf.tabs.indexOf(leaf.active ?? leaf.tabs[0]);
    const next = leaf.tabs[(at + delta + leaf.tabs.length) % leaf.tabs.length];
    get().focusSession(next);
  },

  sendInput(sessionId, data) {
    const session = get().sessions[sessionId];
    if (session?.ptyId) window.api.pty.write(session.ptyId, data);
  },

  notifyResize(sessionId, cols, rows) {
    const session = get().sessions[sessionId];
    if (session?.ptyId) window.api.pty.resize(session.ptyId, cols, rows);
  },

  markActivity(sessionId) {
    const state = get();
    const session = state.sessions[sessionId];
    if (!session) return;

    // While output is already flowing there is nothing to change, so the layout
    // lookup — which walks the whole pane tree — is skipped. This runs on every
    // frame of terminal output, roughly a hundred times a second per session.
    if (!session.busy) {
      const leaf = leafOfTab(state.layout, sessionId);
      const visible = leaf?.active === sessionId;
      set((prev) => ({
        sessions: {
          ...prev.sessions,
          [sessionId]: { ...prev.sessions[sessionId], busy: true, unread: !visible },
        },
      }));
    }

    window.clearTimeout(busyTimers.get(sessionId));
    busyTimers.set(
      sessionId,
      window.setTimeout(() => {
        busyTimers.delete(sessionId);
        set((prev) =>
          prev.sessions[sessionId]
            ? { sessions: { ...prev.sessions, [sessionId]: { ...prev.sessions[sessionId], busy: false } } }
            : prev,
        );
        // A session that has stopped printing is showing its final screen, which
        // is the only place some questions ever appear.
        if (get().sessions[sessionId]?.autopilot) reportScreen(sessionId);
      }, 800),
    );
  },

  setTitle(sessionId, title) {
    const clean = title.trim();
    if (!clean) return;
    set((state) =>
      state.sessions[sessionId] && state.sessions[sessionId].title !== clean
        ? { sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], title: clean } } }
        : state,
    );
  },

  updateSettings(patch) {
    const before = get().settings;
    set((state) => ({ settings: { ...state.settings, ...patch } }));
    const after = get().settings;

    // Dragging the sidebar fires this on every pointer move; reflowing every
    // terminal each time would refit and resize every pty at the frame rate.
    if (after.recordCommandOutput !== before.recordCommandOutput) {
      window.api.history.setCommandOutput(after.recordCommandOutput);
    }
    if (after.recordConversations !== before.recordConversations) {
      window.api.history.setRecordDefault(after.recordConversations);
    }

    if (
      after.fontSize !== before.fontSize ||
      after.fontFamily !== before.fontFamily ||
      after.cursorBlink !== before.cursorBlink ||
      after.theme !== before.theme ||
      after.terminalPalette !== before.terminalPalette ||
      after.terminalOverrides !== before.terminalOverrides
    ) {
      applyAppearance(
        after.fontSize,
        after.fontFamily,
        after.cursorBlink,
        currentTerminalTheme(after),
      );
    }
    schedulePersist(get);
  },

  async saveProfile(profile) {
    if (profile.configDir) await window.api.profiles.ensureConfigDir(profile.configDir);
    const profiles = await window.api.profiles.save(profile);
    set({ profiles });
    const saved = profiles.find((p) => p.name === profile.name && p.configDir === (profile.configDir ?? null));
    if (saved) get().refreshAuth(saved.id, true);
  },

  async removeProfile(id) {
    const profiles = await window.api.profiles.remove(id);
    set({ profiles });
  },

  setProfileEditorOpen(open) {
    set({ profileEditorOpen: open });
  },

  setLauncherOpen(open) {
    set({ launcherOpen: open });
  },

  setFindOpenFor(sessionId) {
    set({ findOpenFor: sessionId });
  },

  setRenamingSessionId(sessionId) {
    set({ renamingSessionId: sessionId });
  },

  setDraggingSessionId(sessionId) {
    set({ draggingSessionId: sessionId });
  },

  setDraggingGroupId(groupId) {
    set({ draggingGroupId: groupId });
  },

  openContextMenu(sessionId, x, y) {
    set({ contextMenu: { sessionId, x, y } });
  },

  closeContextMenu() {
    set({ contextMenu: null });
  },

  /**
   * Watch a session's output for the account running out of usage. The notice can
   * straddle two chunks, so a short tail of recent output is matched, not just the
   * chunk that arrived.
   */
  inspectForLimit(sessionId, chunk) {
    const state = get();
    const session = state.sessions[sessionId];
    if (!session || session.kind !== 'claude' || session.limitHit) return;

    const tail = (outputTails.get(sessionId) ?? '') + chunk;
    outputTails.set(sessionId, tail.slice(-TAIL));

    const pattern = limitRegex(state.settings.limitPattern);
    if (!pattern || !pattern.test(outputTails.get(sessionId) ?? '')) return;

    outputTails.set(sessionId, '');
    set((prev) => ({
      sessions: { ...prev.sessions, [sessionId]: { ...prev.sessions[sessionId], limitHit: true } },
    }));

    get().refreshUsage(session.profileId, true);

    if (state.settings.autoHandoff) {
      const target = get().pickFallbackProfile(sessionId);
      if (target) get().handoffSession(sessionId, target.id);
    }
  },

  /** The account to carry a session over to: the one configured, else any other signed-in one. */
  pickFallbackProfile(sessionId) {
    const state = get();
    const session = state.sessions[sessionId];
    if (!session) return null;

    const usable = (profile: Profile) =>
      profile.id !== session.profileId && state.authByProfile[profile.id]?.loggedIn;

    const profile = state.profiles.find((p) => p.id === session.profileId);
    const configured = profile?.fallbackProfileId
      ? state.profiles.find((p) => p.id === profile.fallbackProfileId)
      : null;
    if (configured && usable(configured)) return configured;

    // Skip accounts that just told us they are out too.
    const exhausted = new Set(
      Object.values(state.sessions).filter((s) => s.limitHit).map((s) => s.profileId),
    );
    return (
      state.profiles.find((p) => usable(p) && !exhausted.has(p.id)) ??
      state.profiles.find(usable) ??
      null
    );
  },

  /**
   * Carry a conversation to another account: copy its transcript into that account's
   * config dir, open a session there resuming it, and retire the original.
   */
  async handoffSession(sessionId, targetProfileId) {
    const state = get();
    const session = state.sessions[sessionId];
    const target = state.profiles.find((p) => p.id === targetProfileId);
    if (!session || !target || session.profileId === targetProfileId) return null;

    const leaf = leafOfTab(state.layout, sessionId);
    const from = state.profiles.find((p) => p.id === session.profileId);

    let moved;
    try {
      moved = await window.api.context.handoff({
        sessionId,
        targetProfileId,
        cwd: session.cwd || session.startCwd,
      });
    } catch (error) {
      announce(
        sessionId,
        `\r\n\x1b[38;5;203mCould not move this session: ${String(error)}\x1b[0m\r\n`,
      );
      return null;
    }

    const newId = await get().newSession({
      profileId: targetProfileId,
      kind: 'claude',
      cwd: moved.cwd,
      leafId: leaf?.id,
      side: 'center',
      title: session.customTitle ?? undefined,
      resumeSessionId: moved.claudeSessionId,
      handoffFrom: { profileId: session.profileId, at: Date.now() },
    });

    if (newId) {
      window.api.history.recordHandoff({
        reason: session.limitHit ? 'usage-limit' : 'manual',
        claudeSessionId: moved.claudeSessionId,
        fromSessionId: sessionId,
        toSessionId: newId,
        fromProfileId: session.profileId,
        fromProfileName: from?.name ?? null,
        toProfileId: targetProfileId,
        toProfileName: target.name,
      });
      announce(
        newId,
        `\r\n\x1b[38;5;244m── conversation carried over from ${from?.name ?? 'another account'} ──\x1b[0m\r\n`,
      );
      get().closeSession(sessionId);
    }
    return newId;
  },

  dismissLimit(sessionId) {
    set((state) =>
      state.sessions[sessionId]
        ? { sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], limitHit: false } } }
        : state,
    );
  },

  /**
   * Plan limits are read by driving a throwaway session to `/status` -> Usage, so
   * this takes several seconds. It is only ever done on request or after an
   * account reports it ran out.
   */
  async refreshUsage(profileId, force = false) {
    if (get().usageLoading[profileId]) return;
    set((state) => ({ usageLoading: { ...state.usageLoading, [profileId]: true } }));
    try {
      const report = await window.api.usage.read(profileId, force);
      set((state) => ({ usageByProfile: { ...state.usageByProfile, [profileId]: report } }));
    } catch (error) {
      set((state) => ({
        usageByProfile: {
          ...state.usageByProfile,
          [profileId]: { ok: false, error: String(error), readAt: Date.now() },
        },
      }));
    } finally {
      set((state) => ({ usageLoading: { ...state.usageLoading, [profileId]: false } }));
    }
  },

  async refreshAllUsage(force = false) {
    for (const profile of get().profiles) {
      if (get().authByProfile[profile.id]?.loggedIn) await get().refreshUsage(profile.id, force);
    }
  },

  /**
   * Open the monitor, on a session if one is meant.
   *
   * A section rather than a modal, and the difference is the whole point: what
   * the monitor says is only useful next to the session it is saying it about.
   * A dialog covers that session and has to be dismissed before anything can be
   * done with what it told you.
   *
   * One at a time. A second monitor would be a second view of the same readings,
   * so asking for it again points the one that exists at the session you meant
   * and brings its section forward.
   */
  openMonitor(sessionId = null) {
    const state = get();
    const wanted = sessionId ?? state.activeSessionId ?? null;
    const existing = Object.values(state.panels).find((panel) => panel.kind === 'monitor');

    if (existing) {
      const leaf = allLeaves(state.layout).find((candidate) => candidate.tabs.includes(existing.id));
      if (leaf) {
        if (wanted) get().setMonitorSession(existing.id, wanted);
        get().focusPanel(leaf.id, existing.id);
        if (wanted) get().refreshAnalysis(wanted);
        return;
      }
      // It exists but is not in the layout — set aside. Restoring it is the
      // honest answer to "open the monitor".
      get().restoreMinimized(existing.id);
      if (wanted) get().setMonitorSession(existing.id, wanted);
      if (wanted) get().refreshAnalysis(wanted);
      return;
    }

    const panelId = crypto.randomUUID();
    const panel: MonitorPanel = { id: panelId, kind: 'monitor', sessionId: wanted };
    const targetLeafId = state.activeLeafId || allLeaves(state.layout)[0]?.id;

    set((prev) => {
      const panels = { ...prev.panels, [panelId]: panel };
      if (!targetLeafId || !findLeaf(prev.layout, targetLeafId)) {
        const leaf = makeLeaf([panelId]);
        return { panels, layout: leaf, activeLeafId: leaf.id };
      }
      return { panels, layout: insertTab(prev.layout, targetLeafId, panelId), activeLeafId: targetLeafId };
    });

    if (wanted) get().refreshAnalysis(wanted);
    schedulePersist(get);
  },

  /**
   * Read one session again.
   *
   * The monitor in the main process is already following every session, so this
   * usually returns a reading it has had for a while; `force` is the panel's
   * Refresh, for when someone is watching the number and wants it re-read now.
   */
  async refreshAnalysis(sessionId, force = false) {
    const verdict = await window.api.analysis.session(sessionId, force);
    if (!verdict) return;
    set((state) => ({ analysisBySession: { ...state.analysisBySession, [sessionId]: verdict } }));
  },

  /**
   * Ask a model what to make of the measurements.
   *
   * The other sessions go along as one line each — a session duplicating another
   * one's work cannot be seen from inside either of them, and that is exactly the
   * sort of thing arithmetic will never notice.
   */
  async askAdvisor(sessionId, { question, force } = {}) {
    if (get().adviceAsking[sessionId]) return;
    set((state) => ({ adviceAsking: { ...state.adviceAsking, [sessionId]: true } }));
    try {
      const alongside = Object.values(get().sessions)
        .filter((session) => session.kind === 'claude' && session.id !== sessionId)
        .map((session) => session.id);
      const advice = await window.api.analysis.advice({ sessionId, question, alongside, force });
      set((state) => ({ adviceBySession: { ...state.adviceBySession, [sessionId]: advice } }));
    } finally {
      set((state) => ({ adviceAsking: { ...state.adviceAsking, [sessionId]: false } }));
    }
  },

  /** Put a reading into the session it is about. Always asked for by name. */
  async tellSession(sessionId, text) {
    await window.api.analysis.tell(sessionId, text);
  },

  /** Point the monitor at a different session. */
  setMonitorSession(panelId, sessionId) {
    set((prev) => {
      const panel = prev.panels[panelId];
      if (panel?.kind !== 'monitor') return prev;
      return { panels: { ...prev.panels, [panelId]: { ...panel, sessionId } } };
    });
    if (sessionId) get().refreshAnalysis(sessionId);
    schedulePersist(get);
  },

  setUsagePanelOpen(open) {
    set({ usagePanelOpen: open });
    if (open) get().refreshAllUsage();
  },

  setHistoryOpen(open) {
    set({ historyOpen: open });
  },

  /**
   * Turn the stored copy of a conversation on or off. Turning it off deletes what
   * was kept — the point of the switch is that nothing is retained against your
   * wishes, so a half-kept conversation would defeat it.
   */
  /** How much each open session has kept, so a tab can say what it is costing. */
  /** Make a group out of sessions that are already working together. */
  createGroup(name, sessionIds) {
    const id = crypto.randomUUID();
    const used = new Set(get().groups.map((g) => g.color));
    const color = GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[0];
    set((state) => {
      // A new group gets a section of its own, the way splitting does. Grouping
      // and then hunting for the members among unrelated tabs is not grouping.
      // Members scattered across panes are collected first, or only the ones that
      // happened to share a pane would end up in the section.
      const gathered = arrangeGroup(state.layout, sessionIds, 'tabs');
      const { root, leafId } = splitOffTabs(gathered, sessionIds);
      return {
        groups: [
          ...state.groups,
          { id, name, color, fontSize: null, collapsed: false, arrangement: 'tabs' as const },
        ],
        sessions: withGroup(state.sessions, sessionIds, id),
        layout: root,
        activeLeafId: leafId || state.activeLeafId,
      };
    });
    window.api.groups.save(get().groups);
    schedulePersist(get);
    return id;
  },

  /**
   * A tab's own colour and text size, for one that is not in a group. Kept on the
   * session rather than applied to the terminal and forgotten, so it survives a
   * restart — and so joining a group only hides it, never destroys it.
   */
  /**
   * Let a session carry on by itself. Only the stops that need a person survive:
   * a question about what to do next is left alone, and the run halts there.
   */
  async setAutopilot(sessionId, on) {
    const active = await window.api.pty.autopilot(sessionId, on);
    // Whatever is on screen right now may already be a question — it usually is,
    // since this gets switched on precisely when a session has stopped.
    if (active) reportScreen(sessionId);
    set((state) =>
      state.sessions[sessionId]
        ? {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...state.sessions[sessionId],
                autopilot: active,
                autopilotState: active ? 'watching' : 'off',
                autopilotAsking: null,
              },
            },
          }
        : state,
    );
    schedulePersist(get);
  },

  updateSessionLook(sessionId, patch) {
    set((state) =>
      state.sessions[sessionId]
        ? {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...state.sessions[sessionId], ...patch },
            },
          }
        : state,
    );
    if (patch.fontSize !== undefined) applyGroupAppearance(get);
    schedulePersist(get);
  },

  updateGroup(groupId, patch) {
    set((state) => ({
      groups: state.groups.map((group) => (group.id === groupId ? { ...group, ...patch } : group)),
    }));
    // A group's own text size has to reach its terminals, not just its label.
    if (patch.fontSize !== undefined) applyGroupAppearance(get);
    window.api.groups.save(get().groups);
    schedulePersist(get);
  },

  /** Disband the group; its sessions stay exactly where they are. */
  removeGroupOnly(groupId) {
    set((state) => ({
      groups: state.groups.filter((group) => group.id !== groupId),
      sessions: Object.fromEntries(
        Object.entries(state.sessions).map(([id, session]) => [
          id,
          session.groupId === groupId ? { ...session, groupId: null } : session,
        ]),
      ),
    }));
    applyGroupAppearance(get);
    window.api.groups.forget(groupId);
    schedulePersist(get);
  },

  assignToGroup(sessionId, groupId) {
    set((state) => ({ sessions: withGroup(state.sessions, [sessionId], groupId) }));
    applyGroupAppearance(get);
    schedulePersist(get);
  },

  arrangeGroupAs(groupId, arrangement) {
    const members = get().membersOf(groupId);
    if (!members.length) return;
    set((state) => ({
      layout: arrangeGroup(state.layout, members, arrangement),
      // Remembered on the group, not just applied: closing it and opening it again
      // should give back the arrangement that was chosen, not a default.
      groups: state.groups.map((group) =>
        group.id === groupId ? { ...group, arrangement } : group,
      ),
    }));
    window.api.groups.save(get().groups);
    schedulePersist(get);
  },

  /**
   * Move a group. When it has a section to itself the whole section travels, so
   * it stays one pane; otherwise its tabs are gathered wherever they land.
   */
  moveGroup(groupId, targetLeafId, side) {
    const members = get().membersOf(groupId);
    if (!members.length) return;

    const section = get().groupSection(groupId);
    set((state) => ({
      layout:
        section && section !== targetLeafId && side !== 'center'
          ? movePane(state.layout, section, targetLeafId, side)
          : moveGroupTo(state.layout, members, targetLeafId, side),
    }));
    schedulePersist(get);
  },

  /** The pane this group has entirely to itself, if it has one. */
  groupSection(groupId) {
    const state = get();
    const members = state.membersOf(groupId);
    if (!members.length) return null;
    const leaf = leafOfTab(state.layout, members[0]);
    if (!leaf) return null;
    const ownsIt = leaf.tabs.every((id) => state.sessions[id]?.groupId === groupId);
    const allHere = members.every((id) => leaf.tabs.includes(id));
    return ownsIt && allHere ? leaf.id : null;
  },

  /**
   * Bring a whole group back from history: every session it had, each continuing
   * its own conversation, gathered in one pane under the group it belonged to.
   *
   * Sessions still open are left alone and simply re-joined, so restoring twice
   * does not give you two of everything.
   */
  async restoreGroup(groupId, arrangement) {
    const [record] = (await window.api.history.groups({ limit: 500 })).filter((g) => g.id === groupId);
    const members = await window.api.history.groupMembers(groupId);
    if (!record || !members.length) return 0;

    const live = get().sessions;
    const alreadyOpen = members.filter((member) => live[member.id]);
    const toOpen = members.filter((member) => !live[member.id]);

    // Recreate the group itself first, so each session can join as it opens.
    if (!get().groups.some((group) => group.id === groupId)) {
      set((state) => ({
        groups: [
          ...state.groups,
          {
            id: groupId,
            name: record.name,
            color: record.color ?? '#7dcfff',
            fontSize: record.fontSize,
            collapsed: false,
            arrangement: record.arrangement ?? 'tabs',
          },
        ],
      }));
    }
    for (const member of alreadyOpen) get().assignToGroup(member.id, groupId);

    const profiles = get().profiles;
    for (const member of toOpen) {
      const profile =
        profiles.find((p) => p.id === member.profileId) ??
        profiles.find((p) => p.name === member.profileName) ??
        profiles[0];
      if (!profile) continue;
      await get().newSession({
        profileId: profile.id,
        kind: member.kind === 'login' ? 'shell' : member.kind,
        cwd: member.lastCwd || member.startCwd,
        title: member.title ?? undefined,
        resumeSessionId: member.claudeSessionId ?? undefined,
        resumedFrom: member.id,
        groupId,
      });
    }

    // Whatever it was arranged as when it was closed, unless asked for otherwise.
    get().arrangeGroupAs(groupId, arrangement ?? record.arrangement ?? 'tabs');
    set({ historyOpen: false });
    return toOpen.length;
  },

  /**
   * Put a tab into a group by name rather than by dragging.
   *
   * The tab moves to sit with the group's other members, because a group is a run
   * of neighbouring tabs on screen as much as it is a set — leaving it stranded
   * across the strip would make the label lie about what it covers.
   */
  addToGroup(sessionId, groupId) {
    const members = get().membersOf(groupId).filter((id) => id !== sessionId);
    if (!members.length) {
      get().assignToGroup(sessionId, groupId);
      return;
    }

    const anchor = leafOfTab(get().layout, members[members.length - 1]);
    if (anchor) {
      const alreadyThere = anchor.tabs.includes(sessionId);
      const lastMemberAt = anchor.tabs.lastIndexOf(members[members.length - 1]);
      // After the run's last member; removing it first shifts the gap when the tab
      // already sits earlier in this same strip.
      const gap = alreadyThere && anchor.tabs.indexOf(sessionId) < lastMemberAt
        ? lastMemberAt
        : lastMemberAt + 1;
      if (alreadyThere) get().reorderTab(sessionId, anchor.id, gap);
      else get().moveTab(sessionId, anchor.id, 'center', gap);
    }
    get().assignToGroup(sessionId, groupId);
  },

  /**
   * A tab's group follows where it sits, the way a browser's does.
   *
   * Joining takes a deliberate drop — between two tabs of the same group — but
   * staying only takes touching it. That asymmetry is what makes a group you add
   * to explicitly hold together: a tab put at the end of the run has a member on
   * one side only, and demanding members on both would eject it immediately.
   */
  reconcileGroup(tabId) {
    const state = get();
    const session = state.sessions[tabId];
    if (!session) return;

    const leaf = leafOfTab(state.layout, tabId);
    if (!leaf) return;

    const at = leaf.tabs.indexOf(tabId);
    const groupAt = (index: number) =>
      index >= 0 && index < leaf.tabs.length ? (state.sessions[leaf.tabs[index]]?.groupId ?? null) : null;

    const before = groupAt(at - 1);
    const after = groupAt(at + 1);

    if (session.groupId) {
      // Still touching its own run? Then it is still in it.
      const touching = before === session.groupId || after === session.groupId;
      if (!touching) get().assignToGroup(tabId, null);
      return;
    }

    // Landing inside a run — a member on each side — is how a loose tab joins.
    if (before && before === after) get().assignToGroup(tabId, before);
  },

  /** In workspace order, so an arrangement keeps the order you see. */
  membersOf(groupId) {
    const state = get();
    return allTabs(state.layout).filter((id) => state.sessions[id]?.groupId === groupId);
  },

  async refreshSessionSizes() {
    const open = Object.keys(get().sessions);
    if (!open.length) return;
    const rows = await window.api.history.sessions({ limit: 400 });
    const sizes: Record<string, number> = {};
    for (const row of rows) if (row.transcriptBytes) sizes[row.id] = row.transcriptBytes;
    set({ sessionSizes: sizes });
  },

  async setRecording(sessionId, recording) {
    await window.api.history.setStoreTranscript(sessionId, recording);
    get().refreshSessionSizes();
    set((state) =>
      state.sessions[sessionId]
        ? { sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], recording } } }
        : state,
    );
  },

  setAppearanceOpen(open) {
    set({ appearanceOpen: open });
  },

  /**
   * Continue a session that was closed earlier. It comes back as a new session
   * resuming the same conversation, with a trail back to the one it continues.
   */
  async reopenSession(historyId, asProfileId) {
    const past = await window.api.history.session(historyId);
    if (!past) return null;

    const original =
      get().profiles.find((p) => p.id === past.profileId) ??
      get().profiles.find((p) => p.name === past.profileName) ??
      get().profiles[0];
    const profile = asProfileId
      ? (get().profiles.find((p) => p.id === asProfileId) ?? original)
      : original;
    if (!profile) return null;

    // Coming back on a different account means the conversation has to exist under
    // that account before anything tries to resume it, and it has to be filed under
    // the folder it actually belongs to — not wherever the session was last seen.
    let conversation = past.claudeSessionId ?? undefined;
    let cwd = past.lastCwd || past.startCwd;
    let note: string | null = null;
    const moving = profile.id !== original?.id;
    if (moving) {
      const carried = await window.api.history.carryOver(past.id, profile.id);
      if (!carried) return null;
      conversation = carried.claudeSessionId ?? undefined;
      cwd = carried.cwd || cwd;
      // Say so rather than quietly opening an empty tab that looks like the old one.
      if (past.claudeSessionId && !conversation) {
        note = `nothing was saved for that conversation, so it comes back on ${profile.name} without its thread`;
      }
    }

    set({ historyOpen: false });
    const newId = await get().newSession({
      profileId: profile.id,
      kind: past.kind === 'login' ? 'shell' : past.kind,
      cwd,
      title: past.title ?? undefined,
      resumeSessionId: conversation,
      resumedFrom: past.id,
      handoffFrom: moving && original ? { profileId: original.id, at: Date.now() } : undefined,
    });

    if (newId && note) {
      announce(newId, `\r\n\x1b[38;5;214m── ${note} ──\x1b[0m\r\n`);
    }
    if (newId && moving && conversation && original) {
      window.api.history.recordHandoff({
        reason: 'restore',
        claudeSessionId: conversation,
        fromSessionId: past.id,
        toSessionId: newId,
        fromProfileId: original.id,
        fromProfileName: original.name,
        toProfileId: profile.id,
        toProfileName: profile.name,
      });
      announce(
        newId,
        `\r\n\x1b[38;5;244m── reopened on ${profile.name}, carrying the conversation from ${original.name} ──\x1b[0m\r\n`,
      );
    }
    return newId;
  },

  /**
   * Start Claude in a tab that is sitting at a shell. The main process decides
   * whether that means continuing the conversation or opening one, since only it
   * can see whether a transcript exists.
   */
  runClaudeIn(sessionId, profileId) {
    const session = get().sessions[sessionId];
    if (!session) return;
    if (session.status === 'exited') {
      get().restartSession(sessionId);
      return;
    }

    // A terminal's environment was settled when its shell was spawned, so running
    // Claude as another account cannot mean editing that environment. The account
    // rides on the command line, and the tab moves over to it so that its colour,
    // its conversation tracking and its history all agree with what is running.
    const switching = profileId && profileId !== session.profileId ? profileId : null;
    if (switching) {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: { ...state.sessions[sessionId], profileId: switching },
        },
      }));
      window.api.pty.reassign(sessionId, switching);
      schedulePersist(get);
    }

    window.api.pty.launchLine(sessionId, switching ?? undefined).then((line) => {
      if (line) get().sendInput(sessionId, `${line}\r`);
    });
  },

  /**
   * Open Claude's own picker in this tab. The app can lose track of which
   * conversation a session belonged to; Claude never does, because the transcripts
   * are its own. This is the way back to one the app cannot name.
   */
  pickConversationIn(sessionId) {
    const state = get();
    const session = state.sessions[sessionId];
    const profile = state.profiles.find((p) => p.id === session?.profileId);
    if (!session || !profile) return;
    const bin = profile.claudeCommand || 'claude';
    const prefix = bin.includes('/') ? '' : 'command ';
    get().sendInput(sessionId, `${prefix}${bin} --resume\r`);
  },

  requestClose(sessionId) {
    const session = get().sessions[sessionId];
    if (!session) return;
    // A finished session has nothing left to lose, so it just goes.
    if (session.status === 'exited') {
      get().closeSession(sessionId);
      return;
    }
    set({ pendingClose: { sessionIds: [sessionId], groupId: null } });
  },

  /**
   * Put a whole group away. The group itself is kept — its name, colour, text size
   * and arrangement — so what comes back later is the group as it was, not a
   * handful of sessions that happen to share a name.
   */
  requestCloseGroup(groupId) {
    // A group can be part in the layout and part in the dock. Closing it means all
    // of it: gathering only what a pane shows would leave the set-aside half
    // running with no group left to close it from.
    const members = [
      ...new Set([
        ...get().membersOf(groupId),
        ...get()
          .minimized.filter((entry) => entry.groupId === groupId)
          .map((entry) => entry.sessionId),
      ]),
    ];
    if (!members.length) return;
    const alive = members.filter((id) => get().sessions[id]?.status !== 'exited');
    if (!alive.length) {
      for (const id of members) get().closeSession(id);
      return;
    }
    set({ pendingClose: { sessionIds: members, groupId } });
  },

  confirmClose() {
    const pending = get().pendingClose;
    set({ pendingClose: null });
    if (!pending) return;
    for (const id of pending.sessionIds) get().closeSession(id);
    // The group record outlives its sessions on purpose: that is what History
    // reopens, and what carries the arrangement back with it.
    if (pending.groupId) window.api.groups.save(get().groups);
  },

  cancelClose() {
    set({ pendingClose: null });
  },

  async refreshAuth(profileId, force = false) {
    const profile = get().profiles.find((p) => p.id === profileId);
    if (!profile) return null;
    const status = await window.api.auth.status(profile, force);
    set((state) => ({ authByProfile: { ...state.authByProfile, [profileId]: status } }));
    return status;
  },

  async refreshAllAuth(force = false) {
    // Sequential: each check spawns the CLI, and a burst of them is slower than a queue.
    for (const profile of get().profiles) {
      await get().refreshAuth(profile.id, force);
    }
  },

  /**
   * Sign a profile in from inside the app: make sure its credential folder exists,
   * then open a session running `claude auth login` against it. The CLI drives the
   * browser handshake; we poll until the account shows up as signed in.
   */
  async startLogin(profileId) {
    const profile = get().profiles.find((p) => p.id === profileId);
    if (!profile) return;
    if (profile.configDir) await window.api.profiles.ensureConfigDir(profile.configDir);

    await get().newSession({
      profileId,
      kind: 'login',
      cwd: profile.cwd,
      title: `sign in · ${profile.name}`,
    });

    window.clearInterval(loginPolls.get(profileId));
    let attempts = 0;
    const timer = window.setInterval(async () => {
      attempts += 1;
      const status = await get().refreshAuth(profileId, true);
      if (status?.loggedIn || attempts > 75) {
        window.clearInterval(timer);
        loginPolls.delete(profileId);
      }
    }, 4000);
    loginPolls.set(profileId, timer);
  },
}));

/** Start a pty for a session id that already exists (or is about to) in the layout. */
/** The files panel with this id, or null — a Git tab is not one. */
function filesPanel(state: State, panelId: string): FilePanel | null {
  const found = state.panels[panelId];
  return found?.kind === 'files' ? found : null;
}

/**
 * Bring docked tabs back into the layout.
 *
 * Where they land is the whole question. A tab goes back to the pane it came
 * from whenever that pane is still there. Usually it is not — minimizing a
 * section is what freed it — and then a set of more than one is given a pane of
 * its own beside the active one, so a group comes back as the section it was
 * instead of being poured in as tabs among somebody else's work. A single tab has
 * no section to rebuild, so it simply joins the pane in front.
 */
function restoreTabs(
  set: (fn: (state: State) => Partial<State>) => void,
  get: () => State,
  sessionIds: string[],
) {
  const state = get();
  const entries = state.minimized.filter(
    (entry) =>
      sessionIds.includes(entry.sessionId) &&
      (state.sessions[entry.sessionId] || state.panels[entry.sessionId]),
  );
  if (!entries.length) return;

  let layout = state.layout;
  const home = entries[0].leafId;
  let target = home && findLeaf(layout, home) ? home : null;

  if (!target) {
    const landing = findLeaf(layout, state.activeLeafId) ?? allLeaves(layout)[0];
    if (!landing) return;
    // An empty pane is already somewhere to go; splitting it would leave a spare.
    if (entries.length > 1 && landing.tabs.length > 0) {
      const made = splitEmpty(layout, landing.id, 'row');
      layout = made.root;
      target = made.leafId;
    } else {
      target = landing.id;
    }
  }

  for (const entry of entries) layout = insertTab(layout, target, entry.sessionId);

  const restored = new Set(entries.map((entry) => entry.sessionId));
  const landed = target;
  set((prev) => ({
    layout,
    minimized: prev.minimized.filter((entry) => !restored.has(entry.sessionId)),
    activeLeafId: landed,
    // Same rule the panes already follow: while one is maximized, arriving
    // somewhere else shows where you arrived rather than hiding it.
    zoomedLeafId: prev.zoomedLeafId ? landed : null,
  }));

  get().focusSession(entries[entries.length - 1].sessionId);
  schedulePersist(get);
}

async function spawnInto(
  set: (fn: (state: State) => Partial<State>) => void,
  get: () => State,
  args: {
    sessionId: string;
    profile: Profile;
    kind: SessionKind;
    cwd: string;
    customTitle: string | null;
    resumeSessionId?: string;
    claudeSessionId?: string;
    resumedFrom?: string;
    handoffFrom?: { profileId: string; at: number } | null;
    record?: boolean;
    groupId?: string | null;
    color?: string | null;
    fontSize?: number | null;
    autopilot?: boolean;
    /** What it was running before, and whether it should start that again. */
    lastCommand?: string | null;
    resumeCommand?: boolean;
    /** Where the session first opened, as a second place to look for its conversation. */
    startCwd?: string;
  },
) {
  const { sessionId, profile, kind, cwd, customTitle } = args;
  const terminal = getTerminal(sessionId);
  // Recording only makes sense for a Claude session — a shell has no conversation.
  args.record = kind === 'claude' && (args.record ?? get().settings.recordConversations);
  // Every Claude conversation gets an id we choose, so its transcript file has a
  // predictable path — that is what makes snapshotting and handoff possible.
  const claudeSessionId =
    kind === 'claude'
      ? (args.resumeSessionId ?? args.claudeSessionId ?? crypto.randomUUID())
      : null;

  set((state) => ({
    sessions: {
      ...state.sessions,
      [sessionId]: {
        id: sessionId,
        title: customTitle || defaultTitle(kind, profile),
        customTitle,
        profileId: profile.id,
        cwd,
        startCwd: cwd,
        kind,
        pid: null,
        ptyId: null,
        claudeSessionId,
        limitHit: false,
        handoffFrom: args.handoffFrom ?? null,
        recording: Boolean(args.record),
        foreground: null,
        lastCommand: args.lastCommand ?? null,
        resumeCommand: args.resumeCommand ?? false,
        offerCommand: null,
        groupId: args.groupId ?? null,
        color: args.color ?? null,
        fontSize: args.fontSize ?? null,
        autopilot: Boolean(args.autopilot),
        autopilotState: args.autopilot ? 'watching' : 'off',
        autopilotAsking: null,
        status: 'starting',
        exitCode: null,
        unread: false,
        busy: false,
        createdAt: Date.now(),
      },
    },
  }));

  try {
    const result = await window.api.pty.create({
      profileId: profile.id,
      sessionId,
      cwd,
      kind,
      cols: terminal?.term.cols ?? 100,
      rows: terminal?.term.rows ?? 30,
      title: customTitle,
      resumedFrom: args.resumedFrom,
      record: args.record,
      recordCommands: get().settings.recordCommandOutput,
      startCwd: args.startCwd,
      ...(args.resumeSessionId
        ? { resumeSessionId: args.resumeSessionId }
        : claudeSessionId
          ? { claudeSessionId }
          : {}),
    });
    ptyIndex.set(result.id, sessionId);
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          ptyId: result.id,
          pid: result.pid,
          cwd: result.cwd,
          status: 'running',
          exitCode: null,
        },
      },
    }));
    // A session that was left on autopilot comes back on it. The pty has to exist
    // first — there is nothing to watch until then.
    if (args.autopilot) window.api.pty.autopilot(sessionId, true);
    // Its text size is stored, but a terminal is born at the global size. Without
    // this, a group's size — or a tab's own — is remembered everywhere except in
    // the one place it shows.
    if (args.groupId || args.fontSize != null) applyGroupAppearance(get);
  } catch (error) {
    announce(sessionId, `\r\n\x1b[38;5;203mFailed to start session: ${String(error)}\x1b[0m\r\n`);
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...state.sessions[sessionId], status: 'exited', exitCode: -1 },
      },
    }));
  }
  schedulePersist(get);
}

/**
 * A session that hosts Claude but is not running it right now.
 *
 * Having a conversation counts as much as being opened as one: typing `claude`
 * into a shell tab is how most sessions actually start, and such a tab is no less
 * a Claude session than one the app launched. A shell that never ran Claude is
 * left alone.
 */
function isIdleClaudeSession(session: Session) {
  const hostsClaude = session.kind === 'claude' || Boolean(session.claudeSessionId);
  if (!hostsClaude) return false;
  if (session.status === 'exited') return true;
  return !session.foreground?.includes('claude');
}

function defaultTitle(kind: SessionKind, profile: Profile) {
  if (kind === 'claude') return 'claude';
  if (kind === 'login') return 'sign in';
  return (profile.shell || 'shell').split('/').pop() || 'shell';
}

/** Chrome-like group colours, distinct from the account palette. */
const GROUP_COLORS = ['#7dcfff', '#f7768e', '#9ece6a', '#e0af68', '#bb9af7', '#41a6b5', '#ff9e64'];

function withGroup(
  sessions: Record<string, Session>,
  ids: string[],
  groupId: string | null,
): Record<string, Session> {
  const next = { ...sessions };
  for (const id of ids) if (next[id]) next[id] = { ...next[id], groupId };
  return next;
}

/**
 * Push each group's text size down to its terminals. A group that sets none falls
 * back to the global size, so removing the override restores it rather than
 * leaving the terminal at whatever it happened to be.
 */
function applyGroupAppearance(get: () => State) {
  const { sessions, groups, settings } = get();
  const sizeByGroup = new Map(groups.map((group) => [group.id, group.fontSize]));
  for (const session of Object.values(sessions)) {
    // A group speaks for everything inside it; a tab on its own speaks for itself.
    // Either way, no override means the global size — so clearing one restores it
    // instead of leaving the terminal wherever it happened to be.
    const override = session.groupId ? sizeByGroup.get(session.groupId) : session.fontSize;
    setTerminalFontSize(session.id, override ?? settings.fontSize);
  }
}
