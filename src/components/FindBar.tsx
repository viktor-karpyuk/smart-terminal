import { useEffect, useRef, useState } from 'react';
import type { ISearchOptions } from '@xterm/addon-search';
import { useStore } from '../state/store';
import { getTerminal } from '../terminals/registry';
import { mixHex } from '../lib/looks';
import { CloseGlyph } from './icons';

/**
 * How matches are marked, in the theme's own colours.
 *
 * xterm draws these itself and only takes #rrggbb, so they are read from the
 * tokens at the moment of searching rather than written as CSS: every match is
 * the accent blended into the terminal's background, and the current one is the
 * warning colour, on whatever theme is on.
 */
function options(sessionId: string): ISearchOptions {
  const tokens = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => {
    const value = tokens.getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  };
  const accent = read('--accent', '#7aa2f7');
  const warn = read('--warn', '#e0af68');
  const background = getTerminal(sessionId)?.term.options.theme?.background ?? '#0f1117';
  const match = /^#[0-9a-f]{6}$/i.test(background) ? mixHex(accent, background, 0.35) : '#3b4261';
  return {
    decorations: {
      matchBackground: match,
      matchBorder: match,
      matchOverviewRuler: accent,
      activeMatchBackground: warn,
      activeMatchBorder: warn,
      activeMatchColorOverviewRuler: warn,
    },
  };
}

export function FindBar({ sessionId }: { sessionId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const setFindOpenFor = useStore((s) => s.setFindOpenFor);
  const [query, setQuery] = useState('');

  useEffect(() => inputRef.current?.focus(), []);

  function search(direction: 1 | -1) {
    const search = getTerminal(sessionId)?.search;
    if (!search || !query) return;
    if (direction === 1) search.findNext(query, options(sessionId));
    else search.findPrevious(query, options(sessionId));
  }

  function close() {
    getTerminal(sessionId)?.search.clearDecorations();
    setFindOpenFor(null);
    getTerminal(sessionId)?.term.focus();
  }

  return (
    <div className="findbar">
      <input
        ref={inputRef}
        value={query}
        placeholder="Find in terminal"
        onChange={(event) => {
          setQuery(event.target.value);
          getTerminal(sessionId)?.search.findNext(event.target.value, options(sessionId));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') search(event.shiftKey ? -1 : 1);
          if (event.key === 'Escape') close();
        }}
      />
      <button className="ghost-btn tiny" onClick={() => search(-1)} title="Previous match (⇧⏎)" aria-label="Previous match">
        ↑
      </button>
      <button className="ghost-btn tiny" onClick={() => search(1)} title="Next match (⏎)" aria-label="Next match">
        ↓
      </button>
      <button className="ghost-btn tiny" onClick={close} title="Close (esc)" aria-label="Close find">
        <CloseGlyph />
      </button>
    </div>
  );
}
