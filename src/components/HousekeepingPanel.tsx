import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { describeIdle, diskUsedPercent, filterSessions, formatBytes, freeable, inBucket, weigh, withSize } from '../lib/housekeeping';

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

type Tab = 'sessions' | 'worktrees' | 'app' | 'log';

const TABS: { id: Tab; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'worktrees', label: 'Worktrees' },
  { id: 'app', label: 'App' },
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
  const alive = useRef(true);

  const load = async ({ measure = true } = {}) => {
    setBusy('reading');
    setError(null);
    try {
      const next = await window.api.housekeeping.inventory();
      if (!alive.current) return;
      setInventory(next);
      setItems(next.items);
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
    const off = window.api.housekeeping.onSize(({ path, bytes }) => {
      setItems((prev) => withSize(prev, path, bytes));
      setMeasuring((n) => Math.max(0, n - 1));
    });
    return () => {
      alive.current = false;
      off();
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
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      if (alive.current) setBusy(null);
    }
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
        <button className="ghost-btn tiny" disabled={Boolean(busy) || measuring > 0} onClick={() => {
            const own = items.filter((one) => one.kind !== 'session' && one.kind !== 'browser-cache' && one.path).map((one) => one.path as string);
            setMeasuring(own.length);
            void window.api.housekeeping.measure(own, true).finally(() => setMeasuring(0));
          }} title="Walk every folder again, ignoring the remembered sizes">
          Measure again
        </button>
        {said && <span className="usage-note">{said}</span>}
        {error && <span className="usage-note is-error">{error}</span>}
      </div>

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
        />
      )}
      {tab === 'worktrees' && <Worktrees items={items} roots={inventory.roots} selected={selected} toggle={toggle} selectAll={selectAll} chosen={chosen} confirm={confirm} reload={() => load()} />}
      {tab === 'app' && <AppFiles items={items} selected={selected} toggle={toggle} selectAll={selectAll} chosen={chosen} confirm={confirm} />}
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
      <Table rows={rows} selected={selected} toggle={toggle} selectAll={selectAll} empty="No session matches. Lower the days or the size." />
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

function Worktrees({ items, roots, selected, toggle, selectAll, chosen, confirm, reload }: ListProps & { roots: HousekeepingRoot[]; reload: () => void }) {
  const caches = items.filter((one) => one.kind === 'build-cache');
  const shops = items.filter((one) => one.kind === 'workshop');
  const pickedCaches = chosen(caches);
  const pickedShops = chosen(shops);
  const [adding, setAdding] = useState(false);

  const addRoot = async () => {
    setAdding(true);
    try {
      const folder = await window.api.system.pickDirectory();
      if (folder) {
        await window.api.housekeeping.addRoot(folder);
        reload();
      }
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
              onClick={async () => {
                await window.api.housekeeping.removeRoot(root.path);
                reload();
              }}
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

      <h3 className="monitor-heading">Build caches</h3>
      <p className="usage-note">
        Folders a build writes and writes again: .angular, node_modules, target, dist. Removing one costs the next build a rebuild and nothing else. A folder git does not ignore is refused.
      </p>
      <Table rows={caches} selected={selected} toggle={toggle} selectAll={selectAll} empty="No build caches under the folders above." />
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
      <Table rows={shops} selected={selected} toggle={toggle} selectAll={selectAll} empty="No review clones on disk." />
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

function AppFiles({ items, selected, toggle, selectAll, chosen, confirm }: ListProps) {
  const rows = inBucket(items, 'app');
  const picked = chosen(rows);
  return (
    <>
      <p className="usage-note">
        What the app keeps beside its database: copies of the database and of whole data folders made before upgrades, installers already downloaded, pasted images, the window's own cache. The database itself is tended from the Monitor.
      </p>
      <Table rows={rows} selected={selected} toggle={toggle} selectAll={selectAll} empty="Nothing beside the database." />
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

function Table({
  rows,
  selected,
  toggle,
  selectAll,
  empty,
}: {
  rows: HousekeepingItem[];
  selected: Set<string>;
  toggle: (id: string) => void;
  selectAll: (list: HousekeepingItem[], on: boolean) => void;
  empty: string;
}) {
  if (!rows.length) return <p className="empty-state">{empty}</p>;
  const free = rows.filter((one) => one.blockers.length === 0);
  const allOn = free.length > 0 && free.every((one) => selected.has(one.id));
  return (
    <table className="housekeeping-table">
      <thead>
        <tr>
          <th>
            <input type="checkbox" checked={allOn} disabled={!free.length} onChange={(e) => selectAll(rows, e.target.checked)} aria-label="select all" />
          </th>
          <th>What</th>
          <th>Idle</th>
          <th className="is-num">Size</th>
          <th>State</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((one) => {
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
              <td className="is-num">{unsized ? <span className="housekeeping-measuring">…</span> : formatBytes(one.bytes)}</td>
              <td>{blocked ? <span className="housekeeping-blocker">{one.blockers.join(', ')}</span> : (one.state ?? '')}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
