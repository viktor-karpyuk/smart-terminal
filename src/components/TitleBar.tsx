import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { allTabs } from '../state/layout';
import { SplitRightIcon, SplitDownIcon, EvenSplitsIcon, MaximizeIcon } from './icons';
import { UsageGauge } from './UsageGauge';
import { CiBell } from './CiNotices';
import { legible } from '../lib/looks';

export function TitleBar() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const splitActive = useStore((s) => s.splitActive);
  const evenSplits = useStore((s) => s.evenSplits);
  const toggleZoom = useStore((s) => s.toggleZoom);
  const zoomed = useStore((s) => s.zoomedLeafId);
  const profiles = useStore((s) => s.profiles);
  const authByProfile = useStore((s) => s.authByProfile);
  // Selecting the session object itself keeps this stable, so dragging a divider
  // or another pane streaming output no longer re-renders the title bar.
  const activeSession = useStore((s) => {
    const leaf = findLeafShallow(s.layout, s.activeLeafId);
    return leaf?.active ? (s.sessions[leaf.active] ?? null) : null;
  });
  const activeProfile = profiles.find((p) => p.id === activeSession?.profileId);
  /*
   * The limits belong to an account, not to whichever tab is in front — and with
   * a folder or a Git view in front there is no session to ask. Falling back to
   * the default account keeps the gauge where it is instead of blinking out
   * every time you look at a file.
   */
  const gaugeProfile =
    activeProfile ??
    profiles.find((p) => p.id === settings.defaultProfileId) ??
    profiles[0];

  return (
    <header className="titlebar">
      <div className="titlebar-drag">
        {/*
          The way back to the sidebar, and nothing else. It said "Sessions" when
          the sidebar held only sessions; it holds folders too now, and a menu
          button that names one of the things behind it is worse than one that
          names none.
        */}
        {!settings.sidebarVisible && (
          <button
            className="icon-btn show-sidebar"
            title="Show the sidebar (⌘B)"
            aria-label="Show the sidebar"
            onClick={() => updateSettings({ sidebarVisible: true })}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2 3.5h10M2 7h10M2 10.5h10" />
            </svg>
          </button>
        )}
        <AppMark />
        {activeProfile && (
          <span
            className="titlebar-chip"
            style={{ borderColor: legible(activeProfile.color), color: legible(activeProfile.color) }}
            title={
              authByProfile[activeProfile.id]?.loggedIn
                ? `Signed in as ${authByProfile[activeProfile.id].email}`
                : 'Not signed in'
            }
          >
            {activeProfile.name}
            {authByProfile[activeProfile.id]?.email && (
              <em className="titlebar-chip-email">{authByProfile[activeProfile.id].email}</em>
            )}
          </span>
        )}
        <WaitingOnYou />
      </div>

      {/*
        The middle of the window, centred on the window itself rather than on
        whatever happens to be to its left. It is the one thing here you look at
        rather than press, and the middle is where the eye goes.
      */}
      <div className="titlebar-centre">
        {gaugeProfile && <UsageGauge profileId={gaugeProfile.id} />}
        <SystemVitals />
      </div>

      <div className="titlebar-actions">
        <UpdateNotice />
        <HousekeepingButton />
        <CiBell />
        <button className="icon-btn" title="Split right (⌘D)" aria-label="Split right" onClick={() => splitActive('row')}>
          <SplitRightIcon />
        </button>
        <button className="icon-btn" title="Split down (⇧⌘D)" aria-label="Split down" onClick={() => splitActive('column')}>
          <SplitDownIcon />
        </button>
        <button className="icon-btn" title="Even out splits (⌥⌘0)" aria-label="Even out splits" onClick={evenSplits}>
          <EvenSplitsIcon />
        </button>
        <button
          className={`icon-btn${zoomed ? ' is-on' : ''}`}
          title="Maximize pane (⌥⌘⏎)"
          aria-label="Maximize pane"
          onClick={toggleZoom}
        >
          <MaximizeIcon restore={Boolean(zoomed)} />
        </button>
      </div>
    </header>
  );
}

