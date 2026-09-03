import type {
  FilePanel,
  MinimizedSection,
  LayoutNode,
  MinimizedTab,
  Profile,
  Session,
  Panel,
  SessionAnalysis,
  SessionGroup,
  Settings,
} from './state/types';

export interface PtyCreateOptions {
  profileId: string;
  /** The app's session id, so the main process can track its transcript. */
  sessionId?: string;
  /** Pin a new conversation's id. */
  claudeSessionId?: string;
  /** Continue an existing conversation instead of starting one. */
  resumeSessionId?: string;
  /** Where the session first opened, as a second place to look for its conversation. */
  startCwd?: string;
  /** The closed session this one continues, for the history trail. */
  resumedFrom?: string;
  title?: string | null;
  /** Keep this session's conversation in the database, searchable and readable. */
  record?: boolean;
  /** Include what commands printed in the kept copy. */
  recordCommands?: boolean;
  cwd?: string;
  kind?: 'claude' | 'shell' | 'login';
  cols?: number;
  rows?: number;
  extraArgs?: string[];
  command?: string | null;
}

export interface PtyCreateResult {
  id: string;
  pid: number;
  cwd: string;
  shell: string;
  kind: 'claude' | 'shell' | 'login';
  profileId: string;
}

export interface PersistedWorkspace {
  layout: LayoutNode | null;
  sessions: Array<
    Pick<
      Session,
      | 'id'
      | 'profileId'
      | 'cwd'
      | 'kind'
      | 'customTitle'
      | 'claudeSessionId'
      | 'handoffFrom'
      | 'groupId'
      | 'color'
      | 'fontSize'
      | 'autopilot'
    > & { startCwd?: string; lastCommand?: string | null; resumeCommand?: boolean }
  >;
  settings: Partial<Settings>;
  /** Which pane had focus, so a crash restores it too. */
  activeLeaf?: string | null;
  groups?: SessionGroup[];
  /** Tabs set aside in the dock. Saved apart from the layout because they are not in it. */
  minimized?: MinimizedTab[];
  /** Panels that occupy tabs in the layout but are not sessions. */
  panels?: Panel[];
  /** Whole sections set aside, each remembering where it was. */
  sections?: MinimizedSection[];
}

/** Everything `git:call` can hand back, in one shape. */
export interface GitResult {
  ok: boolean;
  error?: string;
  value?: unknown;
  stdout?: string;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  detached?: boolean;
  files?: GitFile[];
  commits?: GitCommit[];
  width?: number;
  current?: string | null;
  /** The commit an amend would rewrite: its whole message, and what was in it. */
  sha?: string;
  message?: string;
  author?: string;
  date?: string;
  local?: GitBranch[];
  remote?: Array<{ name: string; sha: string; date: string }>;
  tags?: Array<{ name: string; sha: string; date: string }>;
  stashes?: Array<{ ref: string; subject: string; date: string }>;
  patch?: string;
}

export interface GitFile {
  path: string;
  absolute: string;
  dir: string;
  name: string;
  index: string;
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
  staged: boolean;
  partial: boolean;
  letter: string;
  from?: string;
  added?: number | null;
  removed?: number | null;
}

export interface GitRef {
  kind: 'local' | 'remote' | 'tag' | 'head' | 'other';
  name: string;
  head: boolean;
}

export interface GitCommit {
  sha: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  refs: GitRef[];
  /** Filled in by the lane layout: where this commit's dot and lines go. */
  lane: number;
  colour: string;
  through: Array<{ lane: number; colour: string }>;
  edges: Array<{ sha: string; from: number; to: number; kind: string; colour: string }>;
  merge: boolean;
  root: boolean;
}

export interface GitBranch {
  name: string;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  date: string;
}

/** One entry in a folder listing. */
export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  /** A folder that is a git checkout of its own. */
  repo?: boolean;
  /** Build output, dot-files, node_modules — shown, but dimmed. */
  noise: boolean;
}

export interface FileRead {
  ok: boolean;
  text?: string;
  mtimeMs?: number;
  size?: number;
  error?: string;
  binary?: boolean;
}

