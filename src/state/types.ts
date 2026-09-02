export type Direction = 'row' | 'column';

/** A pane: one rectangle on screen holding a tab strip of sessions. */
export interface LeafNode {
  id: string;
  type: 'leaf';
  tabs: string[];
  active: string | null;
  /**
   * An empty pane that was asked for, not one left behind. Splitting the screen
   * gives you somewhere to put something; a pane emptied by closing its last tab
   * is just gone. Without the distinction, pruning cannot tell them apart.
   */
  placeholder?: boolean;
}

/** A container splitting its area between children along one axis. */
export interface SplitNode {
  id: string;
  type: 'split';
  direction: Direction;
  children: LayoutNode[];
  sizes: number[];
}

export type LayoutNode = LeafNode | SplitNode;

export type DropSide = 'left' | 'right' | 'top' | 'bottom' | 'center';

/**
 * A tab set aside. It is out of the layout — which is exactly what hands its pane
 * back to its neighbours — but its session keeps running, so this is only about
 * where it is shown, never about what it is doing.
 *
 * Because it is not in the layout, the window has to name it somewhere else or a
 * restart would lose it; `electron/restore.js` reads this list alongside the tree.
 */
export interface MinimizedTab {
  sessionId: string;
  /** The pane it came from, so it goes back there if that pane is still around. */
  leafId: string | null;
  /** Minimized together, and restored together: one click brings the set back. */
  groupId: string | null;
}

/** `login` runs `claude auth login` so a profile can be signed in from inside the app. */
export type SessionKind = 'claude' | 'shell' | 'login';

export interface Session {
  id: string;
  title: string;
  customTitle: string | null;
  profileId: string;
  /** Where the shell is *right now* — tracked live, since the user can `cd` freely. */
  cwd: string;
  /** The folder the session was started in, kept so a restart lands in the same place. */
  startCwd: string;
  kind: SessionKind;
  pid: number | null;
  /** Current pty in the main process; changes when the session is restarted. */
  ptyId: string | null;
  /** The conversation id passed to `claude --session-id`, so its transcript is findable. */
  claudeSessionId: string | null;
  /** Set when the account behind this session reported it was out of usage. */
  limitHit: boolean;
  /** Which account this conversation was carried over from, if any. */
  handoffFrom: { profileId: string; at: number } | null;
  /** Whether this session's conversation is being kept in the database. */
  recording: boolean;
  /** The command the shell is currently running, or null at a prompt. */
  foreground: string | null;
  /** The group this session belongs to, if any. */
  groupId: string | null;
  /**
   * A look of its own, for a tab that stands alone. A group governs the look of
   * everything in it, so these only apply while `groupId` is null — joining a group
   * hides them rather than discarding them, and leaving one brings them back.
   */
  color: string | null;
  fontSize: number | null;
  /**
   * Keep going on its own when the only thing stopping it is nobody saying "go".
   * It never answers a question that needs a person; those are exactly the stops
   * worth keeping.
   */
  autopilot: boolean;
  /** What autopilot last saw: working, waiting on you, finished, or off. */
  autopilotState: 'off' | 'watching' | 'working' | 'nudged' | 'waiting-for-you' | 'done';
  /** The tool it is asking permission for, while it waits on you. */
  autopilotAsking: string | null;
  status: 'starting' | 'running' | 'exited';
  exitCode: number | null;
  /** Output seen since the session was last focused. */
  unread: boolean;
  /** True while output is still arriving — a rough "Claude is working" light. */
  busy: boolean;
  createdAt: number;
}

export interface Profile {
  id: string;
  name: string;
  color: string;
  configDir: string | null;
  cwd: string;
  shell: string | null;
  claudeCommand: string;
  claudeArgs: string[];
  env: Record<string, string>;
  /** Account to carry sessions over to when this one runs out of usage. */
  fallbackProfileId: string | null;
}

/**
 * A named set of sessions that belong to the same piece of work — "KS-ERP", say.
 *
 * A group is deliberately not part of the layout tree: its members can sit in one
 * pane as tabs or be spread across several, and the group survives either way.
 * That is what lets it be re-arranged as a unit without losing what it is.
 */
export interface SessionGroup {
  id: string;
  name: string;
  color: string;
  /** Overrides the global text size for every session in the group. */
  fontSize: number | null;
  /** Collapsed in the tab strip, the way a browser folds a tab group away. */
  collapsed: boolean;
  /**
   * How its sessions were last laid out. Remembered so that closing a group and
   * opening it again gives back the arrangement someone chose, not a default pile
   * of tabs that merely share a name.
   */
  arrangement: GroupArrangement | null;
}

/** How a group's sessions are arranged when it is laid out as a unit. */
export type GroupArrangement = 'tabs' | 'columns' | 'rows' | 'grid';

/** What a close confirmation is about: one session, or a whole group of them. */
export interface PendingClose {
  sessionIds: string[];
  groupId: string | null;
}

export interface Settings {
  fontSize: number;
  fontFamily: string;
  sidebarVisible: boolean;
  sidebarWidth: number;
  cursorBlink: boolean;
  scrollback: number;
  /** Move a session to another account by itself when its own runs out. */
  autoHandoff: boolean;
  /** Account new sessions belong to unless one is chosen explicitly. */
  defaultProfileId: string | null;
  /** Regex matched against session output to notice a usage limit. */
  limitPattern: string;
  /** Keep a readable, searchable copy of every conversation in the database. */
  recordConversations: boolean;
  /** Include what each command printed. This is most of what the copies weigh. */
  recordCommandOutput: boolean;
  /** Interface appearance. `system` follows the OS setting. */
  theme: 'system' | 'light' | 'dark';
  /** Terminal palette id, or `follow-app` to track the interface. */
  terminalPalette: string;
  /** Hand-picked colours layered over the chosen palette. */
  terminalOverrides: Record<string, string>;
  /**
   * How far a session can reach when it talks to other sessions through MCP.
   *
   * `group` — the default — is the other sessions in its own group, which is the
   * app's word for "the same piece of work". `all` is every running session.
   * `off` closes the channel. An ungrouped session reaches nobody on `group`:
   * not being in a group is not a group.
   */
  sessionMessaging: 'off' | 'group' | 'all';
}
