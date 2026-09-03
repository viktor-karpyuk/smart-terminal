import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import type { Finding, SessionAnalysis } from '../state/types';

/**
 * The session monitor, as a section.
 *
 * Every running session is read continuously in the background; this is where
 * those readings are shown. The list on the left is the fleet at a glance —
 * which sessions are fine, which are struggling — and the right is one session in
 * full: what it has spent, how its context has grown, and the handful of things
 * worth doing about it.
 *
 * It lives in a section rather than a dialog because it is meant to be *kept*:
 * dropped beside the session it reports on, left open while the work goes on,
 * and still there after a restart. Nothing in it costs anything to look at — it
 * is all read from transcripts already on disk.
 */
export function MonitorPanel({ panelId }: { panelId: string }) {
  const chosen = useStore((s) => {
    const panel = s.panels[panelId];
    return panel?.kind === 'monitor' ? panel.sessionId : null;
  });
  const pick = useStore((s) => s.setMonitorSession);
  const analysis = useStore((s) => s.analysisBySession);
  const refresh = useStore((s) => s.refreshAnalysis);
  const showSuggestions = useStore((s) => s.settings.sessionSuggestions);

  // Ids only. `useShallow` compares the array's members, so a list of strings is
  // stable across renders while a list of freshly built row objects never is —
  // and an unstable selector here does not degrade, it takes the tree down.
  const ids = useStore(
    useShallow((s) =>
      Object.values(s.sessions)
        .filter((session) => session.kind === 'claude')
        .map((session) => session.id),
    ),
  );

  const current = chosen ? analysis[chosen] : null;

  useEffect(() => {
    if (chosen) refresh(chosen);
  }, [chosen, refresh]);

  return (
    <div className="monitor">
      <div className="monitor-body">
        <aside className="monitor-list">
          {!ids.length && <p className="usage-note">No Claude sessions running.</p>}
          {ids.map((id) => (
            <FleetRow
              key={id}
              sessionId={id}
              verdict={analysis[id] ?? null}
              selected={id === chosen}
              onPick={() => pick(panelId, id)}
            />
          ))}
        </aside>

        <section className="monitor-detail">
          {!chosen && <p className="usage-note">Pick a session to see how it is going.</p>}
          {chosen && !current && <p className="usage-note">Reading its transcript…</p>}
          {current && !current.ok && (
            <p className="usage-note">
              {current.reason === 'empty'
                ? 'Nothing written yet — a session says nothing about itself until its first turn.'
                : 'No conversation on disk for this session.'}
            </p>
          )}
          {current?.ok && <Detail verdict={current} showSuggestions={showSuggestions} />}
        </section>
      </div>

      <footer className="monitor-foot">
        <span className="usage-footnote">
          Read from the conversation Claude Code already writes to disk — no tokens, no requests.
        </span>
        {chosen && (
          <button className="ghost-btn tiny" onClick={() => refresh(chosen, true)}>
            Refresh
          </button>
        )}
      </footer>
    </div>
  );
}

function FleetRow({
  sessionId,
  verdict,
  selected,
  onPick,
}: {
  sessionId: string;
  verdict: SessionAnalysis | null;
  selected: boolean;
  onPick: () => void;
}) {
  // Each row reads its own two strings. Primitives, so a row only redraws when
  // the thing it draws has actually changed.
  const title = useStore((s) => s.sessions[sessionId]?.customTitle || s.sessions[sessionId]?.title || 'session');
  const colour = useStore((s) => {
    const owner = s.sessions[sessionId]?.profileId;
    return (owner ? s.profiles.find((p) => p.id === owner)?.color : null) ?? '#7aa2f7';
  });
  const worst = verdict?.ok ? verdict.worst : null;
  const share = verdict?.ok && verdict.context.window ? verdict.context.last / verdict.context.window : 0;

  return (
    <button className={`monitor-row${selected ? ' is-on' : ''}`} onClick={onPick}>
      <span className="tab-dot" style={{ background: colour }} />
      <span className="monitor-row-name">{title}</span>
      {verdict?.ok ? (
        <>
          <ContextBar share={share} />
          <span className={`monitor-pip is-${worst ?? 'clear'}`} title={worst ? `${worst} priority` : 'Nothing to report'} />
        </>
      ) : (
        <span className="monitor-row-quiet">—</span>
      )}
    </button>
  );
}

