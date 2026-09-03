import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { formatBytes } from '../lib/labels';
import { currentTerminalTheme } from '../state/store';
import { FOLLOW_APP, OVERRIDABLE, PALETTES, type OverridableKey } from '../terminals/themes';
import { FileIcon, colourFor } from '../lib/fileIcons';

const FONTS = [
  '"JetBrains Mono", "SF Mono", Menlo, "Fira Code", ui-monospace, monospace',
  '"SF Mono", Menlo, ui-monospace, monospace',
  '"Fira Code", "JetBrains Mono", ui-monospace, monospace',
  'Menlo, Monaco, "Courier New", monospace',
];

/** Interface theme, terminal palette, and the handful of colours worth overriding. */
export function AppearancePanel() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const close = () => useStore.getState().setAppearanceOpen(false);

  const theme = currentTerminalTheme(settings);
  const override = (key: OverridableKey, value: string | null) => {
    const next = { ...settings.terminalOverrides };
    if (value) next[key] = value;
    else delete next[key];
    updateSettings({ terminalOverrides: next });
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal modal-narrow" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2>Appearance</h2>
          <button className="ghost-btn tiny" onClick={close}>
            &times;
          </button>
        </header>

        <div className="usage-body">
          <section className="form-section">
            <h3>Interface</h3>
            <div className="segmented">
              {(['system', 'light', 'dark'] as const).map((option) => (
                <button
                  key={option}
                  className={settings.theme === option ? 'is-on' : ''}
                  onClick={() => updateSettings({ theme: option })}
                >
                  {option === 'system' ? 'Match system' : option === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          </section>

          <section className="form-section">
            <h3>File icons</h3>
            <div className="segmented">
              {(
                [
                  ['colour', 'By kind'],
                  ['outline', 'Outline'],
                  ['solid', 'Solid'],
                  ['none', 'None'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={settings.fileIcons === value ? 'is-on' : ''}
                  onClick={() => updateSettings({ fileIcons: value })}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="form-hint">
              How the file tree draws folders and files. <strong>By kind</strong> tints each one by
              what it is, so a folder reads as groups rather than as forty separate names;{' '}
              <strong>Outline</strong> is the plainer, quieter version of the same shapes.
            </p>
            <div className="folder-settings">
              <div>
                <span className="cap-label">Folder colour</span>
                <div className="group-swatches">
                  {[
                    ['#7aa2f7', 'blue'],
                    ['#e0af68', 'amber'],
                    ['#9ece6a', 'green'],
                    ['#bb9af7', 'violet'],
                    ['#7dcfff', 'cyan'],
                    ['#7b849c', 'grey'],
                  ].map(([colour, label]) => (
                    <button
                      key={colour}
                      className={`swatch${settings.folderColour === colour ? ' is-selected' : ''}`}
                      style={{ background: colour }}
                      aria-label={label}
                      title={label}
                      onClick={() => updateSettings({ folderColour: colour })}
                    />
                  ))}
                  <button
                    className={`swatch is-none${settings.folderColour === 'match' ? ' is-selected' : ''}`}
                    title="Match the files — no colour of their own"
                    aria-label="match the files"
                    onClick={() => updateSettings({ folderColour: 'match' })}
                  />
                </div>
              </div>

              <div>
                <span className="cap-label">Open folders</span>
                <div className="segmented">
                  {(
                    [
                      ['open-shut', 'Show as open'],
                      ['plain', 'Always the same'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      className={settings.folderStyle === value ? 'is-on' : ''}
                      onClick={() => updateSettings({ folderStyle: value })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <p className="form-hint">
              Folders keep their colour in every icon style — they are the one thing in the tree
              that is a different <em>kind</em> of thing, and telling them apart at a glance is
              worth more than an evenly grey list. <strong>Match the files</strong> gives that up
              for anyone who would rather it were quieter.
            </p>

            <div className="icon-preview">
              <span className="icon-preview-item">
                <FileIcon
                  name="src"
                  isDirectory
                  open
                  style={settings.fileIcons}
                  folderColour={settings.folderColour}
                  folderStyle={settings.folderStyle}
                />
                <span>src</span>
              </span>
              <span className="icon-preview-item">
                <FileIcon
                  name="electron"
                  isDirectory
                  style={settings.fileIcons}
                  folderColour={settings.folderColour}
                  folderStyle={settings.folderStyle}
                />
                <span>electron</span>
              </span>
              {[
                ['store.ts', false],
                ['styles.css', false],
                ['main.js', false],
                ['package.json', false],
                ['README.md', false],
                ['schema.sql', false],
                ['icon.png', false],
              ].map(([name, isDir]) => (
                <span key={name as string} className="icon-preview-item">
                  <FileIcon
                    name={name as string}
                    isDirectory={isDir as boolean}
                    style={settings.fileIcons}
                    folderColour={settings.folderColour}
                    folderStyle={settings.folderStyle}
                  />
                  <span
                    style={
                      settings.fileIcons === 'colour' && !isDir
                        ? { color: colourFor(name as string, false, 'colour') }
                        : undefined
                    }
                  >
                    {name as string}
                  </span>
                </span>
              ))}
            </div>
          </section>

          <section className="form-section">
            <h3>Terminal colours</h3>
            <p className="form-hint">
              Kept separate from the interface, so a light window around a dark terminal is a
              choice you can make.
            </p>

            <div className="palette-grid">
              <PaletteChip
                id={FOLLOW_APP}
                name="Follow the interface"
                selected={settings.terminalPalette === FOLLOW_APP}
                swatches={[theme.background!, theme.foreground!, theme.blue!, theme.green!]}
                onSelect={() => updateSettings({ terminalPalette: FOLLOW_APP })}
              />
              {PALETTES.map((palette) => (
                <PaletteChip
                  key={palette.id}
                  id={palette.id}
                  name={palette.name}
                  selected={settings.terminalPalette === palette.id}
                  swatches={[
                    palette.theme.background!,
                    palette.theme.foreground!,
                    palette.theme.blue!,
                    palette.theme.green!,
                  ]}
                  onSelect={() => updateSettings({ terminalPalette: palette.id })}
                />
              ))}
            </div>

            <div className="overrides">
              {OVERRIDABLE.map(({ key, label }) => {
                const custom = settings.terminalOverrides[key];
                return (
                  <label className="override" key={key}>
                    <input
                      type="color"
                      value={normalise(custom ?? (theme as Record<string, string>)[key] ?? '#000000')}
                      onChange={(event) => override(key, event.target.value)}
                    />
                    <span>{label}</span>
                    {custom && (
                      <button className="link-btn" onClick={() => override(key, null)}>
                        reset
                      </button>
                    )}
                  </label>
                );
              })}
            </div>

            <div className="preview" style={{ background: theme.background, color: theme.foreground }}>
              <div>
                <span style={{ color: theme.green }}>viktor@mac</span>
                <span style={{ color: theme.foreground }}> ~/dev </span>
                <span style={{ color: theme.blue }}>%</span> claude
              </div>
              <div style={{ color: theme.magenta }}>&#9679; Reading src/state/store.ts</div>
              <div>
                <span style={{ color: theme.yellow }}>warning</span> 2 files changed,{' '}
                <span style={{ color: theme.red }}>1 failing</span>
              </div>
              <div>
                <span style={{ background: theme.selectionBackground }}>selected text</span>
                <span style={{ color: theme.cursor }}>&#9611;</span>
              </div>
            </div>
          </section>

          <ConversationStorage />

          <section className="form-section">
            <h3>Text</h3>
            <label className="field">
              <span>Font</span>
              <select
                value={settings.fontFamily}
                onChange={(event) => updateSettings({ fontFamily: event.target.value })}
              >
                {FONTS.map((font) => (
                  <option key={font} value={font}>
                    {font.split(',')[0].replace(/"/g, '')}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Size — {settings.fontSize}px</span>
              <input
                type="range"
                min={9}
                max={22}
                value={settings.fontSize}
                onChange={(event) => updateSettings({ fontSize: Number(event.target.value) })}
              />
            </label>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.cursorBlink}
                onChange={(event) => updateSettings({ cursorBlink: event.target.checked })}
              />
              <span>Blinking cursor</span>
            </label>

            <label className="field">
              <span>Scrollback — {settings.scrollback.toLocaleString()} lines</span>
              <input
                type="range"
                min={1000}
                max={50000}
                step={1000}
                value={settings.scrollback}
                onChange={(event) => updateSettings({ scrollback: Number(event.target.value) })}
              />
              <small className="form-hint">
                Applies to new sessions. More scrollback costs memory in every open session.
              </small>
            </label>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * The recording switch, with what it is costing right now beside it. A warning
 * about growth is abstract; a number you can watch is not.
 */
function ConversationStorage() {
  const profiles = useStore((s) => s.profiles);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const [stats, setStats] = useState<{
    onDisk: number;
    entries: number;
    sessions: number;
    recording: number;
    textBytes: number;
    commandBytes: number;
    snapshotBytes: number;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = () => window.api.history.storage().then(setStats);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15000);
    return () => window.clearInterval(timer);
  }, []);

  const heavy = (stats?.onDisk ?? 0) > 500 * 1024 * 1024;
  const commandShare =
    stats && stats.textBytes > 0 ? Math.round((100 * stats.commandBytes) / stats.textBytes) : null;

  return (
    <section className="form-section">
      <h3>Sessions talking to each other</h3>
      <label className="field">
        <span>How far a session can reach</span>
        <div className="segmented">
          {(
            [
              ['group', 'Its group'],
              ['all', 'Every session'],
              ['off', 'Off'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={settings.sessionMessaging === value ? 'is-on' : ''}
              onClick={() => updateSettings({ sessionMessaging: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </label>
      <p className="form-hint">
        Sessions get tools for seeing each other and passing messages along, so two working on the
        same thing can hand over a finding instead of you carrying it across. A message arrives in
        the other session as a note saying who sent it, once that session is next waiting at its
        prompt — never while it is working, and never onto a question it is asking you.{' '}
        <strong>Its group</strong> keeps that to sessions in the same group, which is the safe
        default; a session in no group reaches nobody. <strong>Every session</strong> opens it to
        everything running. Changing this takes effect at once, on sessions already open.
      </p>

      <h3>Session monitor</h3>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.sessionAlerts}
          onChange={(event) => updateSettings({ sessionAlerts: event.target.checked })}
        />
        <span>Mark a session on its tab when it needs a look</span>
      </label>
      <p className="form-hint">
        Every session is read continuously from the conversation Claude Code already writes to disk —
        no requests, no tokens, whether or not this is on. What this decides is whether a session
        that has filled its window, compacted itself, or started paying twice for the same context
        comes and tells you, or waits until you open the monitor.
      </p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.sessionSuggestions}
          onChange={(event) => updateSettings({ sessionSuggestions: event.target.checked })}
        />
        <span>Say what to do about it</span>
      </label>
      <p className="form-hint">
        Each finding comes with the thing that usually fixes it. Turn this off to be told what was
        measured and left to it.
      </p>

      <label className="field">
        <span>Second opinion runs on</span>
        <select
          value={settings.advisorProfileId ?? ''}
          onChange={(event) => updateSettings({ advisorProfileId: event.target.value || null })}
        >
          <option value="">Whichever account the app would use</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      <p className="form-hint">
        Everything above is read from disk and costs nothing. The second opinion in the monitor is
        the one part that spends: a single short request, given the measurements only — never a
        transcript, a file or a command. Putting it on an account of its own keeps it from eating
        the allowance of the work it is reporting on.
      </p>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.tellSessions}
          onChange={(event) => updateSettings({ tellSessions: event.target.checked })}
        />
        <span>Let the monitor warn a session in its own conversation</span>
      </label>
      <p className="form-hint">
        Off by default, because this is the only part of the monitor that acts rather than reports.
        With it on, a session that reaches the worst grade of finding gets one note — what went
        wrong and what helps — at most twice an hour, delivered the way session messages are:
        when it is next waiting at its prompt, never onto work in progress. A session can also ask
        after itself at any time with the <code>session_health</code> tool, which costs nothing.
      </p>

      <h3>Conversations</h3>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.recordConversations}
          onChange={(event) => updateSettings({ recordConversations: event.target.checked })}
        />
        <span>Keep a copy of every conversation</span>
      </label>
      <p className="form-hint">
        What you asked, what Claude answered, and every command it ran with what came back — kept so
        a session can be read and searched from History long after its tab is gone. Individual
        sessions can opt out from their right-click menu; turning it off for one deletes what was
        kept for it.
      </p>

      <div className={`storage${heavy ? ' is-heavy' : ''}`}>
        <div className="storage-figure">
          <strong>{formatBytes((stats?.onDisk ?? 0) + (stats?.snapshotBytes ?? 0))}</strong>
          <small>
            {stats
              ? `${formatBytes(stats.onDisk)} database · ${formatBytes(stats.snapshotBytes)} saved copies · ${stats.recording} recording`
              : 'measuring…'}
          </small>
        </div>
        <button
          className={`ghost-btn tiny${confirming ? ' is-danger' : ''}`}
          disabled={!stats?.entries}
          onClick={async () => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            await window.api.history.forgetAllTranscripts();
            setConfirming(false);
            load();
          }}
        >
          {confirming ? 'Sure? Delete' : 'Delete stored'}
        </button>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          disabled={!settings.recordConversations}
          checked={settings.recordCommandOutput}
          onChange={(event) => updateSettings({ recordCommandOutput: event.target.checked })}
        />
        <span>
          Include what commands printed
          {commandShare !== null && <em className="share"> — {commandShare}% of what is kept</em>}
        </span>
      </label>

      <p className="form-hint">
        This grows quickly, and command output is nearly all of it: turning that off keeps the
        thread of the conversation readable at a fraction of the space. On disk it costs roughly
        2&nbsp;bytes per character kept — measured here at about 17&nbsp;MB per 30,000 entries.
        Deleting frees the space at once; the session index and the ability to continue a past
        conversation are untouched.
      </p>
    </section>
  );
}

function PaletteChip({
  name,
  selected,
  swatches,
  onSelect,
}: {
  id: string;
  name: string;
  selected: boolean;
  swatches: string[];
  onSelect(): void;
}) {
  return (
    <button className={`palette${selected ? ' is-selected' : ''}`} onClick={onSelect}>
      <span className="palette-swatches">
        {swatches.map((colour, i) => (
          <i key={i} style={{ background: colour }} />
        ))}
      </span>
      <span className="palette-name">{name}</span>
    </button>
  );
}

/** <input type="color"> only understands #rrggbb. */
function normalise(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
}
