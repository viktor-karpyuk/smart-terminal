import { useEffect, useRef, useState } from 'react';
import type { ISearchOptions } from '@xterm/addon-search';
import { useStore } from '../state/store';
import { getTerminal } from '../terminals/registry';
import { useTerminalFeature } from '../terminals/features';
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
/** The three ways a search can be narrowed, when the Terminal extension offers them. */
interface Narrowing {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

function options(sessionId: string, narrowing?: Narrowing): ISearchOptions {
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
    ...narrowing,
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
  const offered = useTerminalFeature('find-options');
  const [narrowing, setNarrowing] = useState<Narrowing>({ caseSensitive: false, wholeWord: false, regex: false });
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  const [broken, setBroken] = useState(false);
  const used = offered ? narrowing : undefined;

  useEffect(() => inputRef.current?.focus(), []);

  // "3 of 17", as the addon counts them. Only reported while matches are decorated.
  useEffect(() => {
    const search = getTerminal(sessionId)?.search;
    if (!search) return;
    const heard = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount }),
    );
    return () => heard.dispose();
  }, [sessionId]);

  /*
   * Run the search, saying so when a regular expression does not compile
   * rather than throwing — half-typed patterns are the normal state of a
   * regex search, and each one is a keystroke away from a valid one.
   */
  function run(text: string, direction: 1 | -1, narrow = used) {
    const search = getTerminal(sessionId)?.search;
    if (!search) return;
    if (!text) {
      search.clearDecorations();
      setResults(null);
      setBroken(false);
      return;
    }
    if (narrow?.regex) {
      try {
        new RegExp(text);
      } catch {
        search.clearDecorations();
        setResults(null);
        setBroken(true);
        return;
      }
    }
    setBroken(false);
    if (direction === 1) search.findNext(text, options(sessionId, narrow));
    else search.findPrevious(text, options(sessionId, narrow));
  }

  function search(direction: 1 | -1) {
    if (query) run(query, direction);
  }

  function toggle(key: keyof Narrowing) {
    const next = { ...narrowing, [key]: !narrowing[key] };
    setNarrowing(next);
    run(query, 1, next);
    inputRef.current?.focus();
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
        aria-invalid={broken || undefined}
        className={broken ? 'is-broken' : undefined}
        onChange={(event) => {
          setQuery(event.target.value);
          run(event.target.value, 1);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') search(event.shiftKey ? -1 : 1);
          if (event.key === 'Escape') close();
        }}
      />
      {query && (
        <span className="findbar-count" aria-live="polite">
          {broken
            ? 'not a pattern'
            : results
              ? results.count
                ? `${results.index >= 0 ? results.index + 1 : '–'} of ${results.count}`
                : 'none'
              : ''}
        </span>
      )}
      {offered && (
        <>
          <button
            className={`ghost-btn tiny findbar-toggle${narrowing.caseSensitive ? ' is-on' : ''}`}
            aria-pressed={narrowing.caseSensitive}
            title="Match case"
            onClick={() => toggle('caseSensitive')}
          >
            Aa
          </button>
          <button
            className={`ghost-btn tiny findbar-toggle${narrowing.wholeWord ? ' is-on' : ''}`}
            aria-pressed={narrowing.wholeWord}
            title="Whole words only"
            onClick={() => toggle('wholeWord')}
          >
            <u>ab</u>
          </button>
          <button
            className={`ghost-btn tiny findbar-toggle${narrowing.regex ? ' is-on' : ''}`}
            aria-pressed={narrowing.regex}
            title="Regular expression"
            onClick={() => toggle('regex')}
          >
            .*
          </button>
        </>
      )}
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
