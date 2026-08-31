import type { ITheme } from '@xterm/xterm';

export interface TerminalPalette {
  id: string;
  name: string;
  /** Whether this palette expects a light or dark surface around it. */
  mode: 'light' | 'dark';
  theme: ITheme;
}

/**
 * Terminal palettes. The colours a terminal draws are separate from the app's
 * chrome — someone can want a light interface around a dark terminal, which is a
 * common way to work — so the two are chosen independently, with "follow the app"
 * as the default for people who do not care.
 */
export const PALETTES: TerminalPalette[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    mode: 'dark',
    theme: {
      background: '#0f1117',
      foreground: '#c8d0e0',
      cursor: '#7aa2f7',
      cursorAccent: '#0f1117',
      selectionBackground: '#2c3550',
      black: '#1a1c25',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#565f89',
      brightRed: '#ff7a93',
      brightGreen: '#b9f27c',
      brightYellow: '#ff9e64',
      brightBlue: '#7da6ff',
      brightMagenta: '#bb9af7',
      brightCyan: '#0db9d7',
      brightWhite: '#d5d6db',
    },
  },
  {
    id: 'paper',
    name: 'Paper',
    mode: 'light',
    theme: {
      background: '#fbfbfa',
      foreground: '#33373f',
      cursor: '#2f6fdd',
      cursorAccent: '#fbfbfa',
      selectionBackground: '#cfdcf5',
      black: '#3b3f47',
      red: '#c0384c',
      green: '#3f7f3a',
      yellow: '#9a6a12',
      blue: '#2f6fdd',
      magenta: '#8a4bbd',
      cyan: '#1f7f8f',
      white: '#7c828d',
      brightBlack: '#9aa0aa',
      brightRed: '#d84a5e',
      brightGreen: '#4d9946',
      brightYellow: '#b8801a',
      brightBlue: '#4a86ec',
      brightMagenta: '#a05fd6',
      brightCyan: '#2596a8',
      brightWhite: '#33373f',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    mode: 'dark',
    theme: {
      background: '#002b36',
      foreground: '#93a1a1',
      cursor: '#93a1a1',
      cursorAccent: '#002b36',
      selectionBackground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    mode: 'light',
    theme: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#657b83',
      cursorAccent: '#fdf6e3',
      selectionBackground: '#eee8d5',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    },
  },
];

export const FOLLOW_APP = 'follow-app';

/** The keys a person is actually likely to want to change by hand. */
export const OVERRIDABLE = [
  { key: 'background', label: 'Background' },
  { key: 'foreground', label: 'Text' },
  { key: 'cursor', label: 'Cursor' },
  { key: 'selectionBackground', label: 'Selection' },
] as const;

export type OverridableKey = (typeof OVERRIDABLE)[number]['key'];

export function paletteById(id: string): TerminalPalette | undefined {
  return PALETTES.find((palette) => palette.id === id);
}

/** The palette to draw with, given the chosen id and whether the app is dark. */
export function resolveTerminalTheme(
  paletteId: string,
  overrides: Partial<Record<OverridableKey, string>>,
  appIsDark: boolean,
): ITheme {
  const base =
    paletteId === FOLLOW_APP
      ? paletteById(appIsDark ? 'midnight' : 'paper')!
      : (paletteById(paletteId) ?? PALETTES[0]);

  const theme: ITheme = { ...base.theme };
  for (const [key, value] of Object.entries(overrides)) {
    if (value) (theme as Record<string, unknown>)[key] = value;
  }
  // The cursor's contrasting colour has to track the background it sits on.
  if (overrides.background) theme.cursorAccent = overrides.background;
  return theme;
}
