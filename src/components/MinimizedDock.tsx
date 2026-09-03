import { useStore } from '../state/store';
import { sessionLabel } from '../lib/labels';
import type { MinimizedTab } from '../state/types';

/**
 * The strip along the bottom holding what has been set aside.
 *
 * A minimized tab is out of the layout — that is what handed its pane back — but
 * its session never stopped: it is still running, still recording, still on
 * autopilot if it was. So the dock shows the same signals a tab does, because
 * something waiting down here can still be the thing that needs you.
 *
 * A group goes into the dock as one entry and comes back as one, which is what
 * makes minimizing a whole section reversible rather than a way to scatter it.
 */
export function MinimizedDock() {
  const minimized = useStore((s) => s.minimized);
  const sections = useStore((s) => s.minimizedSections);
  if (!minimized.length && !sections.length) return null;

  return (
    <div className="dock" role="toolbar" aria-label="Minimized tabs">
      <span className="dock-label">Set aside</span>
      {sections.map((section) => (
        <DockedSection key={section.id} id={section.id} />
      ))}
      {entriesInOrder(minimized).map((entry) =>
        entry.groupId ? (
          <DockedGroup key={entry.groupId} groupId={entry.groupId} />
        ) : (
          <DockedTab key={entry.sessionId} sessionId={entry.sessionId} />
        ),
      )}
    </div>
  );
}

/**
 * One button per group, at the place its first member was set aside, and one per
 * ungrouped tab. Members minimized at different moments still share a button:
 * the group is the thing being shown, not the order it went down in.
 */
function entriesInOrder(minimized: MinimizedTab[]): MinimizedTab[] {
  const seen = new Set<string>();
  return minimized.filter((entry) => {
    if (!entry.groupId) return true;
    if (seen.has(entry.groupId)) return false;
    seen.add(entry.groupId);
    return true;
  });
}

/**
 * A whole section, waiting to go back where it was.
 *
 * It says how many tabs it holds, because a section is a *place* rather than one
 * thing — and its arrow says the same as its tooltip: this one knows where it
 * came from, and a single set-aside tab does not.
 */
function DockedSection({ id }: { id: string }) {
  const section = useStore((s) => s.minimizedSections.find((entry) => entry.id === id));
  const live = useStore((s) =>
    section ? section.tabs.filter((tab) => s.sessions[tab] || s.panels[tab]).length : 0,
  );
  const busy = useStore((s) => Boolean(section?.tabs.some((tab) => s.sessions[tab]?.busy)));
  const waiting = useStore((s) =>
    Boolean(section?.tabs.some((tab) => s.sessions[tab]?.autopilotState === 'waiting-for-you')),
  );
  const restoreSection = useStore((s) => s.restoreSection);

  if (!section || !live) return null;
  const colour = section.colour ?? '#7aa2f7';

  return (
    <button
      className={`dock-item is-section${waiting ? ' needs-you' : ''}`}
      style={{ ['--dock-tint' as string]: colour }}
      onClick={() => restoreSection(id)}
      title={`${section.label} — a whole section, ${live} tab${live === 1 ? '' : 's'}\nClick to put it back where it was`}
    >
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke={colour} strokeWidth="1.3">
        <rect x="1.4" y="2.4" width="11.2" height="9.2" rx="1.4" />
        <path d="M5.6 2.4v9.2" />
      </svg>
      <span className="dock-name">{section.label}</span>
      <span className="dock-count">{live}</span>
      {busy && <span className="dock-busy" style={{ borderColor: colour, borderTopColor: 'transparent' }} />}
      {waiting && <span className="dock-flag" title="One of them is stopped for you">✋</span>}
    </button>
  );
}

function DockedTab({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const profile = useStore((s) => {
    const owner = s.sessions[sessionId]?.profileId;
    return owner ? s.profiles.find((p) => p.id === owner) : undefined;
  });
  const homedir = useStore((s) => s.homedir);
  const restore = useStore((s) => s.restoreMinimized);
  const requestClose = useStore((s) => s.requestClose);
  const openContextMenu = useStore((s) => s.openContextMenu);

  // Restored in the same tick it is spawned, a docked entry can briefly name a
  // session the store has not built yet.
  if (!session) return null;
  const color = session.color ?? profile?.color ?? '#5c6370';
  const waiting = session.autopilot && session.autopilotState === 'waiting-for-you';

  return (
    <button
      className={`dock-item${waiting ? ' needs-you' : ''}`}
      style={{ ['--dock-tint' as string]: color }}
      onClick={() => restore(sessionId)}
      onContextMenu={(event) => {
        event.preventDefault();
        openContextMenu(sessionId, event.clientX, event.clientY);
      }}
      title={[
        `${sessionLabel(session, homedir)} — set aside, still running`,
        session.cwd,
        'Click to bring it back',
      ].join('\n')}
    >
      <span className="dock-dot" style={{ background: color }} />
      <span className="dock-name">{sessionLabel(session, homedir)}</span>
      {session.busy && (
        <span className="dock-busy" style={{ borderColor: color, borderTopColor: 'transparent' }} />
      )}
      {waiting && <span className="dock-flag" title="Stopped for you">✋</span>}
      {session.unread && !session.busy && <span className="dock-unread" />}
      <span
        className="dock-close"
        role="button"
        aria-label="Close session"
        onClick={(event) => {
          event.stopPropagation();
          requestClose(sessionId);
        }}
      >
        ×
      </span>
    </button>
  );
}

function DockedGroup({ groupId }: { groupId: string }) {
  const group = useStore((s) => s.groups.find((g) => g.id === groupId));
  // A count, not the list. A selector that builds a fresh array every render makes
  // the store look changed every render, and the re-render loop that follows takes
  // the whole tree down with it — the same trap the tab strip documents.
  const memberCount = useStore(
    (s) =>
      s.minimized.filter((entry) => entry.groupId === groupId && s.sessions[entry.sessionId])
        .length,
  );
  // A group whose sessions are working, or stopped waiting on someone, says so
  // from down here: that is the whole reason to show more than a name.
  const busy = useStore((s) =>
    s.minimized.some((entry) => entry.groupId === groupId && s.sessions[entry.sessionId]?.busy),
  );
  const waiting = useStore((s) =>
    s.minimized.some(
      (entry) =>
        entry.groupId === groupId &&
        s.sessions[entry.sessionId]?.autopilotState === 'waiting-for-you',
    ),
  );
  const restoreGroup = useStore((s) => s.restoreMinimizedGroup);
  const requestCloseGroup = useStore((s) => s.requestCloseGroup);

  if (!group || !memberCount) return null;

  return (
    <button
      className={`dock-item is-group${waiting ? ' needs-you' : ''}`}
      style={{ ['--dock-tint' as string]: group.color }}
      onClick={() => restoreGroup(groupId)}
      title={`${group.name} — ${memberCount} session${memberCount === 1 ? '' : 's'} set aside\nClick to bring the whole group back`}
    >
      <span className="dock-dot" style={{ background: group.color }} />
      <span className="dock-name">{group.name}</span>
      <span className="dock-count">{memberCount}</span>
      {busy && (
        <span
          className="dock-busy"
          style={{ borderColor: group.color, borderTopColor: 'transparent' }}
        />
      )}
      {waiting && <span className="dock-flag" title="One of them is stopped for you">✋</span>}
      <span
        className="dock-close"
        role="button"
        aria-label="Close group"
        onClick={(event) => {
          event.stopPropagation();
          requestCloseGroup(groupId);
        }}
      >
        ×
      </span>
    </button>
  );
}
