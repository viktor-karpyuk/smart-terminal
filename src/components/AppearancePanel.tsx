import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { formatBytes } from '../lib/labels';
import { currentTerminalTheme } from '../state/store';
import { FOLLOW_APP, OVERRIDABLE, PALETTES, type OverridableKey } from '../terminals/themes';

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