/**
 * A newer version, said where it is always seen.
 *
 * The build line at the foot of the sidebar said it too, and still does — but
 * it is out of sight with the sidebar closed, and easy to miss with it open.
 * Only when looking for updates on its own is switched on: that switch is
 * somebody asking to be told.
 */
function UpdateNotice() {
  const update = useStore((s) => s.update);
  const openUpdates = useStore((s) => s.setUpdatePanelOpen);
  if (!update?.auto || !update.release) return null;
  if (update.phase !== 'available' && update.phase !== 'downloading' && update.phase !== 'ready') return null;
  const version = update.release.version;
  const label =
    update.phase === 'downloading'
      ? `Downloading ${version}…`
      : update.phase === 'ready'
        ? `${version} ready to install`
        : `${version} available`;
  return (
    <button
      className="titlebar-update"
      title={`Smart Terminal ${version} is out — you are running ${update.current.version}.${String.fromCharCode(10)}Click to see what is in it.`}
      onClick={() => openUpdates(true)}
    >
      <span className="build-update-dot" />
      {label}
    </button>
  );
}

/**
 * What this app is and which build of it you are running, where the window's
 * name goes anyway.
 *
 * The build number is the useful half: "is the fix even installed?" comes up
 * constantly while iterating, and it should be answerable without opening a
 * panel. The description is there for anyone meeting the app for the first
 * time, and gets out of the way as the window narrows.
 */
function AppMark() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof window.api.version>> | null>(null);

  useEffect(() => {
    window.api.version().then(setInfo);
  }, []);

  const built = info?.builtAt ? new Date(info.builtAt) : null;
  return (
    <span
      className="app-mark"
      title={
        info
          ? `Smart Terminal ${info.version} · build ${info.build}\nBuilt ${built?.toLocaleString() ?? '—'}` +
            '\n\nA workbench for running many Claude Code sessions at once,\neach on its own account, beside the files they are working on.'
          : 'Smart Terminal'
      }
    >
      {/* The name alone. The build is at the foot of the sidebar and in this
          tooltip; saying it twice in the chrome was saying it once too often. */}
      <span className="app-name">Smart Terminal</span>
    </span>
  );
}

function findLeafShallow(node: import('../state/types').LayoutNode, id: string): import('../state/types').LeafNode | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  for (const child of node.children) {
    const found = findLeafShallow(child, id);
    if (found) return found;
  }
  return null;
}

/**
 * Decisions are what actually halt a run, so they are worth counting in one place.
 * One session stopped on a question is easy to miss; three of them piled up is the
 * moment to go and clear them.
 */
function WaitingOnYou() {
  const waiting = useStore(
    useShallow((s) =>
      allTabs(s.layout).filter((id) => s.sessions[id]?.autopilotState === 'waiting-for-you'),
    ),
  );
  const focusSession = useStore((s) => s.focusSession);
  if (!waiting.length) return null;

  return (
    <button
      className="titlebar-waiting"
      title="Sessions running on their own that have stopped on a question"
      onClick={() => focusSession(waiting[0])}
    >
      {waiting.length} waiting on you
    </button>
  );
}

/**
 * Housekeeping, from the window's own bar: the system menu bar belongs to
 * whichever app is in front, and a person with two copies open was looking at
 * the wrong one. The dot is the health job's status, the same as the sidebar's.
 */
function HousekeepingButton() {
  const status = useStore((s) => s.housekeepingStatus);
  const open = useStore((s) => s.openHousekeeping);
  const title =
    status === 'limit'
      ? 'Housekeeping: something is at a limit (⇧⌘H)'
      : status === 'attention'
        ? 'Housekeeping: something needs attention (⇧⌘H)'
        : 'Housekeeping: what is on disk, and how the machine is doing (⇧⌘H)';
  return (
    <button className={`icon-btn housekeeping-dot is-${status}`} title={title} aria-label="Housekeeping" onClick={() => open()}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
        <path d="M3 3.5h8M4 3.5l.7 8h4.6l.7-8M5.8 3.5V2.2h2.4v1.3" />
      </svg>
    </button>
  );
}

