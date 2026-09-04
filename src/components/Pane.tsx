import { Fragment, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { LeafNode } from '../state/types';
import { useStore } from '../state/store';
import { allLeaves } from '../state/layout';
import { TerminalSlot } from './TerminalSlot';
import { NewSessionMenu } from './NewSessionMenu';
import { FindBar } from './FindBar';
import { HandoffBanner } from './HandoffBanner';
import { GROUP_MIME, PANEL_MIME, PANE_MIME, SESSION_MIME, sideFromPoint, type Side } from '../lib/drag';
import { PathLabel } from './PathLabel';
import { SessionTab } from './SessionTab';
import { GroupChip, GroupTheseTabs } from './GroupChip';
import { FilesPanel } from './FilesPanel';
import { MonitorPanel } from './MonitorPanel';
import { ExtensionsPanel } from './ExtensionsPanel';
import { ExtensionView } from './ExtensionView';
import { PanelTab } from './PanelTab';

export function Pane({ leaf }: { leaf: LeafNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const [dropSide, setDropSide] = useState<Side | null>(null);
  /** Another section is hovering over this one, about to trade places with it. */
  const [swapTarget, setSwapTarget] = useState(false);
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
  /** Which of this pane's tabs are file panels rather than sessions. */
  const panelIds = useStore(
    useShallow((s) => leaf.tabs.filter((id) => Boolean(s.panels[id]))),
  );
  /** Which sort of panel is in front, when one is. A string, so it is stable. */
  const activePanelKind = useStore((s) => (leaf.active ? (s.panels[leaf.active]?.kind ?? null) : null));
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
  const swapSections = useStore((s) => s.swapSections);
  const moveSection = useStore((s) => s.moveSection);
  const draggingPane = useStore((s) => s.draggingPaneId);
  const setDraggingPane = useStore((s) => s.setDraggingPaneId);
  const lifting = draggingPane === leaf.id;
  const toggleZoomOf = useStore((s) => s.toggleZoomOf);
  const minimizeSection = useStore((s) => s.minimizeSection);
  const zoomed = useStore((s) => s.zoomedLeafId === leaf.id);
  /**
   * The group this whole pane belongs to, if one owns it outright. The frame's
   * buttons then speak about the group rather than about a rectangle, which is
   * how it reads to someone looking at it.
   */
  const sectionGroup = useStore((s) => {
    if (!leaf.tabs.length) return null;
    const owner = s.sessions[leaf.tabs[0]]?.groupId ?? null;
    if (!owner) return null;
    return leaf.tabs.every((id) => s.sessions[id]?.groupId === owner)
      ? (s.groups.find((g) => g.id === owner) ?? null)
      : null;
  });

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
    /*
     * A section reads the same quadrants a tab does, and means something
     * different by them: an edge puts it on that side, the middle trades places
     * with what is already here. Both move the whole section.
     */
    if (draggingPane || event.dataTransfer.types.includes(PANE_MIME)) {
      // The pane it started from is not a place to drop it.
      if (draggingPane === leaf.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = bodyRef.current?.getBoundingClientRect();
      const where = rect ? sideFromPoint(rect, event.clientX, event.clientY) : 'center';
      setSwapTarget(where === 'center');
      setDropSide(where === 'center' ? null : where);
      return;
    }
    if (!draggingId && !draggingGroup) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = bodyRef.current?.getBoundingClientRect();
    if (rect) setDropSide(sideFromPoint(rect, event.clientX, event.clientY));
  }

  function onBodyDrop(event: React.DragEvent) {
    const side = dropSide;
    const wasSwap = swapTarget;
    const groupId = event.dataTransfer.getData(GROUP_MIME) || draggingGroup;
    const paneId = event.dataTransfer.getData(PANE_MIME) || draggingPane || '';
    const sessionId =
      event.dataTransfer.getData(SESSION_MIME) || event.dataTransfer.getData(PANEL_MIME) || draggingId;
    setDropSide(null);
    setDraggingId(null);
    setDraggingGroup(null);
    if (!side && !wasSwap && !paneId) return;
    event.preventDefault();

    if (paneId) {
      return side && side !== 'center'
        ? moveSection(paneId, leaf.id, side)
        : swapSections(paneId, leaf.id);
    }
    // A group lands as a unit: all of its sessions together in one place.
    if (groupId) moveGroup(groupId, leaf.id, side!);
    else if (sessionId) moveTab(sessionId, leaf.id, side!);
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
                {panelIds.includes(sessionId) ? (
                  <PanelTab panelId={sessionId} selected={leaf.active === sessionId} leafId={leaf.id} />
                ) : (
                  <SessionTab
                    sessionId={sessionId}
                    selected={leaf.active === sessionId}
                    tight={tight}
                    grouped={group !== null}
                  />
                )}
              </Fragment>
            );
          })}
          {dropIndex === leaf.tabs.length && <span className="drop-caret" aria-hidden="true" />}
          {/*
            The empty run of the strip is the section's handle — where you would
            grab a window. Dropping it on another section trades their places.
          */}
          <div
            className={`tab-tail${lifting ? ' is-lifting' : ''}`}
            onDoubleClick={quickNewTab}
            draggable={leaf.tabs.length > 0}
            data-tip="Drag to trade places with another section"
            onDragStart={(event) => {
              event.dataTransfer.setData(PANE_MIME, leaf.id);
              event.dataTransfer.effectAllowed = 'move';
              setDraggingPane(leaf.id);
            }}
            onDragEnd={() => setDraggingPane(null)}
          />
        </div>

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
          {leaf.tabs.length > 0 && (
            <>
              <button
                className="icon-btn"
                onClick={() => minimizeSection(leaf.id)}
                title={
                  sectionGroup
                    ? `Set ${sectionGroup.name} aside — it keeps running, and this space goes back`
                    : 'Set this section aside — it keeps running, and this space goes back'
                }
                aria-label="Minimize this section"
              >
                &#8211;
              </button>
              <button
                className={`icon-btn${zoomed ? ' is-on' : ''}`}
                onClick={() => toggleZoomOf(leaf.id)}
                title={
                  zoomed
                    ? 'Back to the other panes (⌥⌘⏎)'
                    : sectionGroup
                      ? `Fill the window with ${sectionGroup.name} (⌥⌘⏎)`
                      : 'Fill the window with this section (⌥⌘⏎)'
                }
                aria-label={zoomed ? 'Restore this section' : 'Maximize this section'}
              >
                ⤢
              </button>
            </>
          )}
          {menuOpen && (
            <NewSessionMenu
              leafId={leaf.id}
              anchorEl={caretRef.current}
              cwdHint={activeSession?.cwd}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>

      </header>

      <div className="pane-body" ref={bodyRef}>
        {leaf.active && panelIds.includes(leaf.active) ? (
          activePanelKind === 'monitor' ? (
            <MonitorPanel key={leaf.active} panelId={leaf.active} />
          ) : activePanelKind === 'extensions' ? (
            <ExtensionsPanel key={leaf.active} />
          ) : activePanelKind === 'extension' ? (
            <ExtensionView key={leaf.active} panelId={leaf.active} />
          ) : (
            <FilesPanel key={leaf.active} panelId={leaf.active} />
          )
        ) : leaf.active && activeSession ? (
          <>
            <TerminalSlot key={leaf.active} sessionId={leaf.active} />
            {activeSession.offerCommand && <CommandOffer sessionId={leaf.active} />}
            {activeSession.limitHit && <HandoffBanner sessionId={leaf.active} />}
            {findOpenFor === leaf.active && <FindBar sessionId={leaf.active} />}
          </>
        ) : (
          <EmptyPane leafId={leaf.id} />
        )}

        {(draggingId || draggingGroup || draggingPane) && (
          <div
            className="drop-capture"
            onDragOver={onBodyDragOver}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node)) return;
              setDropSide(null);
              setSwapTarget(false);
            }}
            onDrop={(event) => {
              setSwapTarget(false);
              setDraggingPane(null);
              onBodyDrop(event);
            }}
          />
        )}
        {swapTarget && <div className="swap-hint">Trade places</div>}
        {dropSide && draggingPane && <div className="swap-side">Put it here</div>}

        {dropSide && <div className={`drop-hint drop-${dropSide}`} />}
      </div>


      {activeSession && !panelIds.includes(leaf.active ?? '') && (
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

/**
 * What this session was running before the app restarted, offered back.
 *
 * Offered, not run. The app remembers `npm run local` and a migration in exactly
 * the same way and cannot tell them apart — so it asks once, and the checkbox is
 * how you say "this one is safe, do it by itself next time".
 */
function CommandOffer({ sessionId }: { sessionId: string }) {
  const command = useStore((s) => s.sessions[sessionId]?.offerCommand ?? null);
  const runCommandIn = useStore((s) => s.runCommandIn);
  const setResumeCommand = useStore((s) => s.setResumeCommand);
  const dismiss = useStore((s) => s.dismissCommandOffer);
  if (!command) return null;

  return (
    <div className="command-offer">
      <span className="file-bar-dot is-ok" />
      <span className="command-offer-text">
        This was running <code>{command}</code>
      </span>
      <button className="primary-btn" onClick={() => runCommandIn(sessionId, command)}>
        Run it again
      </button>
      <button
        className="ghost-btn"
        title="Start it by itself whenever this session comes back"
        onClick={() => {
          setResumeCommand(sessionId, true);
          runCommandIn(sessionId, command);
        }}
      >
        Always
      </button>
      <button className="tab-close" onClick={() => dismiss(sessionId)} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

function EmptyPane({ leafId }: { leafId: string }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const newSession = useStore((s) => s.newSession);
  const openFilePanel = useStore((s) => s.openFilePanel);
  const closeThisPane = useStore((s) => s.closePane);
  const onlyPane = useStore((s) => allLeaves(s.layout).length === 1);

  return (
    <div className="empty-pane">
      <p>Nothing here yet.</p>
      <p className="form-hint">A section can hold a terminal, or a folder and its files.</p>
      <div className="empty-pane-actions">
        <button className="primary-btn" onClick={() => newSession({ leafId, kind: 'claude' })}>
          Start a session
        </button>
        <button ref={buttonRef} className="ghost-btn" onClick={() => setOpen((o) => !o)}>
          as…
        </button>
        {/* The other thing a section can hold. It is offered here rather than
            only in the ⌄ menu, because an empty pane is exactly the moment
            someone is deciding what this section is for. */}
        <button className="ghost-btn" onClick={() => openFilePanel({ leafId })}>
          Open a folder
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
