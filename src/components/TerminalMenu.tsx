import { useEffect, useState } from 'react';
import { Popover } from './Popover';
import { clearTerminal, copySelection, pasteInto, selectAllIn } from '../terminals/registry';

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
        <button className="menu-item" onClick={run(() => pasteInto(menu.id, clipboard))}>
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

/** "3 lines" or the text itself when it is short — enough to know what it is. */
function lines(text: string) {
  const count = text.split('\n').length;
  if (count > 1) return `${count} lines`;
  return text.length > 24 ? `${text.slice(0, 22)}…` : text;
}
