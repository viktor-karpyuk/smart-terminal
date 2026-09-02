import { useEffect } from 'react';
import { isDarkAppearance, useStore } from './state/store';
import { findLeaf } from './state/layout';
import { copySelection, getTerminal, selectAllIn } from './terminals/registry';
import { LayoutView } from './components/LayoutView';
import { Pane } from './components/Pane';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { ProfileEditor } from './components/ProfileEditor';
import { SessionContextMenu } from './components/SessionContextMenu';
import { UsagePanel } from './components/UsagePanel';
import { AppearancePanel } from './components/AppearancePanel';
import { HistoryPanel } from './components/HistoryPanel';
import { CloseConfirm } from './components/CloseConfirm';
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
      {profileEditorOpen && <ProfileEditor />}
      {usagePanelOpen && <UsagePanel />}
      {historyOpen && <HistoryPanel />}
      {appearanceOpen && <AppearancePanel />}
      <CloseConfirm />
    </div>
  );
}

function SidebarResizer() {
  const updateSettings = useStore((s) => s.updateSettings);
  return (
    <div
      className="sidebar-resizer"
      onPointerDown={(event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = useStore.getState().settings.sidebarWidth;
        const onMove = (move: PointerEvent) =>
          updateSettings({
            sidebarWidth: Math.min(520, Math.max(180, startWidth + move.clientX - startX)),
          });
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

function activeSessionId(): string | null {
  const state = useStore.getState();
  return findLeaf(state.layout, state.activeLeafId)?.active ?? null;
}

function handleMenuAction(id: string) {
  const store = useStore.getState();
  const sessionId = activeSessionId();

  switch (id) {
    case 'new-claude':
      store.newSession({ kind: 'claude' });
      break;
    case 'new-shell':
      store.newSession({ kind: 'shell' });
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
      store.minimizePane(store.activeLeafId);
      break;
    case 'restore-last': {
      // Last in, first out: undoing a minimize you just made is what this is for.
      const last = store.minimized[store.minimized.length - 1];
      if (last?.groupId) store.restoreMinimizedGroup(last.groupId);
      else if (last) store.restoreMinimized(last.sessionId);
      break;
    }
    case 'toggle-sidebar':
      store.updateSettings({ sidebarVisible: !store.settings.sidebarVisible });
      break;
    case 'find':
      store.setFindOpenFor(sessionId);
      break;
    case 'clear':
      if (sessionId) getTerminal(sessionId)?.term.clear();
      break;
    case 'copy':
      copySelection(sessionId);
      break;
    case 'select-all':
      selectAllIn(sessionId);
      break;
    case 'font-bigger':
      store.updateSettings({ fontSize: Math.min(24, store.settings.fontSize + 1) });
      break;
    case 'font-smaller':
      store.updateSettings({ fontSize: Math.max(8, store.settings.fontSize - 1) });
      break;
    case 'font-reset':
      store.updateSettings({ fontSize: 13 });
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
