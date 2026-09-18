import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { compactPath } from '../lib/labels';

/**
 * What to call the session about to be started.
 *
 * The app has always named them itself — `moraine`, `spindle`, `wren` — which
 * answers "it needs *a* name" and not "which of these nineteen tabs is the
 * billing work". So it asks, once, at the moment the name is decided.
 *
 * The suggestion is in the field and selected, so the fastest way through is
 * Enter: you get exactly what the app would have chosen, and typing first
 * replaces it because the text is already highlighted. Nothing here is slower
 * than it was for anybody who does not care what their tabs are called.
 *
 * Escape starts nothing. That is the honest meaning of cancelling a question
 * about a thing that does not exist yet — there is no half-made session left
 * behind to explain.
 */
export function NameSession() {
  const pending = useStore((s) => s.pendingSession);
  const confirm = useStore((s) => s.confirmNewSession);
  const cancel = useStore((s) => s.cancelNewSession);
  const updateSettings = useStore((s) => s.updateSettings);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const homedir = useStore((s) => s.homedir);

  // A fresh question every time, filled with what the app would have picked.
  useEffect(() => {
    if (!pending) return;
    setName(pending.suggested);
    setCwd(pending.cwd);
    setBusy(false);
    // The places you have been, so changing it is usually a click.
    window.api.history.recentFolders(6).then(setRecent, () => {});
    // The frame after mounting, or the select lands before the field is there.
    const at = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(at);
  }, [pending]);

  if (!pending) return null;

  const start = async () => {
    if (busy) return;
    setBusy(true);
    await confirm(name, cwd);
  };

  const kind = String((pending.options as { kind?: string }).kind ?? 'claude');

  return (
    <div className="modal-backdrop" onMouseDown={cancel}>
      <div className="confirm name-session" onMouseDown={(event) => event.stopPropagation()}>
        <h3>Name this {kind === 'shell' ? 'terminal' : 'session'}</h3>
        <p className="usage-note">
          It is what the tab, the sidebar and History will call it. Leave it as it is for the name
          the app picked.
        </p>
        <input
          ref={inputRef}
          value={name}
          placeholder={pending.suggested}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void start();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
            }
          }}
        />
        {/*
          Where it will open, said before it opens rather than discovered after.
          A Claude session is tied to its folder — that folder is the project it
          works on and where its conversation is filed — so it is the other half
          of the question, not a detail.
        */}
        <div className="name-session-where">
          <span className="label">Folder</span>
          <span className="path" title={cwd}>
            {compactPath(cwd, homedir)}
          </span>
          <button
            className="ghost-btn tiny"
            disabled={busy}
            onClick={async () => {
              const picked = await window.api.system.pickDirectory(cwd);
              if (picked) setCwd(picked);
              inputRef.current?.focus();
            }}
          >
            Change…
          </button>
        </div>
        {recent.filter((folder) => folder !== cwd).length > 0 && (
          <div className="name-session-recent">
            {recent
              .filter((folder) => folder !== cwd)
              .slice(0, 4)
              .map((folder) => (
                <button
                  key={folder}
                  className="chip-btn"
                  title={folder}
                  disabled={busy}
                  onClick={() => setCwd(folder)}
                >
                  {folder.split('/').filter(Boolean).pop() ?? folder}
                </button>
              ))}
          </div>
        )}

        <label className="checkbox">
          <input
            type="checkbox"
            onChange={(event) => {
              // Turned off here rather than hunted for in Appearance: this is
              // the one moment somebody knows they do not want to be asked.
              if (event.target.checked) updateSettings({ askSessionName: false });
            }}
          />
          <span>Stop asking — name them for me</span>
        </label>
        <div className="confirm-actions">
          <button className="ghost-btn" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary-btn" onClick={() => void start()} disabled={busy}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}
