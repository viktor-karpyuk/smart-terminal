import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../state/store';
import { formatBytes } from '../lib/labels';
import { currentTerminalTheme } from '../state/store';
import { FOLLOW_APP, OVERRIDABLE, PALETTES, paletteById, type OverridableKey } from '../terminals/themes';
import { FileIcon, colourFor } from '../lib/fileIcons';
import {
  ACCENTS,
  CORNERS,
  INTERFACE_THEMES,
  TEXT_SCALES,
  activeTheme,
  type Corners,
  type InterfaceTheme,
} from '../lib/looks';
import type { Settings } from '../state/types';

/**
 * Monospaced fonts worth offering. Only the ones actually installed are shown —
 * a list of names that silently fall back to Menlo is a list of lies.
 */
const FONT_CANDIDATES = [
  'JetBrains Mono',
  'SF Mono',
  'Menlo',
  'Fira Code',
  'Cascadia Code',
  'IBM Plex Mono',
  'Source Code Pro',
  'Geist Mono',
  'Monaspace Neon',
  'Iosevka',
  'Hack',
  'Roboto Mono',
  'Victor Mono',
  'Ubuntu Mono',
  'DejaVu Sans Mono',
  'Monaco',
  'Courier New',
];

/** What follows the chosen font, so a missing glyph still lands somewhere sane. */
const FALLBACK = '"SF Mono", Menlo, ui-monospace, monospace';

type Section = 'look' | 'terminal' | 'files' | 'sessions' | 'conversations';

const SECTIONS: Array<[Section, string, string]> = [
  ['look', 'Look', 'Theme, accent, text size'],
  ['terminal', 'Terminal', 'Font, cursor, colours'],
  ['files', 'Files', 'Icons and previews'],
  ['sessions', 'Sessions', 'Naming, messages, monitor'],
  ['conversations', 'Conversations', 'What is kept'],
];

/** The section last looked at, so reopening the window goes back to it. */
let lastSection: Section = 'look';

