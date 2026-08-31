import { Fragment, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { LeafNode } from '../state/types';
import { useStore } from '../state/store';
import { allLeaves } from '../state/layout';
import { TerminalSlot } from './TerminalSlot';
import { NewSessionMenu } from './NewSessionMenu';
import { FindBar } from './FindBar';
import { HandoffBanner } from './HandoffBanner';
import { GROUP_MIME, SESSION_MIME, sideFromPoint, type Side } from '../lib/drag';
import { PathLabel } from './PathLabel';
import { SessionTab } from './SessionTab';
import { GroupChip, GroupTheseTabs } from './GroupChip';

export function Pane({ leaf }: { leaf: LeafNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const [dropSide, setDropSide] = useState<Side | null>(null);
  /** Where a dragged tab would land in this strip, as a gap index. */
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  /** True once tabs are squeezed enough that the account label stops fitting. */
  const [tight, setTight] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const profiles = useStore((s) => s.profiles);
  const activeLeafId = useStore((s) => s.activeLeafId);
  const findOpenFor = useStore((s) => s.findOpenFor);
  const draggingId = useStore((s) => s.draggingSessionId);
  const draggingGroup = useStore((s) => s.draggingGroupId);
  const setDraggingGroup = useStore((s) => s.setDraggingGroupId);
  const moveGroup = useStore((s) => s.moveGroup);
  const homedir = useStore((s) => s.homedir);
  // A plain array compared shallowly: a selector returning a fresh function or
  // object every render makes the store look changed on every render.
  const tabGroups = useStore(
    useShallow((s) => leaf.tabs.map((id) => s.sessions[id]?.groupId ?? null)),
  );
  /**
   * A pane held entirely by one group wears that group's colour — border, tab
   * strip and all — so a section reads as belonging to it from across the screen,
   * not only from the small label in its corner.
   */
  const sectionColor = useStore((s) => {
    if (!leaf.tabs.length) return null;
    const owner = s.sessions[leaf.tabs[0]]?.groupId ?? null;
    if (owner) {
      const whole = leaf.tabs.every((id) => s.sessions[id]?.groupId === owner);
      return whole ? (s.groups.find((g) => g.id === owner)?.color ?? null) : null;
    }
    // No group here, but ungrouped tabs that agree on a colour own the section just
    // as plainly — most often a single tab sitting in a pane by itself.
    const own = s.sessions[leaf.tabs[0]]?.color ?? null;
    if (!own) return null;
    return leaf.tabs.every((id) => !s.sessions[id]?.groupId && s.sessions[id]?.color === own)
      ? own
      : null;
  });

  const setDraggingId = useStore((s) => s.setDraggingSessionId);
  const setActiveLeaf = useStore((s) => s.setActiveLeaf);
  const moveTab = useStore((s) => s.moveTab);
  const reorderTab = useStore((s) => s.reorderTab);
  const newSession = useStore((s) => s.newSession);
  const closeThisPane = useStore((s) => s.closePane);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => setTight(strip.clientWidth / Math.max(1, leaf.tabs.length) < 120);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [leaf.tabs.length]);

  const isActive = activeLeafId === leaf.id;
  const activeSession = useStore((s) => (leaf.active ? (s.sessions[leaf.active] ?? null) : null));
  const activeProfile = profiles.find((p) => p.id === activeSession?.profileId);

  /** The plain `+`: another tab here, same account and folder as the one in front. */
  function quickNewTab() {
    newSession({
      profileId: activeSession?.profileId,
      kind: activeSession?.kind ?? 'claude',
      cwd: activeSession?.cwd,
      leafId: leaf.id,
      side: 'center',
    });
  }

  function onBodyDragOver(event: React.DragEvent) {
    if (!draggingId && !draggingGroup) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = bodyRef.current?.getBoundingClientRect();
    if (rect) setDropSide(sideFromPoint(rect, event.clientX, event.clientY));
  }

  function onBodyDrop(event: React.DragEvent) {
    const side = dropSide;
    const groupId = event.dataTransfer.getData(GROUP_MIME) || draggingGroup;
    const sessionId = event.dataTransfer.getData(SESSION_MIME) || draggingId;
    setDropSide(null);
    setDraggingId(null);
    setDraggingGroup(null);
    if (!side) return;
    event.preventDefault();

    // A group lands as a unit: all of its sessions together in one place.
    if (groupId) moveGroup(groupId, leaf.id, side);
    else if (sessionId) moveTab(sessionId, leaf.id, side);
  }

  /**
   * Which gap between tabs the pointer is in. Dropping onto a tab has to mean
   * "before it" or "after it" depending on which half you are over — landing on
   * the tab's own index regardless is what makes a drop look like it displaced
   * the tab you aimed at.
   */
  function gapFromPointer(event: React.DragEvent): number {
    const strip = event.currentTarget.closest('.tabs');
    if (!strip) return leaf.tabs.length;
    const tabs = [...strip.querySelectorAll<HTMLElement>('.tab')];
    for (let i = 0; i < tabs.length; i += 1) {
      const rect = tabs[i].getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) return i;
    }
    return tabs.length;
  }

  function onTabStripOver(event: React.DragEvent) {
    if (draggingGroup) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!draggingId) return;
    event.preventDefault();
    event.stopPropagation();
    setDropSide(null);
    setDropIndex(gapFromPointer(event));
  }

  function onTabStripDrop(event: React.DragEvent) {
    const groupId = event.dataTransfer.getData(GROUP_MIME) || draggingGroup;
    if (groupId) {
      event.preventDefault();
      event.stopPropagation();
      setDraggingGroup(null);
      setDropIndex(null);
      moveGroup(groupId, leaf.id, 'center');
      return;
    }
    const sessionId = event.dataTransfer.getData(SESSION_MIME) || draggingId;
    const gap = dropIndex ?? gapFromPointer(event);
    setDraggingId(null);
    setDropSide(null);
    setDropIndex(null);
    if (!sessionId) return;
    event.preventDefault();
    event.stopPropagation();

    if (leaf.tabs.includes(sessionId)) {
      // Removing the tab first shifts every gap after it left by one.
      const from = leaf.tabs.indexOf(sessionId);
      reorderTab(sessionId, leaf.id, gap > from ? gap - 1 : gap);
    } else {
      moveTab(sessionId, leaf.id, 'center', gap);
    }
  }

  return (
    <section
      className={`pane${isActive ? ' pane-active' : ''}${sectionColor ? ' pane-grouped' : ''}`}
      style={sectionColor ? ({ ['--section' as string]: sectionColor } as React.CSSProperties) : undefined}
      data-leaf-id={leaf.id}
      onMouseDown={() => !isActive && setActiveLeaf(leaf.id)}
    >
      <header className="tabstrip">
        <div
          className="tabs"
          ref={stripRef}
          onDragOver={onTabStripOver}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropIndex(null);
          }}
          onDrop={onTabStripDrop}
        >
          {leaf.tabs.map((sessionId, index) => {
            const group = tabGroups[index] ?? null;
            // One label per run of neighbouring tabs from the same group, the way
            // a browser labels a group once rather than on every tab.
            const startsRun = group !== null && group !== (tabGroups[index - 1] ?? null);
            return (
              <Fragment key={sessionId}>
                {dropIndex === index && <span className="drop-caret" aria-hidden="true" />}
                {startsRun && <GroupChip groupId={group} leafId={leaf.id} />}
                <SessionTab
                  sessionId={sessionId}
                  selected={leaf.active === sessionId}
                  tight={tight}
                  grouped={group !== null}
                />
              </Fragment>
            );
          })}
          {dropIndex === leaf.tabs.length && <span className="drop-caret" aria-hidden="true" />}
          <div className="tabstrip-actions">
            {leaf.tabs.length === 0 && (
              <button
                className="icon-btn"
                title="Close this empty pane"
                onClick={() => closeThisPane(leaf.id)}
              >
                &times;
              </button>
            )}
            <GroupTheseTabs leafId={leaf.id} tabs={leaf.tabs} />
            <button
              className="icon-btn"
              onClick={quickNewTab}
              title={
                activeProfile
                  ? `New tab as ${activeProfile.name} (⌘T)`
                  : 'New tab (⌘T)'
              }
            >
              +
            </button>
            <button
              ref={caretRef}
              className="icon-btn caret"
              onClick={() => setMenuOpen((open) => !open)}
              title="New session as another account…"
            >
              ⌄
            </button>
            {menuOpen && (
              <NewSessionMenu
                leafId={leaf.id}
                anchorEl={caretRef.current}
                cwdHint={activeSession?.cwd}
                onClose={() => setMenuOpen(false)}
              />
            )}
          </div>
          <div className="tab-tail" onDoubleClick={quickNewTab} />
        </div>

      </header>

      <div className="pane-body" ref={bodyRef}>
        {leaf.active && activeSession ? (
          <>
            <TerminalSlot key={leaf.active} sessionId={leaf.active} />
            {activeSession.limitHit && <HandoffBanner sessionId={leaf.active} />}
            {findOpenFor === leaf.active && <FindBar sessionId={leaf.active} />}
          </>
        ) : (
          <EmptyPane leafId={leaf.id} />
        )}

        {(draggingId || draggingGroup) && (
          <div
            className="drop-capture"
            onDragOver={onBodyDragOver}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropSide(null);
            }}
            onDrop={onBodyDrop}
          />
        )}

        {dropSide && <div className={`drop-hint drop-${dropSide}`} />}
      </div>


      {activeSession && (
        <footer className="pane-status">
          <span className="status-profile" style={{ color: activeProfile?.color }}>
            ● {activeProfile?.name ?? 'account'}
          </span>
          <PathLabel path={activeSession.cwd} home={homedir} className="status-cwd" />
          <span
            className="status-meta"
            title={activeSession.pid ? `pid ${activeSession.pid}` : activeSession.status}
          >
            {activeSession.status === 'exited'
              ? `exited (${activeSession.exitCode})`
              : activeSession.status === 'starting'
                ? 'starting…'
                : activeSession.title}
          </span>
        </footer>
      )}
    </section>
  );
}

function EmptyPane({ leafId }: { leafId: string }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const newSession = useStore((s) => s.newSession);
  const closeThisPane = useStore((s) => s.closePane);
  const onlyPane = useStore((s) => allLeaves(s.layout).length === 1);

  return (
    <div className="empty-pane">
      <p>Nothing here yet.</p>
      <div className="empty-pane-actions">
        <button className="primary-btn" onClick={() => newSession({ leafId, kind: 'claude' })}>
          Start a session
        </button>
        <button ref={buttonRef} className="ghost-btn" onClick={() => setOpen((o) => !o)}>
          as…
        </button>
        {!onlyPane && (
          <button className="ghost-btn" onClick={() => closeThisPane(leafId)}>
            Close pane
          </button>
        )}
      </div>
      {open && (
        <NewSessionMenu leafId={leafId} anchorEl={buttonRef.current} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
