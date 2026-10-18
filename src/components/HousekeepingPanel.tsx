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
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [olderThan, setOlderThan] = useState(30);
  const [minMb, setMinMb] = useState(0);
  const [includeOpen, setIncludeOpen] = useState(false);
  const [health, setHealth] = useState<HousekeepingHealth | null>(null);
  const [plan, setPlan] = useState<HousekeepingProposal[]>([]);
  const [stats, setStats] = useState<HousekeepingStats | null>(null);
  const [progress, setProgress] = useState<HousekeepingProgress | null>(null);
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
          setInventory({ ...kept, unsized: [], roots: kept.roots ?? [], checkouts: kept.checkouts ?? 0, log: kept.log ?? [] } as HousekeepingInventory);
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
      if (clear) clearTimeout(clear);
    };
    // Read once when it opens; "Refresh" reads again. Polling a disk to watch it not change is what makes a panel expensive to leave open.
  }, []);

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
    setConfirming(null);
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
      const out = await window.api.housekeeping.act(action.id, action.ids ?? []);
      const failed = (out.results ?? []).filter((one) => !one.ok).length;
      const freed = out.freed ?? out.bytes ?? 0;
      return `${proposal.title}: done, ${formatBytes(freed)} given back${failed ? `, ${failed} refused` : ''}.`;
    });
  };

  const pick = (id: string) => setSelected(new Set([id]));
  const arm = (key: string) => setConfirming(key);

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
  const chosen = (list: HousekeepingItem[]) => list.filter((one) => selected.has(one.id) && one.blockers.length === 0);

  const confirm = (key: string, label: string, detail: string, work: () => Promise<string>, danger = false, disabled = false) =>
    confirming === key ? (
      <span className="storage-confirm">
        <em>{detail}</em>
        <button className={danger ? 'danger-btn tiny' : 'ghost-btn tiny'} onClick={() => run(key, work)}>
          Yes, do it
        </button>
        <button className="ghost-btn tiny" onClick={() => setConfirming(null)}>
          No
        </button>
      </span>
    ) : (
      <button className={danger ? 'danger-btn tiny' : 'ghost-btn tiny'} disabled={disabled || Boolean(busy)} onClick={() => setConfirming(key)}>
        {label}
      </button>
    );

  return (
    <div className="housekeeping">
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
          async () => {
            const out = await window.api.housekeeping.free(freeNow.map((one) => one.id));
            const failed = out.results.filter((one) => !one.ok);
            return `Gave back ${formatBytes(out.freed)}.${failed.length ? ` ${failed.length} could not be removed: ${failed[0].error}` : ''}`;
          },
          false,
          freeNow.length === 0,
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

      {progress && (
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
            .map((one) =>
              confirming === `quick:${one.id}` ? (
                <span key={one.id} className="storage-confirm">
                  <em>{one.detail}</em>
                  <button className={one.action?.danger ? 'danger-btn tiny' : 'ghost-btn tiny'} onClick={() => doAction(one)}>
                    Yes, do it
                  </button>
                  <button className="ghost-btn tiny" onClick={() => setConfirming(null)}>
                    No
                  </button>
                </span>
              ) : (
                <button key={one.id} className={`ghost-btn tiny housekeeping-chip is-${one.priority}`} disabled={Boolean(busy)} title={one.detail} onClick={() => setConfirming(`quick:${one.id}`)}>
                  {one.action?.label}
                </button>
              ),
            )}
        </div>
      )}

      <div className="housekeeping-tabs" role="tablist">
        {TABS.map((one) => (
          <button key={one.id} role="tab" aria-selected={tab === one.id} className={`housekeeping-tab${tab === one.id ? ' is-on' : ''}`} onClick={() => setTab(one.id)}>
            {one.label}
          </button>
        ))}
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
          pick={pick}
          arm={arm}
        />
      )}
      {tab === 'worktrees' && (
        <Worktrees items={items} roots={inventory.roots} selected={selected} toggle={toggle} selectAll={selectAll} chosen={chosen} confirm={confirm} pick={pick} arm={arm} reload={() => load()} onError={setError} />
      )}
      {tab === 'app' && <AppFiles items={items} selected={selected} toggle={toggle} selectAll={selectAll} chosen={chosen} confirm={confirm} pick={pick} arm={arm} />}
      {tab === 'health' && <Health health={health} setHealth={setHealth} onError={setError} ask={askClaude} asking={busy === 'ask'} plan={plan} stats={stats} doAction={doAction} confirming={confirming} setConfirming={setConfirming} busy={Boolean(busy)} />}
      {tab === 'log' && <Log rows={inventory.log} />}
    </div>
  );
}

