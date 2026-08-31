import { useEffect, useRef, useState } from 'react';
import type { ISearchOptions } from '@xterm/addon-search';
import { useStore } from '../state/store';
import { getTerminal } from '../terminals/registry';

const OPTIONS: ISearchOptions = {
  decorations: {
    matchBackground: '#3b4261',
    matchBorder: '#3b4261',
    matchOverviewRuler: '#7aa2f7',
    activeMatchBackground: '#e0af68',
    activeMatchBorder: '#e0af68',
    activeMatchColorOverviewRuler: '#e0af68',
  },
};

export function FindBar({ sessionId }: { sessionId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const setFindOpenFor = useStore((s) => s.setFindOpenFor);
  const [query, setQuery] = useState('');

  useEffect(() => inputRef.current?.focus(), []);

  function search(direction: 1 | -1) {
    const search = getTerminal(sessionId)?.search;
    if (!search || !query) return;
    if (direction === 1) search.findNext(query, OPTIONS);
    else search.findPrevious(query, OPTIONS);
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
          getTerminal(sessionId)?.search.findNext(event.target.value, OPTIONS);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') search(event.shiftKey ? -1 : 1);
          if (event.key === 'Escape') close();
        }}
      />
      <button className="ghost-btn tiny" onClick={() => search(-1)}>↑</button>
      <button className="ghost-btn tiny" onClick={() => search(1)}>↓</button>
      <button className="ghost-btn tiny" onClick={close}>×</button>
    </div>
  );
}