export interface FileWrite {
  ok: boolean;
  mtimeMs?: number;
  size?: number;
  /** The file moved on disk since it was read; `text` is what is there now. */
  conflict?: boolean;
  text?: string | null;
  error?: string;
}

export interface ContextInfo {
  sessionId: string;
  tracked: boolean;
  meta: {
    claudeSessionId: string;
    cwd: string;
    configDir: string | null;
    profileId: string | null;
    bytes: number;
    savedAt: number;
  } | null;
  liveBytes: number | null;
}

export interface UsageBlock {
  percentUsed: number;
  resets: string | null;
}

export interface UsageReport {
  ok: boolean;
  profileId?: string;
  error?: string;
  readAt: number;
  session?: UsageBlock | null;
  week?: (UsageBlock & { model: string }) | null;
  perModel?: Array<UsageBlock & { model: string }>;
  windows?: Array<{
    label: string;
    summary: string;
    behaviours: Array<{ percent: number; what: string }>;
    extras: string[];
  }>;
  raw?: string;
}

export interface HistorySession {
  id: string;
  profileId: string;
  profileName: string | null;
  claudeSessionId: string | null;
  kind: 'claude' | 'shell' | 'login';
  title: string | null;
  startCwd: string;
  lastCwd: string | null;
  startedAt: number;
  endedAt: number | null;
  lastActiveAt: number | null;
  exitCode: number | null;
  resumedFrom: string | null;
  storeTranscript: boolean;
  /** Which window is showing it, when it is open. */
  windowId: string | null;
  /** The group it belonged to, if any. */
  groupId: string | null;
  /** Characters of conversation kept for this session. */
  transcriptBytes: number | null;
  open: boolean;
  durationMs: number;
  matchedTranscript?: boolean;
}

export interface TranscriptEntry {
  seq: number;
  at: number | null;
  role: 'user' | 'assistant' | 'thinking' | 'tool' | 'result';
  text: string;
}

/** A session as the other windows see it: enough to list it and go to it. */
export interface RosterEntry {
  id: string;
  windowId: string | null;
  profileId: string;
  profileName: string | null;
  title: string | null;
  cwd: string;
  kind: 'claude' | 'shell' | 'login';
  groupId: string | null;
}

export interface GroupRecord {
  id: string;
  name: string;
  color: string | null;
  fontSize: number | null;
  /** How it was laid out when it was last arranged, so it comes back that way. */
  arrangement: 'tabs' | 'columns' | 'rows' | 'grid' | null;
  members: number;
  open: number;
  resumable: number;
  lastActiveAt: number;
}

export interface HandoffRecord {
  id: number;
  at: number;
  reason: string;
  claude_session_id: string | null;
  from_session_id: string | null;
  to_session_id: string | null;
  from_profile_name: string | null;
  to_profile_name: string | null;
}

export interface AuthStatus {
  available: boolean;
  loggedIn: boolean;
  email?: string | null;
  orgName?: string | null;
  subscriptionType?: string | null;
  authMethod?: string | null;
  error?: string;
}

export interface ConfigDirSuggestion {
  dir: string;
  label: string;
  detail: string;
  recommended: boolean;
  /** The folder already holds a signed-in account. */
  hasLogin: boolean;
}

/** What a session would be told if it had to start over without its conversation. */
export interface SessionBrief {
  at: number;
  title: string | null;
  lastPrompt: string | null;
  cwd: string | null;
  branch: string | null;
  turns: number;
  open: Array<{ id: string; subject: string; status: string }>;
  done: Array<{ id: string; subject: string; status: string }>;
  text: string | null;
}

/** How the database is doing: what it weighs, what of that is empty, what is rot. */
export interface DbHealth {
  pageSize: number;
  bytes: number;
  wasted: number;
  pages: number;
  freePages: number;
  tables: Array<{ name: string; rows: number; bytes: number | null }>;
  orphans: { chunks: number; stats: number; briefs: number; messages: number };
  sessions: {
    total: number;
    open: number;
    ended: number;
    olderThan30: number;
    olderThan90: number;
    oldest: number | null;
  };
  integrity: string | null;
  readAt: number;
  onDisk: number;
  walBytes: number;
  snapshotBytes: number;
}