/**
 * The machine, in the title bar: memory used, swap, disk free, sessions. The
 * health job reads them every minute; the colour is its verdict. Clicking
 * opens Housekeeping on Health, where the numbers are explained.
 */
function SystemVitals() {
  const vitals = useStore((s) => s.housekeepingVitals);
  const status = useStore((s) => s.housekeepingStatus);
  const open = useStore((s) => s.openHousekeeping);
  if (!vitals) return null;
  const gb = (n: number | null) => (n === null ? '—' : n >= 100 * 1024 ** 3 ? `${Math.round(n / 1024 ** 3)} GB` : `${(n / 1024 ** 3).toFixed(1)} GB`);
  const level = (value: number | null, warn: number, bad: number, below = false) => {
    if (value === null) return '';
    const worse = below ? value < bad : value > bad;
    const warnish = below ? value < warn : value > warn;
    return worse ? ' is-limit' : warnish ? ' is-attention' : '';
  };
  return (
    <button
      className={`titlebar-vitals is-${status}`}
      onClick={() => open('health')}
      title={[
        `Memory ${vitals.memUsedPct ?? '—'}% used, ${gb(vitals.memFree)} free`,
        `Swap ${vitals.swapPct ?? '—'}% used${vitals.pageouts ? `, ${vitals.pageouts} pages/min out` : ''}`,
        `Disk ${gb(vitals.diskFree)} free${vitals.diskFreePct !== null ? ` (${vitals.diskFreePct}%)` : ''}`,
        `Load ${vitals.load ?? '—'} per core`,
        `${vitals.sessions ?? 0} sessions open`,
        'Click for Housekeeping › Health',
      ].join('\n')}
      aria-label="System vitals"
    >
      <span className={`titlebar-vital${level(vitals.memUsedPct, 85, 93)}`}>
        <small>MEM</small> {vitals.memUsedPct ?? '—'}%
      </span>
      <span className={`titlebar-vital${level(vitals.swapPct, 50, 80)}`}>
        <small>SWAP</small> {vitals.swapPct ?? '—'}%
      </span>
      <span className={`titlebar-vital${level(vitals.diskFreePct, 15, 8, true)}`}>
        <small>DISK</small> {gb(vitals.diskFree)}
      </span>
      <span className={`titlebar-vital${level(vitals.load, 1, 2)}`}>
        <small>LOAD</small> {vitals.load ?? '—'}
      </span>
      {(vitals.todayFreed > 0 || (vitals.todayConsumed ?? 0) > 0) && (
        <span
          className={`titlebar-vital titlebar-today${vitals.todayUsedDelta !== null && vitals.todayUsedDelta < 0 ? ' is-good' : vitals.todayUsedDelta !== null && vitals.todayUsedDelta > 0 ? ' is-warm' : ''}`}
          title={`Today: ${gb(vitals.todayFreed)} freed by housekeeping, ${vitals.todayConsumed === null ? '—' : gb(vitals.todayConsumed)} consumed; used space ${vitals.todayUsedDelta === null ? 'not measured yet' : `${vitals.todayUsedDelta >= 0 ? 'up' : 'down'} ${gb(Math.abs(vitals.todayUsedDelta))}`}${vitals.todayUsedPct !== null ? ` (${vitals.todayUsedPct > 0 ? '+' : ''}${vitals.todayUsedPct}%)` : ''}`}
        >
          <small>TODAY</small> −{gb(vitals.todayFreed)} / +{vitals.todayConsumed === null ? '—' : gb(vitals.todayConsumed)}
          {vitals.todayUsedPct !== null ? ` · ${vitals.todayUsedPct > 0 ? '+' : ''}${vitals.todayUsedPct}%` : ''}
        </span>
      )}
    </button>
  );
}
