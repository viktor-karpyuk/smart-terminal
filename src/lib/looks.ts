import type { Settings } from '../state/types';
import { paletteById } from '../terminals/themes';
import { setPreviewInk, type PreviewInk } from './preview';

/**
 * The whole look of the app, as one choice.
 *
 * An interface theme is the chrome's tokens and the terminal palette that was
 * made to sit inside them. Picking one restyles everything at once — the
 * sidebar, the menus, the terminals, the extension panels — because the
 * stylesheet only ever asks for tokens, and this is what answers them.
 *
 * A theme is either dark or light. Somebody who follows the system picks one of
 * each, and the app moves between them with the OS; that is the only way a
 * choice of theme and "match system" can both be honoured.
 */
export interface InterfaceTheme {
  id: string;
  name: string;
  mode: 'dark' | 'light';
  /** The terminal palette that "follow the interface" means under this theme. */
  palette: string;
  tokens: ThemeTokens;
}

type ThemeTokens = {
  bg: string;
  'bg-panel': string;
  'bg-elevated': string;
  'bg-input': string;
  border: string;
  'border-strong': string;
  text: string;
  'text-dim': string;
  'text-faint': string;
  accent: string;
  danger: string;
  ok: string;
  warn: string;
  info: string;
  violet: string;
  'on-accent': string;
};

