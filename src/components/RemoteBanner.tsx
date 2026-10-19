import { useState } from 'react';
import { useStore } from '../state/store';

/**
 * Shown on a session while a phone has it at the phone's width. The terminal
 * here keeps drawing at that width, and resizing the pane does nothing until
 * the phone lets go — which is a surprise unless it is said. The button gives
 * the size back without closing anything on the phone.
 */
export function RemoteBanner({ sessionId }: { sessionId: string }) {
  const viewer = useStore((s) => s.remote.viewers.find((v) => v.driven && v.sessionId === sessionId) ?? null);
  const [busy, setBusy] = useState(false);
  if (!viewer) return null;
  const takeBack = async () => {
    setBusy(true);
    try {
      await window.api.remote.call('releaseSession', { sessionId });
      await useStore.getState().refreshRemoteStatus();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="remote-banner" role="status">
      <span className="remote-banner-text">
        <strong>Sized for {viewer.from}</strong>
        <small>The session took the phone's width; resizing this pane waits until it lets go.</small>
      </span>
      <button className="ghost-btn" onClick={() => void takeBack()} disabled={busy}>
        {busy ? 'Taking back…' : 'Take the size back'}
      </button>
    </div>
  );
}
