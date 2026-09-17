import { useEffect } from 'react';
import { isDarkAppearance, useStore } from './state/store';
import { findLeaf } from './state/layout';
import { GIT_TAB } from './state/types';
import { copySelection, focusedTerminalId, getTerminal, selectAllIn } from './terminals/registry';
import { LayoutView } from './components/LayoutView';
import { Pane } from './components/Pane';
import { Sidebar, SIDEBAR_MIN } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { ProfileEditor } from './components/ProfileEditor';
import { SessionContextMenu } from './components/SessionContextMenu';
import { TerminalMenu, TerminalNotice } from './components/TerminalMenu';
import { UsagePanel } from './components/UsagePanel';
import { AppearancePanel } from './components/AppearancePanel';
import { UpdatePanel } from './components/UpdatePanel';
import { HistoryPanel } from './components/HistoryPanel';
import { CloseConfirm } from './components/CloseConfirm';
import { NameSession } from './components/NameSession';
import { MinimizedDock } from './components/MinimizedDock';

export function App() {
  const ready = useStore((s) => s.ready);
  const layout = useStore((s) => s.layout);
  const settings = useStore((s) => s.settings);
  const zoomedLeafId = useStore((s) => s.zoomedLeafId);
  const profileEditorOpen = useStore((s) => s.profileEditorOpen);
  const usagePanelOpen = useStore((s) => s.usagePanelOpen);
  const historyOpen = useStore((s) => s.historyOpen);
  const appearanceOpen = useStore((s) => s.appearanceOpen);
  const updatePanelOpen = useStore((s) => s.updatePanelOpen);

  useEffect(() => {
    useStore.getState().init();
  }, []);

  useEffect(() => window.api.onMenuAction(({ id }) => handleMenuAction(id)), []);

  // Stamp the resolved appearance on the root so the token palette switches, and
  // keep following the OS while the setting says `system`.
  useEffect(() => {
    const apply = () =>
      document.documentElement.setAttribute(
        'data-theme',
        isDarkAppearance(settings.theme) ? 'dark' : 'light',
      );
    apply();
    if (settings.theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [settings.theme]);

  /*
   * The editors' size, on the root where every editor can see it.
   *
   * A CSS variable rather than a prop threaded down: an editor is a CodeMirror
   * instance with a stylesheet of its own, and the variable is what that
   * stylesheet already asks for — it had simply never been answered.
   */
  useEffect(() => {
    document.documentElement.style.setProperty('--editor-size', `${settings.editorFontSize}px`);
  }, [settings.editorFontSize]);

  const zoomedLeaf = zoomedLeafId ? findLeaf(layout, zoomedLeafId) : null;

  return (
    <div className="app">
      <TitleBar />
      <div className="workbench">
        {settings.sidebarVisible && (
          <>
            <Sidebar />
            <SidebarResizer />
          </>
        )}
        <main className="grid">
          {ready ? (
            zoomedLeaf ? <Pane leaf={zoomedLeaf} /> : <LayoutView node={layout} />
          ) : (
            <div className="boot">Starting…</div>
          )}
        </main>
      </div>
      {/* Below the workbench, so what was set aside is out of the way of the work
          but never out of sight. */}
      <MinimizedDock />
      <SessionContextMenu />
      <TerminalMenu />
      <TerminalNotice />
      {profileEditorOpen && <ProfileEditor />}
      {usagePanelOpen && <UsagePanel />}
      {historyOpen && <HistoryPanel />}
      {appearanceOpen && <AppearancePanel />}
      {updatePanelOpen && <UpdatePanel />}
      <CloseConfirm />
      <NameSession />
    </div>
  );
}

/** Narrower than this and the lists are unreadable, so it hides instead. */
const HIDE_BELOW = 132;
/** The floor lives with the sidebar, which is what has to fit inside it. */
const MIN_WIDTH = SIDEBAR_MIN;

function SidebarResizer() {
  const updateSettings = useStore((s) => s.updateSettings);
  return (
    <div
      className="sidebar-resizer"
      onDoubleClick={() => updateSettings({ sidebarVisible: false })}
      onPointerDown={(event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = useStore.getState().settings.sidebarWidth;

        const onMove = (move: PointerEvent) => {
          const wanted = startWidth + move.clientX - startX;
          /*
           * Dragged in past the point where the sidebar can say anything useful,
           * it goes away rather than being squeezed into a column of half-words.
           * The width it had is kept, so bringing it back with ⌘B gives back the
           * sidebar you were using and not a stub.
           */
          if (wanted < HIDE_BELOW) {
            updateSettings({ sidebarVisible: false });
            onUp();
            return;
          }
          updateSettings({ sidebarWidth: Math.min(520, Math.max(MIN_WIDTH, wanted)) });
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          document.body.classList.remove('resizing');
        };
        document.body.classList.add('resizing');
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      }}
    />
  );
}

/**
 * Whether the keyboard is inside a file editor.
 *
 * Asked of the document rather than tracked in the store: CodeMirror owns its
 * own focus and the answer has to be true at the instant the key was pressed,
 * not at whatever moment the store last heard about it.
 */
function inEditor(): boolean {
  return Boolean(document.activeElement?.closest?.('.cm-editor'));
}

function activeSessionId(): string | null {
  const state = useStore.getState();
  return findLeaf(state.layout, state.activeLeafId)?.active ?? null;
}

export function handleMenuAction(id: string) {
  const store = useStore.getState();
  const sessionId = activeSessionId();
  /*
   * Anything aimed at a terminal goes to the one with the keyboard in it.
   *
   * The active tab is the right answer for everything else, and the wrong one
   * for this: a folder's terminal lives inside a panel, so the active tab there
   * is the panel. Asking which terminal has focus is the same answer as the
   * active tab in every other case, and the only correct one in this one.
   */
  const terminalId = focusedTerminalId() ?? sessionId;

  switch (id) {
    case 'new-claude':
      store.newSession({ kind: 'claude', ask: true });
      break;
    case 'new-shell':
      store.newSession({ kind: 'shell', ask: true });
      break;
    case 'duplicate':
      if (sessionId) store.duplicateSession(sessionId);
      break;
    case 'close':
      if (sessionId) store.requestClose(sessionId);
      break;
    case 'run-claude':
      if (sessionId) store.runClaudeIn(sessionId);
      break;
    case 'history':
      store.setHistoryOpen(true);
      break;
    case 'updates':
      store.setUpdatePanelOpen(true);
      break;
    case 'restart':
      if (sessionId) store.restartSession(sessionId);
      break;
    case 'rename':
      store.setRenamingSessionId(sessionId);
      break;
    case 'split-right':
      store.splitActive('row');
      break;
    case 'split-down':
      store.splitActive('column');
      break;
    case 'focus-left':
      store.focusDirection('left');
      break;
    case 'focus-right':
      store.focusDirection('right');
      break;
    case 'focus-up':
      store.focusDirection('up');
      break;
    case 'focus-down':
      store.focusDirection('down');
      break;
    case 'next-tab':
      store.cycleTab(1);
      break;
    case 'prev-tab':
      store.cycleTab(-1);
      break;
    case 'close-pane':
      store.closePane(store.activeLeafId);
      break;
    case 'even-splits':
      store.evenSplits();
      break;
    case 'toggle-zoom':
      store.toggleZoom();
      break;
    case 'minimize-pane':
      store.minimizeSection(store.activeLeafId);
      break;
    case 'restore-last': {
      // Last in, first out: undoing a minimize you just made is what this is for,
      // and a whole section set aside is the more likely thing to want back.
      const section = store.minimizedSections[store.minimizedSections.length - 1];
      const tab = store.minimized[store.minimized.length - 1];
      if (section && (!tab || section.at >= 0)) {
        store.restoreSection(section.id);
        break;
      }
      if (tab?.groupId) store.restoreMinimizedGroup(tab.groupId);
      else if (tab) store.restoreMinimized(tab.sessionId);
      break;
    }
    case 'toggle-sidebar':
      store.updateSettings({ sidebarVisible: !store.settings.sidebarVisible });
      break;
    case 'find':
      store.setFindOpenFor(sessionId);
      break;
    case 'clear':
      if (terminalId) getTerminal(terminalId)?.term.clear();
      break;
    case 'save': {
      /*
       * The file in front in the panel in front, wherever the keyboard is —
       * the tree, the tab strip, the terminal underneath, the editor itself.
       * A save that depended on the focus being in the editor was a save that
       * silently did nothing after a click somewhere else.
       */
      const panel = sessionId ? store.panels[sessionId] : null;
      if (panel?.kind === 'files' && panel.active && panel.active !== GIT_TAB) void store.saveBuffer(panel.active);
      break;
    }
    case 'copy': {
      // A panel an extension brought has the focus: it is asked for its
      // selection, since the app cannot see into a frame of another origin.
      const focused = document.activeElement;
      if (focused instanceof HTMLIFrameElement && focused.classList.contains('extension-frame')) {
        focused.contentWindow?.postMessage({ type: 'copy' }, '*');
        break;
      }
      copySelection(terminalId);
      break;
    }
    case 'select-all':
      selectAllIn(terminalId);
      break;
    /*
     * Bigger and smaller act on whatever the keyboard is in.
     *
     * ⌘+ used to mean the terminals, wherever you pressed it — so somebody
     * reading a file pressed it, watched the terminals behind them grow, and
     * gave up. Both sizes are settings, so either way the change is kept and
     * comes back after a restart.
     */
    case 'font-bigger':
      if (inEditor()) store.updateSettings({ editorFontSize: Math.min(28, store.settings.editorFontSize + 1) });
      else store.updateSettings({ fontSize: Math.min(24, store.settings.fontSize + 1) });
      break;
    case 'font-smaller':
      if (inEditor()) store.updateSettings({ editorFontSize: Math.max(8, store.settings.editorFontSize - 1) });
      else store.updateSettings({ fontSize: Math.max(8, store.settings.fontSize - 1) });
      break;
    case 'font-reset':
      if (inEditor()) store.updateSettings({ editorFontSize: 12.5 });
      else store.updateSettings({ fontSize: 13 });
      break;
    case 'profiles':
      store.setProfileEditorOpen(true);
      break;
    case 'usage':
      store.setUsagePanelOpen(true);
      break;
    case 'appearance':
      store.setAppearanceOpen(true);
      break;
  }
}