export const INTERFACE_THEMES: InterfaceTheme[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    mode: 'dark',
    palette: 'midnight',
    tokens: {
      bg: '#0b0d13',
      'bg-panel': '#11131a',
      'bg-elevated': '#171a23',
      'bg-input': '#0e1017',
      border: '#232735',
      'border-strong': '#303648',
      text: '#c8d0e0',
      'text-dim': '#7b849c',
      'text-faint': '#565f79',
      accent: '#7aa2f7',
      danger: '#f7768e',
      ok: '#9ece6a',
      warn: '#e0af68',
      info: '#7dcfff',
      violet: '#bb9af7',
      'on-accent': '#0b0d13',
    },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    mode: 'dark',
    palette: 'graphite',
    tokens: {
      bg: '#0f0f0f',
      'bg-panel': '#151515',
      'bg-elevated': '#1c1c1c',
      'bg-input': '#121212',
      border: '#262626',
      'border-strong': '#363636',
      text: '#d4d4d4',
      'text-dim': '#8a8a8a',
      'text-faint': '#5f5f5f',
      accent: '#d4d4d4',
      danger: '#e06c75',
      ok: '#98c379',
      warn: '#d7ba7d',
      info: '#56b6c2',
      violet: '#c678dd',
      'on-accent': '#0f0f0f',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    mode: 'dark',
    palette: 'nord',
    tokens: {
      bg: '#242933',
      'bg-panel': '#2a303c',
      'bg-elevated': '#313744',
      'bg-input': '#262b36',
      border: '#3b4252',
      'border-strong': '#4c566a',
      text: '#e5e9f0',
      'text-dim': '#9aa3b5',
      'text-faint': '#6b7589',
      accent: '#88c0d0',
      danger: '#bf616a',
      ok: '#a3be8c',
      warn: '#ebcb8b',
      info: '#8fbcbb',
      violet: '#b48ead',
      'on-accent': '#242933',
    },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    mode: 'dark',
    palette: 'catppuccin-mocha',
    tokens: {
      bg: '#11111b',
      'bg-panel': '#181825',
      'bg-elevated': '#1e1e2e',
      'bg-input': '#14141f',
      border: '#313244',
      'border-strong': '#45475a',
      text: '#cdd6f4',
      'text-dim': '#a6adc8',
      'text-faint': '#6c7086',
      accent: '#cba6f7',
      danger: '#f38ba8',
      ok: '#a6e3a1',
      warn: '#f9e2af',
      info: '#89dceb',
      violet: '#f5c2e7',
      'on-accent': '#11111b',
    },
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    mode: 'dark',
    palette: 'rose-pine',
    tokens: {
      bg: '#131120',
      'bg-panel': '#191724',
      'bg-elevated': '#1f1d2e',
      'bg-input': '#15131f',
      border: '#26233a',
      'border-strong': '#403d52',
      text: '#e0def4',
      'text-dim': '#908caa',
      'text-faint': '#6e6a86',
      accent: '#c4a7e7',
      danger: '#eb6f92',
      ok: '#9ccfd8',
      warn: '#f6c177',
      info: '#9ccfd8',
      violet: '#ebbcba',
      'on-accent': '#191724',
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox',
    mode: 'dark',
    palette: 'gruvbox-dark',
    tokens: {
      bg: '#191b1c',
      'bg-panel': '#1d2021',
      'bg-elevated': '#282828',
      'bg-input': '#1a1c1d',
      border: '#32302f',
      'border-strong': '#504945',
      text: '#ebdbb2',
      'text-dim': '#a89984',
      'text-faint': '#7c6f64',
      accent: '#fabd2f',
      danger: '#fb4934',
      ok: '#b8bb26',
      warn: '#fe8019',
      info: '#8ec07c',
      violet: '#d3869b',
      'on-accent': '#1d2021',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    mode: 'dark',
    palette: 'dracula',
    tokens: {
      bg: '#1e1f29',
      'bg-panel': '#21222c',
      'bg-elevated': '#282a36',
      'bg-input': '#1c1d26',
      border: '#343746',
      'border-strong': '#44475a',
      text: '#f8f8f2',
      'text-dim': '#b0b3c6',
      'text-faint': '#6272a4',
      accent: '#bd93f9',
      danger: '#ff5555',
      ok: '#50fa7b',
      warn: '#ffb86c',
      info: '#8be9fd',
      violet: '#ff79c6',
      'on-accent': '#21222c',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    mode: 'dark',
    palette: 'solarized-dark',
    tokens: {
      bg: '#00212b',
      'bg-panel': '#002731',
      'bg-elevated': '#073642',
      'bg-input': '#00252e',
      border: '#0e3d49',
      'border-strong': '#2a5561',
      text: '#93a1a1',
      'text-dim': '#839496',
      'text-faint': '#586e75',
      accent: '#268bd2',
      danger: '#dc322f',
      ok: '#859900',
      warn: '#b58900',
      info: '#2aa198',
      violet: '#6c71c4',
      'on-accent': '#fdf6e3',
    },
  },
  {
    id: 'paper',
    name: 'Paper',
    mode: 'light',
    palette: 'paper',
    tokens: {
      bg: '#eceef2',
      'bg-panel': '#f6f7f9',
      'bg-elevated': '#ffffff',
      'bg-input': '#ffffff',
      border: '#dcdfe6',
      'border-strong': '#c2c7d2',
      text: '#24272e',
      'text-dim': '#5c6270',
      'text-faint': '#8b909c',
      accent: '#2f6fdd',
      danger: '#c0384c',
      ok: '#3f7f3a',
      warn: '#9a6512',
      info: '#1f7a9a',
      violet: '#7a4fc9',
      'on-accent': '#ffffff',
    },
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    mode: 'light',
    palette: 'github-light',
    tokens: {
      bg: '#eaeef2',
      'bg-panel': '#f6f8fa',
      'bg-elevated': '#ffffff',
      'bg-input': '#ffffff',
      border: '#d0d7de',
      'border-strong': '#afb8c1',
      text: '#1f2328',
      'text-dim': '#656d76',
      'text-faint': '#8c959f',
      accent: '#0969da',
      danger: '#cf222e',
      ok: '#1a7f37',
      warn: '#9a6700',
      info: '#1b7c83',
      violet: '#8250df',
      'on-accent': '#ffffff',
    },
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    mode: 'light',
    palette: 'catppuccin-latte',
    tokens: {
      bg: '#dce0e8',
      'bg-panel': '#e6e9ef',
      'bg-elevated': '#eff1f5',
      'bg-input': '#f5f6f9',
      border: '#ccd0da',
      'border-strong': '#bcc0cc',
      text: '#4c4f69',
      'text-dim': '#6c6f85',
      'text-faint': '#8c8fa1',
      accent: '#8839ef',
      danger: '#d20f39',
      ok: '#40a02b',
      warn: '#b8700f',
      info: '#179299',
      violet: '#ea76cb',
      'on-accent': '#ffffff',
    },
  },
  {
    id: 'rose-pine-dawn',
    name: 'Rosé Pine Dawn',
    mode: 'light',
    palette: 'rose-pine-dawn',
    tokens: {
      bg: '#f2e9e1',
      'bg-panel': '#faf4ed',
      'bg-elevated': '#fffaf3',
      'bg-input': '#fffaf3',
      border: '#dfdad9',
      'border-strong': '#cecacd',
      text: '#575279',
      'text-dim': '#797593',
      'text-faint': '#9893a5',
      accent: '#286983',
      danger: '#b4637a',
      ok: '#56949f',
      warn: '#c4801f',
      info: '#56949f',
      violet: '#907aa9',
      'on-accent': '#fffaf3',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    mode: 'light',
    palette: 'solarized-light',
    tokens: {
      bg: '#eee8d5',
      'bg-panel': '#f5efdc',
      'bg-elevated': '#fdf6e3',
      'bg-input': '#fdf6e3',
      border: '#ddd6c1',
      'border-strong': '#c9c2ad',
      text: '#586e75',
      'text-dim': '#657b83',
      'text-faint': '#93a1a1',
      accent: '#268bd2',
      danger: '#dc322f',
      ok: '#859900',
      warn: '#b58900',
      info: '#2aa198',
      violet: '#6c71c4',
      'on-accent': '#fdf6e3',
    },
  },
];

/** Accents offered as swatches. Any colour can still be picked by hand. */
export const ACCENTS: Array<[string, string]> = [
  ['#7aa2f7', 'blue'],
  ['#7dcfff', 'sky'],
  ['#41a6b5', 'teal'],
  ['#9ece6a', 'green'],
  ['#e0af68', 'amber'],
  ['#ff9e64', 'orange'],
  ['#f7768e', 'rose'],
  ['#bb9af7', 'violet'],
];

export const TEXT_SCALES: Array<[number, string]> = [
  [0.92, 'Small'],
  [1, 'Default'],
  [1.08, 'Large'],
  [1.16, 'Larger'],
];

export const CORNERS = {
  square: { sm: 2, md: 3, lg: 4, modal: 6, label: 'Square' },
  soft: { sm: 4, md: 6, lg: 8, modal: 10, label: 'Soft' },
  round: { sm: 6, md: 10, lg: 14, modal: 16, label: 'Round' },
} as const;

export type Corners = keyof typeof CORNERS;

/** The type scale, at 100%. Every size in the stylesheet is one of these. */
const TYPE_SCALE = { xs: 10, sm: 11, md: 12.5, base: 13, lg: 14, xl: 16 };

export function themeById(id: string, mode: 'dark' | 'light'): InterfaceTheme {
  const found = INTERFACE_THEMES.find((theme) => theme.id === id && theme.mode === mode);
  return found ?? INTERFACE_THEMES.find((theme) => theme.mode === mode)!;
}

/** Whether the interface is dark right now, resolving `system` against the OS. */
export function isDarkMode(mode: Settings['theme']) {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** The interface theme in force, given the settings and the OS. */
export function activeTheme(settings: Pick<Settings, 'theme' | 'darkTheme' | 'lightTheme'>) {
  return isDarkMode(settings.theme)
    ? themeById(settings.darkTheme, 'dark')
    : themeById(settings.lightTheme, 'light');
}

/**
 * Stamp the look on the document.
 *
 * Tokens go on the root element's own style, which outranks the stylesheet's
 * `:root` blocks — so the stylesheet keeps its defaults for the moment before
 * this runs, and this is the only thing that has to know about themes.
 */
export function applyLook(settings: Settings) {
  const root = document.documentElement;
  const theme = activeTheme(settings);
  const dark = theme.mode === 'dark';

  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  for (const [token, value] of Object.entries(theme.tokens)) root.style.setProperty(`--${token}`, value);
  root.style.setProperty('--git-new', theme.tokens.warn);

  root.style.setProperty('--ink-mix', dark ? '100%' : '62%');

  const accent = accentFor(settings, theme);
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-soft', withAlpha(accent, dark ? 0.16 : 0.12));
  root.style.setProperty(
    '--on-accent',
    settings.accent
      ? contrast(accent, '#ffffff') >= contrast(accent, theme.tokens.bg)
        ? '#ffffff'
        : theme.tokens.bg
      : theme.tokens['on-accent'],
  );

  const scale = settings.uiScale || 1;
  root.style.setProperty('--ui-scale', String(scale));
  for (const [step, size] of Object.entries(TYPE_SCALE)) {
    const px = Math.round(size * scale * 2) / 2;
    // The smallest step carries section labels and counts; below 9.5px they stop being read.
    root.style.setProperty(`--fs-${step}`, `${step === 'xs' ? Math.max(px, 9.5) : px}px`);
  }

  const corners = CORNERS[settings.corners] ?? CORNERS.soft;
  root.style.setProperty('--r-sm', `${corners.sm}px`);
  root.style.setProperty('--r-md', `${corners.md}px`);
  root.style.setProperty('--r-lg', `${corners.lg}px`);
  root.style.setProperty('--r-modal', `${corners.modal}px`);
  // Pills follow the corners too: square buttons beside round chips looked like two apps.
  root.style.setProperty('--r-pill', settings.corners === 'square' ? `${corners.md}px` : '999px');

  for (const [name, colour] of Object.entries(syntaxFor(theme))) {
    root.style.setProperty(`--syn-${name}`, colour);
  }

  // Previews are documents of their own, so they are handed the same colours.
  setPreviewInk(previewInkFor(settings));

  // One attribute that changes whenever any of this does, for the things that
  // have to rebuild to follow it — an extension panel is its own document.
  root.setAttribute(
    'data-look',
    [theme.id, accent, scale, settings.corners].join(' '),
  );
}

/** The accent in force: the person's own, made readable on this theme, or the theme's. */
function accentFor(settings: Settings, theme: InterfaceTheme) {
  return settings.accent
    ? readableOn(settings.accent, theme.tokens['bg-panel'], theme.mode === 'dark')
    : theme.tokens.accent;
}

/**
 * Syntax colours for the editor and the previews, from the palette made for
 * this theme — so code reads like the terminal beside it — and each one moved
 * just far enough to read on the editor's background. Comments are meant to
 * recede, so they are held to a lower bar.
 */
function syntaxFor(theme: InterfaceTheme): Record<string, string> {
  const dark = theme.mode === 'dark';
  const ink = paletteById(theme.palette)?.theme ?? {};
  const bg = theme.tokens.bg;
  const wanted: Record<string, [string | undefined, number]> = {
    keyword: [ink.magenta, 4],
    string: [ink.green, 4],
    number: [dark ? ink.brightYellow : ink.yellow, 4],
    fn: [ink.blue, 4],
    type: [ink.brightCyan ?? ink.cyan, 4],
    property: [ink.cyan, 4],
    tag: [ink.yellow, 4],
    invalid: [ink.red, 4],
    comment: [ink.brightBlack, 2.6],
  };
  const out: Record<string, string> = { punct: theme.tokens['text-dim'] };
  for (const [name, [colour, minimum]] of Object.entries(wanted)) {
    if (colour) out[name] = readableOn(colour, bg, dark, minimum);
  }
  return out;
}

/**
 * The colours a preview is painted in, worked out from the settings alone.
 *
 * Not read back from the document: a preview rebuilt in the same render that
 * changed the theme would otherwise be painted with the theme it is leaving,
 * because the document is only restyled after that render.
 */
export function previewInkFor(settings: Settings): PreviewInk {
  const theme = activeTheme(settings);
  const syntax = syntaxFor(theme);
  return {
    ink: theme.tokens.text,
    dim: theme.tokens['text-dim'],
    paper: theme.tokens.bg,
    rule: theme.tokens.border,
    inset: theme.tokens['bg-panel'],
    link: accentFor(settings, theme),
    key: syntax.fn,
    str: syntax.string,
    num: syntax.number,
    cons: syntax.keyword,
    quiet: syntax.comment,
    tag: syntax.tag,
  };
}

/* ---------- colour ---------- */

/**
 * A colour chosen for the dark themes, made readable on whatever theme is on.
 *
 * Account, group and file colours were picked against Midnight, and a pale
 * green that sings on near-black all but disappears on white. On a light theme
 * this blends the colour with the theme's own text colour, which is always
 * dark there; on a dark theme `--ink-mix` is 100% and the colour is untouched.
 *
 * It is CSS rather than a computed hex on purpose: the answer changes the
 * moment the theme does, with nothing to re-render and nothing to go stale.
 */
export function legible(colour: string): string {
  if (!colour || colour === 'currentColor' || colour.startsWith('var(')) return colour;
  return `color-mix(in srgb, ${colour} var(--ink-mix, 100%), var(--text))`;
}

function parse(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const n = parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: [number, number, number]) {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(colour: string) {
  const [r, g, b] = parse(colour).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Whether a background is light enough that dark-terminal colours will fade on it. */
export function isLightSurface(colour: string | undefined) {
  return Boolean(colour && /^#[0-9a-f]{6}$/i.test(colour) && luminance(colour) > 0.4);
}

/** `a` blended into `b` by `share` (0–1), as #rrggbb — for places that take no CSS. */
export function mixHex(a: string, b: string, share: number) {
  const x = parse(a);
  const y = parse(b);
  return hex(x.map((c, i) => c * share + y[i] * (1 - share)) as [number, number, number]);
}

export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function withAlpha(colour: string, alpha: number) {
  const [r, g, b] = parse(colour);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The chosen accent, moved just far enough to be read on this theme.
 *
 * The accent is used as text — a selected tab, a link, a count — so a pale blue
 * picked on a dark theme would all but vanish on a light one. Rather than keep
 * an accent per mode, the one colour is darkened or lightened towards legibility
 * and left alone when it is already there.
 */
function readableOn(colour: string, on: string, dark: boolean, minimum = 4.5) {
  let rgb = parse(colour);
  const target: [number, number, number] = dark ? [255, 255, 255] : [0, 0, 0];
  for (let step = 0; step < 20 && contrast(hex(rgb), on) < minimum; step++) {
    rgb = rgb.map((c, i) => c + (target[i] - c) * 0.1) as [number, number, number];
  }
  return hex(rgb);
}
