import { useStore } from '../state/store';
import type { UsageReport } from '../global';

/**
 * Plan limits per account: how much of the weekly allowance and of the current
 * session window is gone, and when each resets.
 */
export function UsagePanel() {
  const profiles = useStore((s) => s.profiles);
  const usageByProfile = useStore((s) => s.usageByProfile);
  const usageLoading = useStore((s) => s.usageLoading);
  const authByProfile = useStore((s) => s.authByProfile);
  const refreshUsage = useStore((s) => s.refreshUsage);
  const close = () => useStore.getState().setUsagePanelOpen(false);

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal modal-narrow" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2>Usage limits</h2>
          <button className="ghost-btn tiny" onClick={close}>
            &times;
          </button>
        </header>

        <div className="usage-body">
          {profiles.map((profile) => {
            const report = usageByProfile[profile.id];
            const loading = usageLoading[profile.id];
            const signedIn = authByProfile[profile.id]?.loggedIn;

            return (
              <section className="usage-account" key={profile.id}>
                <header className="usage-account-header">
                  <span className="tab-dot" style={{ background: profile.color }} />
                  <span style={{ color: profile.color }}>{profile.name}</span>
                  <small>{authByProfile[profile.id]?.email ?? ''}</small>
                  <button
                    className="ghost-btn tiny"
                    disabled={loading || !signedIn}
                    onClick={() => refreshUsage(profile.id, true)}
                  >
                    {loading ? 'Reading…' : 'Refresh'}
                  </button>
                </header>

                {!signedIn && <p className="usage-note">Not signed in.</p>}
                {signedIn && !report && !loading && (
                  <p className="usage-note">Not read yet — Refresh asks this account.</p>
                )}
                {signedIn && loading && !report && (
                  <p className="usage-note">Asking the CLI…</p>
                )}
                {report && <UsageBody report={report} />}
              </section>
            );
          })}

          <p className="usage-footnote">
            Read with <code>claude -p /usage</code> — a local command, so it spends no tokens and
            no API turn, and can be asked as often as you like.
          </p>
        </div>
      </div>
    </div>
  );
}

function UsageBody({ report }: { report: UsageReport }) {
  if (!report.ok) {
    return (
      <div className="usage-error">
        <div className="usage-error-head">
          <strong>Could not read the limits.</strong>
          <button
            className="ghost-btn tiny"
            onClick={() => navigator.clipboard.writeText(report.error ?? '')}
          >
            Copy
          </button>
        </div>
        <pre className="usage-error-text">{report.error}</pre>
      </div>
    );
  }

  return (
    <div className="usage-bars">
      {report.session && <Meter label="Current session" {...report.session} />}
      {report.week && <Meter label="This week, all models" {...report.week} />}
      {(report.perModel ?? []).map((entry) => (
        <Meter key={entry.model} label={`This week, ${entry.model}`} {...entry} />
      ))}
      {(report.windows ?? []).map((window) => (
        <details className="usage-window" key={window.label}>
          <summary>
            {window.label} <span>{window.summary}</span>
          </summary>
          {window.behaviours.map((entry) => (
            <p key={entry.what}>
              <b>{entry.percent}%</b> of usage {entry.what}
            </p>
          ))}
          {window.extras.map((extra) => (
            <p key={extra}>{extra}</p>
          ))}
        </details>
      ))}
      <p className="usage-note usage-stamp">Read {new Date(report.readAt).toLocaleTimeString()}</p>
    </div>
  );
}

function Meter({
  label,
  percentUsed,
  resets,
}: {
  label: string;
  percentUsed: number;
  resets: string | null;
}) {
  const level = percentUsed >= 90 ? 'critical' : percentUsed >= 70 ? 'warn' : 'ok';
  return (
    <div className="meter">
      <div className="meter-top">
        <span>{label}</span>
        <strong>{percentUsed}%</strong>
      </div>
      <div className="meter-track">
        <div className={`meter-fill is-${level}`} style={{ width: `${Math.min(100, percentUsed)}%` }} />
      </div>
      {resets && <small>Resets {resets}</small>}
    </div>
  );
}