/** Settings: how the app looks and how it behaves, one section at a time. */
export function AppearancePanel() {
  const [section, setSection] = useState<Section>(lastSection);
  const close = () => useStore.getState().setAppearanceOpen(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    lastSection = section;
    bodyRef.current?.scrollTo({ top: 0 });
  }, [section]);

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal settings" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2>Settings</h2>
          <button className="ghost-btn tiny modal-close" onClick={close} aria-label="Close">
            &times;
          </button>
        </header>

        <div className="modal-body settings-body">
          <nav className="profile-nav settings-nav">
            {SECTIONS.map(([id, label, hint]) => (
              <button
                key={id}
                className={`profile-nav-item${section === id ? ' is-selected' : ''}`}
                onClick={() => setSection(id)}
              >
                <span className="settings-nav-text">
                  <span>{label}</span>
                  <small>{hint}</small>
                </span>
              </button>
            ))}
          </nav>

          <div className="settings-page" ref={bodyRef}>
            {section === 'look' && <LookSection />}
            {section === 'terminal' && <TerminalSection />}
            {section === 'files' && <FilesSection />}
            {section === 'sessions' && <SessionsSection />}
            {section === 'conversations' && <ConversationsSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- pieces every section is made of ---------- */

function Group({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-group">
      <h3>{title}</h3>
      {hint && <p className="form-hint">{hint}</p>}
      {children}
    </section>
  );
}

/** A setting on one row: what it is on the left, the control on the right. */
function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/** An on/off setting, drawn as a switch like every other one in the app. */
function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange(on: boolean): void;
}) {
  return (
    <label className={`settings-row is-toggle${disabled ? ' is-disabled' : ''}`}>
      <div className="settings-row-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <span className="checkbox">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
      </span>
    </label>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<readonly [T, ReactNode]>;
  onChange(value: T): void;
}) {
  return (
    <div className="segmented">
      {options.map(([option, label]) => (
        <button
          key={String(option)}
          className={value === option ? 'is-on' : ''}
          onClick={() => onChange(option)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  format(value: number): string;
  onChange(value: number): void;
}) {
  return (
    <div className="settings-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{format(value)}</output>
    </div>
  );
}

function useSettings() {
  return [useStore((s) => s.settings), useStore((s) => s.updateSettings)] as const;
}

/* ---------- Look ---------- */

function LookSection() {
  const [settings, updateSettings] = useSettings();
  const active = activeTheme(settings);
  const following = settings.theme === 'system';

  // A colour picker reports every step of a drag. Each one would rebuild every
  // extension panel, so the accent is applied once the hand stops moving.
  const [draftAccent, setDraftAccent] = useState<string | null>(null);
  useEffect(() => {
    if (draftAccent === null) return;
    const timer = window.setTimeout(() => updateSettings({ accent: draftAccent }), 150);
    return () => window.clearTimeout(timer);
  }, [draftAccent, updateSettings]);
  const accent = draftAccent ?? settings.accent;
  const customAccent = accent && !ACCENTS.some(([colour]) => colour === accent) ? accent : null;

  const pick = (theme: InterfaceTheme) =>
    updateSettings(
      theme.mode === 'dark'
        ? { darkTheme: theme.id, ...(following ? {} : { theme: 'dark' as const }) }
        : { lightTheme: theme.id, ...(following ? {} : { theme: 'light' as const }) },
    );

  return (
    <>
      <Group
        title="Theme"
        hint={
          following
            ? 'Following the system: your dark theme at night, your light theme by day, moving between them when macOS does.'
            : 'Pick one of each. Choosing a theme switches to it; Match system lets the app move between the two.'
        }
      >
        <Segmented
          value={settings.theme}
          options={[
            ['system', 'Match system'],
            ['light', 'Light'],
            ['dark', 'Dark'],
          ]}
          onChange={(theme) => updateSettings({ theme })}
        />
        {(['dark', 'light'] as const).map((mode) => (
          <div key={mode} className="theme-set">
            <span className="cap-label">{mode === 'dark' ? 'Dark theme' : 'Light theme'}</span>
            <div className="theme-grid">
              {INTERFACE_THEMES.filter((theme) => theme.mode === mode).map((theme) => (
                <ThemeCard
                  key={theme.id}
                  theme={theme}
                  chosen={(mode === 'dark' ? settings.darkTheme : settings.lightTheme) === theme.id}
                  inUse={active.id === theme.id}
                  onPick={() => pick(theme)}
                />
              ))}
            </div>
          </div>
        ))}
      </Group>

      <Group
        title="Accent"
        hint="The colour of what is selected, focused or waiting on you. It is nudged lighter or darker where it would be hard to read, so one choice works on every theme."
      >
        <div className="group-swatches accent-swatches">
          <button
            className={`swatch is-theme${accent ? '' : ' is-selected'}`}
            style={{ background: active.tokens.accent }}
            title={`The theme's own (${active.name})`}
            aria-label="the theme's own accent"
            onClick={() => {
              setDraftAccent(null);
              updateSettings({ accent: null });
            }}
          />
          {ACCENTS.map(([colour, label]) => (
            <button
              key={colour}
              className={`swatch${accent === colour ? ' is-selected' : ''}`}
              style={{ background: colour }}
              aria-label={label}
              title={label}
              onClick={() => {
                setDraftAccent(null);
                updateSettings({ accent: colour });
              }}
            />
          ))}
          <label
            className={`swatch is-custom${customAccent ? ' is-selected' : ''}`}
            style={customAccent ? { background: customAccent } : undefined}
            title="Any colour"
          >
            <input
              type="color"
              value={normalise(accent ?? active.tokens.accent)}
              onChange={(event) => setDraftAccent(event.target.value)}
            />
          </label>
        </div>
      </Group>

      <Group title="Layout">
        <Row label="Interface text" hint="Menus, tabs, the sidebar. Terminals have their own size.">
          <Segmented
            value={settings.uiScale}
            options={TEXT_SCALES}
            onChange={(uiScale) => updateSettings({ uiScale })}
          />
        </Row>
        <Row label="Corners" hint="Panels, buttons, menus and this window.">
          <Segmented
            value={settings.corners}
            options={(Object.keys(CORNERS) as Corners[]).map(
              (key) =>
                [
                  key,
                  <span className="corner-option" key={key}>
                    <i style={{ borderTopLeftRadius: CORNERS[key].lg }} />
                    {CORNERS[key].label}
                  </span>,
                ] as const,
            )}
            onChange={(corners) => updateSettings({ corners })}
          />
        </Row>
      </Group>

      <div className="settings-foot">
        <button
          className="link-btn"
          onClick={() => {
            setDraftAccent(null);
            updateSettings({
              theme: 'system',
              darkTheme: 'midnight',
              lightTheme: 'paper',
              accent: null,
              uiScale: 1,
              corners: 'soft',
            });
          }}
        >
          Back to how it came
        </button>
      </div>
    </>
  );
}

/** A theme, drawn as a small picture of the app wearing it. */
function ThemeCard({
  theme,
  chosen,
  inUse,
  onPick,
}: {
  theme: InterfaceTheme;
  chosen: boolean;
  inUse: boolean;
  onPick(): void;
}) {
  const t = theme.tokens;
  const term = paletteById(theme.palette)?.theme ?? {};
  return (
    <button
      className={`theme-card${chosen ? ' is-selected' : ''}${inUse ? ' is-in-use' : ''}`}
      onClick={onPick}
      title={theme.name}
    >
      <span className="theme-mock" style={{ background: t.bg, borderColor: t.border }}>
        <span className="theme-mock-side" style={{ background: t['bg-panel'], borderColor: t.border }}>
          <i style={{ background: t.accent }} />
          <i style={{ background: t['text-faint'] }} />
          <i style={{ background: t['text-faint'] }} />
        </span>
        <span className="theme-mock-main" style={{ background: term.background }}>
          <span className="theme-mock-tab" style={{ background: t.accent }} />
          <i style={{ background: term.green, width: '38%' }} />
          <i style={{ background: term.foreground, width: '70%' }} />
          <i style={{ background: term.blue, width: '52%' }} />
          <i style={{ background: term.magenta, width: '28%' }} />
        </span>
      </span>
      <span className="theme-card-name">
        <span>{theme.name}</span>
        {inUse ? <em>in use</em> : chosen && <em className="is-waiting">for {theme.mode}</em>}
      </span>
    </button>
  );
}

/* ---------- Terminal ---------- */

function TerminalSection() {
  const [settings, updateSettings] = useSettings();
  const theme = currentTerminalTheme(settings);
  const installed = useInstalledFonts();
  const primary = firstFamily(settings.fontFamily);
  const [custom, setCustom] = useState(false);
  const known = installed.includes(primary);
  // What the terminals are really drawn in: the first font of the stack this
  // machine has. The default asks for JetBrains Mono, which many never install.
  const drawnIn = families(settings.fontFamily).find((family) => installed.includes(family));

  const override = (key: OverridableKey, value: string | null) => {
    const next = { ...settings.terminalOverrides };
    if (value) next[key] = value;
    else delete next[key];
    updateSettings({ terminalOverrides: next });
  };

  const setFont = (name: string) => {
    const clean = name.trim().replace(/["']/g, '');
    if (!clean) return;
    updateSettings({ fontFamily: `"${clean}", ${FALLBACK}` });
  };

  const bold = { '300': 500, '400': 600, '500': 700 }[settings.terminalFontWeight];
  const followName = paletteById(activeTheme(settings).palette)?.name ?? '';

  return (
    <>
      <div
        className="term-preview"
        style={{
          background: theme.background,
          color: theme.foreground,
          fontFamily: settings.fontFamily,
          fontSize: settings.fontSize,
          lineHeight: settings.terminalLineHeight,
          letterSpacing: settings.terminalLetterSpacing,
          fontWeight: Number(settings.terminalFontWeight),
        }}
      >
        <div>
          <span style={{ color: theme.green }}>viktor@mac</span>
          <span> ~/dev/smart-terminal </span>
          <span style={{ color: theme.blue }}>%</span> claude
        </div>
        <div style={{ color: theme.magenta }}>
          ● <span style={{ fontWeight: bold }}>Reading</span> src/state/store.ts
        </div>
        <div>
          <span style={{ color: theme.yellow }}>warning</span> 2 files changed,{' '}
          <span style={{ color: theme.red }}>1 failing</span>
          <span style={{ color: theme.brightBlack }}> {'-> => != 0O1lI'}</span>
        </div>
        <div>
          <span style={{ background: theme.selectionBackground }}>selected text</span>{' '}
          <Cursor
            style={settings.cursorStyle}
            colour={theme.cursor ?? theme.foreground ?? '#fff'}
            blink={settings.cursorBlink}
          />
        </div>
      </div>

      <Group title="Font">
        <Row
          label="Typeface"
          hint={
            known
              ? undefined
              : drawnIn
                ? `${primary} is not installed, so ${drawnIn} is drawn instead.`
                : `${primary} is not installed.`
          }
        >
          {custom ? (
            <input
              className="settings-input"
              autoFocus
              defaultValue={primary}
              placeholder="Any installed font"
              onKeyDown={(event) => {
                if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                if (event.key === 'Escape') setCustom(false);
              }}
              onBlur={(event) => {
                setFont(event.target.value);
                setCustom(false);
              }}
            />
          ) : (
            <select
              value={known ? primary : '__custom'}
              className={known ? undefined : 'is-missing'}
              onChange={(event) =>
                event.target.value === '__other' ? setCustom(true) : setFont(event.target.value)
              }
            >
              {!known && <option value="__custom">{primary} (not installed)</option>}
              {installed.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
              <option value="__other">Another font…</option>
            </select>
          )}
        </Row>
        <Row label="Size">
          <Slider
            value={settings.fontSize}
            min={9}
            max={22}
            step={1}
            format={(v) => `${v}px`}
            onChange={(fontSize) => updateSettings({ fontSize })}
          />
        </Row>
        <Row label="Line height">
          <Slider
            value={settings.terminalLineHeight}
            min={1}
            max={1.8}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(terminalLineHeight) => updateSettings({ terminalLineHeight })}
          />
        </Row>
        <Row label="Letter spacing">
          <Slider
            value={settings.terminalLetterSpacing}
            min={0}
            max={3}
            step={0.5}
            format={(v) => `${v}px`}
            onChange={(terminalLetterSpacing) => updateSettings({ terminalLetterSpacing })}
          />
        </Row>
        <Row label="Weight">
          <Segmented
            value={settings.terminalFontWeight}
            options={[
              ['300', 'Light'],
              ['400', 'Regular'],
              ['500', 'Medium'],
            ]}
            onChange={(terminalFontWeight) => updateSettings({ terminalFontWeight })}
          />
        </Row>
        {/*
          The editors' own size, beside the terminals' rather than in a section
          of its own: they are the same question asked about the two places text
          appears, and somebody setting one is the person most likely to want the
          other.
        */}
        <Row label="Editor size" hint="⌘+ and ⌘− change whichever you are in.">
          <Slider
            value={settings.editorFontSize}
            min={9}
            max={24}
            step={0.5}
            format={(v) => `${v}px`}
            onChange={(editorFontSize) => updateSettings({ editorFontSize })}
          />
        </Row>
      </Group>

      <Group title="Cursor">
        <Row label="Shape">
          <Segmented
            value={settings.cursorStyle}
            options={[
              ['bar', <CursorOption key="bar" style="bar" label="Bar" />],
              ['block', <CursorOption key="block" style="block" label="Block" />],
              ['underline', <CursorOption key="underline" style="underline" label="Line" />],
            ]}
            onChange={(cursorStyle) => updateSettings({ cursorStyle })}
          />
        </Row>
        <Toggle
          label="Blinking"
          checked={settings.cursorBlink}
          onChange={(cursorBlink) => updateSettings({ cursorBlink })}
        />
      </Group>

      <Group
        title="Colours"
        hint="Kept separate from the interface, so a light window around a dark terminal is a choice you can make. Following the interface uses the palette made for your theme."
      >
        <div className="palette-grid">
          <PaletteChip
            name={`Follow the interface${followName ? ` · ${followName}` : ''}`}
            selected={settings.terminalPalette === FOLLOW_APP}
            swatches={swatchesOf(paletteById(activeTheme(settings).palette)?.theme ?? {})}
            onSelect={() => updateSettings({ terminalPalette: FOLLOW_APP })}
          />
          {[...PALETTES]
            .sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'dark' ? -1 : 1))
            .map((palette) => (
              <PaletteChip
                key={palette.id}
                name={palette.name}
                selected={settings.terminalPalette === palette.id}
                swatches={swatchesOf(palette.theme)}
                onSelect={() => updateSettings({ terminalPalette: palette.id })}
              />
            ))}
        </div>

        <div className="overrides">
          {OVERRIDABLE.map(({ key, label }) => {
            const own = settings.terminalOverrides[key];
            return (
              <label className="override" key={key}>
                <input
                  type="color"
                  value={normalise(own ?? (theme as Record<string, string>)[key] ?? '#000000')}
                  onChange={(event) => override(key, event.target.value)}
                />
                <span>{label}</span>
                {own && (
                  <button className="link-btn" onClick={() => override(key, null)}>
                    reset
                  </button>
                )}
              </label>
            );
          })}
        </div>
      </Group>

      <Group title="Memory">
        <Row
          label="Scrollback"
          hint={`For new sessions. About ${(settings.scrollback * 0.0026).toFixed(0)} MB in each one that fills it; a Claude session's transcript is kept in full regardless.`}
        >
          <Slider
            value={settings.scrollback}
            min={1000}
            max={50000}
            step={1000}
            format={(v) => `${(v / 1000).toFixed(0)}k lines`}
            onChange={(scrollback) => updateSettings({ scrollback })}
          />
        </Row>
      </Group>
    </>
  );
}

function Cursor({ style, colour, blink }: { style: Settings['cursorStyle']; colour: string; blink?: boolean }) {
  return (
    <i
      className={`cursor-glyph is-${style}${blink ? ' is-blinking' : ''}`}
      style={{ ['--cursor' as string]: colour }}
    />
  );
}

function CursorOption({ style, label }: { style: Settings['cursorStyle']; label: string }) {
  return (
    <span className="cursor-option">
      <Cursor style={style} colour="currentColor" />
      {label}
    </span>
  );
}

function swatchesOf(theme: { background?: string; foreground?: string; blue?: string; green?: string; magenta?: string }) {
  return [theme.background, theme.foreground, theme.blue, theme.green, theme.magenta].filter(
    (colour): colour is string => Boolean(colour),
  );
}

/** The families in a font stack, in the order they are tried. */
function families(stack: string) {
  return stack.split(',').map((family) => family.trim().replace(/["']/g, '')).filter(Boolean);
}

/** The first family in a font stack, which is the one the person chose. */
function firstFamily(stack: string) {
  return families(stack)[0] ?? '';
}

/**
 * Which of the candidate fonts this machine actually has.
 *
 * A missing font does not fail — the browser quietly draws the fallback — so the
 * only way to tell is to measure: text asked for in "X, monospace" that comes
 * out exactly as wide as plain monospace, and the same again against serif, was
 * never drawn in X.
 */
function useInstalledFonts(): string[] {
  return useMemo(() => {
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return FONT_CANDIDATES;
    const sample = 'mmmmmmmmmmlli10OO@@WW';
    const width = (family: string) => {
      context.font = `72px ${family}`;
      return context.measureText(sample).width;
    };
    const bases = ['monospace', 'serif'].map((base) => [base, width(base)] as const);
    return FONT_CANDIDATES.filter((font) =>
      bases.some(([base, baseWidth]) => width(`"${font}", ${base}`) !== baseWidth),
    );
  }, []);
}

/* ---------- Files ---------- */

function FilesSection() {
  const [settings, updateSettings] = useSettings();
  return (
    <>
      <Group
        title="File icons"
        hint={
          <>
            <strong>By kind</strong> tints each file by what it is, so a folder reads as groups rather than as
            forty separate names; <strong>Outline</strong> is the plainer, quieter version of the same shapes.
          </>
        }
      >
        <Segmented
          value={settings.fileIcons}
          options={[
            ['colour', 'By kind'],
            ['outline', 'Outline'],
            ['solid', 'Solid'],
            ['none', 'None'],
          ]}
          onChange={(fileIcons) => updateSettings({ fileIcons })}
        />
        <Row label="Folder colour" hint="Folders keep it in every icon style.">
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
        </Row>
        <Row label="Open folders">
          <Segmented
            value={settings.folderStyle}
            options={[
              ['open-shut', 'Show as open'],
              ['plain', 'Always the same'],
            ]}
            onChange={(folderStyle) => updateSettings({ folderStyle })}
          />
        </Row>

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
          {['store.ts', 'styles.css', 'main.js', 'package.json', 'README.md', 'schema.sql', 'icon.png'].map((name) => (
            <span key={name} className="icon-preview-item">
              <FileIcon
                name={name}
                isDirectory={false}
                style={settings.fileIcons}
                folderColour={settings.folderColour}
                folderStyle={settings.folderStyle}
              />
              <span style={settings.fileIcons === 'colour' ? { color: colourFor(name, false, 'colour') } : undefined}>
                {name}
              </span>
            </span>
          ))}
        </div>
      </Group>

      {/*
        The one preview decision worth a switch. Off, a page is drawn and can do
        nothing; on, it behaves as it would in a browser. Neither setting lets it
        reach the disk or the app — the frame has no origin of its own — so what
        is being chosen is behaviour against reach.
      */}
      <Group title="Previews">
        <Toggle
          label="Let previewed web pages run their own scripts"
          hint="A page's own arrows, tabs and slides only work with this on. It also lets the page talk to the network, which is why it is off until you say so. Each preview can be run once from its own footer without changing this."
          checked={settings.previewScripts}
          onChange={(previewScripts) => updateSettings({ previewScripts })}
        />
      </Group>
    </>
  );
}

/* ---------- Sessions ---------- */

function SessionsSection() {
  const [settings, updateSettings] = useSettings();
  const profiles = useStore((s) => s.profiles);
  return (
    <>
      <Group title="New sessions">
        <Toggle
          label="Ask what to call a new session"
          hint="Otherwise the app names it. Its name is still offered as the suggestion."
          checked={settings.askSessionName}
          onChange={(askSessionName) => updateSettings({ askSessionName })}
        />
      </Group>

      <Group title="Names">
        <Row
          label="Longest name shown"
          hint="Sessions, folders, extensions and clusters, on tabs and in the sidebar. A longer name is cut with …, and hovering it shows the whole of it."
        >
          <Slider
            value={settings.nameMaxChars}
            min={8}
            max={60}
            step={1}
            format={(v) => `${v} characters`}
            onChange={(nameMaxChars) => updateSettings({ nameMaxChars })}
          />
        </Row>
      </Group>

      <Group
        title="Sessions talking to each other"
        hint={
          <>
            A message arrives in the other session as a note saying who sent it, once that session is next
            waiting at its prompt — never while it is working. <strong>Its group</strong> keeps that to sessions
            in the same group; a session in no group reaches nobody. <strong>Every session</strong> opens it to
            everything running. Takes effect at once.
          </>
        }
      >
        <Row label="How far a session can reach">
          <Segmented
            value={settings.sessionMessaging}
            options={[
              ['group', 'Its group'],
              ['all', 'Every session'],
              ['off', 'Off'],
            ]}
            onChange={(sessionMessaging) => updateSettings({ sessionMessaging })}
          />
        </Row>
      </Group>

      <Group
        title="Session monitor"
        hint="Every session is read continuously from the conversation Claude Code already writes to disk — no requests, no tokens, whether or not these are on."
      >
        <Toggle
          label="Mark a session on its tab when it needs a look"
          hint="One that has filled its window, compacted itself, or started paying twice for the same context comes and tells you."
          checked={settings.sessionAlerts}
          onChange={(sessionAlerts) => updateSettings({ sessionAlerts })}
        />
        <Toggle
          label="Say what to do about it"
          hint="Each finding comes with the thing that usually fixes it."
          checked={settings.sessionSuggestions}
          onChange={(sessionSuggestions) => updateSettings({ sessionSuggestions })}
        />
        <Toggle
          label="Let the monitor warn a session in its own conversation"
          hint="The one part that acts rather than reports: a single note at the worst grade of finding, at most twice an hour, when the session is next waiting."
          checked={settings.tellSessions}
          onChange={(tellSessions) => updateSettings({ tellSessions })}
        />
        <Row
          label="Second opinion runs on"
          hint="One short request, given the measurements only. An account of its own keeps it off the work's allowance."
        >
          <select
            value={settings.advisorProfileId ?? ''}
            onChange={(event) => updateSettings({ advisorProfileId: event.target.value || null })}
          >
            <option value="">Whichever the app would use</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </Row>
      </Group>

      <Group title="Context">
        <Row
          label="Compact by itself at"
          hint="Smaller compacts sooner and more often; larger keeps more. Applies to sessions started from now on."
        >
          <select value={settings.autocompact} onChange={(event) => updateSettings({ autocompact: event.target.value })}>
            <option value="">Claude decides</option>
            <option value="auto">Automatic</option>
            <option value="100k">100k tokens</option>
            <option value="200k">200k tokens</option>
            <option value="400k">400k tokens</option>
            <option value="800k">800k tokens</option>
          </select>
        </Row>
      </Group>
    </>
  );
}

/* ---------- Conversations ---------- */

/**
 * The recording switch, with what it is costing right now beside it. A warning
 * about growth is abstract; a number you can watch is not.
 */
function ConversationsSection() {
  const [settings, updateSettings] = useSettings();
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
    <Group
      title="Conversations"
      hint="What you asked, what Claude answered, and every command it ran with what came back — kept so a session can be read and searched from History long after its tab is gone. Single sessions can opt out from their right-click menu."
    >
      <Toggle
        label="Keep a copy of every conversation"
        checked={settings.recordConversations}
        onChange={(recordConversations) => updateSettings({ recordConversations })}
      />
      <Toggle
        label={
          <>
            Include what commands printed
            {commandShare !== null && <em className="share"> — {commandShare}% of what is kept</em>}
          </>
        }
        hint="Command output is nearly all of it: turning this off keeps the thread readable at a fraction of the space."
        disabled={!settings.recordConversations}
        checked={settings.recordCommandOutput}
        onChange={(recordCommandOutput) => updateSettings({ recordCommandOutput })}
      />

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
      <p className="form-hint">
        Roughly 2&nbsp;bytes per character kept. Deleting frees the space at once; the session index and the
        ability to continue a past conversation are untouched.
      </p>
    </Group>
  );
}

function PaletteChip({
  name,
  selected,
  swatches,
  onSelect,
}: {
  name: string;
  selected: boolean;
  swatches: string[];
  onSelect(): void;
}) {
  return (
    <button className={`palette${selected ? ' is-selected' : ''}`} onClick={onSelect} title={name}>
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
