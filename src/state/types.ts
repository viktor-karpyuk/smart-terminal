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

/**
 * A tab that is not a session: a folder on the left, the file you are looking at
 * on the right.
 *
 * It is a tab rather than a sidebar on purpose. Everything the app can already do
 * to a section — split it, drag it somewhere else, fill the window with it, set
 * it aside — it can then do to this, for free and without a single special case.
 */
export interface FilePanel {
  id: string;
  kind: 'files';
  /** The folder the tree is rooted at. */
  root: string;
  /**
   * Git is not a tab of its own — it is the same tab looking at the same folder
   * a different way, reached from the icon in the tree's own corner. A second
   * tab would have meant choosing between them in the strip, when what is
   * wanted is the repository *of the folder you are already in*.
   */
  /**
   * Git is open as a tab in the content row, beside the files. Not a mode: the
   * tree never goes away, and closing Git leaves you on whatever file you had —
   * so there is nothing to be in and nothing to remember.
   */
  gitOpen: boolean;
  /** The repository `root` is inside, once git has been asked. */
  gitRoot: string | null;
  gitView: GitView;
  gitGrouping: GitGrouping;
  /** Folders collapsed in the changes tree. */
  gitCollapsed: string[];
  message: string;
  amend: boolean;
  selectedSha: string | null;
  /** The changed file whose diff is showing, as a repository-relative path. */
  selectedPath: string | null;
  selectedBranch: string | null;
  /** Which session's folder this followed, if it was opened from one. */
  followsSessionId: string | null;
  /** Folders opened in the tree, so it keeps its shape across a restart. */
  expanded: string[];
  /** How wide the tree is. Per panel, because two folders are not equally deep. */
  treeWidth: number;
  /** Files open in the editor, in tab order. */
  open: string[];
  /** The one in front. */
  active: string | null;
}

/**
 * Git's place in the content row. A file path is always absolute, so this can
 * never be mistaken for one.
 */
export const GIT_TAB = '::git';

export type GitView = 'changes' | 'history' | 'branches';
export type GitGrouping = 'directory' | 'module' | 'both' | 'files';

/**
 * A whole section set aside, and where it was.
 *
 * Unlike a single tab, a section has a *place* — it was beside something, on a
 * side, at a width. All three are kept so bringing it back is genuinely undoing
 * the minimize rather than dropping its tabs somewhere plausible.
 */
export interface MinimizedSection {
  id: string;
  tabs: string[];
  active: string | null;
  /** A tab in the pane it sat beside; a tab id survives the tree being rebuilt. */
  anchorTabId: string | null;
  side: 'left' | 'right' | 'top' | 'bottom' | null;
  share: number;
  /** What to call it in the dock: the group it belongs to, or its own tabs. */
  label: string;
  colour: string | null;
  at: number;
}

/**
 * A file being edited. Held apart from the panels because two panels showing the
 * same file must show the same unsaved text — the buffer belongs to the file, not
 * to the pane looking at it.
 */
export interface Buffer {
  path: string;
  /** What is in the editor now. */
  text: string;
  /** What was last read from or written to disk; equal to `text` means saved. */
  savedText: string;
  /** The modification time the text was read at, which is what a save is checked against. */
  mtimeMs: number;
  /** Set when the file changed on disk under an edit that is not saved yet. */
  conflict: { text: string; mtimeMs: number } | null;
  /** True while the file changed on disk and the editor took it silently. */
  reloadedAt: number | null;
  loading: boolean;
  error: string | null;
  readOnly: boolean;
}

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
  /**
   * How the file tree draws its icons. `colour` tints each one by what the file
   * is, which is the difference between finding a stylesheet by looking and
   * finding it by reading forty names.
   */
  fileIcons: 'outline' | 'solid' | 'colour' | 'none';
  /**
   * Folders are set apart from files on purpose. They are the thing you navigate
   * by, so their colour is worth choosing rather than inheriting whatever the
   * files happen to be — and `match` is for anyone who would rather they did.
   */
  folderColour: string;
  /** Whether an open folder is drawn differently from a shut one. */
  folderStyle: 'plain' | 'open-shut';
  /**
   * Which lists the sidebar shows. Both by default: they are different things —
   * a session is work in progress, a folder is a place — and someone running
   * twenty sessions and one folder wants a different sidebar from someone
   * reading four repositories.
   */
  sidebarShowSessions: boolean;
  sidebarShowFolders: boolean;
}
