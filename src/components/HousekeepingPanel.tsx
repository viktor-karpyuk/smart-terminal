import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useStore } from '../state/store';
import { describeIdle, diskUsedPercent, filterSessions, filterWorktrees, formatBytes, freeable, idleDays, inBucket, weigh, withSize, type HousekeepingTab } from '../lib/housekeeping';

/**
 * What Smart Terminal and the work around it leave on disk, and giving it back.
 *
 * One list of removable things in three buckets — sessions, worktrees, the app's
 * own folders — with the numbers at the top and the actions at the bottom of
 * each. Two kinds of action, kept apart on purpose. "Free now" takes what comes
 * back by itself: caches a build rewrites, installers already applied, copies
 * of an installation long replaced. Everything else is the only copy of
 * something, is listed row by row, and is confirmed before it goes.
 *
 * Sizes arrive in two steps. The inventory answers at once with what was
 * measured before; the folders it does not know are walked on a worker thread
 * and each row fills in as its number lands.
 */

type Tab = HousekeepingTab;

const TABS: { id: Tab; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'worktrees', label: 'Worktrees' },
  { id: 'app', label: 'App' },
  { id: 'health', label: 'Health' },
  { id: 'log', label: 'Log' },
];



const KIND_LABEL: Record<HousekeepingKind, string> = {
  session: 'session',
  'build-cache': 'build cache',
  worktree: 'worktree',
  workshop: 'review clone',
  'db-backup': 'database backup',
  'install-backup': 'previous installation',
  installer: 'downloaded update',
  pasted: 'pasted images',
  'browser-cache': 'browser cache',
  trash: 'removal in progress',
};

