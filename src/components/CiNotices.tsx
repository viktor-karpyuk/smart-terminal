import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { Popover } from './Popover';
import { agoShort, ciTone } from '../lib/jenkinsTree';

/** How long a notice stays on screen by itself; after that it waits in the title bar's list. */
const TOAST_MS = 12_000;
const BLOCKED_KEY = 'smart-terminal.osNotificationsBlocked.dismissed';

/**
 * What CI has to say, on screen where nobody's permission is needed.
 *
 * The system's own notifications can be refused — an app without a real Apple
 * signature is refused every one, with no message — so the same words arrive
 * here too: a card in the corner for a few seconds, and a line in the title
 * bar's list until somebody looks. Clicking one goes to what it was about.
 */
export function CiToasts() {
  const notices = useStore((s) => s.ciNotices);
  const blocked = useStore((s) => s.osNotificationsBlocked);
  const readCiNotice = useStore((s) => s.readCiNotice);
  const openJenkinsAt = useStore((s) => s.openJenkinsAt);
  const [ticks, tick] = useState(0);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(BLOCKED_KEY) === '1';
    } catch {
      return false;
    }
  });

  const now = Date.now();
  const fresh = notices.filter((one) => !one.read && now - one.at < TOAST_MS).slice(0, 4);

  // Woken when the oldest card is due to go, and not before: nothing runs while nothing is showing.
  useEffect(() => {
    if (!fresh.length) return;
    const due = Math.min(...fresh.map((one) => one.at + TOAST_MS)) - Date.now();
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(50, due));
    return () => clearTimeout(timer);
    // `ticks` is here so the next card's timer is set once this one has fired: with only `notices` the second of two cards stayed up for ever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notices, ticks]);

  // The system's own refusal is a macOS thing: the words about an Apple signature mean nothing anywhere else.
  const showBlocked = blocked && !dismissed && window.api.platform === 'darwin';

  // Always mounted, even empty: a live region that appears together with its text is often not announced.
  return (
    <div className="ci-toasts" role="status" aria-live="polite">
      {showBlocked && (
        <div className="ci-toast is-plain" role="alert">
          <div className="ci-toast-main">
            <strong>macOS is blocking notifications from Smart Terminal</strong>
            <span>
              It does that to apps that are not signed with an Apple Developer ID, and says nothing. CI alerts still
              arrive here, in the title bar and as a number on the dock.
            </span>
          </div>
          <button
            className="ci-toast-close"
            aria-label="Dismiss"
            onClick={() => {
              setDismissed(true);
              try {
                localStorage.setItem(BLOCKED_KEY, '1');
              } catch {
                /* it comes back next time; that is all */
              }
            }}
          >
            ×
          </button>
        </div>
      )}
      {fresh.map((notice) => (
        <div key={notice.id} className={`ci-toast is-${ciTone(notice)}`}>
          <button
            className="ci-toast-main"
            onClick={() => {
              readCiNotice(notice.id);
              if (notice.place) openJenkinsAt(notice.place);
            }}
            title={notice.place ? 'Open it' : undefined}
          >
            <strong>{notice.title}</strong>
            {notice.body && <span>{notice.body}</span>}
          </button>
          <button className="ci-toast-close" aria-label="Dismiss" onClick={() => readCiNotice(notice.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The title bar's bell: how many things CI said that nobody has looked at, and
 * the list of them. It is also what the dock's number counts.
 */
export function CiBell() {
  const notices = useStore((s) => s.ciNotices);
  const readCiNotice = useStore((s) => s.readCiNotice);
  const readAll = useStore((s) => s.readAllCiNotices);
  const clear = useStore((s) => s.clearCiNotices);
  const openJenkinsAt = useStore((s) => s.openJenkinsAt);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const unread = notices.filter((one) => !one.read).length;

  // Nothing said yet: nothing to show. The bell appears with the first thing and stays until the list is cleared.
  if (!notices.length) return null;
  const now = Date.now();

  return (
    <>
      <button
        ref={button}
        className={`icon-btn ci-bell${unread ? ' has-unread' : ''}`}
        title={unread ? `${unread} from CI waiting for you` : 'What CI said'}
        aria-label={unread ? `CI: ${unread} unread` : 'CI notices'}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((on) => !on)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9a6 6 0 0 1 12 0c0 6 2 7.5 2 7.5H4S6 15 6 9z" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
        {unread > 0 && <span className="ci-bell-count">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <Popover anchorEl={button.current} onClose={() => setOpen(false)}>
          <div className="ci-inbox">
            <div className="ci-inbox-head">
              <span>CI</span>
              <span className="ci-inbox-actions">
                <button onClick={readAll} disabled={!unread}>Mark all read</button>
                <button onClick={() => { clear(); setOpen(false); }}>Clear</button>
              </span>
            </div>
            <div className="ci-inbox-list">
              {notices.map((notice) => (
                <button
                  key={notice.id}
                  className={`ci-inbox-row is-${ciTone(notice)}${notice.read ? ' is-read' : ''}`}
                  onClick={() => {
                    readCiNotice(notice.id);
                    setOpen(false);
                    if (notice.place) openJenkinsAt(notice.place);
                  }}
                >
                  <span className="ci-inbox-dot" />
                  <span className="ci-inbox-text">
                    <strong>{notice.title}</strong>
                    {notice.body && <span>{notice.body}</span>}
                  </span>
                  <span className="ci-inbox-when">{agoShort(notice.at, now)}</span>
                </button>
              ))}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}
