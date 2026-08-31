import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useStore } from './state/store';
import { getTerminal } from './terminals/registry';
import './styles.css';

if (import.meta.env.DEV) {
  // Handy for poking at state from the devtools console. The WebGL renderer draws
  // to a canvas, so reading a terminal means going through xterm's buffer API.
  const debug = window as unknown as {
    store: typeof useStore;
    readTerminal(id: string): string;
    terminal: typeof getTerminal;
    terminalStats(id: string): { lines: number; cols: number; rows: number } | null;
  };
  debug.store = useStore;
  debug.terminal = getTerminal;
  debug.terminalStats = (id: string) => {
    const handle = getTerminal(id);
    if (!handle) return null;
    const buffer = handle.term.buffer.active;
    return { lines: buffer.length, cols: handle.term.cols, rows: handle.term.rows };
  };
  debug.readTerminal = (id: string) => {
    const term = getTerminal(id)?.term;
    if (!term) return '';
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i += 1) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
