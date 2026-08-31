import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { sessionLabel } from '../lib/labels';

/**
 * Closing kills running processes, so it is always asked about first — for one
 * session, or for a whole group at once.
 */
export function CloseConfirm() {
  const pending = useStore((s) => s.pendingClose);
  const confirmClose = useStore((s) => s.confirmClose);
  const cancelClose = useStore((s) => s.cancelClose);

  if (!pending) return null;
  return (
    <div className="modal-backdrop" onMouseDown={cancelClose}>
      <div className="confirm" onMouseDown={(event) => event.stopPropagation()}>
        {pending.groupId ? (
          <GroupBody groupId={pending.groupId} sessionIds={pending.sessionIds} />
        ) : (
          <SessionBody sessionId={pending.sessionIds[0]} />
        )}
        <div className="confirm-actions">
          <button className="ghost-btn" onClick={cancelClose} autoFocus>
            Keep {pending.sessionIds.length > 1 ? 'them' : 'it'}
          </button>
          <button className="danger-btn" onClick={confirmClose}>
            {pending.groupId
              ? `Close ${pending.sessionIds.length} session${pending.sessionIds.length === 1 ? '' : 's'}`
              : 'Close session'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionBody({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const profile = useStore((s) => s.profiles.find((p) => p.id === session?.profileId));
  const homedir = useStore((s) => s.homedir);
  if (!session) return null;

  return (
    <>
      <h3>
        Close <span style={{ color: profile?.color }}>{sessionLabel(session, homedir)}</span>?
      </h3>
      <p>
        {session.kind === 'claude'
          ? 'The process stops, but the conversation is saved — you can continue it later from History.'
          : 'The shell stops. Anything running in it is ended.'}
      </p>
    </>
  );
}

function GroupBody({ groupId, sessionIds }: { groupId: string; sessionIds: string[] }) {
  const group = useStore((s) => s.groups.find((g) => g.id === groupId));
  const homedir = useStore((s) => s.homedir);
  // Compared shallowly: a selector that builds a fresh array every render makes
  // the store look changed on every render, and the app never settles.
  const sessions = useStore(
    useShallow((s) => sessionIds.map((id) => s.sessions[id]).filter(Boolean)),
  );
  if (!group) return null;

  const withConversation = sessions.filter((s) => s.claudeSessionId).length;

  return (
    <>
      <h3>
        Close everything in{' '}
        <span style={{ color: group.color }}>
          <i className="group-dot" style={{ background: group.color, marginRight: 6 }} />
          {group.name}
        </span>
        ?
      </h3>
      <p>
        {sessions.length} session{sessions.length === 1 ? '' : 's'} stop
        {sessions.length === 1 ? 's' : ''}
        {withConversation > 0 &&
          `, and ${withConversation === sessions.length ? 'their' : `${withConversation} of their`} conversation${withConversation === 1 ? '' : 's'} ${withConversation === 1 ? 'is' : 'are'} saved`}
        . The group itself is kept — its colour, text size and arrangement — so
        History can bring the whole thing back as it is now.
      </p>
      <ul className="confirm-list">
        {sessions.slice(0, 6).map((session) => (
          <li key={session.id}>{sessionLabel(session, homedir)}</li>
        ))}
        {sessions.length > 6 && <li className="is-more">and {sessions.length - 6} more</li>}
      </ul>
    </>
  );
}
