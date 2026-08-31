import { useStore } from '../state/store';

/**
 * Shown when a session's account reports it is out of usage. The conversation has
 * already been saved by then; this offers to carry it to another account, which
 * resumes it there with everything said so far intact.
 */
export function HandoffBanner({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const profiles = useStore((s) => s.profiles);
  const authByProfile = useStore((s) => s.authByProfile);
  const settings = useStore((s) => s.settings);
  const handoffSession = useStore((s) => s.handoffSession);
  const dismissLimit = useStore((s) => s.dismissLimit);
  const updateSettings = useStore((s) => s.updateSettings);
  const setProfileEditorOpen = useStore((s) => s.setProfileEditorOpen);

  if (!session) return null;
  const current = profiles.find((p) => p.id === session.profileId);
  const candidates = profiles.filter(
    (p) => p.id !== session.profileId && authByProfile[p.id]?.loggedIn,
  );

  return (
    <div className="handoff-banner">
      <div className="handoff-text">
        <strong>
          <span style={{ color: current?.color }}>{current?.name ?? 'This account'}</span> is out of
          usage
        </strong>
        <small>
          The conversation is saved. Moving it to another account picks it up where it stopped.
        </small>
      </div>

      <div className="handoff-actions">
        {candidates.length === 0 ? (
          <button className="primary-btn" onClick={() => setProfileEditorOpen(true)}>
            Add another account
          </button>
        ) : (
          candidates.map((profile) => (
            <button
              key={profile.id}
              className="ghost-btn"
              style={{ borderColor: profile.color, color: profile.color }}
              onClick={() => handoffSession(sessionId, profile.id)}
              title={authByProfile[profile.id]?.email ?? undefined}
            >
              Move to {profile.name}
            </button>
          ))
        )}
        <label className="handoff-auto" title="Do this without asking next time">
          <input
            type="checkbox"
            checked={settings.autoHandoff}
            onChange={(event) => updateSettings({ autoHandoff: event.target.checked })}
          />
          auto
        </label>
        <button className="ghost-btn tiny" onClick={() => dismissLimit(sessionId)}>
          ×
        </button>
      </div>
    </div>
  );
}
