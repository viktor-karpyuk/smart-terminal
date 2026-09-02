import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import type { DropSide } from '../state/types';
import { Popover } from './Popover';
import { compactPath } from '../lib/labels';

interface Props {
  leafId: string;
  anchorEl: HTMLElement | null;
  cwdHint?: string;
  side?: DropSide;
  onClose(): void;
}

/**
 * Opening something new is two different decisions, so it asks them separately.
 *
 * A Claude session is tied to a folder — that folder is the project it will work
 * on, and it is where its conversation gets filed — so it is chosen first, and
 * offered from the places you have been. A plain terminal needs none of that: it
 * is a shell, and if Claude is started in it by hand the app notices and adopts
 * the conversation anyway.
 */
export function NewSessionMenu({ leafId, anchorEl, cwdHint, side = 'center', onClose }: Props) {
  const profiles = useStore((s) => s.profiles);
  const homedir = useStore((s) => s.homedir);
  const authByProfile = useStore((s) => s.authByProfile);
  const defaultProfileId = useStore((s) => s.settings.defaultProfileId);
  const newSession = useStore((s) => s.newSession);
  const updateSettings = useStore((s) => s.updateSettings);
  const setProfileEditorOpen = useStore((s) => s.setProfileEditorOpen);
  const openFilePanel = useStore((s) => s.openFilePanel);

  const [cwd, setCwd] = useState(cwdHint || '');
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    window.api.history.recentFolders(6).then(setRecent);
  }, []);

  async function open(profileId: string, kind: 'claude' | 'shell') {
    onClose();
    await newSession({ profileId, kind, cwd: cwd || undefined, leafId, side });
  }

  async function browse() {
    const picked = await window.api.system.pickDirectory(cwd || homedir);
    if (picked) setCwd(picked);
  }

  const folderLabel = cwd ? compactPath(cwd, homedir) : 'the account’s default folder';

  return (
    <Popover anchorEl={anchorEl} onClose={onClose}>
      <div className="popover-header">
        <span>Open in</span>
        <button className="link-btn" onClick={browse}>
          Choose a folder…
        </button>
      </div>

      <div className="folder-pick">
        <input
          value={cwd}
          placeholder={homedir}
          spellCheck={false}
          onChange={(event) => setCwd(event.target.value)}
        />
        {recent.length > 0 && (
          <div className="recent-folders">
            {recent.map((folder) => (
              <button
                key={folder}
                className={`chip${cwd === folder ? ' is-selected' : ''}`}
                title={folder}
                onClick={() => setCwd(folder)}
              >
                {folder.split('/').pop() || folder}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="menu-separator" />
      <div className="menu-label">Claude session in {folderLabel}</div>
      <ul className="profile-list">
        {profiles.map((profile) => (
          <li key={profile.id}>
            <button className="profile-row" onClick={() => open(profile.id, 'claude')}>
              <span className="tab-dot" style={{ background: profile.color }} />
              <span className="profile-name" style={{ color: profile.color }}>
                {profile.name}
              </span>
              <span className="profile-hint">
                {authByProfile[profile.id]?.loggedIn
                  ? authByProfile[profile.id].email
                  : 'not signed in'}
              </span>
            </button>
            <button
              className={`star-btn${defaultProfileId === profile.id ? ' is-on' : ''}`}
              title={
                defaultProfileId === profile.id
                  ? `${profile.name} is used for new sessions`
                  : `Use ${profile.name} for new sessions`
              }
              onClick={() =>
                updateSettings({
                  defaultProfileId: defaultProfileId === profile.id ? null : profile.id,
                })
              }
            >
              {defaultProfileId === profile.id ? '★' : '☆'}
            </button>
          </li>
        ))}
      </ul>

      <div className="menu-separator" />
      <button
        className="menu-item"
        onClick={() => open(defaultProfileId ?? profiles[0]?.id, 'shell')}
      >
        <span>Just a terminal</span>
        <kbd>no session</kbd>
      </button>
      <p className="form-hint">
        A terminal is only a shell. Start Claude in it yourself and the app picks the conversation
        up from there.
      </p>

      <div className="menu-separator" />
      {/* Not a session at all: a folder, its files, and an editor for them. */}
      <button
        className="menu-item"
        onClick={() => {
          onClose();
          openFilePanel({ leafId, side, root: cwd || undefined });
        }}
      >
        <span>
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="#7aa2f7" strokeWidth="1.3" style={{ marginRight: 7, verticalAlign: -1 }}>
            <path d="M1.6 3.4h3.4l1.1 1.4h6.3v6.2H1.6z" />
          </svg>
          File system
        </span>
        <kbd>{cwd ? compactPath(cwd, homedir) : 'pick a folder'}</kbd>
      </button>
      <div className="menu-separator" />
      <button className="menu-item" onClick={() => { onClose(); setProfileEditorOpen(true); }}>
        <span>Manage accounts…</span>
      </button>
    </Popover>
  );
}
