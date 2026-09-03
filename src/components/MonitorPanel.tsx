import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { STORAGE } from '../state/types';
import type { CompactionRecord, DbHealth, HistorySample, Norms } from '../global';
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

  const current = chosen && chosen !== STORAGE ? analysis[chosen] : null;

  useEffect(() => {
    if (chosen && chosen !== STORAGE) refresh(chosen);
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

          {/* The other thing the app keeps, asked the same question. */}
          <button
            className={`monitor-row is-storage${chosen === STORAGE ? ' is-on' : ''}`}
            onClick={() => pick(panelId, STORAGE)}
          >
            <span className="tab-dot" style={{ background: 'var(--text-dim)' }} />
            <span className="monitor-row-name">Storage</span>
          </button>
        </aside>

        <section className="monitor-detail">
          {chosen === STORAGE && <Storage />}
          {!chosen && <p className="usage-note">Pick a session to see how it is going.</p>}
          {chosen && chosen !== STORAGE && !current && (
            <p className="usage-note">Reading its transcript…</p>
          )}
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
        {chosen && chosen !== STORAGE && (
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
      {verdict.quality && <Quality quality={verdict.quality} />}

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

      <Compactions verdict={verdict} />

      <Compared sessionId={verdict.sessionId} verdict={verdict} />

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
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [at, setAt] = useState<number | null>(null);

  // Measured rather than stretched. A viewBox scaled to fit would squash every
  // label and stroke with it, and the labels are most of what makes this a chart
  // rather than a squiggle.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const points = verdict.context.curve;
  const height = 150;
  const pad = { left: 46, right: 10, top: 12, bottom: 20 };
  const plot = { w: Math.max(0, width - pad.left - pad.right), h: height - pad.top - pad.bottom };

  const { top, xOf, yOf, path, area, marks, ticks } = useMemo(() => {
    // The window is the top of the scale whenever the session is anywhere near
    // it, so "how full" reads off the height directly. Only a session using very
    // little of it gets a scale of its own, or the line would sit flat on the
    // floor saying nothing.
    const ceiling = verdict.context.window;
    const scaleTop = verdict.context.peak > ceiling * 0.25 ? ceiling : Math.max(verdict.context.peak * 1.35, 1);
    const x = (i: number) => pad.left + (points.length < 2 ? plot.w : (i / (points.length - 1)) * plot.w);
    const y = (value: number) => pad.top + plot.h - Math.min(1, value / scaleTop) * plot.h;

    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.context).toFixed(1)}`).join(' ');
    const filled = points.length
      ? `${line} L${x(points.length - 1).toFixed(1)},${(pad.top + plot.h).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + plot.h).toFixed(1)} Z`
      : '';

    // Where the session compacted, placed on the request nearest in time. A
    // sawtooth is unreadable until you can see which drops were compactions.
    const compactions = verdict.compactions
      .map((c) => {
        if (!c.at || !points.length) return null;
        let nearest = 0;
        let best = Infinity;
        points.forEach((p, i) => {
          if (!p.at) return;
          const gap = Math.abs(p.at - c.at!);
          if (gap < best) {
            best = gap;
            nearest = i;
          }
        });
        return { x: x(nearest), trigger: c.trigger, dropped: c.droppedTokens };
      })
      .filter(Boolean) as Array<{ x: number; trigger: string; dropped: number }>;

    // Two lines worth drawing: where degradation starts, and the ceiling itself.
    const lines = [
      { value: ceiling * 0.6, label: '60%', kind: 'warn' as const },
      { value: ceiling, label: tokens(ceiling), kind: 'ceiling' as const },
    ].filter((tick) => tick.value <= scaleTop * 1.001);

    return { top: scaleTop, xOf: x, yOf: y, path: line, area: filled, marks: compactions, ticks: lines };
  }, [points, verdict.compactions, verdict.context.window, verdict.context.peak, plot.w, plot.h]);

  if (points.length < 2) return <div className="monitor-curve-box" ref={box} />;

  const hovered = at === null ? null : points[at];

  return (
    <div className="monitor-curve-box" ref={box}>
      {width > 120 && (
        <svg
          className="monitor-curve"
          width={width}
          height={height}
          onMouseLeave={() => setAt(null)}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - rect.left - pad.left) / (plot.w || 1);
            const index = Math.round(ratio * (points.length - 1));
            setAt(index >= 0 && index < points.length ? index : null);
          }}
        >
          <defs>
            <linearGradient id="monitor-fade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="monitor-fade-top" />
              <stop offset="100%" className="monitor-fade-bottom" />
            </linearGradient>
          </defs>

          {ticks.map((tick) => (
            <g key={tick.label}>
              <line
                x1={pad.left}
                y1={yOf(tick.value)}
                x2={width - pad.right}
                y2={yOf(tick.value)}
                className={`monitor-rule is-${tick.kind}`}
              />
              <text x={pad.left - 6} y={yOf(tick.value) + 3} className={`monitor-tick is-${tick.kind}`} textAnchor="end">
                {tick.label}
              </text>
            </g>
          ))}

          <path d={area} fill="url(#monitor-fade)" />
          <path d={path} className="monitor-curve-line" />

          {marks.map((mark, i) => (
            <g key={`${mark.x}-${i}`}>
              <line x1={mark.x} y1={pad.top} x2={mark.x} y2={pad.top + plot.h} className="monitor-compaction" />
              <title>
                {mark.trigger === 'auto' ? 'Compacted itself' : 'Compacted'} — {tokens(mark.dropped)} dropped
              </title>
            </g>
          ))}

          {/* Where it is now: the end of the line, called out. */}
          <circle cx={xOf(points.length - 1)} cy={yOf(points[points.length - 1].context)} r="3" className="monitor-now" />

          {hovered && (
            <g>
              <line x1={xOf(at as number)} y1={pad.top} x2={xOf(at as number)} y2={pad.top + plot.h} className="monitor-cursor" />
              <circle cx={xOf(at as number)} cy={yOf(hovered.context)} r="3.5" className="monitor-dot" />
            </g>
          )}

          {/* A day at each end when the session spans days, clock times when it
              does not — printing the same date twice tells nobody anything. */}
          <text x={pad.left} y={height - 5} className="monitor-axis">
            {when(points[0].at, verdict.spanMs)}
          </text>
          <text x={width - pad.right} y={height - 5} className="monitor-axis" textAnchor="end">
            {when(points[points.length - 1].at, verdict.spanMs) || 'now'}
          </text>
        </svg>
      )}

      <div className="monitor-curve-read">
        {hovered ? (
          <>
            <strong>{tokens(hovered.context)}</strong>
            <span>{Math.round((hovered.context / verdict.context.window) * 100)}% of the window</span>
            {hovered.at && <small>{new Date(hovered.at).toLocaleString()}</small>}
          </>
        ) : (
          <>
            <strong>{tokens(top)}</strong>
            <span>top of the scale · {points.length} requests{marks.length ? ` · ${marks.length} compaction${marks.length === 1 ? '' : 's'}` : ''}</span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * How well the session is being used, as one judgement.
 *
 * The findings below say what is wrong; this says how much it matters, which is
 * the question actually being asked. Every point off is listed beside it —
 * a score that will not account for itself is a horoscope, and nobody should act
 * on one.
 */
function Quality({ quality }: { quality: NonNullable<SessionAnalysis['quality']> }) {
  return (
    <div className={`monitor-quality is-${quality.grade}`}>
      <div className="monitor-quality-mark">
        <strong>{quality.score}</strong>
        <span>{quality.grade}</span>
      </div>
      <div className="monitor-quality-why">
        {!quality.reasons.length && <p>Nothing is being wasted here.</p>}
        {quality.reasons.map((reason) => (
          <p key={reason.label}>
            <em>−{reason.cost}</em> {reason.label}
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * What each compaction actually did.
 *
 * A compaction is the one event in a session's life that changes it rather than
 * adding to it, and a single "context now" figure hides it completely: the
 * number goes down and nothing says why, or it stays high and nothing says the
 * session already threw away half its memory to get there. Before, after, and
 * where it stands now — so the drop can be read as the event it was.
 */
function Compactions({ verdict }: { verdict: SessionAnalysis }) {
  const [kept, setKept] = useState<CompactionRecord[]>([]);

  useEffect(() => {
    let alive = true;
    window.api.analysis.history(verdict.sessionId).then((answer) => {
      if (alive) setKept(answer.compactions ?? []);
    });
    return () => {
      alive = false;
    };
  }, [verdict.sessionId, verdict.compactions.length]);

  if (!verdict.compactions.length) return null;
  const recordFor = (at: number | null) => (at ? kept.find((row) => row.at === at) ?? null : null);

  return (
    <>
      <h3 className="monitor-heading">What each compaction changed</h3>
      <div className="monitor-compactions">
        {verdict.compactions.map((entry, index) => (
          <div className={`monitor-compaction-row${entry.trigger === 'auto' ? ' is-auto' : ''}`} key={`${entry.at}-${index}`}>
            <span className="monitor-compaction-when">
              {entry.at ? new Date(entry.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}
            </span>
            <span className="monitor-compaction-move">
              <strong>{tokens(entry.preTokens)}</strong>
              <i>→</i>
              <strong>{tokens(entry.postTokens)}</strong>
            </span>
            <span className="monitor-compaction-note">
              {entry.trigger === 'auto' ? 'chose for itself' : 'you asked'}
              {entry.droppedTokens ? ` · ${tokens(entry.droppedTokens)} dropped` : ''}
              {entry.durationMs ? ` · ${duration(entry.durationMs)}` : ''}
            </span>
            <Losing record={recordFor(entry.at)} />
          </div>
        ))}
        <div className="monitor-compaction-row is-now">
          <span className="monitor-compaction-when">now</span>
          <span className="monitor-compaction-move">
            <strong>{tokens(verdict.context.last)}</strong>
          </span>
          <span className="monitor-compaction-note">
            {Math.round((verdict.context.last / verdict.context.window) * 100)}% of the window · peak was{' '}
            {tokens(verdict.context.peak)}
          </span>
        </div>
      </div>
    </>
  );
}

/**
 * What the session was in the middle of when it compacted.
 *
 * The token counts say how much was thrown away; this says what. Kept in the
 * database at the moment the compaction was first noticed, because the
 * transcript afterwards no longer remembers — which is the whole point of a
 * compaction, and the reason it has to be written down as it happens.
 */
function Losing({ record }: { record: CompactionRecord | null }) {
  if (!record || (!record.title && !record.last_prompt && !record.open_tasks.length)) return null;

  return (
    <div className="monitor-losing">
      {record.title && <span className="monitor-losing-title">It was on: {record.title}</span>}
      {record.last_prompt && <span className="monitor-losing-prompt">“{record.last_prompt}”</span>}
      {record.open_tasks.length > 0 && (
        <span className="monitor-losing-tasks">
          {record.open_tasks.length} open at the time: {record.open_tasks.slice(0, 3).map((t) => t.subject).join(' · ')}
          {record.open_tasks.length > 3 ? ` · +${record.open_tasks.length - 3}` : ''}
        </span>
      )}
    </div>
  );
}

/**
 * This session against the others, and against its own past.
 *
 * A number about one session says almost nothing on its own: 400k of context is
 * either ordinary or alarming depending on what the rest of the fleet does. The
 * comparison is to the median rather than the average, because one session that
 * ran for a week at nine hundred thousand tokens would pull an average up behind
 * it and make everything else look healthy.
 */
function Compared({ sessionId, verdict }: { sessionId: string; verdict: SessionAnalysis }) {
  const [samples, setSamples] = useState<HistorySample[]>([]);
  const [norms, setNorms] = useState<Norms | null>(null);

  useEffect(() => {
    let alive = true;
    window.api.analysis.history(sessionId).then((answer) => {
      if (!alive) return;
      setSamples(answer.samples ?? []);
      setNorms(answer.norms ?? null);
    });
    return () => {
      alive = false;
    };
  }, [sessionId, verdict.readAt]);

  if (!norms || norms.sessions < 2) return null;

  const share = verdict.context.window ? verdict.context.last / verdict.context.window : 0;
  const runs = new Set(samples.map((sample) => sample.conversation_id ?? '')).size;
  const first = samples[0];

  return (
    <>
      <h3 className="monitor-heading">Compared</h3>
      <div className="monitor-compare">
        <Against label="Context" mine={share} typical={norms.contextShare} render={(v) => `${Math.round(v * 100)}%`} />
        <Against label="Input, weighted" mine={verdict.effectiveInput} typical={norms.effectiveInput} render={tokens} />
        <Against label="Output" mine={verdict.totals.output} typical={norms.output} render={tokens} />
        <Against label="Requests" mine={verdict.requests} typical={norms.requests} render={(v) => String(Math.round(v))} />
      </div>
      <p className="usage-footnote">
        Against the middle of {norms.sessions} measured session{norms.sessions === 1 ? '' : 's'}.
        {samples.length > 1 && first
          ? ` Followed since ${new Date(first.at).toLocaleDateString()}, ${samples.length} readings kept${runs > 1 ? ` across ${runs} conversations` : ''}.`
          : ''}
      </p>
    </>
  );
}

/** One figure beside the typical one, with the gap said out loud. */
function Against({
  label,
  mine,
  typical,
  render,
}: {
  label: string;
  mine: number;
  typical: number;
  render: (value: number) => string;
}) {
  const ratio = typical > 0 ? mine / typical : 0;
  // Only a difference worth mentioning gets a word; everything within half again
  // of typical is just noise dressed up as a finding.
  const word = !typical || (ratio > 0.66 && ratio < 1.5) ? 'about typical' : ratio >= 1.5 ? `${ratio.toFixed(1)}× typical` : `${(1 / ratio).toFixed(1)}× below`;
  const tone = ratio >= 2 ? 'is-high' : ratio >= 1.5 ? 'is-warm' : 'is-ok';

  return (
    <div className="monitor-compare-row">
      <span className="monitor-compare-label">{label}</span>
      <strong>{render(mine)}</strong>
      <span className="monitor-compare-typical">vs {render(typical)}</span>
      <span className={`monitor-compare-word ${tone}`}>{word}</span>
    </div>
  );
}

/**
 * How the database is doing, and what can be done about it.
 *
 * Three readings, kept apart because they mean different things. What it weighs.
 * How much of that weight is holding nothing — deleting rows only frees pages
 * for reuse, so a database that has had a lot removed stays exactly as big, and
 * that gap is the closest thing SQLite has to going bad. And rows that outlived
 * what they belonged to.
 *
 * Every button here is asked for by name. Nothing tidies on a timer, and nothing
 * tidies because this was opened: deleting somebody's history as a side effect of
 * looking at a panel would be indefensible however old the history is.
 */
function Storage() {
  const [health, setHealth] = useState<DbHealth | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const read = (deep = false) => {
    setBusy(deep ? 'checking' : 'reading');
    window.api.analysis
      .dbHealth(deep)
      .then(setHealth)
      .finally(() => setBusy(null));
  };

  useEffect(() => {
    read(false);
    // Read once when it opens. Polling a database to watch it not change is the
    // sort of thing that makes a panel expensive to leave open.
  }, []);

  const run = async (key: string, options: Parameters<typeof window.api.analysis.dbMaintain>[0], describe: (r: { done: Array<{ op: string; rows: number }>; freed: number }) => string) => {
    setBusy(key);
    setConfirming(null);
    try {
      const result = await window.api.analysis.dbMaintain(options);
      setHealth(result.after);
      setSaid(describe(result));
    } finally {
      setBusy(null);
    }
  };

  if (!health) return <p className="usage-note">Reading the database…</p>;

  const orphans =
    health.orphans.chunks + health.orphans.stats + health.orphans.briefs + health.orphans.messages + health.orphans.history;
  const historyRows = health.tables.find((table) => table.name === 'session_history')?.rows ?? 0;
  const wastedShare = health.bytes ? Math.round((health.wasted / health.bytes) * 100) : 0;

  const ask = (key: string, label: string, detail: string, options: Parameters<typeof window.api.analysis.dbMaintain>[0], describe: (r: { done: Array<{ op: string; rows: number }>; freed: number }) => string, danger = false) =>
    confirming === key ? (
      <span className="storage-confirm">
        <em>{detail}</em>
        <button className={danger ? 'danger-btn tiny' : 'ghost-btn tiny'} onClick={() => run(key, options, describe)}>
          Yes, do it
        </button>
        <button className="ghost-btn tiny" onClick={() => setConfirming(null)}>
          No
        </button>
      </span>
    ) : (
      <button className="ghost-btn tiny" disabled={Boolean(busy)} onClick={() => setConfirming(key)}>
        {label}
      </button>
    );

  return (
    <>
      <div className="monitor-stats">
        <div className="monitor-stat">
          <span className="monitor-stat-label">On disk</span>
          <strong>{bytes(health.onDisk)}</strong>
          <small>{bytes(health.walBytes)} of it the write-ahead log</small>
        </div>
        <div className="monitor-stat">
          <span className="monitor-stat-label">Holding nothing</span>
          <strong>{bytes(health.wasted)}</strong>
          <small>{wastedShare}% of the file, {health.freePages} free pages</small>
        </div>
        <div className="monitor-stat">
          <span className="monitor-stat-label">Snapshots</span>
          <strong>{bytes(health.snapshotBytes)}</strong>
          <small>conversation copies, beside the file</small>
        </div>
        <div className="monitor-stat">
          <span className="monitor-stat-label">Sessions</span>
          <strong>{health.sessions.total}</strong>
          <small>{health.sessions.open} still open</small>
        </div>
        <div className="monitor-stat">
          <span className="monitor-stat-label">Orphaned rows</span>
          <strong>{orphans}</strong>
          <small>{orphans ? 'outlived their session' : 'nothing left behind'}</small>
        </div>
        <div className="monitor-stat">
          <span className="monitor-stat-label">Integrity</span>
          <strong>{health.integrity ?? '—'}</strong>
          <small>{health.integrity ? 'checked just now' : 'not checked yet'}</small>
        </div>
      </div>

      <h3 className="monitor-heading">What is taking the room</h3>
      <div className="monitor-tools">
        {health.tables
          .filter((table) => table.rows > 0)
          .map((table) => {
            const widest = health.tables[0]?.bytes || 1;
            return (
              <div className="monitor-tool" key={table.name}>
                <span className="monitor-tool-name">{table.name}</span>
                <span className="monitor-bar">
                  <span
                    className="monitor-bar-fill is-ok"
                    style={{ width: `${Math.round(((table.bytes ?? 0) / widest) * 100)}%` }}
                  />
                </span>
                <small>
                  {table.rows.toLocaleString()} rows{table.bytes ? ` · ${bytes(table.bytes)}` : ''}
                </small>
              </div>
            );
          })}
      </div>

      <h3 className="monitor-heading">Tidying</h3>
      {said && <p className="usage-note">{said}</p>}
      <div className="storage-actions">
        {ask(
          'orphans',
          `Clear ${orphans} orphaned row${orphans === 1 ? '' : 's'}`,
          'Rows whose session no longer exists. Nothing else refers to them.',
          { orphans: true },
          (r) => `Removed ${r.done.find((d) => d.op === 'orphans')?.rows ?? 0} rows.`,
        )}
        {ask(
          'transcripts',
          'Forget conversations older than 90 days',
          `Deletes the kept conversations of sessions that ended over 90 days ago. The record of what ran stays.`,
          { transcriptsOlderThanDays: 90 },
          (r) => `Forgot ${r.done.find((d) => d.op === 'transcripts')?.rows ?? 0} conversations.`,
        )}
        {historyRows > 0 &&
          ask(
            'history',
            'Trim readings older than a year',
            'Removes monitor readings older than a year. The sessions and their conversations stay.',
            { historyOlderThanDays: 365 },
            (r) => `Trimmed ${r.done.find((d) => d.op === 'history')?.rows ?? 0} readings.`,
          )}
        {ask(
          'sessions',
          `Delete ${health.sessions.olderThan90} session${health.sessions.olderThan90 === 1 ? '' : 's'} older than 90 days`,
          `Removes those sessions entirely — their record, conversation, messages and readings. This cannot be undone.`,
          { olderThanDays: 90 },
          (r) => `Deleted ${r.done.find((d) => d.op === 'sessions')?.rows ?? 0} sessions.`,
          true,
        )}
        <button
          className="ghost-btn tiny"
          disabled={Boolean(busy)}
          title="Rewrites the file so the empty pages are given back. Takes a few seconds."
          onClick={() => run('reclaim', { reclaim: true }, (r) => `Gave back ${bytes(r.freed)}.`)}
        >
          {busy === 'reclaim' ? 'Compacting…' : `Reclaim ${bytes(health.wasted)}`}
        </button>
        <button className="ghost-btn tiny" disabled={Boolean(busy)} onClick={() => read(true)}>
          {busy === 'checking' ? 'Checking…' : 'Check integrity'}
        </button>
      </div>
    </>
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

/** A date only when there is one; a curve can carry rows with no timestamp. */
function when(at: number | null, spanMs: number) {
  if (!at) return '';
  const stamp = new Date(at);
  return spanMs > 86400000
    ? stamp.toLocaleDateString()
    : stamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function bytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
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
