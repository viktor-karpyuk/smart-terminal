import type { Settings } from '../state/types';

/**
 * What a file and a folder look like in the tree.
 *
 * Every icon was the same grey glyph, which is readable and tells you nothing: in
 * a folder of forty files the eye has to read every name. Colour by kind fixes
 * that without adding a single pixel — you find the stylesheet among the
 * TypeScript by looking, not by reading.
 *
 * It is a setting rather than a decision because it is a matter of taste, and
 * because a tree of coloured icons is genuinely noisier than a plain one. The
 * shapes are the same in every style; only the fill and the colour change, so
 * switching never moves anything.
 */

export type IconStyle = Settings['fileIcons'];

/**
 * Colour by what the file *is*, not by its extension one at a time — the point is
 * that stylesheets look alike and scripts look alike, so a folder reads as
 * groups rather than as forty separate things.
 */
const BY_EXTENSION: Record<string, string> = {
  // TypeScript and its neighbours
  ts: '#7aa2f7', tsx: '#7aa2f7', mts: '#7aa2f7', cts: '#7aa2f7',
  js: '#e0af68', jsx: '#e0af68', mjs: '#e0af68', cjs: '#e0af68',
  // styles
  css: '#bb9af7', scss: '#bb9af7', less: '#bb9af7', sass: '#bb9af7',
  // markup and documents
  html: '#ff9e64', htm: '#ff9e64', vue: '#9ece6a', svelte: '#ff9e64',
  md: '#7dcfff', markdown: '#7dcfff', mdx: '#7dcfff', txt: '#7b849c',
  // data and configuration
  json: '#e0af68', jsonc: '#e0af68', yaml: '#7dcfff', yml: '#7dcfff',
  toml: '#7dcfff', ini: '#7dcfff', conf: '#7dcfff', env: '#e0af68',
  // other languages
  py: '#9ece6a', rb: '#f7768e', go: '#2ac3de', rs: '#ff9e64',
  java: '#f7768e', kt: '#bb9af7', swift: '#ff9e64', php: '#bb9af7',
  c: '#7dcfff', h: '#7dcfff', cpp: '#7dcfff', cs: '#9ece6a',
  sh: '#9ece6a', zsh: '#9ece6a', bash: '#9ece6a', fish: '#9ece6a',
  sql: '#7dcfff', db: '#565f79', sqlite: '#565f79',
  // pictures and the rest
  png: '#bb9af7', jpg: '#bb9af7', jpeg: '#bb9af7', gif: '#bb9af7',
  svg: '#9ece6a', webp: '#bb9af7', icns: '#bb9af7', ico: '#bb9af7',
  lock: '#565f79', log: '#565f79', zip: '#565f79', pdf: '#f7768e',
};

/** A few names carry more meaning than their extension does. */
const BY_NAME: Record<string, string> = {
  'package.json': '#9ece6a',
  'package-lock.json': '#565f79',
  'tsconfig.json': '#7aa2f7',
  'readme.md': '#7dcfff',
  'license': '#e0af68',
  '.gitignore': '#f7768e',
  '.env': '#e0af68',
  dockerfile: '#7dcfff',
  makefile: '#ff9e64',
};

export function colourFor(
  name: string,
  isDirectory: boolean,
  style: IconStyle,
  folderColour = '#7aa2f7',
): string {
  // A folder keeps its colour even in the plain styles: it is the one thing in
  // the tree that is a different kind of thing, and telling it apart at a glance
  // is worth more than the restraint of an all-grey list.
  if (isDirectory) return folderColour === 'match' ? 'currentColor' : folderColour;
  if (style !== 'colour') return 'currentColor';
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  return BY_EXTENSION[ext] ?? '#7b849c';
}

interface Props {
  name: string;
  isDirectory: boolean;
  /** Only meaningful for a folder. */
  open?: boolean;
  style: IconStyle;
  size?: number;
  folderColour?: string;
  /** Whether an open folder is drawn differently from a shut one. */
  folderStyle?: 'plain' | 'open-shut';
}

/**
 * One icon. The shapes never change between styles — a tree that reflows when you
 * change how it is painted is a tree you have to find your place in again.
 */
export function FileIcon({
  name,
  isDirectory,
  open = false,
  style,
  size = 13,
  folderColour = '#7aa2f7',
  folderStyle = 'open-shut',
}: Props) {
  if (style === 'none') return <span style={{ width: 0, flex: '0 0 auto' }} />;

  const colour = colourFor(name, isDirectory, style, folderColour);
  const filled = style === 'solid' || style === 'colour';
  const ajar = isDirectory && open && folderStyle === 'open-shut';
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 14 14',
    style: { flex: '0 0 auto' as const },
  };

  if (isDirectory) {
    return filled ? (
      <svg {...common} fill={colour} stroke="none" opacity={style === 'solid' ? 0.75 : 1}>
        {ajar ? (
          <path d="M1.6 3.4h3.4l1.1 1.4h6.3v1.1H3.5L1.6 11.4z" />
        ) : (
          <path d="M1.6 3.4h3.4l1.1 1.4h6.3v6.2H1.6z" />
        )}
      </svg>
    ) : (
      <svg {...common} fill="none" stroke={colour} strokeWidth="1.3">
        <path d={ajar ? 'M1.6 3.4h3.4l1.1 1.4h6.3v1.4M1.6 3.4v7.6h10.8l1.6-5.6H3.4z' : 'M1.6 3.4h3.4l1.1 1.4h6.3v6.2H1.6z'} />
      </svg>
    );
  }

  return filled ? (
    <svg {...common} fill={colour} stroke="none" opacity={style === 'solid' ? 0.7 : 1}>
      <path d="M3.4 1.6h4.4l2.8 2.8v8H3.4z" />
      <path d="M7.8 1.6l2.8 2.8H7.8z" opacity="0.55" />
    </svg>
  ) : (
    <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M3.4 1.6h4.4l2.8 2.8v8H3.4z" />
      <path d="M7.8 1.6v2.8h2.8" />
    </svg>
  );
}