// --- the tabs --------------------------------------------------------------------

type Confirm = (key: string, label: string, detail: string, work: () => Promise<string>, danger?: boolean, disabled?: boolean) => ReactElement;

interface ListProps {
  items: HousekeepingItem[];
  selected: Set<string>;
  toggle: (id: string) => void;
  selectAll: (list: HousekeepingItem[], on: boolean) => void;
  chosen: (list: HousekeepingItem[]) => HousekeepingItem[];
  confirm: Confirm;
  /** Select only this row, and arm the confirm named: the row's own button. */
  pick: (id: string) => void;
  arm: (key: string) => void;
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
  pick,
  arm,
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
      <Table rows={rows} selected={selected} toggle={toggle} selectAll={selectAll} empty="No session matches. Lower the days or the size." quick={{ label: 'Forget', run: (one) => { pick(one.id); arm('forget'); } }} />
      <div className="storage-actions">
        {confirm(
          'forget',
          `Forget ${picked.length} conversation${picked.length === 1 ? '' : 's'} (${formatBytes(weigh(picked))})`,
          'Deletes the kept conversations and their saved copies. The record of what ran, when and where stays in History.',
          async () => {
            const out = await window.api.housekeeping.forgetTranscripts(picked.map((one) => String(one.meta?.sessionId)));
            return `Forgot ${out.count} conversation${out.count === 1 ? '' : 's'}, ${formatBytes(out.bytes)}.`;
          },
          false,
          picked.length === 0,
        )}
        {confirm(
          'delete',
          `Delete ${picked.length} session${picked.length === 1 ? '' : 's'} entirely`,
          'Removes the sessions — record, conversation, messages and readings. This cannot be undone.',
          async () => {
            const out = await window.api.housekeeping.deleteSessions(picked.map((one) => String(one.meta?.sessionId)));
            return `Deleted ${out.deleted.length} session${out.deleted.length === 1 ? '' : 's'}${out.skipped.length ? `, left ${out.skipped.length} running` : ''}.`;
          },
          true,
          picked.length === 0,
        )}
      </div>
    </>
  );
}

