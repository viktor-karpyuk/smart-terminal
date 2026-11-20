import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../state/store';
import type { GroupArrangement } from '../state/types';
import type { HistorySession } from '../global';
import { compactPath } from '../lib/labels';

const ARRANGEMENTS: Array<{ id: GroupArrangement; label: string }> = [
  { id: 'tabs', label: 'as tabs' },
  { id: 'columns', label: 'side by side' },
  { id: 'rows', label: 'stacked' },
  { id: 'grid', label: 'in a grid' },
];

/**
 * Every session a group has had, and a way to bring back just the ones wanted.
 *
 * "Restore all" was the only door, and a group that has lived a while has
 * fourteen sessions in it of which today needs two. So each closed one gets a
 * checkbox, the open ones say so (and take you there), and Restore brings back
 * exactly what is ticked — into the group, laid out the way it was.
 */
export function GroupSessions({
  groupId,
  arrangement: wasArranged = null,
  onRestored,
}: {
  groupId: string;
  /** How the group was laid out, so the default option can say "(as it was)". */
  arrangement?: GroupArrangement | null;
  onRestored?(count: number): void;
}) {
  const restoreGroup = useStore((s) => s.restoreGroup);
  const focusSession = useStore((s) => s.focusSession);
  const live = useStore((s) => s.sessions);
  const profiles = useStore((s) => s.profiles);
  const homedir = useStore((s) => s.homedir);
  const colours = useMemo(() => new Map(profiles.map((p) => [p.id, p.color])), [profiles]);

  const [members, setMembers] = useState<HistorySession[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [arrangement, setArrangement] = useState<GroupArrangement | ''>('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void window.api.history.groupMembers(groupId).then((rows) => {
      // Newest work first: the one you were last in is the one you came for.
      setMembers([...rows].sort((a, b) => lastActive(b) - lastActive(a)));
    });
  }, [groupId]);
  useEffect(load, [load]);

  const restorable = (members ?? []).filter((row) => canRestore(row, live, window.api.windowId));
  const allPicked = restorable.length > 0 && restorable.every((row) => picked.has(row.id));

  const toggle = (id: string, on: boolean) =>
    setPicked((was) => {
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  if (!members) return <p className="group-sessions-empty">Reading its sessions…</p>;
  if (!members.length) return <p className="group-sessions-empty">No sessions recorded for this group.</p>;

  return (
    <div className="group-sessions">
      <div className="group-sessions-bar">
        <label className="group-sessions-all" title={allPicked ? 'Untick every one' : 'Tick every closed one'}>
          <input
            type="checkbox"
            checked={allPicked}
            disabled={!restorable.length}
            onChange={(event) => setPicked(event.target.checked ? new Set(restorable.map((row) => row.id)) : new Set())}
          />
          <span>
            {members.length} session{members.length === 1 ? '' : 's'}
            {restorable.length < members.length ? ` · ${members.length - restorable.length} open` : ''}
          </span>
        </label>
      </div>

      <div className="group-sessions-list">
        {members.map((row) => {
          const here = Boolean(live[row.id]);
          const restorableRow = canRestore(row, live, window.api.windowId);
          const name = row.title || compactPath(row.lastCwd || row.startCwd, homedir).split('/').pop() || 'session';
          return (
            <label
              key={row.id}
              className={`group-session${picked.has(row.id) ? ' is-picked' : ''}${restorableRow ? '' : ' is-open'}`}
              title={`${row.profileName ?? 'account'} · ${compactPath(row.lastCwd || row.startCwd, homedir)}`}
              onClick={(event) => {
                if (!here) return;
                // An open one is not something to tick; it is somewhere to go.
                event.preventDefault();
                focusSession(row.id);
              }}
            >
              {restorableRow ? (
                <input type="checkbox" checked={picked.has(row.id)} onChange={(event) => toggle(row.id, event.target.checked)} />
              ) : (
                <span className="group-session-gap" aria-hidden="true" />
              )}
              <span className="tab-dot" style={{ background: colours.get(row.profileId) ?? 'var(--text-faint)' }} />
              <span className="group-session-name">{name}</span>
              {here ? (
                <em className="badge">open</em>
              ) : row.open && !restorableRow ? (
                <em className="badge">other window</em>
              ) : !row.claudeSessionId ? (
                <em className="badge" title="No conversation was recorded; it opens fresh in the same folder">fresh</em>
              ) : null}
              <span className="group-session-when">{ago(lastActive(row))}</span>
            </label>
          );
        })}
      </div>

      <div className="group-sessions-actions">
        <select
          value={arrangement}
          aria-label="How to lay them out"
          onChange={(event) => setArrangement(event.target.value as GroupArrangement | '')}
        >
          <option value="">Layout as it was</option>
          {ARRANGEMENTS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
              {wasArranged === option.id ? ' (as it was)' : ''}
            </option>
          ))}
        </select>
        <button
          className="ghost-btn tiny is-primary"
          disabled={busy || picked.size === 0}
          onClick={async () => {
            setBusy(true);
            try {
              const count = await restoreGroup(groupId, arrangement || undefined, [...picked]);
              setPicked(new Set());
              load();
              onRestored?.(count);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Opening…' : picked.size ? `Restore ${picked.size}` : 'Restore'}
        </button>
      </div>
    </div>
  );
}

/**
 * Whether a session is one that can be brought back.
 *
 * Anything finished can. Anything running in another window cannot — continuing
 * it here would give you two tabs holding the same conversation, and the useful
 * move is to go to where it already is. Anything running *here* is already on
 * screen, so there is nothing to restore.
 */
export function canRestore(
  row: { id: string; open: boolean; windowId?: string | null },
  live: Record<string, unknown>,
  thisWindow: string,
) {
  if (live[row.id]) return false;
  if (!row.open) return true;
  return !(row.windowId && row.windowId !== thisWindow);
}

function lastActive(row: { lastWorkedAt?: number | null; endedAt: number | null; startedAt: number }) {
  return row.lastWorkedAt ?? row.endedAt ?? row.startedAt;
}

function ago(at: number) {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