/** How full the window is, as the one number that predicts everything else. */
function ContextBar({ share }: { share: number }) {
  const pct = Math.min(100, Math.round(share * 100));
  const tone = pct >= 80 ? 'is-high' : pct >= 60 ? 'is-warm' : 'is-ok';
  return (
    <span className="monitor-bar" title={`${pct}% of the context window`}>
      <span className={`monitor-bar-fill ${tone}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

function Detail({ verdict, showSuggestions }: { verdict: SessionAnalysis; showSuggestions: boolean }) {
  const auto = verdict.compactions.filter((c) => c.trigger === 'auto').length;
  const heaviest = verdict.tools[0];

  const stats = useMemo(
    () => [
      { label: 'Context now', value: tokens(verdict.context.last), note: `${Math.round((verdict.context.last / verdict.context.window) * 100)}% of ${tokens(verdict.context.window)}` },
      { label: 'Peak', value: tokens(verdict.context.peak), note: `${verdict.requests} requests` },
      { label: 'Input, weighted', value: tokens(verdict.effectiveInput), note: 'cache priced in' },
      { label: 'Output', value: tokens(verdict.totals.output), note: 'tokens written' },
      { label: 'Typical turn', value: duration(verdict.latency.p50), note: `slowest ${duration(verdict.latency.p95)}` },
      { label: 'Compactions', value: String(verdict.compactions.length), note: auto ? `${auto} automatic` : 'none automatic' },
      ...(verdict.projection
        ? [
            {
              label: 'Room left',
              value: `${verdict.projection.requests} req`,
              note: verdict.projection.ms
                ? `~${duration(verdict.projection.ms)} at this pace`
                : `+${tokens(verdict.projection.perRequest)} a request`,
            },
          ]
        : []),
    ],
    [verdict, auto],
  );

  return (
    <>
      <div className="monitor-stats">
        {stats.map((stat) => (
          <div className="monitor-stat" key={stat.label}>
            <span className="monitor-stat-label">{stat.label}</span>
            <strong>{stat.value}</strong>
            <small>{stat.note}</small>
          </div>
        ))}
      </div>

      <Curve verdict={verdict} />

      <h3 className="monitor-heading">
        {verdict.findings.length ? 'What stands out' : 'Nothing stands out'}
      </h3>
      {!verdict.findings.length && (
        <p className="usage-note">This session is working within its means.</p>
      )}
      {verdict.findings.map((finding) => (
        <FindingRow key={finding.id} finding={finding} showSuggestion={showSuggestions} />
      ))}

      <Advisor sessionId={verdict.sessionId} />

      {heaviest && heaviest.calls > 0 && (
        <>
          <h3 className="monitor-heading">Where the context went</h3>
          <div className="monitor-tools">
            {verdict.tools.slice(0, 6).map((tool) => (
              <div className="monitor-tool" key={tool.name}>
                <span className="monitor-tool-name">{tool.name}</span>
                <span className="monitor-bar">
                  <span
                    className="monitor-bar-fill is-ok"
                    style={{ width: `${Math.round((tool.bytes / (heaviest.bytes || 1)) * 100)}%` }}
                  />
                </span>
                <small>
                  {tool.calls} {tool.calls === 1 ? 'call' : 'calls'} · {tokens(tool.tokens)}
                  {tool.fails ? ` · ${tool.fails} failed` : ''}
                </small>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/**
 * The context curve.
 *
 * A drawn line rather than a number because the shape is the diagnosis: a climb
 * that flattens is a session with its size under control, a sawtooth is one
 * compacting over and over, and a straight run into the ceiling is the one worth
 * doing something about.
 */
function Curve({ verdict }: { verdict: SessionAnalysis }) {
  const points = verdict.context.curve;
  if (points.length < 2) return null;

  const width = 100;
  const height = 34;
  const top = Math.max(verdict.context.peak, verdict.context.window * 0.25);
  const path = points
    .map((point, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - (point.context / top) * height;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const ceiling = height - (verdict.context.window / top) * height;

  return (
    <svg className="monitor-curve" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden>
      {ceiling > 0 && <line x1="0" y1={ceiling} x2={width} y2={ceiling} className="monitor-curve-ceiling" />}
      <path d={`${path} L${width},${height} L0,${height} Z`} className="monitor-curve-fill" />
      <path d={path} className="monitor-curve-line" />
    </svg>
  );
}

/**
 * The second opinion.
 *
 * Separated from everything above it because it is the only part that costs
 * anything: one short request, on the account chosen in settings, and only when
 * this button is pressed. What it is given is the measurements and nothing else —
 * no transcript, no files, no commands.
 */
function Advisor({ sessionId }: { sessionId: string }) {
  const advice = useStore((s) => s.adviceBySession[sessionId] ?? null);
  const asking = useStore((s) => Boolean(s.adviceAsking[sessionId]));
  const ask = useStore((s) => s.askAdvisor);
  const tell = useStore((s) => s.tellSession);
  const [told, setTold] = useState(false);

  return (
    <>
      <h3 className="monitor-heading">A second opinion</h3>
      <div className="monitor-advice">
        {!advice && !asking && (
          <p className="usage-note">
            The figures above are free. This asks a model what to make of them — one short request,
            given the measurements only.
          </p>
        )}
        {asking && <p className="usage-note">Asking…</p>}
        {advice && !advice.ok && <p className="usage-note">{advice.error}</p>}
        {advice?.ok && advice.text && (
          <>
            <p className="monitor-advice-text">{advice.text}</p>
            <small className="usage-footnote">
              {advice.account ? `Read on ${advice.account}` : 'Read'}
              {advice.at ? ` · ${new Date(advice.at).toLocaleTimeString()}` : ''}
            </small>
          </>
        )}
        <div className="monitor-advice-actions">
          <button className="ghost-btn tiny" disabled={asking} onClick={() => ask(sessionId, { force: Boolean(advice) })}>
            {advice ? 'Ask again' : 'Ask'}
          </button>
          {advice?.ok && advice.text && (
            <button
              className="ghost-btn tiny"
              disabled={told}
              title="Put this into the session itself, once it is waiting at its prompt"
              onClick={() => {
                tell(sessionId, advice.text as string);
                setTold(true);
              }}
            >
              {told ? 'Sent to the session' : 'Tell the session'}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function FindingRow({ finding, showSuggestion }: { finding: Finding; showSuggestion: boolean }) {
  return (
    <div className={`monitor-finding is-${finding.severity}`}>
      <header>
        <span className={`monitor-pip is-${finding.severity}`} />
        <strong>{finding.title}</strong>
      </header>
      <p>{finding.detail}</p>
      {showSuggestion && <p className="monitor-suggestion">{finding.suggestion}</p>}
    </div>
  );
}

function tokens(value: number) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(value < 10000000 ? 1 : 0)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}

function duration(ms: number) {
  if (!ms) return '—';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}
