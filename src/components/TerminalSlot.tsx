import { useEffect, useLayoutEffect, useRef } from 'react';
import { terminalFontSizeFor, terminalLook, useStore } from '../state/store';
import { attachTerminal, ensureTerminal, fitTerminal, parkTerminal } from '../terminals/registry';

/**
 * Mounts a persistent xterm instance into this rectangle. The terminal itself is
 * owned by the registry, so dragging a session to another pane re-parents the
 * existing DOM node instead of recreating it — scrollback and process survive.
 */
export function TerminalSlot({ sessionId }: { sessionId: string }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const settings = useStore((s) => s.settings);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;

    ensureTerminal(sessionId, {
      ...terminalLook(settings),
      // Its group's size, or its own, from the first frame — not the global size until something changes.
      fontSize: terminalFontSizeFor(useStore.getState(), sessionId),
      scrollback: settings.scrollback,
      onData: (data) => useStore.getState().sendInput(sessionId, data),
      onResize: (cols, rows) => useStore.getState().notifyResize(sessionId, cols, rows),
      onTitle: (title) => useStore.getState().setTitle(sessionId, title),
      onBell: () => useStore.getState().markActivity(sessionId),
    });
    attachTerminal(sessionId, slot);

    return () => parkTerminal(sessionId);
    // Appearance changes are pushed globally by the store, not by remounting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const observer = new ResizeObserver(() => fitTerminal(sessionId));
    observer.observe(slot);
    return () => observer.disconnect();
  }, [sessionId]);

  return <div className="terminal-slot" ref={slotRef} />;
}
