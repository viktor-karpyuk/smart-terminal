import { useEffect } from 'react';
import { useStore } from '../state/store';

/** Re-read the limits now and then; the CLI call is local, so this costs nothing. */
const REFRESH_EVERY = 10 * 60 * 1000;

/**
 * The account's ceilings, in the title bar where there is room for them. Seeing
 * the week creep towards full is the difference between planning a handoff and
 * being interrupted by one.
 */
export function UsageGauge({ profileId }: { profileId: string | undefined }) {
  const report = useStore((s) => (profileId ? s.usageByProfile[profileId] : undefined));
  // Standing on its own in the middle of the title bar, it has to say whose
  // limits these are — beside the account chip that was obvious, and here it
  // is not.
  const account = useStore((s) => s.profiles.find((p) => p.id === profileId)?.name ?? 'this account');
  const loading = useStore((s) => (profileId ? s.usageLoading[profileId] : false));
  const signedIn = useStore((s) => (profileId ? s.authByProfile[profileId]?.loggedIn : false));
  const refreshUsage = useStore((s) => s.refreshUsage);
  const openPanel = useStore((s) => s.setUsagePanelOpen);

  useEffect(() => {
    if (!profileId || !signedIn) return;
    refreshUsage(profileId);
    const timer = window.setInterval(() => refreshUsage(profileId, true), REFRESH_EVERY);
    return () => window.clearInterval(timer);
  }, [profileId, signedIn, refreshUsage]);

  if (!profileId) return null;
  // An account that reads as signed out still gets the placeholder. Rendering
  // nothing is what let a broken reading look like a feature that was never
  // there: when the CLI could not be found, the gauge and the panel both went
  // silently blank with nowhere to see why. The button opens the panel, which
  // says what happened.
  if (!signedIn || !report?.ok) {
    return (
      <button
        className="gauge gauge-empty"
        onClick={() => openPanel(true)}
        title={
          signedIn
            ? `${account} — open usage limits (⌘U)`
            : `${account} reads as signed out — open for details`
        }
      >
        {loading ? 'reading usage…' : 'usage —'}
      </button>
    );
  }

  return (
    <button className="gauge" onClick={() => openPanel(true)} title={`${account} — open usage limits (⌘U)`}>
      {report.session && <Pill label="session" percent={report.session.percentUsed} />}
      {report.week && <Pill label="week" percent={report.week.percentUsed} />}
    </button>
  );
}

function Pill({ label, percent }: { label: string; percent: number }) {
  const level = percent >= 90 ? 'critical' : percent >= 70 ? 'warn' : 'ok';
  return (
    <span className="gauge-pill">
      <span className="gauge-label">{label}</span>
      <span className="gauge-track">
        <span className={`gauge-fill is-${level}`} style={{ width: `${Math.min(100, percent)}%` }} />
      </span>
      <span className={`gauge-value is-${level}`}>{percent}%</span>
    </span>
  );
}
