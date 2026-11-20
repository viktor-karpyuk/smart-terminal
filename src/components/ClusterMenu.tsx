import { useState } from 'react';
import { useStore } from '../state/store';
import { shortContext } from '../lib/extensionHost';
import { Popover } from './Popover';

/**
 * Three answers, not two.
 *
 * Answered: green. Said no — refused the connection, or the credentials are
 * stale: red. Did not answer at all: amber, because that is not the same claim.
 * A cluster that is merely slow, or behind a VPN that drops rather than
 * refuses, has told us nothing, and a confident red about a healthy production
 * cluster is how a dashboard stops being believed.
 */
export function dotFor(reach?: { up: boolean | null; slow?: boolean }): 'ok' | 'warn' | 'bad' | 'unknown' {
  if (!reach || reach.up == null) return 'unknown';
  if (reach.up) return 'ok';
  return reach.slow ? 'warn' : 'bad';
}

/**
 * What you can do to a cluster from the list.
 *
 * Two of these edit the person's own kubeconfig rather than talk to a cluster,
 * and they are the two worth being careful about — so removing asks first, and
 * making one the default says out loud what else that changes.
 */
export function ClusterMenu({
  name,
  x,
  y,
  onClose,
}: {
  name: string;
  x: number;
  y: number;
  onClose(): void;
}) {
  const reach = useStore((s) => s.clusters.reach[name]);
  const isDefault = useStore((s) => s.clusters.current === name);
  const [confirming, setConfirming] = useState(false);
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  if (confirming) {
    return (
      <div className="modal-backdrop" onMouseDown={onClose}>
        <div className="confirm" onMouseDown={(event) => event.stopPropagation()}>
          <h3>Remove {shortContext(name)}?</h3>
          <p style={{ color: 'var(--text)' }}>{name}</p>
          <p>
            This edits your kubeconfig. The context goes, and so do its cluster and user entries
            unless another context is still pointing at them. Nothing in the cluster itself is
            touched — you are removing the way in, not the thing.
          </p>
          <div className="confirm-actions">
            <button className="ghost-btn" onClick={onClose} autoFocus>
              Keep it
            </button>
            <button
              className="danger-btn"
              onClick={() => {
                onClose();
                void useStore.getState().removeCluster(name);
              }}
            >
              Remove from kubeconfig
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Popover anchorPoint={{ x, y }} onClose={onClose}>
      <div className="menu-heading">
        <span className={`cluster-dot is-${dotFor(reach)}`} />
        <span>{shortContext(name)}</span>
      </div>

      <button className="menu-item" onClick={run(() => useStore.getState().openCluster(name))}>
        <span>Open</span>
        <kbd>a tab of its own</kbd>
      </button>
      <button
        className="menu-item"
        onClick={run(() => void useStore.getState().openClusterTerminal(name))}
      >
        <span>Terminal here</span>
        <kbd>k aliased to it</kbd>
      </button>
      <button className="menu-item" onClick={run(() => void useStore.getState().probeCluster(name))}>
        <span>Check it again</span>
        {reach?.error && <kbd title={reach.error}>not answering</kbd>}
      </button>

      <div className="menu-separator" />

      <button className="menu-item" onClick={run(() => void navigator.clipboard.writeText(name))}>
        <span>Copy its full name</span>
      </button>
      {!isDefault && (
        <button
          className="menu-item"
          onClick={run(() => void useStore.getState().makeClusterDefault(name))}
          title="Changes what a plain kubectl does everywhere, including in your own shells"
        >
          <span>Make it kubectl's default</span>
          <kbd>outside this app too</kbd>
        </button>
      )}

      <div className="menu-separator" />

      <button className="menu-item is-danger" onClick={() => setConfirming(true)}>
        <span>Remove from kubeconfig…</span>
      </button>
    </Popover>
  );
}