export function HousekeepingPanel() {
  const [inventory, setInventory] = useState<HousekeepingInventory | null>(null);
  const [items, setItems] = useState<HousekeepingItem[]>([]);
  const [tab, setTab] = useState<Tab>('sessions');
  const [busy, setBusy] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(0);
  const [said, setSaidRaw] = useState<string | null>(null);
  const saidTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A short line that goes away by itself: the panel is not a log, the Log tab is. */
  const setSaid = (text: string | null) => {
    setSaidRaw(text);
    if (saidTimer.current) clearTimeout(saidTimer.current);
    if (text) saidTimer.current = setTimeout(() => alive.current && setSaidRaw(null), 7000);
  };
  const [error, setError] = useState<string | null>(null);
  /** What a button is about to do, shown as a modal that lists every item before anything goes. */
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [olderThan, setOlderThan] = useState(30);
  const [minMb, setMinMb] = useState(0);
  const [includeOpen, setIncludeOpen] = useState(false);
  const [health, setHealth] = useState<HousekeepingHealth | null>(null);
  const [plan, setPlan] = useState<HousekeepingProposal[]>([]);
  const [stats, setStats] = useState<HousekeepingStats | null>(null);
  const [progress, setProgress] = useState<HousekeepingProgress | null>(null);
  const [jobs, setJobs] = useState<HousekeepingJob[]>([]);
  const [stale, setStale] = useState(false);
  const alive = useRef(true);
  // A menu entry or a notification named a tab: go there, on mount and whenever it changes.
  const wantedTab = useStore((s) => s.housekeepingTab);
  useEffect(() => {
    if (!wantedTab) return;
    setTab(wantedTab);
    useStore.getState().clearHousekeepingTab();
  }, [wantedTab]);

  const refreshPlan = () => {
    window.api.housekeeping
      .advice()
      .then((p) => alive.current && setPlan(p))
      .catch(() => {});
    window.api.housekeeping
      .stats(30)
      .then((s) => alive.current && setStats(s))
      .catch(() => {});
  };

  const load = async ({ measure = true } = {}) => {
    setBusy('reading');
    setError(null);
    try {
      // The last inventory kept opens the panel at once; the fresh one replaces it when it lands.
      if (!inventory) {
        const kept = await window.api.housekeeping.snapshot().catch(() => null);
        if (kept && alive.current) {
          setInventory({ ...kept, unsized: [], roots: Array.isArray(kept.roots) ? kept.roots : [], checkouts: kept.checkouts ?? 0, log: Array.isArray(kept.log) ? kept.log : [] } as HousekeepingInventory);
          setItems(kept.items);
          setStale(true);
        }
      }
      const next = await window.api.housekeeping.inventory();
      if (!alive.current) return;
      setStale(false);
      setInventory(next);
      setItems(next.items);
      refreshPlan();
      setSelected((prev) => new Set([...prev].filter((id) => next.items.some((one) => one.id === id))));
      if (measure && next.unsized.length) {
        setMeasuring(next.unsized.length);
        window.api.housekeeping
          .measure(next.unsized)
          .catch((e: unknown) => setError(String((e as Error)?.message ?? e)))
          .finally(() => alive.current && setMeasuring(0));
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  useEffect(() => {
    alive.current = true;
    void load();
    const off = window.api.housekeeping.onSize(({ path, bytes, partial }) => {
      setItems((prev) => withSize(prev, path, bytes, partial));
      if (!partial) setMeasuring((n) => Math.max(0, n - 1));
    });
    window.api.housekeeping
      .health(true)
      .then((h) => alive.current && setHealth(h))
      .catch(() => {});
    const offHealth = window.api.housekeeping.onHealth(({ status, conditions }) => setHealth((prev) => (prev ? { ...prev, status, conditions } : prev)));
    window.api.housekeeping
      .jobs()
      .then((list) => alive.current && setJobs(list))
      .catch(() => {});
    let refreshAfterJob: ReturnType<typeof setTimeout> | null = null;
    const offJob = window.api.housekeeping.onJob((job) => {
      setJobs((prev) => {
        const rest = prev.filter((one) => one.id !== job.id);
        return [job, ...rest].sort((a, b) => b.createdAt - a.createdAt);
      });
      // A job that ended changed the disk: read it again, once it has had a moment.
      if (['done', 'cancelled', 'failed', 'paused', 'interrupted'].includes(job.status)) {
        if (refreshAfterJob) clearTimeout(refreshAfterJob);
        refreshAfterJob = setTimeout(() => alive.current && void load(), 800);
      }
    });
    let clear: ReturnType<typeof setTimeout> | null = null;
    const offProgress = window.api.housekeeping.onProgress((p) => {
      setProgress(p);
      if (clear) clearTimeout(clear);
      // A finished bar stays long enough to be read, then goes.
      if (p.done) clear = setTimeout(() => alive.current && setProgress((cur) => (cur?.done ? null : cur)), 2500);
    });
    return () => {
      alive.current = false;
      off();
      offHealth();
      offProgress();
      offJob();
      if (clear) clearTimeout(clear);
      if (refreshAfterJob) clearTimeout(refreshAfterJob);
    };
    // Read once when it opens; "Refresh" reads again. Polling a disk to watch it not change is what makes a panel expensive to leave open.
  }, []);

  /** Items a job holds right now: queued, or the one being removed. The rows show it and refuse a second click. */
  const inFlight = useMemo(() => {
    const map = new Map<string, 'removing' | 'queued' | 'paused'>();
    for (const job of jobs) {
      if (!['running', 'queued', 'paused', 'interrupted'].includes(job.status)) continue;
      for (const id of job.ids) {
        if (job.results[id]) continue;
        map.set(id, job.status === 'running' ? (job.current === id ? 'removing' : 'queued') : 'paused');
      }
    }
    return map;
  }, [jobs]);

  const totals = useMemo(() => {
    const sum = (list: HousekeepingItem[]) => weigh(list);
    return {
      sessions: sum(inBucket(items, 'sessions')),
      worktrees: sum(inBucket(items, 'worktrees')),
      app: sum(inBucket(items, 'app')),
      free: sum(freeable(items)),
    };
  }, [items]);

  const run = async (key: string, work: () => Promise<string>) => {
    setBusy(key);
    setError(null);
    try {
      const message = await work();
      setSaid(message);
      setSelected(new Set());
      await load();
      window.api.housekeeping
        .health(true)
        .then((h) => alive.current && h && setHealth(h))
        .catch(() => {});
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  /**
   * Hand the machine's state to a Claude session and ask for a plan. One
   * session per panel, opened the first time it is wanted; the account is
   * one that is signed in, or the brief sits behind a sign-in prompt.
   */
  const askRef = useRef<string | null>(null);
  const askClaude = async (question?: string) => {
    setBusy('ask');
    setError(null);
    try {
      const store = useStore.getState();
      const brief = await window.api.housekeeping.brief(question ?? null);
      let sessionId = askRef.current && store.sessions[askRef.current] ? askRef.current : null;
      if (!sessionId) {
        const { profiles, settings, authByProfile } = store;
        const usual = profiles.find((p) => p.id === settings.defaultProfileId) ?? profiles[0];
        const profileId = usual && authByProfile[usual.id]?.loggedIn !== false ? usual.id : (profiles.find((p) => authByProfile[p.id]?.loggedIn)?.id ?? usual?.id);
        sessionId = await store.newSession({ kind: 'claude', title: 'ask housekeeping', profileId });
        if (!sessionId) throw new Error('the app could not open a session');
        askRef.current = sessionId;
      }
      store.focusSession(sessionId);
      const handed = await window.api.analysis.handOver(sessionId, brief);
      setSaid(handed.ok ? 'Handed the machine\'s state to a Claude session.' : (handed.error ?? 'The brief could not be handed over.'));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  /** One of the plan's actions. The ones that remove go through the same confirm as the buttons below. */
  const doAction = (proposal: HousekeepingProposal) => {
    const action = proposal.action;
    if (!action) return;
    if (action.id === 'show-sessions') return setTab('sessions');
    if (action.id === 'show-worktrees') return setTab('worktrees');
    void run(`plan:${proposal.id}`, async () => {
      if (action.id === 'db-checkpoint' || action.id === 'db-reclaim') {
        const out = await window.api.housekeeping.act(action.id, []);
        return `${proposal.title}: done, ${formatBytes(out.freed ?? 0)} given back.`;
      }
      const ids = action.ids ?? [];
      const list = items.filter((one) => ids.includes(one.id) || ids.includes(String(one.meta?.sessionId)));
      const job = await window.api.housekeeping.jobStart(action.id as HousekeepingJobKind, ids, Object.fromEntries(list.map((one) => [one.id, one.label])), proposal.title);
      setJobs((prev) => [job, ...prev.filter((one) => one.id !== job.id)]);
      return `Started — ${proposal.title}.`;
    });
  };

  /** The long removals go as jobs: queued in the database, one item at a time, stoppable, resumable. */
  const startJob = async (kind: HousekeepingJobKind, list: HousekeepingItem[], title: string) => {
    const labels = Object.fromEntries(list.map((one) => [one.id, one.label]));
    const ids = list.map((one) => (kind === 'forget-transcripts' || kind === 'delete-sessions' ? String(one.meta?.sessionId ?? one.id) : one.id));
    const job = await window.api.housekeeping.jobStart(kind, ids, labels, title);
    setJobs((prev) => [job, ...prev.filter((one) => one.id !== job.id)]);
    return `Started — ${title}.`;
  };

  /** A proposal's action, shown as the same modal with the items it names. */
  const askPlan = (proposal: HousekeepingProposal) => {
    const action = proposal.action;
    if (!action) return;
    if (action.id === 'show-sessions' || action.id === 'show-worktrees') return doAction(proposal);
    const ids = new Set(action.ids ?? []);
    const list = items.filter((one) => ids.has(one.id) || ids.has(String(one.meta?.sessionId)));
    setPending({
      key: `plan:${proposal.id}`,
      title: action.label,
      detail: proposal.detail,
      danger: Boolean(action.danger),
      items: list,
      work: async () => {
        doAction(proposal);
        return '';
      },
    });
  };

  /** The row's own button: the same modal, for this one item. */
  const quickRow = (one: HousekeepingItem) => {
    const forced = one.kind === 'worktree' && one.blockers.length > 0 && one.meta?.forceable === true;
    const kind: HousekeepingJobKind | null =
      one.kind === 'session' ? 'forget-transcripts' : one.kind === 'worktree' ? (one.meta?.broken ? 'repair-worktrees' : forced ? 'remove-worktrees-forced' : 'remove-worktrees') : one.kind === 'workshop' ? 'discard-workshops' : one.reversible ? 'free' : null;
    if (!kind) return;
    const verb = kind === 'forget-transcripts' ? 'Forget the conversation of' : kind === 'repair-worktrees' ? 'Repair' : kind === 'remove-worktrees-forced' ? 'Remove anyway' : kind === 'remove-worktrees' ? 'Remove' : kind === 'discard-workshops' ? 'Discard' : 'Remove';
    const danger = kind !== 'free' && kind !== 'repair-worktrees';
    setPending({
      key: `row:${one.id}`,
      title: `${verb} ${one.label}`,
      detail:
        kind === 'remove-worktrees-forced'
          ? 'git worktree remove --force: the uncommitted work inside is thrown away. Commits stay on their branch, which is kept. There is no undo.'
          : kind === 'remove-worktrees'
          ? 'git worktree remove, never forced. A merged branch is deleted; an unmerged one keeps its commits.'
          : kind === 'forget-transcripts'
            ? 'The kept conversation and its saved copy go; the record of the session stays in History.'
            : kind === 'repair-worktrees'
              ? 'git worktree repair points it back at the repository that lists it. Nothing is removed.'
              : kind === 'discard-workshops'
                ? "The reviewer's own rules apply: a clone with a fix not handed back is refused."
                : 'It comes back by itself when needed.',
      danger,
      items: [one],
      work: () => startJob(kind, [one], `${verb} ${one.label}`),
    });
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAll = (list: HousekeepingItem[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const one of list) {
        if (on && one.blockers.length === 0) next.add(one.id);
        else next.delete(one.id);
      }
      return next;
    });

  if (!inventory) {
    return (
      <div className="housekeeping">
        <p className="empty-state">{error ? `The disk could not be read: ${error}` : 'Reading the disk…'}</p>
      </div>
    );
  }

  const freeNow = freeable(items);
  const used = diskUsedPercent(inventory.disk);
  const chosen = (list: HousekeepingItem[]) => list.filter((one) => selected.has(one.id) && one.blockers.length === 0 && !inFlight.has(one.id));

  const confirm = (key: string, label: string, detail: string, work: () => Promise<string>, danger = false, disabled = false, items: HousekeepingItem[] = []) => (
    <button
      className={danger ? 'danger-btn tiny' : 'ghost-btn tiny'}
      disabled={disabled || Boolean(busy)}
      onClick={() => setPending({ key, title: label, detail, work, danger, items })}
    >
      {label}
    </button>
  );

  return (
    <div className="housekeeping">
      {pending && (
        <ConfirmModal
          pending={pending}
          busy={Boolean(busy)}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const todo = pending;
            setPending(null);
            void run(todo.key, todo.work);
          }}
        />
      )}
      <div className="monitor-stats">
        <div className="monitor-stat">
          <span className="monitor-stat-label">Disk</span>
          <strong>{inventory.disk.free === null ? '—' : `${formatBytes(inventory.disk.free)} free`}</strong>
          <small>{used === null ? 'the volume did not say' : `${used}% of ${formatBytes(inventory.disk.total)} in use`}</small>
        </div>
        <div className="monitor-stat">
          <span className="monitor-stat-label">Sessions</span>
          <strong>{formatBytes(totals.sessions)}</strong>
          <small>{inBucket(items, 'sessions').length} kept, conversations and copies</small>
        </div>
        <div className="monitor-stat">
          <span className="monitor-stat-label">Worktrees</span>
          <strong>{formatBytes(totals.worktrees)}</strong>
          <small>
            {inventory.checkouts} checkout{inventory.checkouts === 1 ? '' : 's'} under {inventory.roots.length} folder{inventory.roots.length === 1 ? '' : 's'}
            {measuring ? ` · measuring ${measuring}…` : ''}
          </small>
        </div>
        <div className="monitor-stat">
          <span className="monitor-stat-label">App</span>
          <strong>{formatBytes(totals.app)}</strong>
          <small>backups, installers, caches</small>
        </div>
        <div className="monitor-stat is-free">
          <span className="monitor-stat-label">Free now</span>
          <strong>{formatBytes(totals.free)}</strong>
          <small>{freeNow.length} item{freeNow.length === 1 ? '' : 's'} that come back by themselves</small>
        </div>
      </div>

      {health && health.conditions.length > 0 && (
        <div className={`housekeeping-strip is-${health.status}`} role="status">
          <strong>{health.status === 'limit' ? 'At a limit' : 'Needs attention'}:</strong>{' '}
          {health.conditions
            .slice(0, 3)
            .map((one) => `${one.label} ${one.unit === 'bytes' ? formatBytes(one.value) : one.unit === '%' ? `${one.value}%` : one.unit === 'x' ? `${one.value}×` : one.value}`)
            .join(' · ')}
          {health.conditions.length > 3 ? ` · and ${health.conditions.length - 3} more` : ''}
          <button className="link-btn" onClick={() => setTab('health')}>
            see why
          </button>
          {plan.length > 0 && (
            <button className="link-btn" onClick={() => setTab('health')}>
              {plan.length} proposal{plan.length === 1 ? '' : 's'}
            </button>
          )}
          <button className="ghost-btn tiny" disabled={Boolean(busy)} onClick={() => askClaude()} title="Open a Claude session with the machine's state and ask how to free memory and disk">
            {busy === 'ask' ? 'Asking…' : 'Ask Claude'}
          </button>
        </div>
      )}
      <div className="housekeeping-bar">
        {confirm(
          'free',
          `Free ${formatBytes(totals.free)} now`,
          `Removes ${freeNow.length} build caches, old installers, backups and browser caches. Every one is rebuilt or redownloaded when needed.`,
          () => startJob('free', freeNow, `Free ${formatBytes(totals.free)}`),
          false,
          freeNow.length === 0,
          freeNow,
        )}
        <button className="ghost-btn tiny" disabled={Boolean(busy)} onClick={() => load()}>
          {busy === 'reading' ? 'Reading…' : 'Refresh'}
        </button>
        <button className="ghost-btn tiny" disabled={Boolean(busy)} onClick={() => askClaude()} title="Open a Claude session with the machine's state and ask how to free memory and disk">
          {busy === 'ask' ? 'Asking…' : 'Ask Claude'}
        </button>
        <button className="ghost-btn tiny" disabled={Boolean(busy) || measuring > 0} onClick={() => {
            const own = items.filter((one) => one.kind !== 'session' && one.kind !== 'browser-cache' && one.path).map((one) => one.path as string);
            setMeasuring(own.length);
            void window.api.housekeeping
              .measure(own, true)
              .catch((e: unknown) => setError(String((e as Error)?.message ?? e)))
              .finally(() => setMeasuring(0));
          }} title="Walk every folder again, ignoring the remembered sizes">
          Measure again
        </button>
        {said && <span className="usage-note">{said}</span>}
        {error && <span className="usage-note is-error">{error}</span>}
        {stale && inventory && (
          <span className="usage-note">
            showing the inventory from {describeIdle(inventory.readAt) === 'today' ? 'earlier today' : describeIdle(inventory.readAt) + ' ago'} while a fresh one is read…
          </span>
        )}
      </div>

      {jobs
        .filter((job) => !['done', 'cancelled', 'failed'].includes(job.status))
        .map((job) => (
          <JobStrip key={job.id} job={job} progress={progress} />
        ))}
      <FinishedJobs jobs={jobs.filter((job) => ['done', 'cancelled', 'failed'].includes(job.status) && Date.now() - (job.finishedAt ?? job.updatedAt) < 15 * 60_000)} />

      {progress && !jobs.some((job) => job.status === 'running') && (
        <div className={`housekeeping-progress${progress.done ? ' is-done' : ''}`} role="status" aria-live="polite">
          <div className="housekeeping-progress-text">
            <strong>{progressTitle(progress)}</strong>
            {progress.label ? <span> · {progress.label}</span> : progress.detail ? <span> · {progress.detail}</span> : null}
            {progress.total ? <span> · {progress.index ?? 0} of {progress.total}</span> : null}
            {progress.freed ? <span> · {formatBytes(progress.freed)} given back</span> : null}
            {progress.failed ? <span className="is-error"> · {progress.failed} refused</span> : null}
          </div>
          <div className="housekeeping-progress-bar">
            <div style={{ width: progress.done ? '100%' : progress.total ? `${Math.min(100, Math.round(((progress.index ?? 0) / progress.total) * 100))}%` : '35%' }} className={progress.total || progress.done ? '' : 'is-indeterminate'} />
          </div>
        </div>
      )}

      {plan.some((one) => one.action && one.action.id !== 'show-sessions' && one.action.id !== 'show-worktrees') && (
        <div className="housekeeping-quick">
          <span className="monitor-stat-label">Quick actions</span>
          {plan
            .filter((one) => one.action && one.action.id !== 'show-sessions' && one.action.id !== 'show-worktrees')
            .slice(0, 5)
            .map((one) => (
              <button key={one.id} className={`ghost-btn tiny housekeeping-chip is-${one.priority}`} disabled={Boolean(busy)} title={one.detail} onClick={() => askPlan(one)}>
                {one.action?.label}
              </button>
            ))}
        </div>
      )}

      <div className="housekeeping-tabs" role="tablist">
        {TABS.map((one) => {
          const count =
            one.id === 'sessions'
              ? inBucket(items, 'sessions').filter((s) => s.state !== 'open').length
              : one.id === 'worktrees'
                ? items.filter((s) => s.kind === 'worktree').length
                : one.id === 'app'
                  ? inBucket(items, 'app').length
                  : one.id === 'health'
                    ? (health?.conditions.length ?? 0)
                    : jobs.filter((job) => !['done', 'cancelled', 'failed'].includes(job.status)).length;
          const hint =
            one.id === 'worktrees'
              ? `${items.filter((s) => s.kind === 'worktree' && s.meta?.finished && !s.blockers.length).length} finished and clear`
              : one.id === 'health'
                ? health?.status === 'fine'
                  ? 'nothing crossed'
                  : `${count} condition${count === 1 ? '' : 's'}`
                : one.id === 'log'
                  ? count
                    ? `${count} job${count === 1 ? '' : 's'} in flight`
                    : 'what was removed'
                  : '';
          return (
            <button key={one.id} role="tab" aria-selected={tab === one.id} className={`housekeeping-tab${tab === one.id ? ' is-on' : ''}`} onClick={() => setTab(one.id)} title={hint || undefined}>
              {one.id === 'health' && <span className={`housekeeping-tab-dot is-${health?.status ?? 'fine'}`} aria-hidden />}
              {one.label}
              {one.id !== 'health' && count > 0 && <span className="housekeeping-tab-count">{count}</span>}
              {one.id === 'health' && count > 0 && <span className="housekeeping-tab-count is-warn">{count}</span>}
            </button>
          );
        })}
      </div>

      {tab === 'sessions' && (
        <Sessions
          items={items}
          olderThan={olderThan}
          setOlderThan={setOlderThan}
          minMb={minMb}
          setMinMb={setMinMb}
          includeOpen={includeOpen}
          setIncludeOpen={setIncludeOpen}
          selected={selected}
          toggle={toggle}
          selectAll={selectAll}
          chosen={chosen}
          confirm={confirm}
          quickRow={quickRow}
          startJob={startJob}
          inFlight={inFlight}
        />
      )}
      {tab === 'worktrees' && (
        <Worktrees items={items} roots={inventory.roots} selected={selected} toggle={toggle} selectAll={selectAll} chosen={chosen} confirm={confirm} quickRow={quickRow} startJob={startJob} inFlight={inFlight} reload={() => load()} onError={setError} />
      )}
      {tab === 'app' && <AppFiles items={items} selected={selected} toggle={toggle} selectAll={selectAll} chosen={chosen} confirm={confirm} quickRow={quickRow} startJob={startJob} inFlight={inFlight} />}
      {tab === 'health' && <Health health={health} setHealth={setHealth} onError={setError} ask={askClaude} asking={busy === 'ask'} plan={plan} stats={stats} askPlan={askPlan} busy={Boolean(busy)} />}
      {tab === 'log' && <Log initial={inventory.log} />}
    </div>
  );
}

// --- the tabs --------------------------------------------------------------------

type Confirm = (key: string, label: string, detail: string, work: () => Promise<string>, danger?: boolean, disabled?: boolean, items?: HousekeepingItem[]) => ReactElement;

interface ListProps {
  items: HousekeepingItem[];
  selected: Set<string>;
  toggle: (id: string) => void;
  selectAll: (list: HousekeepingItem[], on: boolean) => void;
  chosen: (list: HousekeepingItem[]) => HousekeepingItem[];
  confirm: Confirm;
  /** The row's own button: the same modal, for this one item. */
  quickRow: (one: HousekeepingItem) => void;
  /** Queue a removal as a job and say so. */
  startJob: (kind: HousekeepingJobKind, list: HousekeepingItem[], title: string) => Promise<string>;
  /** Items a job holds right now. */
  inFlight: Map<string, 'removing' | 'queued' | 'paused'>;
}

/** Jobs that ended lately, as one line rather than a stack: how many, what they gave back, and one Dismiss. */
function FinishedJobs({ jobs }: { jobs: HousekeepingJob[] }) {
  const [open, setOpen] = useState(false);
  if (!jobs.length) return null;
  const freed = jobs.reduce((a, j) => a + j.freed, 0);
  const refused = jobs.reduce((a, j) => a + j.failed, 0);
  const bad = jobs.filter((j) => j.status !== 'done').length;
  const dismissAll = () => jobs.forEach((j) => void window.api.housekeeping.jobDismiss(j.id));
  if (jobs.length === 1) {
    const j = jobs[0];
    return (
      <div className={`housekeeping-finished is-${j.status}`} role="status">
        <span className="housekeeping-finished-dot" />
        <strong>{j.status === 'done' ? 'Done' : j.status === 'cancelled' ? 'Stopped' : 'Failed'}</strong>
        <span className="housekeeping-finished-title">{j.title}</span>
        <span className="housekeeping-finished-sum">
          {formatBytes(j.freed)} given back{j.failed ? ` · ${j.failed} refused` : ''}
        </span>
        <button className="ghost-btn tiny" onClick={dismissAll}>
          Dismiss
        </button>
      </div>
    );
  }
  return (
    <div className={`housekeeping-finished${bad ? ' is-cancelled' : ' is-done'}`} role="status">
      <span className="housekeeping-finished-dot" />
      <strong>{jobs.length} jobs finished</strong>
      <span className="housekeeping-finished-sum">
        {formatBytes(freed)} given back{refused ? ` · ${refused} refused` : ''}{bad ? ` · ${bad} stopped or failed` : ''}
      </span>
      <button className="link-btn" onClick={() => setOpen((v) => !v)}>
        {open ? 'hide' : 'show'}
      </button>
      <button className="ghost-btn tiny" onClick={dismissAll}>
        Dismiss all
      </button>
      {open && (
        <ul className="housekeeping-finished-list">
          {jobs.map((j) => (
            <li key={j.id}>
              <span>{j.status === 'done' ? '✓' : '✕'}</span> {j.title} · {formatBytes(j.freed)}
              {j.failed ? ` · ${j.failed} refused` : ''}
              <button className="link-btn" onClick={() => void window.api.housekeeping.jobDismiss(j.id)}>
                dismiss
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One job, as a strip: what it is, where it is, what it gave back, and the buttons that stop or resume it. */
function JobStrip({ job, progress }: { job: HousekeepingJob; progress: HousekeepingProgress | null }) {
  const total = job.ids.length;
  const done = Object.keys(job.results).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const live = job.status === 'running';
  const label = job.current ? (job.labels[job.current] ?? job.current) : null;
  const inside = live && progress && progress.op === 'delete' && !progress.done ? progress : null;
  const verb: Record<HousekeepingJobStatus, string> = { queued: 'Waiting', running: 'Running', paused: 'Paused', interrupted: 'Interrupted by a restart', done: 'Done', cancelled: 'Stopped', failed: 'Failed' };
  return (
    <div className={`housekeeping-progress housekeeping-job is-${job.status}`} role="status" aria-live="polite">
      <div className="housekeeping-progress-text">
        <strong>{verb[job.status]}</strong> · {job.title} · {done} of {total}
        {job.freed ? ` · ${formatBytes(job.freed)} given back` : ''}
        {job.failed ? <span className="is-error"> · {job.failed} refused</span> : null}
        {live && label ? <span> · now: {label}</span> : null}
        {inside ? (
          <span>
            {' '}
            · {formatBytes(inside.itemBytes ?? 0)}
            {inside.itemExpected ? ` of ${formatBytes(inside.itemExpected)}` : ''} deleted{inside.files ? `, ${inside.files} files` : ''}
          </span>
        ) : null}
        <span className="housekeeping-job-actions">
          {live && (
            <>
              <button className="ghost-btn tiny" onClick={() => void window.api.housekeeping.jobPause(job.id)}>
                Pause
              </button>
              <button className="ghost-btn tiny" onClick={() => void window.api.housekeeping.jobCancel(job.id)}>
                Stop
              </button>
            </>
          )}
          {['paused', 'interrupted', 'failed'].includes(job.status) && (
            <>
              <button className="ghost-btn tiny" onClick={() => void window.api.housekeeping.jobResume(job.id)}>
                Resume
              </button>
              <button className="ghost-btn tiny" onClick={() => void window.api.housekeeping.jobCancel(job.id)}>
                Drop
              </button>
            </>
          )}
          {job.status === 'queued' && (
            <button className="ghost-btn tiny" onClick={() => void window.api.housekeeping.jobCancel(job.id)}>
              Drop
            </button>
          )}
          {['done', 'cancelled'].includes(job.status) && (
            <button className="ghost-btn tiny" onClick={() => void window.api.housekeeping.jobDismiss(job.id)}>
              Dismiss
            </button>
          )}
        </span>
      </div>
      <div className="housekeeping-progress-bar">
        <div style={{ width: `${pct}%` }} />
        {inside && inside.itemExpected ? <div className="is-inner" style={{ width: `${Math.min(100, Math.round(((inside.itemBytes ?? 0) / inside.itemExpected) * 100))}%` }} /> : null}
      </div>
    </div>
  );
}

/** What a progress event is about, in words. */
function progressTitle(p: HousekeepingProgress): string {
  const names: Record<string, string> = {
    inventory: p.done ? 'Inventory read' : 'Reading the disk',
    free: p.done ? 'Freed' : 'Freeing',
    'remove-worktrees': p.done ? 'Worktrees removed' : 'Removing worktrees',
    'delete-sessions': 'Sessions deleted',
    'forget-transcripts': 'Conversations forgotten',
  };
  return names[p.op] ?? (p.done ? 'Done' : 'Working');
}

function Sessions({
  items,
  olderThan,
  setOlderThan,
  minMb,
  setMinMb,
  includeOpen,
  setIncludeOpen,
  selected,
  toggle,
  selectAll,
  chosen,
  confirm,
  quickRow,
  startJob,
  inFlight,
}: ListProps & {
  olderThan: number;
  setOlderThan: (n: number) => void;
  minMb: number;
  setMinMb: (n: number) => void;
  includeOpen: boolean;
  setIncludeOpen: (on: boolean) => void;
}) {
  const rows = filterSessions(items, { olderThanDays: olderThan, minBytes: minMb * 1024 * 1024, includeOpen });
  const picked = chosen(rows);
  return (
    <>
      <div className="housekeeping-filters">
        <label>
          Idle for at least
          <input type="number" min={0} value={olderThan} onChange={(e) => setOlderThan(Math.max(0, Number(e.target.value) || 0))} /> days
        </label>
        <label>
          Weighing at least
          <input type="number" min={0} value={minMb} onChange={(e) => setMinMb(Math.max(0, Number(e.target.value) || 0))} /> MB
        </label>
        <label>
          <input type="checkbox" checked={includeOpen} onChange={(e) => setIncludeOpen(e.target.checked)} /> show running
        </label>
        <span className="usage-note">
          {rows.length} session{rows.length === 1 ? '' : 's'}, {formatBytes(weigh(rows))}
        </span>
      </div>
      <Table rows={rows} selected={selected} toggle={toggle} selectAll={selectAll} empty="No session matches. Lower the days or the size." quick={{ label: 'Forget', run: quickRow }} inFlight={inFlight} />
      <div className="storage-actions">
        {confirm(
          'forget',
          `Forget ${picked.length} conversation${picked.length === 1 ? '' : 's'} (${formatBytes(weigh(picked))})`,
          'Deletes the kept conversations and their saved copies. The record of what ran, when and where stays in History.',
          () => startJob('forget-transcripts', picked, `Forget ${picked.length} conversation${picked.length === 1 ? '' : 's'}`),
          false,
          picked.length === 0,
          picked,
        )}
        {confirm(
          'delete',
          `Delete ${picked.length} session${picked.length === 1 ? '' : 's'} entirely`,
          'Removes the sessions — record, conversation, messages and readings. This cannot be undone.',
          () => startJob('delete-sessions', picked, `Delete ${picked.length} session${picked.length === 1 ? '' : 's'}`),
          true,
          picked.length === 0,
          picked,
        )}
      </div>
    </>
  );
}

function Worktrees({ items, roots, selected, toggle, selectAll, chosen, confirm, quickRow, startJob, inFlight, reload, onError }: ListProps & { roots: HousekeepingRoot[]; reload: () => void; onError: (message: string) => void }) {
  const caches = items.filter((one) => one.kind === 'build-cache');
  const shops = items.filter((one) => one.kind === 'workshop');
  const pickedCaches = chosen(caches);
  const pickedShops = chosen(shops);
  const [adding, setAdding] = useState(false);
  const [idleFor, setIdleFor] = useState(0);
  const [finishedOnly, setFinishedOnly] = useState(false);
  const trees = filterWorktrees(items, { olderThanDays: idleFor, finishedOnly });
  const broken = items.filter((one) => one.kind === 'worktree' && one.meta?.broken);
  const allTrees = items.filter((one) => one.kind === 'worktree');
  const pickedTrees = chosen(trees);
  /** The blocked ones the person ticked on purpose: old worktrees whose work no longer matters. */
  const pickedForced = trees.filter((one) => selected.has(one.id) && one.blockers.length > 0 && one.meta?.forceable === true && !inFlight.has(one.id));
  const finished = allTrees.filter((one) => one.meta?.finished && one.blockers.length === 0);

  const addRoot = async () => {
    setAdding(true);
    try {
      const folder = await window.api.system.pickDirectory();
      if (folder) {
        await window.api.housekeeping.addRoot(folder);
        reload();
      }
    } catch (e) {
      onError(String((e as Error)?.message ?? e));
    } finally {
      setAdding(false);
    }
  };

  const settings = (
    <details className="housekeeping-settings" open={!roots.length}>
      <summary>
        Where to look, and what counts as a build's own
        <small>
          {roots.length} folder{roots.length === 1 ? '' : 's'} · offer at session close · regenerable names
        </small>
      </summary>
      <h3 className="monitor-heading">Folders looked through</h3>
      <p className="usage-note">A folder of worktrees, or a checkout. Its direct children that are git checkouts are listed; nothing deeper is crawled.</p>
      <ul className="housekeeping-roots">
        {roots.map((root) => (
          <li key={root.path}>
            <code>{root.path}</code>
            <button
              className="ghost-btn tiny"
              onClick={() =>
                window.api.housekeeping
                  .removeRoot(root.path)
                  .then(() => reload())
                  .catch((e: unknown) => onError(String((e as Error)?.message ?? e)))
              }
            >
              Forget
            </button>
          </li>
        ))}
        {!roots.length && <li className="usage-note">None yet. Add the folder your worktrees live in, for example ~/dev/worktrees.</li>}
      </ul>
      <button className="ghost-btn tiny" disabled={adding} onClick={addRoot}>
        {adding ? 'Choosing…' : 'Add a folder…'}
      </button>

      <h3 className="monitor-heading">Files a build makes again</h3>
      <p className="usage-note">
        A worktree with an ignored file nothing could rebuild (an .env, a key) is kept. Build caches on the list are not counted; add here the other names your builds write, one per line, * allowed: for example <code>dist-*</code>, <code>buildNumber.properties</code>.
      </p>
      <Regenerable reload={reload} onError={onError} />

      <h3 className="monitor-heading">When a session closes</h3>
      <OfferOnClose onError={onError} />
    </details>
  );

  return (
    <>
      {!roots.length && settings}
      <h3 className="monitor-heading">Worktrees</h3>
      <p className="usage-note">
        Every worktree of the repositories above and of the ones your sessions are in, except each repository's main working tree. Idle is the latest of its last commit, its last checkout, and the last time a session was inside it. One
        with changes of its own, commits never pushed, or a session inside is shown and refused.
      </p>
      <div className="housekeeping-filters">
        <label>
          Idle for at least
          <input type="number" min={0} value={idleFor} onChange={(e) => setIdleFor(Math.max(0, Number(e.target.value) || 0))} /> days
        </label>
        <label>
          <input type="checkbox" checked={finishedOnly} onChange={(e) => setFinishedOnly(e.target.checked)} /> finished only (merged, or branch gone on origin)
        </label>
        <span className="usage-note">
          {trees.length} of {allTrees.length} worktree{allTrees.length === 1 ? '' : 's'}, {formatBytes(weigh(trees))} · {finished.length} finished and clear
        </span>
      </div>
      <Table rows={trees} selected={selected} toggle={toggle} selectAll={selectAll} empty={allTrees.length ? 'No worktree matches. Lower the days or untick finished only.' : 'No worktrees found. Add the folder they live in above.'} quick={{ label: 'Remove', run: quickRow }} inFlight={inFlight} allowForce />
      <div className="storage-actions">
        {confirm(
          'trees',
          `Remove ${pickedTrees.length} worktree${pickedTrees.length === 1 ? '' : 's'} (${formatBytes(weigh(pickedTrees))})`,
          'git worktree remove, never forced: anything that changed since it was looked at is refused. A finished branch is deleted; an unfinished one keeps its commits.',
          () => startJob('remove-worktrees', pickedTrees, `Remove ${pickedTrees.length} worktree${pickedTrees.length === 1 ? '' : 's'} (${formatBytes(weigh(pickedTrees))})`),
          true,
          pickedTrees.length === 0,
          pickedTrees,
        )}
        {pickedForced.length > 0 &&
          confirm(
            'trees-forced',
            `Remove ${pickedForced.length} anyway, discarding ${pickedForced.length === 1 ? 'its' : 'their'} work (${formatBytes(weigh(pickedForced))})`,
            'These have changes not committed, commits on no base branch, or ignored files. git worktree remove --force throws the uncommitted work away; commits stay on their branch, which is kept. There is no undo.',
            () => startJob('remove-worktrees-forced', pickedForced, `Remove ${pickedForced.length} worktree${pickedForced.length === 1 ? '' : 's'} anyway, discarding work`),
            true,
            false,
            pickedForced,
          )}
        {broken.length > 0 &&
          confirm(
            'repair',
            `Repair ${broken.length} broken link${broken.length === 1 ? '' : 's'}`,
            'git worktree repair points each one back at the repository that lists it. Nothing is removed; afterwards they can be read, and removed if finished.',
            async () => {
              const out = await window.api.housekeeping.repairWorktrees(broken.map((one) => one.id));
              const failed = out.results.filter((one) => !one.ok);
              return `Repaired ${out.results.length - failed.length}.${failed.length ? ` ${failed.length} could not be: ${failed[0].error}` : ''}`;
            },
            false,
            false,
            broken,
          )}
        {finished.length > 0 &&
          confirm(
            'finished',
            `Remove all ${finished.length} finished (${formatBytes(weigh(finished))})`,
            'Only worktrees whose work is merged or whose branch is gone on origin, with nothing of their own and nobody inside.',
            () => startJob('remove-worktrees', finished, `Remove all ${finished.length} finished (${formatBytes(weigh(finished))})`),
            true,
            false,
            finished,
          )}
      </div>

      <h3 className="monitor-heading">Build caches</h3>
      <p className="usage-note">
        Folders a build writes and writes again: .angular, node_modules, target, dist. Removing one costs the next build a rebuild and nothing else. A folder git does not ignore is refused. A cache inside a worktree listed above is shown here but counted inside that worktree's size.
      </p>
      <Table rows={caches} selected={selected} toggle={toggle} selectAll={selectAll} empty="No build caches under the folders above." quick={{ label: 'Clear', run: quickRow }} inFlight={inFlight} />
      <div className="storage-actions">
        {confirm(
          'caches',
          `Clear ${pickedCaches.length} cache${pickedCaches.length === 1 ? '' : 's'} (${formatBytes(weigh(pickedCaches))})`,
          'Each folder is renamed aside at once and deleted in the background. The next build rewrites it.',
          () => startJob('free', pickedCaches, `Clear ${pickedCaches.length} cache${pickedCaches.length === 1 ? '' : 's'} (${formatBytes(weigh(pickedCaches))})`),
          false,
          pickedCaches.length === 0,
          pickedCaches,
        )}
      </div>

      <h3 className="monitor-heading">Code Reviewer clones</h3>
      <p className="usage-note">A clone per pull request the reviewer wrote fixes in. One whose pull request is closed and whose fixes were handed back can go.</p>
      <Table rows={shops} selected={selected} toggle={toggle} selectAll={selectAll} empty="No review clones on disk." quick={{ label: 'Discard', run: quickRow }} inFlight={inFlight} />
      <div className="storage-actions">
        {confirm(
          'shops',
          `Discard ${pickedShops.length} clone${pickedShops.length === 1 ? '' : 's'} (${formatBytes(weigh(pickedShops))})`,
          'The reviewer refuses any clone with a fix still waiting to be handed back.',
          () => startJob('discard-workshops', pickedShops, `Discard ${pickedShops.length} clone${pickedShops.length === 1 ? '' : 's'}`),
          true,
          pickedShops.length === 0,
          pickedShops,
        )}
      </div>

      {roots.length > 0 && settings}
    </>
  );
}

/** The switch for the offer made when a session closes in a finished worktree. */
function OfferOnClose({ onError }: { onError: (m: string) => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    window.api.housekeeping
      .pref('offer-on-close')
      .then((v) => setOn(v === null || v === undefined ? true : Boolean(v)))
      .catch(() => setOn(true));
  }, []);
  if (on === null) return null;
  return (
    <label className="housekeeping-switch">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          const next = e.target.checked;
          setOn(next);
          window.api.housekeeping.pref('offer-on-close', next).catch((err: unknown) => onError(String((err as Error)?.message ?? err)));
        }}
      />{' '}
      When a session closes in a worktree whose work is merged and clean, offer to remove it (also from Housekeeping › Check This Session's Worktree…)
    </label>
  );
}

function Regenerable({ reload, onError }: { reload: () => void; onError: (m: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    window.api.housekeeping
      .regenerable()
      .then((list) => setText(list.join('\n')))
      .catch(() => setText(''));
  }, []);
  if (text === null) return null;
  const save = async () => {
    setSaving(true);
    try {
      const list = await window.api.housekeeping.regenerable(text);
      setText(list.join('\n'));
      reload();
    } catch (e) {
      onError(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="housekeeping-regenerable">
      <textarea value={text} rows={3} spellCheck={false} onChange={(e) => setText(e.target.value)} placeholder={'dist-*\nbuildNumber.properties'} aria-label="Files a build makes again" />
      <button className="ghost-btn tiny" disabled={saving} onClick={save}>
        {saving ? 'Saving…' : 'Save and look again'}
      </button>
    </div>
  );
}

function AppFiles({ items, selected, toggle, selectAll, chosen, confirm, quickRow, startJob, inFlight }: ListProps) {
  const rows = inBucket(items, 'app');
  const picked = chosen(rows);
  return (
    <>
      <p className="usage-note">
        What the app keeps beside its database: copies of the database and of whole data folders made before upgrades, installers already downloaded, pasted images, the window's own cache. The database itself is tended from the Monitor.
      </p>
      <Table rows={rows} selected={selected} toggle={toggle} selectAll={selectAll} empty="Nothing beside the database." quick={{ label: 'Remove', run: quickRow }} inFlight={inFlight} />
      <div className="storage-actions">
        {confirm(
          'app',
          `Remove ${picked.length} item${picked.length === 1 ? '' : 's'} (${formatBytes(weigh(picked))})`,
          'Backups older than the running version, installers, pasted images and caches. The newest downloaded update is the one waiting to be installed.',
          () => startJob('free', picked, `Remove ${picked.length} item${picked.length === 1 ? '' : 's'} (${formatBytes(weigh(picked))})`),
          false,
          picked.length === 0,
          picked,
        )}
      </div>
    </>
  );
}

const METRIC_ORDER = ['disk.free.bytes', 'disk.free.pct', 'mem.free.bytes', 'swap.used.pct', 'swap.used.bytes', 'load.per.core', 'app.rss.bytes', 'sessions.open', 'db.bytes', 'db.wal.bytes', 'worktrees.inactive', 'budget.app.bytes', 'budget.worktrees.bytes'];

function showValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return '—';
  if (unit === 'bytes') return formatBytes(value);
  if (unit === '%') return `${value}%`;
  if (unit === 'x') return `${value}×`;
  return String(value);
}

/** A threshold typed by a person: bytes are typed in GB, the rest as they are. */
function ThresholdInput({ metric, level, unit, value, onSave }: { metric: string; level: 'attention' | 'limit'; unit: string; value: number | null; onSave: (metric: string, level: 'attention' | 'limit', value: number | null) => void }) {
  const toField = (v: number | null) => (v === null ? '' : unit === 'bytes' ? String(Math.round((v / 1024 ** 3) * 10) / 10) : String(v));
  const [text, setText] = useState(toField(value));
  useEffect(() => setText(toField(value)), [value, unit]);
  const commit = () => {
    const trimmed = text.trim();
    const number = trimmed === '' ? null : Number(trimmed);
    if (number !== null && !Number.isFinite(number)) return setText(toField(value));
    const stored = number === null ? null : unit === 'bytes' ? number * 1024 ** 3 : number;
    if (stored !== value) onSave(metric, level, stored);
  };
  return (
    <span className="housekeeping-threshold">
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} placeholder="off" aria-label={`${metric} ${level}`} />
      <small>{unit === 'bytes' ? 'GB' : unit}</small>
    </span>
  );
}

function Health({
  health,
  setHealth,
  onError,
  ask,
  asking,
  plan,
  stats,
  askPlan,
  busy: parentBusy,
}: {
  health: HousekeepingHealth | null;
  setHealth: (h: HousekeepingHealth | null) => void;
  onError: (m: string) => void;
  ask: (question?: string) => void;
  asking: boolean;
  plan: HousekeepingProposal[];
  stats: HousekeepingStats | null;
  askPlan: (p: HousekeepingProposal) => void;
  busy: boolean;
}) {
  const [busy, setBusy] = useState(false);
  if (!health) return <p className="empty-state">The first reading lands a few seconds after start.</p>;
  const save = (metric: string, level: 'attention' | 'limit', value: number | null) =>
    window.api.housekeeping
      .setThreshold(metric, level, value)
      .then((h) => h && setHealth(h))
      .catch((e: unknown) => onError(String((e as Error)?.message ?? e)));
  const measureNow = () => {
    setBusy(true);
    window.api.housekeeping
      .measureNow()
      .then((h) => h && setHealth(h))
      .catch((e: unknown) => onError(String((e as Error)?.message ?? e)))
      .finally(() => setBusy(false));
  };
  const growth = (metric: string) => {
    const g = health.growthPerWeek[metric];
    if (g === null || g === undefined) return 'not enough days yet';
    return `${g >= 0 ? '+' : '−'}${formatBytes(Math.abs(g))} a week`;
  };
  return (
    <>
      <p className="usage-note">
        The system is read every minute, what things weigh once an hour. A line crossed is said once by a notification and not again for a day unless it gets worse. Bytes are typed in GB; an empty field turns a line off.
      </p>
      <div className="monitor-stats">
        <div className={`monitor-stat is-${health.status}`}>
          <span className="monitor-stat-label">Status</span>
          <strong>{health.status === 'fine' ? 'Fine' : health.status === 'limit' ? 'At a limit' : 'Attention'}</strong>
          <small>{health.conditions.length ? `${health.conditions.length} condition${health.conditions.length === 1 ? '' : 's'}` : 'nothing crossed'}</small>
        </div>
        <div className="monitor-stat">
          <span className="monitor-stat-label">Disk, at this rate</span>
          <strong>{health.daysUntilFull === null ? '—' : `${health.daysUntilFull} days`}</strong>
          <small>{health.daysUntilFull === null ? 'needs two days of readings, or the disk is not filling' : 'until the volume is full'}</small>
        </div>
        <div className="monitor-stat">
          <span className="monitor-stat-label">Disk used</span>
          <strong>{growth('disk.used.bytes')}</strong>
          <small>over the last two weeks</small>
        </div>
        <div className="monitor-stat">
          <span className="monitor-stat-label">Worktrees</span>
          <strong>{growth('bucket.worktrees.bytes')}</strong>
          <small>{health.lastInventoryAt ? `weighed ${describeIdle(health.lastInventoryAt) === 'today' ? 'today' : describeIdle(health.lastInventoryAt) + ' ago'}` : 'not weighed yet'}</small>
        </div>
        <div className="monitor-stat">
          <span className="monitor-stat-label">App data</span>
          <strong>{growth('bucket.app.bytes')}</strong>
          <small>conversations, copies, backups</small>
        </div>
      </div>
      <div className="housekeeping-bar">
        <button className="ghost-btn tiny" disabled={busy} onClick={measureNow}>
          {busy ? 'Weighing…' : 'Weigh everything now'}
        </button>
        <button className="ghost-btn tiny" disabled={asking} onClick={() => ask()} title="A Claude session is handed the readings, the processes holding memory, the swap, the disk and the worktrees, and asked for a plan">
          {asking ? 'Asking…' : 'Ask Claude how to free memory'}
        </button>
        <button className="ghost-btn tiny" disabled={asking} onClick={() => ask('The disk is filling. From the numbers above, say what to remove first and in which order without losing unmerged work, name the worktrees and caches with their sizes, and say what to keep.')}>
          Ask Claude about the disk
        </button>
      </div>

      <h3 className="monitor-heading">What to do, in order</h3>
      {plan.length === 0 ? (
        <p className="usage-note">Nothing to propose: nothing is crossed and nothing large is idle.</p>
      ) : (
        <ol className="housekeeping-plan">
          {plan.map((one) => (
            <li key={one.id} className={`is-${one.priority}`}>
              <div className="housekeeping-plan-head">
                <span className="housekeeping-work">{one.priority}</span>
                <strong>{one.title}</strong>
                {one.effect && <em> — {one.effect}</em>}
              </div>
              <p>{one.detail}</p>
              {one.action && (
                <button className={one.action.danger ? 'danger-btn tiny' : 'ghost-btn tiny'} disabled={parentBusy} onClick={() => askPlan(one)}>
                  {one.action.label}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      {stats && (
        <>
          <h3 className="monitor-heading">Freed against consumed</h3>
          <p className="usage-note">
            Freed is what housekeeping gave back. Consumed is how much the disk's used space would have grown had nothing been removed: its movement plus what was freed. Net is the movement itself; a negative net means the disk ended with more room than it started.
          </p>
          <table className="housekeeping-table housekeeping-balance">
            <thead>
              <tr>
                <th>Period</th>
                <th className="is-num">Freed</th>
                <th className="is-num">Consumed</th>
                <th className="is-num">Net</th>
                <th>Readings</th>
              </tr>
            </thead>
            <tbody>
              {(['day', 'week', 'month', 'year'] as const).map((period) => {
                const b = stats.balance[period];
                const label = { day: 'Today', week: 'Last 7 days', month: 'Last 30 days', year: 'Last year' }[period];
                const max = Math.max(1, ...(['day', 'week', 'month', 'year'] as const).map((p) => Math.max(stats.balance[p].freed, stats.balance[p].consumed ?? 0)));
                return (
                  <tr key={period}>
                    <td>
                      <span className="housekeeping-label">{label}</span>
                      <small>{b.removals} removal{b.removals === 1 ? '' : 's'}</small>
                    </td>
                    <td className="is-num">
                      {formatBytes(b.freed)}
                      <div className="housekeeping-meter is-freed" style={{ width: `${Math.round((b.freed / max) * 100)}%` }} />
                    </td>
                    <td className="is-num">
                      {b.consumed === null ? '—' : formatBytes(b.consumed)}
                      <div className="housekeeping-meter is-consumed" style={{ width: `${Math.round(((b.consumed ?? 0) / max) * 100)}%` }} />
                    </td>
                    <td className={`is-num${b.usedDelta !== null && b.usedDelta < 0 ? ' is-good' : b.usedDelta !== null && b.usedDelta > 0 ? ' is-bad' : ''}`}>
                      {b.usedDelta === null ? '—' : `${b.usedDelta > 0 ? '+' : b.usedDelta < 0 ? '−' : ''}${formatBytes(Math.abs(b.usedDelta))}`}
                    </td>
                    <td>
                      <small>{b.covered ? `${b.covered} of ${b.days} day${b.days === 1 ? '' : 's'} measured` : 'no readings yet'}</small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h3 className="monitor-heading">The last {stats.days} days</h3>
          <div className="monitor-stats">
            <div className="monitor-stat">
              <span className="monitor-stat-label">Given back</span>
              <strong>{formatBytes(stats.freed.bytes)}</strong>
              <small>{stats.freed.n} removal{stats.freed.n === 1 ? '' : 's'}</small>
            </div>
            {moved(stats, 'disk.used.bytes', 'Disk used', true)}
            {moved(stats, 'bucket.worktrees.bytes', 'Worktrees', true)}
            {moved(stats, 'worktrees.inactive', 'Inactive worktrees', false)}
            {moved(stats, 'db.bytes', 'Database', true)}
          </div>
          {stats.weeks.some((w) => w.bytes > 0) && (
            <div className="housekeeping-weeks" title="Given back, by week">
              {stats.weeks.map((w) => {
                const max = Math.max(...stats.weeks.map((x) => x.bytes), 1);
                return (
                  <div key={w.start} className="housekeeping-week" title={`${new Date(w.start).toLocaleDateString()} – ${new Date(w.end).toLocaleDateString()}: ${formatBytes(w.bytes)} in ${w.n}`}>
                    <div style={{ height: `${Math.max(2, Math.round((w.bytes / max) * 40))}px` }} />
                    <small>{formatBytes(w.bytes)}</small>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {health.conditions.length > 0 && (
        <>
          <h3 className="monitor-heading">Why the machine may be slow</h3>
          <ul className="housekeeping-conditions">
            {health.conditions.map((one) => (
              <li key={one.metric} className={`is-${one.level}`}>
                <strong>
                  {one.label} is {showValue(one.value, one.unit)}
                </strong>{' '}
                ({one.level} {one.direction} {showValue(one.threshold, one.unit)}). {one.why}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="monitor-heading">Readings and lines</h3>
      <table className="housekeeping-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th className="is-num">Now</th>
            <th>Attention</th>
            <th>Limit</th>
            <th>Why it matters</th>
          </tr>
        </thead>
        <tbody>
          {METRIC_ORDER.filter((metric) => health.thresholds[metric]).map((metric) => {
            const line = health.thresholds[metric];
            const reading = health.latest[metric];
            const condition = health.conditions.find((one) => one.metric === metric);
            return (
              <tr key={metric} className={condition ? `is-${condition.level}` : ''}>
                <td>
                  <span className="housekeeping-label">{line.label}</span>
                  <small>
                    {metric} · worse {line.direction}
                  </small>
                </td>
                <td className="is-num">{showValue(reading?.value, line.unit)}</td>
                <td>
                  <ThresholdInput metric={metric} level="attention" unit={line.unit} value={line.attention} onSave={save} />
                </td>
                <td>
                  <ThresholdInput metric={metric} level="limit" unit={line.unit} value={line.limit} onSave={save} />
                </td>
                <td>
                  <small className="housekeeping-why">{line.why}</small>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

interface PendingAction {
  key: string;
  title: string;
  detail: string;
  danger: boolean;
  items: HousekeepingItem[];
  work: () => Promise<string>;
}

/**
 * The question before anything goes, as a modal: what, how many, how much,
 * and every item by name with its state and size — so a selection of thirty
 * worktrees is read, not guessed from a count at the bottom of a long list.
 */
function ConfirmModal({ pending, busy, onCancel, onConfirm }: { pending: PendingAction; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const bytes = weigh(pending.items);
  const forcedKind = pending.key.includes('forced') || /anyway/i.test(pending.title);
  const blocked = forcedKind ? pending.items.filter((one) => one.blockers.length && one.meta?.forceable !== true) : pending.items.filter((one) => one.blockers.length);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="confirm housekeeping-confirm" role="dialog" aria-modal="true" aria-labelledby="hk-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
        <h3 id="hk-confirm-title">{pending.title}</h3>
        <p className={pending.danger ? 'confirm-warn' : undefined}>{pending.detail}</p>
        {pending.items.length > 0 && (
          <>
            <p className="housekeeping-confirm-sum">
              <strong>{pending.items.length}</strong> item{pending.items.length === 1 ? '' : 's'}
              {bytes ? (
                <>
                  {' '}
                  · <strong>{formatBytes(bytes)}</strong>
                </>
              ) : null}
              {blocked.length ? <span className="is-error"> · {blocked.length} will be refused</span> : null}
            </p>
            <ul className="housekeeping-confirm-list">
              {[...pending.items]
                .sort((a, b) => b.bytes - a.bytes)
                .map((one) => (
                  <li key={one.id} className={one.blockers.length ? 'is-blocked' : ''} title={one.path ?? undefined}>
                    <span className="housekeeping-confirm-name">{one.label}</span>
                    <span className="housekeeping-confirm-state">
                      {one.kind === 'worktree' && typeof one.meta?.work === 'string' ? <span className={`housekeeping-work is-${String(one.meta.work)}`}>{String(one.meta.work)}</span> : null}
                      {one.state ?? KIND_LABEL[one.kind]}
                      {Array.isArray(one.meta?.loses) && (one.meta.loses as string[]).length ? (
                        <small className="is-lost"> · loses {(one.meta.loses as string[]).join(', ')}</small>
                      ) : one.blockers.length ? (
                        <small> · {one.blockers.join(', ')}</small>
                      ) : null}
                    </span>
                    <span className="housekeeping-confirm-size">{one.meta?.sized === false ? '…' : formatBytes(one.bytes)}</span>
                  </li>
                ))}
            </ul>
          </>
        )}
        <div className="confirm-actions">
          <button className="ghost-btn" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className={pending.danger ? 'danger-btn' : 'primary-btn'} disabled={busy} onClick={onConfirm}>
            {pending.danger ? 'Yes, remove' : 'Yes, do it'}
          </button>
        </div>
      </div>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  free: 'Freed',
  'remove-worktree': 'Worktree removed',
  'repair-worktree': 'Worktree repaired',
  'delete-sessions': 'Sessions deleted',
  'forget-transcripts': 'Conversations forgotten',
  'discard-workshop': 'Clone discarded',
  'db-checkpoint': 'Database log folded',
  'db-reclaim': 'Database compacted',
};

/** "11:23" today, "yesterday 09:20", or the date — enough to place a removal without reading a timestamp. */
function whenLabel(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return time;
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(d, yesterday)) return `yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

interface LogGroup {
  key: string;
  action: string;
  at: number;
  rows: HousekeepingLogRow[];
  bytes: number;
  refused: number;
}

/** Rows of one action within a minute of each other are one pass: a job, or one button. */
function groupLog(rows: HousekeepingLogRow[]): LogGroup[] {
  const groups: LogGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.action === row.action && Math.abs(last.rows[last.rows.length - 1].at - row.at) <= 90_000) {
      last.rows.push(row);
      last.bytes += row.ok ? row.bytes : 0;
      last.refused += row.ok ? 0 : 1;
    } else {
      groups.push({ key: `${row.action}:${row.id}`, action: row.action, at: row.at, rows: [row], bytes: row.ok ? row.bytes : 0, refused: row.ok ? 0 : 1 });
    }
  }
  return groups;
}

/**
 * What housekeeping did, as passes rather than lines: one row per button
 * press or job, with its total and what it refused, opening to the items.
 */
function Log({ initial }: { initial: HousekeepingLogRow[] }) {
  const [rows, setRows] = useState<HousekeepingLogRow[]>(initial);
  const [limit, setLimit] = useState(200);
  const [filter, setFilter] = useState<string>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    window.api.housekeeping
      .log(limit)
      .then(setRows)
      .catch(() => {});
  }, [limit]);
  const actions = [...new Set(rows.map((r) => r.action))];
  const shown = filter === 'all' ? rows : rows.filter((r) => r.action === filter);
  const groups = groupLog(shown);
  const now = Date.now();
  const sum = (since: number) => rows.filter((r) => r.ok && r.at >= since).reduce((a, r) => a + r.bytes, 0);
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  if (!rows.length) return <p className="empty-state">Nothing removed yet. What housekeeping gives back is written here, one line per item.</p>;
  const toggleGroup = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <>
      <div className="monitor-stats">
        <div className="monitor-stat">
          <span className="monitor-stat-label">Today</span>
          <strong>{formatBytes(sum(dayStart))}</strong>
          <small>{rows.filter((r) => r.ok && r.at >= dayStart).length} items</small>
        </div>
        <div className="monitor-stat">
          <span className="monitor-stat-label">Last 7 days</span>
          <strong>{formatBytes(sum(now - 7 * 86_400_000))}</strong>
          <small>{rows.filter((r) => r.ok && r.at >= now - 7 * 86_400_000).length} items</small>
        </div>
        <div className="monitor-stat">
          <span className="monitor-stat-label">In this log</span>
          <strong>{formatBytes(sum(0))}</strong>
          <small>
            {rows.length} line{rows.length === 1 ? '' : 's'}, {rows.filter((r) => !r.ok).length} refused
          </small>
        </div>
      </div>
      <div className="housekeeping-filters">
        <label>
          Show
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">everything</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a] ?? a}
              </option>
            ))}
          </select>
        </label>
        <span className="usage-note">
          {groups.length} pass{groups.length === 1 ? '' : 'es'} · click one to see its items
        </span>
      </div>
      <ul className="housekeeping-log">
        {groups.map((g) => {
          const isOpen = open.has(g.key) || g.rows.length === 1;
          return (
            <li key={g.key} className={`housekeeping-log-group is-${g.action}${g.refused && !g.bytes ? ' is-refused' : ''}`}>
              <button className="housekeeping-log-head" onClick={() => g.rows.length > 1 && toggleGroup(g.key)} aria-expanded={isOpen}>
                <span className="housekeeping-log-when">{whenLabel(g.at, now)}</span>
                <span className={`housekeeping-work is-action-${g.action}`}>{ACTION_LABEL[g.action] ?? g.action}</span>
                <span className="housekeeping-log-title">
                  {g.rows.length === 1 ? g.rows[0].label : `${g.rows.length} items`}
                  {g.rows.length === 1 && g.rows[0].detail ? <small> — {g.rows[0].detail}</small> : null}
                  {g.refused ? <small className="is-error"> · {g.refused} refused</small> : null}
                </span>
                <span className="housekeeping-log-bytes">{g.bytes ? formatBytes(g.bytes) : g.refused ? 'refused' : '—'}</span>
                {g.rows.length > 1 && <span className="housekeeping-log-caret">{isOpen ? '▾' : '▸'}</span>}
              </button>
              {isOpen && g.rows.length > 1 && (
                <ul className="housekeeping-log-items">
                  {g.rows.map((row) => (
                    <li key={row.id} className={row.ok ? '' : 'is-refused'}>
                      <span className="housekeeping-log-when">{new Date(row.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                      <span className="housekeeping-log-title">
                        {row.label}
                        {row.detail ? <small> — {row.detail}</small> : null}
                      </span>
                      <span className="housekeeping-log-bytes">{row.ok ? formatBytes(row.bytes) : 'refused'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {rows.length >= limit && (
        <button className="ghost-btn tiny" onClick={() => setLimit((n) => n + 500)}>
          Show older
        </button>
      )}
    </>
  );
}

/** "went from A to B" for one metric over the stats window, as a stat card. */
function moved(stats: HousekeepingStats, metric: string, label: string, bytes: boolean) {
  const m = stats.moved[metric];
  if (!m) return null;
  const show = (v: number) => (bytes ? formatBytes(v) : String(Math.round(v)));
  const delta = m.to - m.from;
  return (
    <div className="monitor-stat" key={metric}>
      <span className="monitor-stat-label">{label}</span>
      <strong>{show(m.to)}</strong>
      <small>
        {delta === 0 ? 'unchanged' : `${delta > 0 ? '+' : '−'}${show(Math.abs(delta))} since ${new Date(m.fromAt).toLocaleDateString()}`}
      </small>
    </div>
  );
}

function Table({
  rows,
  selected,
  toggle,
  selectAll,
  empty,
  quick,
  inFlight,
  allowForce = false,
}: {
  rows: HousekeepingItem[];
  selected: Set<string>;
  toggle: (id: string) => void;
  selectAll: (list: HousekeepingItem[], on: boolean) => void;
  empty: string;
  /** The row's own button: selects the row alone and arms the list's confirm. */
  quick?: { label: string; run: (one: HousekeepingItem) => void };
  inFlight?: Map<string, 'removing' | 'queued' | 'paused'>;
  /** Blocked rows whose blockers are only the work inside may be ticked one by one, for a removal that says so. */
  allowForce?: boolean;
}) {
  const [sort, setSort] = useState<'size' | 'idle' | 'name'>('size');
  if (!rows.length) return <p className="empty-state">{empty}</p>;
  const free = rows.filter((one) => one.blockers.length === 0 && !inFlight?.has(one.id));
  const allOn = free.length > 0 && free.every((one) => selected.has(one.id));
  const picked = rows.filter((one) => selected.has(one.id));
  const ordered = [...rows].sort((a, b) =>
    sort === 'size' ? b.bytes - a.bytes : sort === 'idle' ? (idleDays(b.lastActivityAt) ?? -1) - (idleDays(a.lastActivityAt) ?? -1) : a.label.localeCompare(b.label),
  );
  const head = (key: 'size' | 'idle' | 'name', label: string, className = '') => (
    <th className={className}>
      <button className={`housekeeping-sort${sort === key ? ' is-on' : ''}`} onClick={() => setSort(key)} title={`Sort by ${label.toLowerCase()}`}>
        {label}
        {sort === key ? ' ▾' : ''}
      </button>
    </th>
  );
  return (
    <table className="housekeeping-table">
      <thead>
        <tr>
          <th>
            <input type="checkbox" checked={allOn} disabled={!free.length} onChange={(e) => selectAll(rows, e.target.checked)} aria-label="select all" />
          </th>
          {head('name', 'What')}
          {head('idle', 'Idle')}
          {head('size', 'Size', 'is-num')}
          <th>State</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {picked.length > 0 && (
          <tr className="housekeeping-picked">
            <td />
            <td colSpan={5}>
              {picked.length} selected, {formatBytes(weigh(picked))}
            </td>
          </tr>
        )}
        {ordered.map((one) => {
          const blocked = one.blockers.length > 0;
          const unsized = one.meta?.sized === false;
          const working = inFlight?.get(one.id) ?? null;
          return (
            <tr key={one.id} className={`${blocked ? 'is-blocked' : ''}${working ? ` is-working is-${working}` : ''}`} title={one.path ?? undefined}>
              <td>
                {working ? (
                  <span className={`housekeeping-spinner${working === 'removing' ? ' is-live' : ''}`} aria-label={working} />
                ) : (
                  <input
                    type="checkbox"
                    className={blocked && allowForce && one.meta?.forceable === true ? 'is-force' : undefined}
                    checked={selected.has(one.id)}
                    disabled={blocked && !(allowForce && one.meta?.forceable === true)}
                    onChange={() => toggle(one.id)}
                    title={blocked && allowForce && one.meta?.forceable === true ? 'Blocked by the work inside; tick to remove it anyway, discarding that work' : undefined}
                    aria-label={`select ${one.label}`}
                  />
                )}
              </td>
              <td>
                <span className="housekeeping-label">{one.label}</span>
                <small>
                  {KIND_LABEL[one.kind]}
                  {one.detail ? ` · ${one.detail}` : ''}
                </small>
              </td>
              <td>{describeIdle(one.lastActivityAt)}</td>
              <td className="is-num">
                {unsized && one.meta?.partial ? (
                  <span className="housekeeping-measuring" title="still measuring">
                    {formatBytes(one.bytes)}…
                  </span>
                ) : unsized ? (
                  <span className="housekeeping-measuring">…</span>
                ) : (
                  formatBytes(one.bytes)
                )}
              </td>
              <td>
                {working && (
                  <span className={`housekeeping-working is-${working}`}>
                    {working === 'removing' ? 'Removing…' : working === 'queued' ? 'Queued' : 'Paused'}
                  </span>
                )}
                {one.kind === 'worktree' && (
                  <span className={`housekeeping-work ${one.meta?.dirty ? 'is-unmerged' : 'is-done'}`} title={one.meta?.dirty ? 'git status lists files changed, staged or untracked' : 'git status is clean'}>
                    {one.meta?.dirty ? `${Number(one.meta?.dirtyCount) || '?'} uncommitted` : 'clean'}
                  </span>
                )}
                {one.kind === 'worktree' && typeof one.meta?.work === 'string' && (
                  <span className={`housekeeping-work is-${String(one.meta.work)}`} title={one.meta.work === 'done' ? 'Its work is on a base branch, or its branch is gone on origin' : one.meta.work === 'unmerged' ? 'Commits or changes no base branch has' : one.meta.work === 'empty' ? 'No commit of its own' : ''}>
                    {one.meta.work === 'done' ? 'done' : one.meta.work === 'unmerged' ? 'unmerged' : one.meta.work === 'empty' ? 'empty' : ''}
                  </span>
                )}
                {one.state ?? ''}
                {blocked && <small className="housekeeping-blocker">{one.blockers.join(', ')}</small>}
              </td>
              <td className="is-num housekeeping-rowactions">
                {quick && !working && (!blocked || Boolean(one.meta?.broken) || (allowForce && one.meta?.forceable === true)) && (
                  <button
                    className={`${blocked && !one.meta?.broken ? 'danger-btn' : 'ghost-btn'} tiny`}
                    onClick={() => quick.run(one)}
                    title={one.meta?.broken ? 'Repair only this one' : blocked ? 'Remove it anyway, discarding the work inside' : `${quick.label} only this one`}
                  >
                    {one.meta?.broken ? 'Repair' : blocked ? 'Remove anyway' : quick.label}
                  </button>
                )}
                {one.path && one.kind !== 'browser-cache' && (
                  <button className="ghost-btn tiny" title={`Show ${one.path} in the file manager`} onClick={() => window.api.files.reveal(one.path as string)}>
                    Show
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
