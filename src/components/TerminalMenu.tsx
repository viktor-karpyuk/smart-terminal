import { useEffect, useRef, useState } from 'react';
import { Popover } from './Popover';
import { clearTerminal, copySelection, focusTerminal, getTerminal, guardedPaste, pasteInto, selectAllIn } from '../terminals/registry';

/**
 * The right-click menu on a terminal.
 *
 * Terminals have always been copyable — ⌘C works, and so does dragging a
 * selection — but nothing on screen ever said so, and a terminal is the one
 * place in an app where people expect a right-click to offer it. This is that,
 * for every terminal at once: a session's, and the one inside a folder. They
 * are the same object underneath, so they get the same menu by construction
 * rather than by being wired up twice.
 *
 * What is offered depends on what there is. Copy appears when something is
 * selected, because a Copy that copies nothing teaches people not to trust the
 * menu; and the selection is captured when the menu opens rather than read when
 * an item is clicked, since by then the click itself may have cleared it.
 */
type Raised = { id: string; x: number; y: number; selection: string };

export function TerminalMenu() {
  const [menu, setMenu] = useState<Raised | null>(null);
  const [clipboard, setClipboard] = useState('');

  useEffect(() => {
    const onMenu = (event: Event) => {
      const detail = (event as CustomEvent<Raised>).detail;
      if (!detail?.id) return;
      setMenu(detail);
      /*
       * What is on the clipboard, asked for as the menu opens.
       *
       * So Paste can say what it would paste — and disappear when there is
       * nothing. Reading the clipboard can be refused; a refusal simply means
       * the item is not offered, which is better than offering one that fails.
       */
      navigator.clipboard
        .readText()
        .then((text) => setClipboard(text ?? ''))
        .catch(() => setClipboard(''));
    };
    window.addEventListener('terminal-menu', onMenu);
    return () => window.removeEventListener('terminal-menu', onMenu);
  }, []);

  if (!menu) return null;

  const close = () => setMenu(null);
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  return (
    <Popover anchorPoint={{ x: menu.x, y: menu.y }} onClose={close}>
      {menu.selection ? (
        <button className="menu-item" onClick={run(() => copySelection(menu.id))}>
          <span>Copy</span>
          <kbd>{lines(menu.selection)}</kbd>
        </button>
      ) : (
        <button className="menu-item" disabled>
          <span>Copy</span>
          <kbd>nothing selected</kbd>
        </button>
      )}

      {clipboard && (
        <button className="menu-item" onClick={run(() => guardedPaste(menu.id, clipboard))}>
          <span>Paste</span>
          <kbd>{lines(clipboard)}</kbd>
        </button>
      )}

      <div className="menu-separator" />

      <button className="menu-item" onClick={run(() => selectAllIn(menu.id))}>
        <span>Select all</span>
      </button>
      <button className="menu-item" onClick={run(() => clearTerminal(menu.id))}>
        <span>Clear</span>
        <kbd>keeps what is running</kbd>
      </button>
    </Popover>
  );
}

/**
 * When something a terminal tried to do for you did not work.
 *
 * There is one of these so far: an image pasted into a session, which is
 * written to a file so its path can be typed. When that succeeds the path
 * appears in the prompt and says so by being there; when it fails, nothing
 * happens at all, and nothing happening is indistinguishable from the app
 * ignoring you.
 */
export function TerminalNotice() {
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const heard = (event: Event) => {
      const text = (event as CustomEvent<{ text: string }>).detail?.text;
      if (text) setNotice(text);
    };
    window.addEventListener('terminal-notice', heard);
    return () => window.removeEventListener('terminal-notice', heard);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const going = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(going);
  }, [notice]);

  if (!notice) return null;
  return (
    <div className="terminal-notice" onClick={() => setNotice(null)} role="status">
      {notice}
    </div>
  );
}

/**
 * Asked before a paste that would run as it lands.
 *
 * A program that did not ask for bracketed paste reads every newline in a
 * paste as Return, so twelve copied lines are twelve commands run one after
 * another before anybody can look at them. Claude and zsh ask for bracketed
 * paste, so this is rare by design: it shows up over the plain shells, the
 * ssh session and the REPL — exactly where a stray line does damage.
 */
type Guarded = { id: string; text: string };

export function TerminalPasteGuard() {
  const [held, setHeld] = useState<Guarded | null>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const heard = (event: Event) => {
      const detail = (event as CustomEvent<Guarded>).detail;
      if (detail?.id && detail.text) setHeld(detail);
    };
    window.addEventListener('terminal-paste-guard', heard);
    return () => window.removeEventListener('terminal-paste-guard', heard);
  }, []);

  useEffect(() => {
    if (held) first.current?.focus();
  }, [held]);

  if (!held) return null;
  const box = getTerminal(held.id)?.host.getBoundingClientRect();
  const count = held.text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').length;
  const done = (text: string | null) => {
    const { id } = held;
    setHeld(null);
    if (text) pasteInto(id, text);
    focusTerminal(id);
  };

  return (
    <div
      className="terminal-paste-guard"
      role="alertdialog"
      aria-label="Paste several lines"
      style={box ? { top: box.top + 12, left: box.left + box.width / 2 } : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape') done(null);
      }}
    >
      <p>
        <strong>{count === 1 ? 'This paste ends in a newline.' : `Paste ${count} lines?`}</strong>{' '}
        The program here runs each line the moment it arrives.
      </p>
      <pre>{held.text.length > 400 ? `${held.text.slice(0, 400)}…` : held.text}</pre>
      <div className="terminal-paste-guard-actions">
        <button ref={first} className="ghost-btn tiny is-primary" onClick={() => done(held.text)}>
          {count === 1 ? 'Paste and run it' : `Paste and run ${count}`}
        </button>
        <button
          className="ghost-btn tiny"
          title="Joined with spaces, and nothing runs until you press Return"
          onClick={() => done(held.text.replace(/\s*[\r\n]+\s*/g, ' ').trim())}
        >
          Paste as one line
        </button>
        <button className="ghost-btn tiny" onClick={() => done(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** "3 lines" or the text itself when it is short — enough to know what it is. */
function lines(text: string) {
  const count = text.split('\n').length;
  if (count > 1) return `${count} lines`;
  return text.length > 24 ? `${text.slice(0, 22)}…` : text;
}
