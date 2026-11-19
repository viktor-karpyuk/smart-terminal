import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import type { GroupRecord, HandoffRecord, HistorySession, WorktreeCleanup } from '../global';
import { TranscriptViewer } from './TranscriptViewer';
import { compactPath, formatBytes } from '../lib/labels';
import { Popover } from './Popover';
import { legible } from '../lib/looks';
import { CaretIcon } from './icons';
import { canRestore, GroupSessions } from './GroupSessions';

/**
 * Where the list was left, for as long as the app is running.
 *
 * Opening a session to see what it was about unmounts the list, and closing
 * History to go to one throws the whole panel away, so either way the list came
 * back at the top and the person had to find their place again — usually after
 * scrolling past a hundred sessions to get there. The tab, the search and how
 * far down it was are kept here instead, per tab and search, and so is the
 * session last opened, which is marked and kept in view when the list returns.
 */
const place = {
  tab: 'sessions' as 'sessions' | 'groups' | 'handoffs',
  query: '',
  scroll: new Map<string, number>(),
  last: null as string | null,
};

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

  const [query, setQuery] = useState(place.query);
  const [tab, setTab] = useState<'sessions' | 'groups' | 'handoffs'>(place.tab);
  const [last, setLast] = useState<string | null>(place.last);
  useEffect(() => {
    place.query = query;
    place.tab = tab;
  }, [query, tab]);

  /*
   * The sessions list, and whether this mount of it has been put back where it
   * was. It is put back once, as soon as it has rows: before that there is
   * nothing to scroll, and after it the person is the one scrolling.
   */
  const listRef = useRef<HTMLDivElement | null>(null);
  const placed = useRef(false);
  const placeKey = `${tab}|${query.trim()}`;
  /*
   * Stable on purpose. An inline ref callback is a new function every render,
   * so React called it with null and then the element on every keystroke and
   * every click — and each of those calls marked the list as "not put back
   * yet". From then on scrolling was not remembered, and the next reload (a
   * delete) put the list back at whatever depth was last recorded: the top.
   */
  const setListRef = useCallback((el: HTMLDivElement | null) => {
    if (el && el !== listRef.current) placed.current = false;
    listRef.current = el;
  }, []);
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [rows, setRows] = useState<HistorySession[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffRecord[]>([]);
  const [excerpts, setExcerpts] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  /** Whether the first answer is in, so an empty list is not called a miss before it is asked. */
  const [loaded, setLoaded] = useState(false);
  const [reading, setReading] = useState<HistorySession | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingStop, setPendingStop] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState<number | null>(null);
  /** What the last delete did to the worktrees the sessions were in. */
  const [treeNote, setTreeNote] = useState<string | null>(null);
  const noteWorktrees = (result: WorktreeCleanup) => setTreeNote(worktreeNote(result, homedir));
  /*
   * The sessions picked to come back.
   *
   * By id rather than by row, because the rows are replaced on every search and
   * every reload — a selection held as objects would quietly empty itself the
   * moment somebody typed another letter.
   */
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [restoring, setRestoring] = useState(false);
  const [restoreNote, setRestoreNote] = useState<string | null>(null);
  const restoreSessions = useStore((s) => s.restoreSessions);

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
      .sort((a, b) => lastActive(b.rows[0]) - lastActive(a.rows[0]));

    return loose.length ? [...grouped, { key: 'loose', group: null, rows: loose }] : grouped;
  }, [rows, allGroups]);

  /*
   * The answer to the question that is being asked, not to an older one.
   *
   * The debounce cancelled the timer but nothing cancelled a search already on
   * its way, and a broader query takes longer — so typing "auth" then "authz"
   * could leave "auth"'s results on screen under the word "authz", with the
   * older search's `finally` clearing the spinner while the newer one was still
   * running. Each run carries a flag its own cleanup clears.
   */
  const load = useCallback(async (alive: () => boolean) => {
    setBusy(true);
    try {
      const found = await window.api.history.sessions({ query, limit: 200 });
      if (!alive()) return;
      setRows(found);
      setLoaded(true);
      if (query.trim()) {
        const withText = found.filter((row) => row.matchedTranscript).slice(0, 8);
        const pairs = await Promise.all(
          withText.map(async (row) => [row.id, await window.api.history.excerpts(row.id, query)] as const),
        );
        if (!alive()) return;
        setExcerpts(Object.fromEntries(pairs));
      } else {
        setExcerpts({});
      }
    } finally {
      if (alive()) setBusy(false);
    }
  }, [query]);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => { void load(() => live); }, 180);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    if (tab === 'handoffs') window.api.history.handoffs(100).then(setHandoffs);
    if (tab === 'groups') window.api.history.groups({ limit: 100 }).then(setGroups);
  }, [tab]);

  /*
   * Back where it was left. Layout, not an ordinary effect, so the list is never
   * painted at the top first and then jumps. The scroll is the part that
   * matters; the session last opened is then kept in view, in case the list
   * moved under it — something ran and rose, or new sessions arrived above.
   */
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || reading || tab !== 'sessions' || placed.current || rows.length === 0) return;
    el.scrollTop = place.scroll.get(placeKey) ?? 0;
    if (last) {
      const row = el.querySelector<HTMLElement>(`[data-history-id="${CSS.escape(last)}"]`);
      const box = row?.getBoundingClientRect();
      const frame = el.getBoundingClientRect();
      if (row && box && (box.top < frame.top || box.bottom > frame.bottom)) row.scrollIntoView({ block: 'center' });
    }
    placed.current = true;
  }, [reading, tab, rows, placeKey, last]);

  // A new search is a new list: it starts at its own top, not at the old one's depth.
  useEffect(() => {
    placed.current = false;
  }, [placeKey]);

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal modal-wide" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2>History</h2>
          <nav className="tabbar">
            <button className={tab === 'sessions' ? 'is-on' : ''} onClick={() => setTab('sessions')}>
              Sessions
            </button>
            <button className={tab === 'groups' ? 'is-on' : ''} onClick={() => { setTab('groups'); setPicked(new Set()); }}>
              Groups
            </button>
            <button className={tab === 'handoffs' ? 'is-on' : ''} onClick={() => { setTab('handoffs'); setPicked(new Set()); }}>
              Account moves
            </button>
          </nav>
          <button className="ghost-btn tiny modal-close" onClick={close} aria-label="Close">
            &times;
          </button>
        </header>

        {reading && (
          <TranscriptViewer
            session={reading}
            onBack={() => {
              placed.current = false;
              setReading(null);
            }}
          />
        )}

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
              {/* Here rather than in the header: it only means anything on this tab. */}
              <button
                className={`ghost-btn tiny${confirming ? ' is-danger' : ''}`}
                title="Remove every finished session from history. Running ones stay."
                onClick={async () => {
                  if (!confirming) {
                    setConfirming(true);
                    return;
                  }
                  const { removed, worktrees } = await window.api.history.clearHistory({});
                  setConfirming(false);
                  setCleared(removed);
                  noteWorktrees(worktrees);
                  void load(() => true);
                }}
              >
                {confirming ? 'Sure? Clear' : 'Clear finished'}
              </button>
            </div>

            {picked.size > 0 && (
              /*
               * Only once something is picked. A bar that is always there is a
               * row of height spent on a mode nobody is in yet.
               */
              <div className="history-picked">
                <strong>
                  {picked.size} session{picked.size === 1 ? '' : 's'} picked
                </strong>
                <button
                  className="ghost-btn tiny is-primary"
                  disabled={restoring}
                  onClick={async () => {
                    setRestoring(true);
                    setRestoreNote(null);
                    /*
                     * In the order they are listed, which is the order somebody
                     * reading the list was thinking in — not the order of a Set.
                     *
                     * Then whatever else is picked but not on screen. Searching
                     * after picking is normal, and a Restore that quietly dropped
                     * the ones the search hid would be the worst kind of wrong:
                     * it would look like it worked.
                     */
                    const listed = rows.filter((row) => picked.has(row.id)).map((row) => row.id);
                    const ordered = [...listed, ...[...picked].filter((id) => !listed.includes(id))];
                    const { restored, failed } = await restoreSessions(ordered);
                    setRestoring(false);
                    setPicked(new Set(failed));
                    if (failed.length) {
                      setRestoreNote(
                        `${restored.length} came back. ${failed.length} could not — still picked, so you can see which.`,
                      );
                    }
                  }}
                >
                  {restoring ? 'Restoring…' : `Restore ${picked.size}`}
                </button>
                <button className="ghost-btn tiny" disabled={restoring} onClick={() => setPicked(new Set())}>
                  Clear
                </button>
              </div>
            )}

            <div
              className="history-list"
              ref={setListRef}
              onScroll={(event) => {
                if (placed.current) place.scroll.set(placeKey, event.currentTarget.scrollTop);
              }}
            >
              {restoreNote && <p className="usage-note">{restoreNote}</p>}
              {treeNote && (
                <p className="usage-note" title={treeNote}>
                  {treeNote}{' '}
                  <button className="link-btn" onClick={() => setTreeNote(null)}>
                    Dismiss
                  </button>
                </p>
              )}
              {cleared !== null && (
                <p className="usage-note">Removed {cleared} finished session{cleared === 1 ? '' : 's'}.</p>
              )}
              {rows.length === 0 && (
                <p className="empty-state">
                  {!loaded
                    ? 'Reading history…'
                    : query.trim()
                      ? `Nothing matches “${query.trim()}”.`
                      : 'No sessions yet — closed sessions show up here.'}
                </p>
              )}
              {sections.map((section) => (
                <section className="history-section" key={section.key}>
                  {section.group && (
                    <header className="history-section-head">
                      <span className="tab-dot" style={{ background: section.group.color }} />
                      <strong style={{ color: legible(section.group.color) }}>{section.group.name}</strong>
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
                            void load(() => true);
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
                <article
                  className={`history-row${picked.has(row.id) ? ' is-picked' : ''}${last === row.id ? ' is-last' : ''}`}
                  key={row.id}
                  data-history-id={row.id}
                >
                  {/*
                    Only what can actually come back is offered. A session running
                    in this window is already here, and a checkbox beside it would
                    be a promise the Restore button could not keep.
                  */}
                  {canRestore(row, liveSessions, window.api.windowId) ? (
                    <label className="history-pick" title="Pick this one to bring back">
                      <input
                        type="checkbox"
                        checked={picked.has(row.id)}
                        onChange={(event) =>
                          setPicked((was) => {
                            const next = new Set(was);
                            if (event.target.checked) next.add(row.id);
                            else next.delete(row.id);
                            return next;
                          })
                        }
                      />
                    </label>
                  ) : (
                    <span className="history-pick is-empty" aria-hidden="true" />
                  )}
                  <span className="tab-dot" style={{ background: colours.get(row.profileId) ?? 'var(--text-faint)' }} />
                  <button
                    className="history-main history-open"
                    onClick={() => {
                      place.last = row.id;
                      setLast(row.id);
                      setReading(row);
                    }}
                  >
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
                    {/* When something last happened here, because that is what
                        the list is ordered by and what people are looking for.
                        Whether it is still open is a badge on the title, which
                        is a different question and no longer this one. */}
                    <span title={whenTitle(row)}>{closedAt(lastActive(row))}</span>
                    <small title={`opened ${new Date(row.startedAt).toLocaleString()}`}>
                      {duration(row.durationMs)}
                    </small>
                    {row.stats && (
                      // The conversation, not the tab: a resumed session can
                      // have been open five minutes and carry a thousand
                      // requests, because the requests are the whole
                      // conversation's and the five minutes are this sitting's.
                      <small title={`the whole conversation${row.stats.spanMs ? `, over ${duration(row.stats.spanMs)} of it` : ''}`}>
                        {work(row.stats)}
                      </small>
                    )}
                  </div>
                  {/* One fixed column, so the buttons line up row under row. */}
                  <div className="history-actions">
                  <RowAction
                    row={row}
                    isLive={Boolean(liveSessions[row.id])}
                    thisWindow={window.api.windowId}
                    onGoTo={() => {
                      place.last = row.id;
                      setHistoryOpen(false);
                      focusSession(row.id, { startClaude: true });
                    }}
                    onGoToWindow={() => {
                      place.last = row.id;
                      setHistoryOpen(false);
                      if (row.windowId) window.api.sessions.focusWindow(row.windowId);
                    }}
                    onReopen={(asProfileId) => {
                      place.last = row.id;
                      setLast(row.id);
                      return reopenSession(row.id, asProfileId);
                    }}
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
                        void load(() => true);
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
                          ? 'Click again to delete this session, everything kept for it, and the worktrees it worked in'
                          : 'Delete this session'
                      }
                      onClick={async () => {
                        if (pendingDelete !== row.id) {
                          setPendingDelete(row.id);
                          return;
                        }
                        setPendingDelete(null);
                        /*
                         * Taken out of the list where it stands, and the list
                         * held at the depth it was at: deleting is something
                         * done down a long list, one after another, and being
                         * sent back to the top after each one loses the place.
                         */
                        const el = listRef.current;
                        const depth = el?.scrollTop ?? 0;
                        setRows((was) => was.filter((one) => one.id !== row.id));
                        setPicked((was) => {
                          if (!was.has(row.id)) return was;
                          const next = new Set(was);
                          next.delete(row.id);
                          return next;
                        });
                        const { worktrees } = await window.api.history.deleteSession(row.id);
                        noteWorktrees(worktrees);
                        await load(() => true);
                        if (listRef.current) {
                          listRef.current.scrollTop = depth;
                          place.scroll.set(placeKey, depth);
                        }
                      }}
                      onBlur={() => setPendingDelete((id) => (id === row.id ? null : id))}
                    >
                      {pendingDelete === row.id ? 'Sure?' : '×'}
                    </button>
                  )}
                  </div>
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
            {handoffs.length === 0 && <p className="empty-state">No conversation has changed account yet.</p>}
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
          aria-label="Bring it back on another account"
        >
          <CaretIcon />
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

/**
 * Groups you have worked in, whether or not anything of them is still open.
 *
 * Each one unfolds onto its sessions, so you bring back the ones you want
 * rather than all fourteen. "All" is still there, for the day you do want
 * the whole set.
 */
function GroupHistory({ groups, onChanged }: { groups: GroupRecord[]; onChanged(): void }) {
  const restoreGroup = useStore((s) => s.restoreGroup);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState<string | null>(null);

  if (!groups.length) {
    return (
      <div className="history-list">
        <p className="empty-state">
          No groups yet. Group the tabs sitting together in a pane with the &#9678; button on its tab
          strip, and the whole set becomes something you can bring back from here.
        </p>
      </div>
    );
  }

  return (
    <div className="history-list">
      {groups.map((group) => {
        const isOpen = unfolded === group.id;
        return (
          <section className={`history-group${isOpen ? ' is-open' : ''}`} key={group.id}>
            <article className="history-row">
              <span className="tab-dot" style={{ background: group.color ?? 'var(--text-faint)' }} />
              <button
                className="history-main history-open"
                aria-expanded={isOpen}
                title={isOpen ? 'Fold its sessions away' : 'Show its sessions, and pick which to bring back'}
                onClick={() => setUnfolded(isOpen ? null : group.id)}
              >
                <div className="history-title">
                  <svg
                    className={`files-chevron${isOpen ? ' is-open' : ''}`}
                    width="11"
                    height="11"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    aria-hidden="true"
                  >
                    <path d="M4.5 2.5L8 6l-3.5 3.5" />
                  </svg>
                  <strong>{group.name}</strong>
                  {group.open > 0 && <em className="badge">{group.open} open</em>}
                  {group.fontSize && <em className="badge">{group.fontSize}px</em>}
                </div>
                <div className="history-meta">
                  {group.members} session{group.members === 1 ? '' : 's'} ·{' '}
                  {group.resumable} with a conversation to continue
                </div>
              </button>

              <div className="group-restore">
                <button
                  className={`ghost-btn tiny${isOpen ? '' : ' is-primary'}`}
                  onClick={() => setUnfolded(isOpen ? null : group.id)}
                >
                  {isOpen ? 'Hide sessions' : 'Choose sessions…'}
                </button>
                <button
                  className="ghost-btn tiny"
                  disabled={busy === group.id}
                  title="Bring back every session it had, laid out the way it was"
                  onClick={async () => {
                    setBusy(group.id);
                    try {
                      await restoreGroup(group.id);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === group.id ? 'Opening…' : `All ${group.members}`}
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
            {isOpen && (
              <div className="history-group-body">
                <GroupSessions groupId={group.id} arrangement={group.arrangement} onRestored={onChanged} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** One line on what deleting did to worktrees, or null when there were none. */
function worktreeNote(result: WorktreeCleanup | undefined, homedir: string) {
  if (!result) return null;
  const parts: string[] = [];
  if (result.removed.length) {
    parts.push(
      `Removed ${result.removed.length} worktree${result.removed.length === 1 ? '' : 's'}: ${result.removed
        .map((dir) => compactPath(dir, homedir))
        .join(', ')}.`,
    );
  }
  for (const kept of result.kept) parts.push(`Kept ${compactPath(kept.path, homedir)} — ${kept.reason}.`);
  if (result.error) parts.push(`Worktrees could not be checked: ${result.error}`);
  return parts.length ? parts.join(' ') : null;
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

/**
 * When a session closed, with the time of day.
 *
 * `when` drops the time for anything before today, which is right for "when did
 * this start" and wrong for the column the list is now ordered by: two sessions
 * that closed four hours apart on the same afternoon should not read as the
 * same moment.
 */
/**
 * The tooltip says which of the three the date actually is, because they are not
 * the same claim: work that happened, a session that stopped, or one that was
 * opened and in which nothing was ever recorded.
 */
function whenTitle(row: { lastWorkedAt?: number | null; endedAt: number | null; startedAt: number; open?: boolean }) {
  if (row.lastWorkedAt) return `last worked on ${new Date(row.lastWorkedAt).toLocaleString()}`;
  if (row.endedAt) return `closed ${new Date(row.endedAt).toLocaleString()}`;
  return `opened ${new Date(row.startedAt).toLocaleString()} — nothing recorded since`;
}

function closedAt(at: number) {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  const clock = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return today ? clock : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock}`;
}

/**
 * The key the list is sorted by: when something last happened here.
 *
 * Not whether it is open. That was the previous answer — anything running
 * sorted above everything else — and it put a tab opened five days ago and
 * never touched since above the one that was being talked to last night. What
 * this list is scanned for is the thing you were last doing.
 *
 * The same order the query already returns; it is repeated here because groups
 * are folded in the renderer and a fold has to sort by the same key as the
 * rows inside it, or a group jumps to a place none of its members explain.
 */
export function lastActive(row: { lastWorkedAt?: number | null; endedAt: number | null; startedAt: number }) {
  return row.lastWorkedAt ?? row.endedAt ?? row.startedAt;
}

/**
 * What a session did, in one line.
 *
 * Requests and tokens, because those are the two numbers that say whether a
 * session was a quick question or a day's work — and the compactions, because a
 * session that compacted three times had more to say than its context could
 * hold, which is worth seeing next to the rest.
 */
function work(stats: NonNullable<HistorySession['stats']>) {
  const tokens = stats.inputTokens + stats.outputTokens;
  const parts = [`${stats.requests} request${stats.requests === 1 ? '' : 's'}`];
  if (tokens) parts.push(`${round(tokens)} tokens`);
  if (stats.compactions) parts.push(`${stats.compactions}× compacted`);
  return parts.join(' · ');
}

/** 1.3M rather than 1316065: the magnitude is the information. */
function round(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function duration(ms: number) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
