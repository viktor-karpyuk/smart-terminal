import { useStore } from '../state/store';
import { formatBytes, sessionLabel } from '../lib/labels';
import { SESSION_MIME } from '../lib/drag';

interface Props {
  sessionId: string;
  selected: boolean;
  /** Space is short: drop everything but the name and the state. */
  tight?: boolean;
  /** Part of a group, so it wears the group's tint. */
  grouped?: boolean;
}

/**
 * One tab. It subscribes to its own session rather than the whole map, so a
 * session streaming output only re-renders its own tab — not every pane in the
 * window, several times a second.
 */
export function SessionTab({ sessionId, selected, tight, grouped }: Props) {
  const session = useStore((s) => s.sessions[sessionId]);
  const profile = useStore((s) => {
    const owner = s.sessions[sessionId]?.profileId;
    return owner ? s.profiles.find((p) => p.id === owner) : undefined;
  });
  const homedir = useStore((s) => s.homedir);
  const kept = useStore((s) => s.sessionSizes[sessionId]);
  const groupColor = useStore((s) => {
    const owner = s.sessions[sessionId]?.groupId;
    return owner ? (s.groups.find((g) => g.id === owner)?.color ?? null) : null;
  });
  // A tab standing on its own can carry a colour of its own. Inside a group the
  // group's colour wins, so the run of matching underlines stays unbroken.
  const ownColor = useStore((s) =>
    s.sessions[sessionId]?.groupId ? null : (s.sessions[sessionId]?.color ?? null),
  );
  const cameFrom = useStore((s) => {
    const origin = s.sessions[sessionId]?.handoffFrom?.profileId;
    return origin ? (s.profiles.find((p) => p.id === origin)?.name ?? null) : null;
  });
  const renaming = useStore((s) => s.renamingSessionId === sessionId);

  const setRenamingId = useStore((s) => s.setRenamingSessionId);
  const setDraggingId = useStore((s) => s.setDraggingSessionId);
  const focusSession = useStore((s) => s.focusSession);
  const requestClose = useStore((s) => s.requestClose);
  const renameSession = useStore((s) => s.renameSession);
  const openContextMenu = useStore((s) => s.openContextMenu);

  if (!session) return null;
  const color = profile?.color ?? '#5c6370';

  return (
    <div
      className={`tab${selected ? ' tab-selected' : ''}${session.status === 'exited' ? ' tab-exited' : ''}${tight ? ' is-tight' : ''}${grouped || ownColor ? ' is-grouped' : ''}`}
      style={{
        // A grouped tab is underlined in its group's colour, selected or not:
        // the run of matching underlines is what shows the group at a glance.
        // Ungrouped, the underline marks the selected tab in its account's colour.
        ...(groupColor || ownColor
          ? { ['--group' as string]: groupColor ?? ownColor }
          : selected
            ? { boxShadow: `inset 0 -2px 0 ${color}` }
            : null),
      }}
      draggable={!renaming}
      title={[
        `${profile?.name ?? 'account'}${profile?.configDir ? '' : ' (default config)'}`,
        session.cwd,
        session.title,
        session.pid ? `pid ${session.pid}` : session.status,
        ...(session.recording ? [`recording · ${formatBytes(kept ?? 0)} kept`] : []),
        ...(cameFrom ? [`conversation carried over from ${cameFrom}`] : []),
      ].join('\n')}
      onDragStart={(event) => {
        setDraggingId(sessionId);
        event.dataTransfer.setData(SESSION_MIME, sessionId);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => setDraggingId(null)}
      onMouseDown={() => focusSession(sessionId)}
      onDoubleClick={() => setRenamingId(sessionId)}
      onContextMenu={(event) => {
        event.preventDefault();
        focusSession(sessionId);
        openContextMenu(sessionId, event.clientX, event.clientY);
      }}
    >
      <span className="tab-dot" style={{ background: color }} />
      <span className="tab-account" style={{ color }}>
        {profile?.name ?? 'account'}
      </span>
      {session.handoffFrom && (
        <span className="tab-handoff" title={`Conversation carried over from ${cameFrom ?? 'another account'}`}>
          ↷
        </span>
      )}
      {session.recording && (
        <span
          className="tab-record"
          title={`Conversation kept and searchable — ${formatBytes(kept ?? 0)} so far`}
        />
      )}
      {session.busy && (
        <span className="tab-busy" style={{ borderColor: color, borderTopColor: 'transparent' }} />
      )}
      {renaming ? (
        <input
          className="tab-rename"
          autoFocus
          defaultValue={session.customTitle ?? sessionLabel(session, homedir)}
          onBlur={(event) => {
            renameSession(sessionId, event.target.value.trim() || null);
            setRenamingId(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            if (event.key === 'Escape') setRenamingId(null);
          }}
        />
      ) : (
        <span className="tab-title">{sessionLabel(session, homedir)}</span>
      )}
      {/* Running by itself, or stopped because it needs you — the second is the one
          worth spotting from across the screen. */}
      {session.autopilot && (
        <span
          className={`tab-auto${session.autopilotState === 'waiting-for-you' ? ' needs-you' : ''}`}
          title={
            session.autopilotState === 'waiting-for-you'
              ? `Stopped for you${session.autopilotAsking ? ` — ${session.autopilotAsking}` : ''}`
              : session.autopilotState === 'done'
                ? 'Working on its own — nothing left to do'
                : 'Working on its own'
          }
        >
          {session.autopilotState === 'waiting-for-you' ? '✋' : '⏵⏵'}
        </span>
      )}
      {session.unread && !selected && <span className="tab-unread" />}
      <button
        className="tab-close"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          requestClose(sessionId);
        }}
        aria-label="Close session"
      >
        ×
      </button>
    </div>
  );
}