/** One session's row in the monitor's saved history. */
export interface SessionStats {
  session_id: string;
  measured_at: number;
  requests: number;
  span_ms: number;
  context_window: number;
  context_peak: number;
  context_last: number;
  context_mean: number;
  turns_above: number;
  input_tokens: number;
  output_tokens: number;
  cache_write: number;
  cache_read: number;
  effective_input: number;
  compactions: number;
  auto_compactions: number;
  dropped_tokens: number;
  reprimed_tokens: number;
  latency_p50: number;
  latency_p95: number;
  errors: number;
  worst: 'high' | 'medium' | 'low' | null;
  findings: Array<{ id: string; severity: 'high' | 'medium' | 'low'; title: string }>;
  title: string | null;
  profile_name: string | null;
  start_cwd: string | null;
  started_at: number | null;
  ended_at: number | null;
}

declare global {
  interface Window {
    api: {
      platform: string;
      windowId: string;
      newWindow(): void;
      version(): Promise<{
        version: string;
        build: number | null;
        builtAt: string | null;
        electron: string;
        node: string;
      }>;
      pty: {
        create(options: PtyCreateOptions): Promise<PtyCreateResult>;
        write(id: string, data: string): void;
        resize(id: string, cols: number, rows: number): void;
        kill(id: string): void;
        releaseOrphans(): void;
        launchLine(sessionId: string, profileId?: string): Promise<string | null>;
        autopilot(sessionId: string, on: boolean): Promise<boolean>;
        reportScreen(sessionId: string, text: string): void;
        onAutopilot(
          handler: (payload: {
            sessionId: string;
            on: boolean;
            state: 'off' | 'watching' | 'working' | 'nudged' | 'waiting-for-you' | 'done';
            asking?: string | null;
            nudges?: number;
          }) => void,
        ): () => void;
        reassign(sessionId: string, profileId: string): Promise<boolean>;
        onData(handler: (payload: { id: string; data: string }) => void): () => void;
        onExit(
          handler: (payload: { id: string; exitCode: number; signal?: number }) => void,
        ): () => void;
        onCwd(
          handler: (
            changes: Array<{
              id: string;
              cwd?: string;
              foreground: string | null;
              /** The whole line, for offering it again after a restart. */
              command?: string | null;
            }>,
          ) => void,
        ): () => void;
        onAdopted(
          handler: (payload: { sessionId: string; claudeSessionId: string }) => void,
        ): () => void;
      };
      profiles: {
        list(): Promise<Profile[]>;
        save(profile: Partial<Profile>): Promise<Profile[]>;
        remove(id: string): Promise<Profile[]>;
        discover(): Promise<Array<{ name: string; dir: string }>>;
        suggestConfigDirs(name: string): Promise<ConfigDirSuggestion[]>;
        ensureConfigDir(dir: string): Promise<string>;
      };
      auth: {
        status(profile: Partial<Profile>, force?: boolean): Promise<AuthStatus>;
      };
      usage: {
        read(profileId: string, force?: boolean): Promise<UsageReport>;
      };
      analysis: {
        session(sessionId: string, force?: boolean): Promise<SessionAnalysis | null>;
        all(): Promise<SessionStats[]>;
        live(): Promise<Record<string, SessionAnalysis>>;
        advice(payload: {
          sessionId: string;
          question?: string;
          alongside?: string[];
          force?: boolean;
        }): Promise<Advice>;
        adviceHeld(sessionId: string): Promise<Advice | null>;
        tell(sessionId: string, text: string): Promise<{ ok: boolean; detail?: string; error?: string }>;
        brief(sessionId: string): Promise<SessionBrief | null>;
        handOver(sessionId: string, text: string): Promise<{ ok: boolean; delivered?: boolean; error?: string }>;
        dbHealth(deep?: boolean): Promise<DbHealth>;
        dbMaintain(options: {
          orphans?: boolean;
          olderThanDays?: number | null;
          transcriptsOlderThanDays?: number | null;
          reclaim?: boolean;
        }): Promise<{ done: Array<{ op: string; rows: number }>; freed: number; after: DbHealth }>;
        onChanged(fn: (payload: { sessionId: string; verdict: SessionAnalysis }) => void): () => void;
      };
      context: {
        info(sessionId: string): Promise<ContextInfo>;
        save(sessionId: string): Promise<ContextInfo | null>;
        handoff(payload: {
          sessionId: string;
          targetProfileId: string;
          cwd?: string;
        }): Promise<{ claudeSessionId: string; cwd: string; transcript: string }>;
        forget(sessionId: string): void;
        release(sessionId: string): void;
      };
      groups: {
        list(): Promise<SessionGroup[]>;
        save(groups: SessionGroup[]): void;
        forget(groupId: string): void;
        onChanged(handler: (groups: SessionGroup[]) => void): () => void;
      };
      sessions: {
        roster(): Promise<RosterEntry[]>;
        stop(sessionId: string): Promise<boolean>;
        onStopped(handler: (payload: { sessionId: string }) => void): () => void;
        onRoster(handler: (roster: RosterEntry[]) => void): () => void;
        focusWindow(windowId: string): void;
      };
      history: {
        sessions(options?: {
          query?: string;
          profileId?: string | null;
          includeOpen?: boolean;
          limit?: number;
        }): Promise<HistorySession[]>;
        session(id: string): Promise<HistorySession | null>;
        handoffs(limit?: number): Promise<HandoffRecord[]>;
        carryOver(
          sessionId: string,
          profileId: string,
        ): Promise<{ claudeSessionId: string | null; cwd: string } | null>;
        deleteSession(sessionId: string): Promise<boolean>;
        clearHistory(options?: { before?: number }): Promise<number>;
        groups(options?: { limit?: number }): Promise<GroupRecord[]>;
        recentFolders(limit?: number): Promise<string[]>;
        groupMembers(groupId: string): Promise<HistorySession[]>;
        deleteGroup(groupId: string): Promise<void>;
        excerpts(sessionId: string, query: string): Promise<string[]>;
        setStoreTranscript(sessionId: string, enabled: boolean): Promise<HistorySession | null>;
        transcript(sessionId: string, limit?: number): Promise<TranscriptEntry[]>;
        storage(): Promise<{
          entries: number;
          textBytes: number;
          commandBytes: number;
          sessions: number;
          recording: number;
          onDisk: number;
          snapshotBytes: number;
        }>;
        setCommandOutput(withCommands: boolean): void;
        setRecordDefault(enabled: boolean): void;
        forgetAllTranscripts(): Promise<{ entries: number; snapshots: number }>;
        rename(sessionId: string, title: string | null): void;
        setResumeCommand(sessionId: string, on: boolean): void;
        updateCwd(sessionId: string, cwd: string): void;
        endSession(sessionId: string, exitCode?: number | null): void;
        recordHandoff(entry: Record<string, unknown>): void;
      };
      workspace: {
        load(): Promise<PersistedWorkspace>;
        save(state: PersistedWorkspace): void;
      };
      git: {
        call(name: string, root: string, args?: unknown): Promise<GitResult>;
      };
      files: {
        list(dir: string): Promise<{ ok: boolean; entries?: DirEntry[]; error?: string }>;
        read(file: string): Promise<FileRead>;
        write(
          file: string,
          text: string,
          options?: { expectedMtimeMs?: number | null; force?: boolean },
        ): Promise<FileWrite>;
        watch(file: string, mtimeMs: number): void;
        unwatch(file: string): void;
        onChanged(
          handler: (changes: Array<{ path: string; mtimeMs: number; gone?: boolean }>) => void,
        ): () => void;
        reveal(file: string): void;
      };
      system: {
        pickDirectory(startIn?: string): Promise<string | null>;
        homedir(): Promise<string>;
        paths(): Promise<{ home: string; accountsRoot: string }>;
        openExternal(url: string): void;
      };
      onMenuAction(handler: (payload: { id: string }) => void): () => void;
    };
  }
}