function Worktrees({ items, roots, selected, toggle, selectAll, chosen, confirm, pick, arm, reload, onError }: ListProps & { roots: HousekeepingRoot[]; reload: () => void; onError: (message: string) => void }) {
  const caches = items.filter((one) => one.kind === 'build-cache');
  const shops = items.filter((one) => one.kind === 'workshop');
  const pickedCaches = chosen(caches);
  const pickedShops = chosen(shops);
  const [adding, setAdding] = useState(false);
  const [idleFor, setIdleFor] = useState(0);
  const [finishedOnly, setFinishedOnly] = useState(false);
  const trees = filterWorktrees(items, { olderThanDays: idleFor, finishedOnly });
  const allTrees = items.filter((one) => one.kind === 'worktree');
  const pickedTrees = chosen(trees);
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

  return (
    <>
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
      <Table rows={trees} selected={selected} toggle={toggle} selectAll={selectAll} empty={allTrees.length ? 'No worktree matches. Lower the days or untick finished only.' : 'No worktrees found. Add the folder they live in above.'} quick={{ label: 'Remove', run: (one) => { pick(one.id); arm('trees'); } }} />
      <div className="storage-actions">
        {confirm(
          'trees',
          `Remove ${pickedTrees.length} worktree${pickedTrees.length === 1 ? '' : 's'} (${formatBytes(weigh(pickedTrees))})`,
          'git worktree remove, never forced: anything that changed since it was looked at is refused. A finished branch is deleted; an unfinished one keeps its commits.',
          async () => {
            const out = await window.api.housekeeping.removeWorktrees(pickedTrees.map((one) => one.id));
            const failed = out.results.filter((one) => !one.ok);
            return `Removed ${out.results.length - failed.length}, ${formatBytes(out.freed)}.${failed.length ? ` ${failed.length} refused: ${failed[0].error}` : ''}`;
          },
          true,
          pickedTrees.length === 0,
        )}
        {finished.length > 0 &&
          confirm(
            'finished',
            `Remove all ${finished.length} finished (${formatBytes(weigh(finished))})`,
            'Only worktrees whose work is merged or whose branch is gone on origin, with nothing of their own and nobody inside.',
            async () => {
              const out = await window.api.housekeeping.removeWorktrees(finished.map((one) => one.id));
              const failed = out.results.filter((one) => !one.ok);
              return `Removed ${out.results.length - failed.length}, ${formatBytes(out.freed)}.${failed.length ? ` ${failed.length} refused: ${failed[0].error}` : ''}`;
            },
            true,
          )}
      </div>

      <h3 className="monitor-heading">Build caches</h3>
      <p className="usage-note">
        Folders a build writes and writes again: .angular, node_modules, target, dist. Removing one costs the next build a rebuild and nothing else. A folder git does not ignore is refused. A cache inside a worktree listed above is shown here but counted inside that worktree's size.
      </p>
      <Table rows={caches} selected={selected} toggle={toggle} selectAll={selectAll} empty="No build caches under the folders above." quick={{ label: 'Clear', run: (one) => { pick(one.id); arm('caches'); } }} />
      <div className="storage-actions">
        {confirm(
          'caches',
          `Clear ${pickedCaches.length} cache${pickedCaches.length === 1 ? '' : 's'} (${formatBytes(weigh(pickedCaches))})`,
          'Each folder is renamed aside at once and deleted in the background. The next build rewrites it.',
          async () => {
            const out = await window.api.housekeeping.free(pickedCaches.map((one) => one.id));
            const failed = out.results.filter((one) => !one.ok);
            return `Cleared ${formatBytes(out.freed)}.${failed.length ? ` ${failed.length} refused: ${failed[0].error}` : ''}`;
          },
          false,
          pickedCaches.length === 0,
        )}
      </div>

      <h3 className="monitor-heading">Code Reviewer clones</h3>
      <p className="usage-note">A clone per pull request the reviewer wrote fixes in. One whose pull request is closed and whose fixes were handed back can go.</p>
      <Table rows={shops} selected={selected} toggle={toggle} selectAll={selectAll} empty="No review clones on disk." quick={{ label: 'Discard', run: (one) => { pick(one.id); arm('shops'); } }} />
      <div className="storage-actions">
        {confirm(
          'shops',
          `Discard ${pickedShops.length} clone${pickedShops.length === 1 ? '' : 's'} (${formatBytes(weigh(pickedShops))})`,
          'The reviewer refuses any clone with a fix still waiting to be handed back.',
          async () => {
            const out = await window.api.housekeeping.discardWorkshops(pickedShops.map((one) => one.id));
            const failed = out.results.filter((one) => !one.ok);
            return `Discarded ${out.results.length - failed.length}.${failed.length ? ` ${failed.length} refused: ${failed[0].error}` : ''}`;
          },
          true,
          pickedShops.length === 0,
        )}
      </div>
    </>
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

function AppFiles({ items, selected, toggle, selectAll, chosen, confirm, pick, arm }: ListProps) {
  const rows = inBucket(items, 'app');
  const picked = chosen(rows);
  return (
    <>
      <p className="usage-note">
        What the app keeps beside its database: copies of the database and of whole data folders made before upgrades, installers already downloaded, pasted images, the window's own cache. The database itself is tended from the Monitor.
      </p>
      <Table rows={rows} selected={selected} toggle={toggle} selectAll={selectAll} empty="Nothing beside the database." quick={{ label: 'Remove', run: (one) => { pick(one.id); arm('app'); } }} />
      <div className="storage-actions">
        {confirm(
          'app',
          `Remove ${picked.length} item${picked.length === 1 ? '' : 's'} (${formatBytes(weigh(picked))})`,
          'Backups older than the running version, installers, pasted images and caches. The newest downloaded update is the one waiting to be installed.',
          async () => {
            const out = await window.api.housekeeping.free(picked.map((one) => one.id));
            const failed = out.results.filter((one) => !one.ok);
            return `Removed ${formatBytes(out.freed)}.${failed.length ? ` ${failed.length} refused: ${failed[0].error}` : ''}`;
          },
          false,
          picked.length === 0,
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
  doAction,
  confirming,
  setConfirming,
  busy: parentBusy,
}: {
  health: HousekeepingHealth | null;
  setHealth: (h: HousekeepingHealth | null) => void;
  onError: (m: string) => void;
  ask: (question?: string) => void;
  asking: boolean;
  plan: HousekeepingProposal[];
  stats: HousekeepingStats | null;
  doAction: (p: HousekeepingProposal) => void;
  confirming: string | null;
  setConfirming: (k: string | null) => void;
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
              {one.action &&
                (confirming === `plan:${one.id}` ? (
                  <span className="storage-confirm">
                    <em>{one.action.danger ? 'This cannot be undone.' : 'It comes back by itself when needed.'}</em>
                    <button className={one.action.danger ? 'danger-btn tiny' : 'ghost-btn tiny'} onClick={() => doAction(one)}>
                      Yes, do it
                    </button>
                    <button className="ghost-btn tiny" onClick={() => setConfirming(null)}>
                      No
                    </button>
                  </span>
                ) : (
                  <button
                    className={one.action.danger ? 'danger-btn tiny' : 'ghost-btn tiny'}
                    disabled={parentBusy}
                    onClick={() => (one.action?.id === 'show-sessions' || one.action?.id === 'show-worktrees' ? doAction(one) : setConfirming(`plan:${one.id}`))}
                  >
                    {one.action.label}
                  </button>
                ))}
            </li>
          ))}
        </ol>
      )}

      {stats && (
        <>
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

function Log({ rows }: { rows: HousekeepingLogRow[] }) {
  if (!rows.length) return <p className="empty-state">Nothing removed yet.</p>;
  return (
    <table className="housekeeping-table">
      <thead>
        <tr>
          <th>When</th>
          <th>What</th>
          <th className="is-num">Gave back</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className={row.ok ? '' : 'is-failed'}>
            <td>{new Date(row.at).toLocaleString()}</td>
            <td>
              {row.action.replace(/-/g, ' ')} · {row.label}
              {row.detail && <small> — {row.detail}</small>}
            </td>
            <td className="is-num">{row.ok ? formatBytes(row.bytes) : 'refused'}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
}: {
  rows: HousekeepingItem[];
  selected: Set<string>;
  toggle: (id: string) => void;
  selectAll: (list: HousekeepingItem[], on: boolean) => void;
  empty: string;
  /** The row's own button: selects the row alone and arms the list's confirm. */
  quick?: { label: string; run: (one: HousekeepingItem) => void };
}) {
  const [sort, setSort] = useState<'size' | 'idle' | 'name'>('size');
  if (!rows.length) return <p className="empty-state">{empty}</p>;
  const free = rows.filter((one) => one.blockers.length === 0);
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
          return (
            <tr key={one.id} className={blocked ? 'is-blocked' : ''} title={one.path ?? undefined}>
              <td>
                <input type="checkbox" checked={selected.has(one.id)} disabled={blocked} onChange={() => toggle(one.id)} aria-label={`select ${one.label}`} />
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
                {one.kind === 'worktree' && typeof one.meta?.work === 'string' && (
                  <span className={`housekeeping-work is-${String(one.meta.work)}`} title={one.meta.work === 'done' ? 'Its work is on a base branch, or its branch is gone on origin' : one.meta.work === 'unmerged' ? 'Commits or changes no base branch has' : one.meta.work === 'empty' ? 'No commit of its own' : ''}>
                    {one.meta.work === 'done' ? 'done' : one.meta.work === 'unmerged' ? 'unmerged' : one.meta.work === 'empty' ? 'empty' : ''}
                  </span>
                )}
                {one.state ?? ''}
                {blocked && <small className="housekeeping-blocker">{one.blockers.join(', ')}</small>}
              </td>
              <td className="is-num housekeeping-rowactions">
                {quick && !blocked && (
                  <button className="ghost-btn tiny" onClick={() => quick.run(one)} title={`${quick.label} only this one`}>
                    {quick.label}
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
