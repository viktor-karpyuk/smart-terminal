import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import type { GroupRecord, HandoffRecord, HistorySession } from '../global';
import { TranscriptViewer } from './TranscriptViewer';
import { compactPath, formatBytes } from '../lib/labels';
import { Popover } from './Popover';

/**
 * Everything this app has ever run: when each session started, how long it lasted,
 * which account paid for it, and — for sessions closed earlier — a way to pick the
 * conversation back up in a new one.
 */
export function HistoryPanel() {
  const profiles = useStore((s) => s.profiles);
  const homedir = useStore((s) => s.homedir);
  const reopenSession = useStore((s) => s.reopenSession);
  const restoreGroup = useStore((s) => s.restoreGroup);
  const allGroups = useStore((s) => s.groups);
  const focusSession = useStore((s) => s.focusSession);
  const setHistoryOpen = useStore((s) => s.setHistoryOpen);
  const liveSessions = useStore((s) => s.sessions);
  const close = () => useStore.getState().setHistoryOpen(false);

  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'sessions' | 'groups' | 'handoffs'>('sessions');
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [rows, setRows] = useState<HistorySession[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffRecord[]>([]);
  const [excerpts, setExcerpts] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState<HistorySession | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingStop, setPendingStop] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState<number | null>(null);

  const colours = useMemo(() => new Map(profiles.map((p) => [p.id, p.color])), [profiles]);

  /**
   * Sessions that worked together are listed together. A group is the unit people
   * remember afterwards — "the KS-ERP ones" — so a flat list buries exactly the
   * thing you came looking for.
   */
  const sections = useMemo(() => {
    const known = new Map(allGroups.map((group) => [group.id, group]));
    const byGroup = new Map<string, typeof rows>();
    const loose: typeof rows = [];
    for (const row of rows) {
      // A group that has since been disbanded leaves its id behind; those sessions
      // are simply ungrouped now, not members of a group nobody can name.
      if (!row.groupId || !known.has(row.groupId)) loose.push(row);
      else byGroup.set(row.groupId, [...(byGroup.get(row.groupId) ?? []), row]);
    }

    const grouped = [...byGroup.entries()]
      .map(([id, members]) => ({ key: id, group: known.get(id)!, rows: members }))
      // Newest activity first, the same order the flat list uses.
      .sort((a, b) => b.rows[0].startedAt - a.rows[0].startedAt);

    return loose.length ? [...grouped, { key: 'loose', group: null, rows: loose }] : grouped;
  }, [rows, allGroups]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const found = await window.api.history.sessions({ query, limit: 200 });
      setRows(found);
      if (query.trim()) {
        const withText = found.filter((row) => row.matchedTranscript).slice(0, 8);
        const pairs = await Promise.all(
          withText.map(async (row) => [row.id, await window.api.history.excerpts(row.id, query)] as const),
        );
        setExcerpts(Object.fromEntries(pairs));
      } else {
        setExcerpts({});
      }
    } finally {
      setBusy(false);
    }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(load, 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (tab === 'handoffs') window.api.history.handoffs(100).then(setHandoffs);
    if (tab === 'groups') window.api.history.groups({ limit: 100 }).then(setGroups);
  }, [tab]);

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal modal-wide" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2>History</h2>
          <nav className="tabbar">
            <button className={tab === 'sessions' ? 'is-on' : ''} onClick={() => setTab('sessions')}>
              Sessions
            </button>
            <button className={tab === 'groups' ? 'is-on' : ''} onClick={() => setTab('groups')}>
              Groups
            </button>
            <button className={tab === 'handoffs' ? 'is-on' : ''} onClick={() => setTab('handoffs')}>
              Account moves
            </button>
          </nav>
          <button
            className="ghost-btn tiny"
            title="Remove every finished session from history. Running ones stay."
            onClick={async () => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              const removed = await window.api.history.clearHistory({});
              setConfirming(false);
              setCleared(removed);
              load();
            }}
          >
            {confirming ? 'Sure? Clear' : 'Clear finished'}
          </button>
          <button className="ghost-btn tiny" onClick={close}>
            &times;
          </button>
        </header>

        {reading && <TranscriptViewer session={reading} onBack={() => setReading(null)} />}

        {!reading && tab === 'sessions' && (
          <>
            <div className="history-search">
              <input
                autoFocus
                value={query}
                placeholder="Search by name, folder, account — or by what was said"
                onChange={(event) => setQuery(event.target.value)}
              />
              {busy && <span className="history-busy">searching…</span>}
            </div>

            <div className="history-list">
              {cleared !== null && (
                <p className="usage-note">Removed {cleared} finished session{cleared === 1 ? '' : 's'}.</p>
              )}
              {rows.length === 0 && <p className="usage-note">Nothing matches.</p>}
              {sections.map((section) => (
                <section className="history-section" key={section.key}>
                  {section.group && (
                    <header className="history-section-head">
                      <span className="tab-dot" style={{ background: section.group.color }} />
                      <strong style={{ color: section.group.color }}>{section.group.name}</strong>
                      <span className="sidebar-group-count">{section.rows.length}</span>
                      {section.rows.some((row) => row.open) ? (
                        <button
                          className={`ghost-btn tiny${pendingStop === section.key ? ' is-danger' : ''}`}
                          onClick={async () => {
                            if (pendingStop !== section.key) {
                              setPendingStop(section.key);
                              return;
                            }
                            setPendingStop(null);
                            for (const row of section.rows.filter((r) => r.open)) {
                              await window.api.sessions.stop(row.id);
                            }
                            load();
                          }}
                          onBlur={() => setPendingStop((id) => (id === section.key ? null : id))}
                        >
                          {pendingStop === section.key
                            ? `End ${section.rows.filter((r) => r.open).length}?`
                            : 'Stop all'}
                        </button>
                      ) : (
                        <button
                          className="ghost-btn tiny is-primary"
                          title="Bring the whole group back the way it was"
                          onClick={() => restoreGroup(section.group!.id)}
                        >
                          Restore all
                        </button>
                      )}
                    </header>
                  )}
              {section.rows.map((row) => (
                <article className="history-row" key={row.id}>
                  <span className="tab-dot" style={{ background: colours.get(row.profileId) ?? '#5c6370' }} />
                  <button className="history-main history-open" onClick={() => setReading(row)}>
                    <div className="history-title">
                      <strong>
                        {row.title || compactPath(where(row), homedir).split('/').pop() || 'session'}
                      </strong>
                      {row.storeTranscript && (
                        <em className="badge" title="Conversation kept in the database">
                          {row.transcriptBytes ? formatBytes(row.transcriptBytes) : 'kept'}
                        </em>
                      )}
                      {row.open && <em className="badge">running</em>}
                      {row.resumedFrom && (
                        <em className="badge" title="Continues an earlier session's conversation">
                          continues
                        </em>
                      )}
                      {row.matchedTranscript && <em className="badge">match inside</em>}
                    </div>
                    <div className="history-meta">
                      {row.profileName ?? 'account'} · {compactPath(where(row), homedir)}
                    </div>
                    {(excerpts[row.id] ?? []).map((excerpt, i) => (
                      <div className="history-excerpt" key={i}>
                        {excerpt}
                      </div>
                    ))}
                  </button>
                  <div className="history-when">
                    <span>{when(row.startedAt)}</span>
                    <small>{duration(row.durationMs)}</small>
                  </div>
                  <RowAction
                    row={row}
                    isLive={Boolean(liveSessions[row.id])}
                    thisWindow={window.api.windowId}
                    onGoTo={() => {
                      setHistoryOpen(false);
                      focusSession(row.id, { startClaude: true });
                    }}
                    onGoToWindow={() => {
                      setHistoryOpen(false);
                      if (row.windowId) window.api.sessions.focusWindow(row.windowId);
                    }}
                    onReopen={(asProfileId) => reopenSession(row.id, asProfileId)}
                  />
                  {row.open && (
                    <button
                      className={`row-stop${pendingStop === row.id ? ' is-armed' : ''}`}
                      title={
                        pendingStop === row.id
                          ? 'Click again to end this session'
                          : 'End this session, wherever it is running'
                      }
                      onClick={async () => {
                        if (pendingStop !== row.id) {
                          setPendingStop(row.id);
                          return;
                        }
                        setPendingStop(null);
                        await window.api.sessions.stop(row.id);
                        load();
                      }}
                      onBlur={() => setPendingStop((id) => (id === row.id ? null : id))}
                    >
                      {pendingStop === row.id ? 'End it?' : 'Stop'}
                    </button>
                  )}
                  {!row.open && (
                    <button
                      className={`row-delete${pendingDelete === row.id ? ' is-armed' : ''}`}
                      title={
                        pendingDelete === row.id
                          ? 'Click again to delete this session and everything kept for it'
                          : 'Delete this session'
                      }
                      onClick={async () => {
                        if (pendingDelete !== row.id) {
                          setPendingDelete(row.id);
                          return;
                        }
                        setPendingDelete(null);
                        await window.api.history.deleteSession(row.id);
                        load();
                      }}
                      onBlur={() => setPendingDelete((id) => (id === row.id ? null : id))}
                    >
                      {pendingDelete === row.id ? 'Sure?' : '×'}
                    </button>
                  )}
                </article>
              ))}
                </section>
              ))}
            </div>
          </>
        )}

        {!reading && tab === 'groups' && (
          <GroupHistory groups={groups} onChanged={() => window.api.history.groups({ limit: 100 }).then(setGroups)} />
        )}

        {!reading && tab === 'handoffs' && (
          <div className="history-list">
            {handoffs.length === 0 && <p className="usage-note">No conversation has changed account yet.</p>}
            {handoffs.map((entry) => (
              <article className="history-row" key={entry.id}>
                <div className="history-main">
                  <div className="history-title">
                    <strong>
                      {entry.from_profile_name ?? 'account'} &rarr; {entry.to_profile_name ?? 'account'}
                    </strong>
                    <em className="badge">{entry.reason === 'usage-limit' ? 'ran out of usage' : 'moved by hand'}</em>
                  </div>
                  <div className="history-meta">conversation {(entry.claude_session_id ?? '').slice(0, 8)}</div>
                </div>
                <div className="history-when">
                  <span>{when(entry.at)}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Every row can do something, so none of them is dead. A running session is
 * somewhere to go; a finished one with a recorded conversation can be picked up
 * where it stopped; anything else can at least be opened again in the same place
 * under the same account.
 */
function RowAction({
  row,
  isLive,
  thisWindow,
  onGoTo,
  onGoToWindow,
  onReopen,
}: {
  row: HistorySession;
  isLive: boolean;
  thisWindow: string;
  onGoTo(): void;
  onGoToWindow(): void;
  onReopen(asProfileId?: string): void;
}) {
  const profiles = useStore((s) => s.profiles);
  const authByProfile = useStore((s) => s.authByProfile);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [choosing, setChoosing] = useState(false);

  if (row.open && isLive) {
    return (
      <button className="ghost-btn tiny" title="Bring this running session into view" onClick={onGoTo}>
        Go to
      </button>
    );
  }

  // Open, but in another window. Continuing it here would give you two of the
  // same conversation; the useful thing is to go to where it already is.
  if (row.open && row.windowId && row.windowId !== thisWindow) {
    return (
      <button
        className="ghost-btn tiny"
        title="This session is running in another window"
        onClick={onGoToWindow}
      >
        Other window
      </button>
    );
  }

  const resumable = Boolean(row.claudeSessionId);
  // Bringing it back somewhere else. A conversation is not tied to the account
  // that had it, so coming back and changing hands can be the same single step —
  // which is the whole point when the reason it closed was that account running out.
  const elsewhere = profiles.filter(
    (profile) => profile.id !== row.profileId && authByProfile[profile.id]?.loggedIn,
  );

  return (
    <div className="row-reopen">
      <button
        className={`ghost-btn tiny${resumable ? ' is-primary' : ''}`}
        title={
          resumable
            ? 'Open a new session that continues this conversation'
            : 'No conversation was recorded, so this opens a fresh session in the same folder and account'
        }
        onClick={() => onReopen()}
      >
        {resumable ? 'Continue' : 'Open here'}
      </button>
      {elsewhere.length > 0 && (
        <button
          ref={anchorRef}
          className="ghost-btn tiny caret"
          title={`Bring it back on another account than ${row.profileName ?? 'this one'}`}
          onClick={() => setChoosing((open) => !open)}
        >
          ⌄
        </button>
      )}
      {choosing && (
        <Popover anchorEl={anchorRef.current} onClose={() => setChoosing(false)}>
          <div className="menu-label">
            {resumable ? 'Continue on' : 'Open on'}
          </div>
          {elsewhere.map((profile) => (
            <button
              key={profile.id}
              className="menu-item"
              onClick={() => {
                setChoosing(false);
                onReopen(profile.id);
              }}
            >
              <span>
                <i className="group-dot" style={{ background: profile.color, marginRight: 7 }} />
                {profile.name}
              </span>
              <kbd>{authByProfile[profile.id]?.email ?? 'signed in'}</kbd>
            </button>
          ))}
          {resumable && (
            <p className="form-hint">
              The conversation is copied across first, so it comes back with everything it
              had — in the same folder, on the other account.
            </p>
          )}
        </Popover>
      )}
    </div>
  );
}

const ARRANGEMENTS = [
  { id: 'tabs', label: 'as tabs' },
  { id: 'columns', label: 'side by side' },
  { id: 'rows', label: 'stacked' },
  { id: 'grid', label: 'in a grid' },
] as const;

/**
 * Groups you have worked in, whether or not anything of them is still open.
 * Bringing one back opens every session it had, each continuing its own
 * conversation, laid out the way you ask for.
 */
function GroupHistory({ groups, onChanged }: { groups: GroupRecord[]; onChanged(): void }) {
  const restoreGroup = useStore((s) => s.restoreGroup);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  if (!groups.length) {
    return (
      <div className="history-list">
        <p className="usage-note">
          No groups yet. Group the tabs sitting together in a pane with the &#9678; button on its tab
          strip, and the whole set becomes something you can bring back from here.
        </p>
      </div>
    );
  }

  return (
    <div className="history-list">
      {groups.map((group) => (
        <article className="history-row" key={group.id}>
          <span className="tab-dot" style={{ background: group.color ?? 'var(--text-faint)' }} />
          <div className="history-main">
            <div className="history-title">
              <strong>{group.name}</strong>
              {group.open > 0 && <em className="badge">{group.open} open</em>}
              {group.fontSize && <em className="badge">{group.fontSize}px</em>}
            </div>
            <div className="history-meta">
              {group.members} session{group.members === 1 ? '' : 's'} ·{' '}
              {group.resumable} with a conversation to continue
            </div>
          </div>

          <div className="group-restore">
            <select
              defaultValue=""
              aria-label={`How to arrange ${group.name}`}
              onChange={async (event) => {
                const arrangement = event.target.value as (typeof ARRANGEMENTS)[number]['id'];
                setBusy(group.id);
                try {
                  await restoreGroup(group.id, arrangement);
                } finally {
                  setBusy(null);
                }
              }}
            >
              <option value="" disabled>
                Restore…
              </option>
              {ARRANGEMENTS.map((option) => (
                <option key={option.id} value={option.id}>
                  Restore {option.label}
                  {group.arrangement === option.id ? ' (as it was)' : ''}
                </option>
              ))}
            </select>
            <button
              className="ghost-btn tiny is-primary"
              disabled={busy === group.id}
              onClick={async () => {
                setBusy(group.id);
                try {
                  // No arrangement named: it comes back the way it was left.
                  await restoreGroup(group.id);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === group.id ? 'Opening…' : `Restore all ${group.members}`}
            </button>
          </div>

          <button
            className={`row-delete${pendingDelete === group.id ? ' is-armed' : ''}`}
            title="Forget this group. Its sessions stay in history."
            onClick={async () => {
              if (pendingDelete !== group.id) {
                setPendingDelete(group.id);
                return;
              }
              setPendingDelete(null);
              await window.api.history.deleteGroup(group.id);
              onChanged();
            }}
            onBlur={() => setPendingDelete((id) => (id === group.id ? null : id))}
          >
            {pendingDelete === group.id ? 'Sure?' : '×'}
          </button>
        </article>
      ))}
    </div>
  );
}

/** Where a session was working, which is not always where it opened. */
function where(row: HistorySession) {
  return row.lastCwd || row.startCwd;
}

function when(at: number) {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function duration(ms: number) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
