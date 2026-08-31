import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../state/store';
import type { Profile } from '../state/types';
import type { AuthStatus, ConfigDirSuggestion } from '../global';

const COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64', '#41a6b5'];

const blank = (): Partial<Profile> => ({
  name: '',
  color: COLORS[0],
  configDir: null,
  cwd: '',
  claudeCommand: 'claude',
  claudeArgs: [],
  env: {},
});

/**
 * Accounts are the "user X / user Y" mechanism: each one points at its own
 * CLAUDE_CONFIG_DIR, which is where Claude Code keeps that login's credentials.
 * A new account gets a suggested folder and can be signed in without leaving the app.
 */
export function ProfileEditor() {
  const profiles = useStore((s) => s.profiles);
  const homedir = useStore((s) => s.homedir);
  const authByProfile = useStore((s) => s.authByProfile);
  const saveProfile = useStore((s) => s.saveProfile);
  const removeProfile = useStore((s) => s.removeProfile);
  const refreshAuth = useStore((s) => s.refreshAuth);
  const startLogin = useStore((s) => s.startLogin);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const close = () => useStore.getState().setProfileEditorOpen(false);

  const [selectedId, setSelectedId] = useState<string | null>(profiles[0]?.id ?? null);
  const [draft, setDraft] = useState<Partial<Profile>>(profiles[0] ?? blank());
  const [discovered, setDiscovered] = useState<Array<{ name: string; dir: string }>>([]);
  const [suggestions, setSuggestions] = useState<ConfigDirSuggestion[]>([]);
  const [dirTouched, setDirTouched] = useState(false);
  const [probe, setProbe] = useState<AuthStatus | null>(null);
  const [probing, setProbing] = useState(false);

  const isNew = selectedId === null;
  const saved = selectedId ? profiles.find((p) => p.id === selectedId) : null;
  const status = probe ?? (selectedId ? authByProfile[selectedId] : null);

  useEffect(() => {
    window.api.profiles.discover().then(setDiscovered);
  }, []);

  useEffect(() => {
    const found = profiles.find((p) => p.id === selectedId);
    if (found) {
      setDraft(found);
      setDirTouched(true);
    }
    setProbe(null);
  }, [selectedId, profiles]);

  // A new account's credential folder is proposed from its name until the user edits it.
  useEffect(() => {
    if (!isNew) return;
    let cancelled = false;
    window.api.profiles.suggestConfigDirs(draft.name || '').then((next) => {
      if (cancelled) return;
      setSuggestions(next);
      if (!dirTouched) {
        const recommended = next.find((s) => s.recommended) ?? next[0];
        setDraft((prev) => ({ ...prev, configDir: draft.name ? recommended.dir : null }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [draft.name, isNew, dirTouched]);

  /** Check a folder that has not been saved as a profile yet. */
  async function probeAuth() {
    setProbing(true);
    try {
      const result = await window.api.auth.status(
        { configDir: draft.configDir ?? null, claudeCommand: draft.claudeCommand || 'claude' },
        true,
      );
      setProbe(result);
      if (selectedId) refreshAuth(selectedId, true);
    } finally {
      setProbing(false);
    }
  }

  function patch(next: Partial<Profile>) {
    setDraft((prev) => ({ ...prev, ...next }));
  }

  async function save() {
    if (!draft.name?.trim()) return;
    await saveProfile({ ...draft, cwd: draft.cwd || homedir });
    close();
  }

  /** Save first — signing in needs a real profile id to launch a session against. */
  async function saveAndSignIn() {
    if (!draft.name?.trim()) return;
    await saveProfile({ ...draft, cwd: draft.cwd || homedir });
    const target = useStore
      .getState()
      .profiles.find((p) => p.id === draft.id || (p.name === draft.name && p.configDir === (draft.configDir ?? null)));
    close();
    if (target) await startLogin(target.id);
  }

  const envText = useMemo(
    () =>
      Object.entries(draft.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    [draft.env],
  );

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2>Accounts</h2>
          <button className="ghost-btn tiny" onClick={close}>×</button>
        </header>

        <div className="modal-body">
          <nav className="profile-nav">
            {profiles.map((profile) => {
              const auth = authByProfile[profile.id];
              return (
                <button
                  key={profile.id}
                  className={`profile-nav-item${profile.id === selectedId ? ' is-selected' : ''}`}
                  onClick={() => setSelectedId(profile.id)}
                >
                  <span className="tab-dot" style={{ background: profile.color }} />
                  <span className="profile-nav-text">
                    <span>
                      {profile.name}
                      {settings.defaultProfileId === profile.id && <em className="badge">default</em>}
                    </span>
                    <small>{auth?.loggedIn ? auth.email : auth ? 'not signed in' : '…'}</small>
                  </span>
                </button>
              );
            })}
            <button
              className="ghost-btn wide"
              onClick={() => {
                setSelectedId(null);
                setDirTouched(false);
                setProbe(null);
                setDraft({ ...blank(), cwd: homedir });
              }}
            >
              + Add account
            </button>
          </nav>

          <div className="profile-form">
            <div className="field-pair">
              <label className="field">
                <span>Name</span>
                <input
                  value={draft.name ?? ''}
                  placeholder="Work, Personal, Client X…"
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Colour</span>
                <div className="swatches">
                  {COLORS.map((color) => (
                    <button
                      key={color}
                      className={`swatch${draft.color === color ? ' is-selected' : ''}`}
                      style={{ background: color }}
                      onClick={() => patch({ color })}
                      aria-label={color}
                    />
                  ))}
                </div>
              </label>
            </div>

            <section className="form-section">
              <h3>Credentials</h3>
              <p className="form-hint">
                This folder is what makes the account separate — Claude Code keeps this
                login's tokens and settings inside it, and nothing else reads them.
              </p>

              {isNew && suggestions.length > 0 && (
                <div className="suggestions">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion.dir}
                      className={`suggestion${draft.configDir === suggestion.dir ? ' is-selected' : ''}`}
                      onClick={() => {
                        setDirTouched(true);
                        patch({ configDir: suggestion.dir });
                      }}
                    >
                      <span className="suggestion-label">
                        {suggestion.label}
                        {suggestion.recommended && <em className="badge">suggested</em>}
                        {suggestion.hasLogin && <em className="badge badge-warn">already signed in</em>}
                      </span>
                      <span className="suggestion-path">{shorten(suggestion.dir, homedir)}</span>
                      <span className="suggestion-detail">{suggestion.detail}</span>
                    </button>
                  ))}
                </div>
              )}

              <label className="field">
                <span>CLAUDE_CONFIG_DIR</span>
                <div className="field-row">
                  <input
                    value={draft.configDir ?? ''}
                    placeholder="empty = the shared default ~/.claude"
                    spellCheck={false}
                    onChange={(e) => {
                      setDirTouched(true);
                      patch({ configDir: e.target.value || null });
                    }}
                  />
                  <button
                    className="ghost-btn"
                    onClick={async () => {
                      const picked = await window.api.system.pickDirectory(draft.configDir ?? homedir);
                      if (picked) {
                        setDirTouched(true);
                        patch({ configDir: picked });
                      }
                    }}
                  >
                    …
                  </button>
                </div>
              </label>

              {discovered.length > 0 && (
                <div className="discovered">
                  <span>Existing logins found:</span>
                  {discovered.map((account) => (
                    <button
                      key={account.dir}
                      className="chip"
                      onClick={() => {
                        setDirTouched(true);
                        patch({ configDir: account.dir });
                      }}
                    >
                      {account.name}
                    </button>
                  ))}
                </div>
              )}

              <AuthPanel
                status={status}
                probing={probing}
                canSignIn={Boolean(draft.name?.trim())}
                onCheck={probeAuth}
                onSignIn={saveAndSignIn}
              />
            </section>

            {saved && (
              <label className="checkbox standalone">
                <input
                  type="checkbox"
                  checked={settings.defaultProfileId === saved.id}
                  onChange={(e) =>
                    updateSettings({ defaultProfileId: e.target.checked ? saved.id : null })
                  }
                />
                <span>Start new sessions with this account unless another is picked</span>
              </label>
            )}

            <section className="form-section">
              <h3>When this account runs out of usage</h3>
              <p className="form-hint">
                Sessions are saved continuously. When an account reports it is out of usage,
                the conversation can be carried to another one and resumed there with
                everything said so far intact.
              </p>
              <div className="field-pair">
                <label className="field">
                  <span>Carry sessions over to</span>
                  <select
                    value={draft.fallbackProfileId ?? ''}
                    onChange={(e) => patch({ fallbackProfileId: e.target.value || null })}
                  >
                    <option value="">Any other signed-in account</option>
                    {profiles
                      .filter((p) => p.id !== draft.id)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="field checkbox-field">
                  <span>Automatically</span>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.autoHandoff}
                      onChange={(e) => updateSettings({ autoHandoff: e.target.checked })}
                    />
                    <span>Move without asking (applies to every account)</span>
                  </label>
                </label>
              </div>
            </section>

            <section className="form-section">
              <h3>Defaults for new sessions</h3>
              <label className="field">
                <span>Starting folder</span>
                <div className="field-row">
                  <input
                    value={draft.cwd ?? ''}
                    placeholder={homedir}
                    spellCheck={false}
                    onChange={(e) => patch({ cwd: e.target.value })}
                  />
                  <button
                    className="ghost-btn"
                    onClick={async () => {
                      const picked = await window.api.system.pickDirectory(draft.cwd ?? homedir);
                      if (picked) patch({ cwd: picked });
                    }}
                  >
                    …
                  </button>
                </div>
                <small className="form-hint">
                  Only where a session opens. Each session then follows its own shell, so a
                  <code> cd </code> inside the terminal moves that session and nothing else.
                </small>
              </label>

              <div className="field-pair">
                <label className="field">
                  <span>Claude command</span>
                  <input
                    value={draft.claudeCommand ?? 'claude'}
                    spellCheck={false}
                    onChange={(e) => patch({ claudeCommand: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Extra arguments</span>
                  <input
                    value={(draft.claudeArgs ?? []).join(' ')}
                    placeholder="--model opus"
                    spellCheck={false}
                    onChange={(e) => patch({ claudeArgs: e.target.value.split(/\s+/).filter(Boolean) })}
                  />
                </label>
              </div>

              <label className="field">
                <span>Environment (KEY=value per line)</span>
                <textarea
                  rows={3}
                  spellCheck={false}
                  defaultValue={envText}
                  key={`${selectedId}-env`}
                  onBlur={(e) => patch({ env: parseEnv(e.target.value) })}
                />
              </label>
            </section>

            <div className="modal-actions">
              {saved && profiles.length > 1 && (
                <button
                  className="danger-btn"
                  onClick={async () => {
                    await removeProfile(saved.id);
                    setSelectedId(null);
                    setDirTouched(false);
                    setDraft(blank());
                  }}
                >
                  Delete
                </button>
              )}
              <span className="spacer" />
              <button className="ghost-btn" onClick={close}>Cancel</button>
              <button className="primary-btn" onClick={save} disabled={!draft.name?.trim()}>
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AuthPanel({
  status,
  probing,
  canSignIn,
  onCheck,
  onSignIn,
}: {
  status: AuthStatus | null;
  probing: boolean;
  canSignIn: boolean;
  onCheck(): void;
  onSignIn(): void;
}) {
  const state = !status ? 'unknown' : !status.available ? 'missing' : status.loggedIn ? 'in' : 'out';

  return (
    <div className={`auth-panel auth-${state}`}>
      <div className="auth-summary">
        <span className={`state-dot ${state === 'in' ? 'state-running' : state === 'out' ? 'state-exited' : ''}`} />
        <div className="auth-text">
          {state === 'in' && (
            <>
              <strong>{status?.email}</strong>
              <small>
                {[status?.subscriptionType, status?.orgName].filter(Boolean).join(' · ') || 'signed in'}
              </small>
            </>
          )}
          {state === 'out' && (
            <>
              <strong>Not signed in</strong>
              <small>This folder has no Claude credentials yet.</small>
            </>
          )}
          {state === 'missing' && (
            <>
              <strong>Could not reach the Claude CLI</strong>
              <small>{status?.error}</small>
            </>
          )}
          {state === 'unknown' && (
            <>
              <strong>Not checked</strong>
              <small>Check which account these credentials belong to.</small>
            </>
          )}
        </div>
      </div>

      <div className="auth-actions">
        <button className="ghost-btn tiny" onClick={onCheck} disabled={probing}>
          {probing ? 'Checking…' : 'Check'}
        </button>
        <button className="primary-btn" onClick={onSignIn} disabled={!canSignIn}>
          {state === 'in' ? 'Sign in as someone else' : 'Sign in…'}
        </button>
      </div>
    </div>
  );
}

function shorten(p: string, home: string) {
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at <= 0) continue;
    env[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return env;
}
