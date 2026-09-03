import { useState } from 'react';
import { useStore } from '../state/store';
import type { Session } from '../state/types';
import { Popover } from './Popover';
import { leafOfTab } from '../state/layout';

/** Right-click menu for a session, wherever it is listed. */
export function SessionContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const onClose = useStore((s) => s.closeContextMenu);
  if (!menu) return null;
  return <Menu sessionId={menu.sessionId} x={menu.x} y={menu.y} onClose={onClose} />;
}

function Menu({
  sessionId,
  x,
  y,
  onClose,
}: {
  sessionId: string;
  x: number;
  y: number;
  onClose(): void;
}) {
  const session = useStore((s) => s.sessions[sessionId]);
  const profile = useStore((s) => s.profiles.find((p) => p.id === s.sessions[sessionId]?.profileId));
  const profiles = useStore((s) => s.profiles);
  const authByProfile = useStore((s) => s.authByProfile);
  const [pickingAccount, setPickingAccount] = useState(false);
  const store = useStore.getState();
  if (!session) return null;

  // What is actually happening in this tab right now. The menu turns on this:
  // offering "Run Claude here" while Claude is running types the words into
  // Claude's own prompt, which is worse than not offering it at all.
  const exited = session.status === 'exited';
  const foreground = session.foreground ?? null;
  const claudeUp = Boolean(foreground?.includes('claude'));
  const settling = !exited && !claudeUp && session.status === 'starting';
  const busyWith = !exited && !claudeUp && foreground ? foreground : null;
  const hostsClaude = session.kind === 'claude' || Boolean(session.claudeSessionId);
  const idle = !exited && !claudeUp && !settling && !busyWith;

  const state = exited
    ? `exited${session.exitCode !== null ? ` (${session.exitCode})` : ''}`
    : claudeUp
      ? session.busy
        ? 'Claude · working'
        : 'Claude · waiting for you'
      : settling
        ? 'starting…'
        : busyWith
          ? `running ${busyWith}`
          : 'shell';

  // Somewhere else to run Claude from. An account you are not signed in to would
  // only put you at a login prompt, so it is not offered as a place to run.
  const signedInElsewhere = profiles.filter(
    (p) => p.id !== session.profileId && authByProfile[p.id]?.loggedIn,
  );
  // A tab with no conversation of its own can simply change hands. One that has a
  // thread moves by handoff instead, so the thread travels with it.
  const otherAccounts = session.claudeSessionId ? [] : signedInElsewhere;
  const moveTargets = session.claudeSessionId ? signedInElsewhere : [];

  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <Popover anchorPoint={{ x, y }} onClose={onClose}>
      <div className="menu-heading">
        <span className="tab-dot" style={{ background: profile?.color }} />
        <span style={{ color: profile?.color }}>{profile?.name}</span>
        <span className="menu-heading-pid">{state}</span>
      </div>

      {exited && (
        <MenuItem label="Start again" hint="⌘R" onClick={run(() => store.restartSession(sessionId))} />
      )}

      {claudeUp && (
        <MenuItem
          label="Interrupt Claude"
          hint="esc"
          onClick={run(() => store.sendInput(sessionId, '\x1b'))}
        />
      )}

      {busyWith && (
        <MenuItem
          label={`Interrupt ${busyWith}`}
          hint="⌃C"
          onClick={run(() => store.sendInput(sessionId, '\x03'))}
        />
      )}

      {idle && (
        <>
          <MenuItem
            label={session.claudeSessionId ? 'Continue the conversation' : 'Run Claude here'}
            hint="⌘⏎"
            onClick={run(() => store.runClaudeIn(sessionId))}
          />
          {otherAccounts.length > 0 &&
            (pickingAccount ? (
              <>
                <div className="menu-label">Run Claude as</div>
                {otherAccounts.map((target) => (
                  <button
                    key={target.id}
                    className="menu-item"
                    onClick={run(() => store.runClaudeIn(sessionId, target.id))}
                  >
                    <span>
                      <i className="group-dot" style={{ background: target.color, marginRight: 7 }} />
                      {target.name}
                    </span>
                    <kbd title={authByProfile[target.id]?.email ?? 'signed in'}>
                      {authByProfile[target.id]?.email ?? 'signed in'}
                    </kbd>
                  </button>
                ))}
                <p className="form-hint">
                  Starts a new conversation on that account and moves this tab to it. The
                  conversation already here stays where it is.
                </p>
              </>
            ) : (
              <MenuItem label="Run Claude as…" hint="other account" onClick={() => setPickingAccount(true)} />
            ))}
          <MenuItem
            label="Resume a conversation…"
            onClick={run(() => store.pickConversationIn(sessionId))}
          />
        </>
      )}

      {hostsClaude && (
        <button
          className={`menu-item menu-check${session.autopilot ? ' is-on' : ''}`}
          title={
            session.autopilot
              ? 'It carries on by itself, and stops when something needs you'
              : 'Let it carry on by itself between turns'
          }
          onClick={run(() => store.setAutopilot(sessionId, !session.autopilot))}
        >
          <span>
            <i className="check">{session.autopilot ? '☑' : '☐'}</i> Keep working on its own
          </span>
          <kbd title={autopilotHint(session)}>{autopilotHint(session)}</kbd>
        </button>
      )}

      {hostsClaude && (
        <MenuItem
          label={session.recording ? 'Recording conversation ✓' : 'Record conversation'}
          hint={session.recording ? 'on' : 'off'}
          onClick={run(() => store.setRecording(sessionId, !session.recording))}
        />
      )}

      <LookSection session={session} />
      <GroupSection session={session} onClose={onClose} />
      <div className="menu-separator" />
      <MenuItem
        label="Set aside"
        hint="keeps running"
        onClick={run(() => store.minimizeSession(sessionId))}
      />
      <MenuItem label="Rename…" hint="⌘E" onClick={run(() => store.setRenamingSessionId(sessionId))} />
      <MenuItem label="Duplicate" hint="⇧⌘K" onClick={run(() => store.duplicateSession(sessionId))} />
      {!exited && (
        <MenuItem
          label="Restart"
          hint={claudeUp || busyWith ? 'ends what is running' : '⌘R'}
          danger={claudeUp || Boolean(busyWith)}
          onClick={run(() => store.restartSession(sessionId))}
        />
      )}

      {moveTargets.length > 0 && (
        <>
          <div className="menu-separator" />
          <div className="menu-label">Move conversation to</div>
          {moveTargets.map((target) => (
            <MenuItem
              key={target.id}
              label={target.name}
              hint={authByProfile[target.id]?.subscriptionType ?? undefined}
              onClick={run(() => store.handoffSession(sessionId, target.id))}
            />
          ))}
        </>
      )}

      <div className="menu-separator" />
      {/*
        The folder this session is working in, opened beside it. A session
        already knows where it is — asking which folder, when the answer is on
        the tab you right-clicked, is a question with one answer.
      */}
      <MenuItem
        label="Open its folder"
        hint={folderName(session.cwd)}
        onClick={run(() => {
          const leaf = leafOfTab(store.layout, sessionId);
          store.openFilePanel({ leafId: leaf?.id, side: 'right', root: session.cwd });
        })}
      />
      <MenuItem
        label="Open its folder here"
        hint="same section"
        onClick={run(() => {
          const leaf = leafOfTab(store.layout, sessionId);
          store.openFilePanel({ leafId: leaf?.id, side: 'center', root: session.cwd });
        })}
      />

      <div className="menu-separator" />
      <MenuItem label="Split right" hint="⌘D" onClick={run(() => store.splitActive('row'))} />
      <MenuItem label="Split down" hint="⇧⌘D" onClick={run(() => store.splitActive('column'))} />
      <div className="menu-separator" />
      <MenuItem label="Close" hint="⌘W" danger onClick={run(() => store.requestClose(sessionId))} />
    </Popover>
  );
}

/** The last part of a path, which is what a folder is called in conversation. */
function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** What autopilot is doing right now, in the fewest words that still say it. */
function autopilotHint(session: Session): string {
  if (!session.autopilot) return 'off';
  switch (session.autopilotState) {
    case 'waiting-for-you':
      return session.autopilotAsking ? `needs you · ${session.autopilotAsking}` : 'needs you';
    case 'done':
      return 'nothing left';
    case 'working':
      return 'working';
    case 'nudged':
      return 'carrying on';
    default:
      return 'on';
  }
}

const TAB_COLORS = ['#7dcfff', '#f7768e', '#9ece6a', '#e0af68', '#bb9af7', '#41a6b5', '#ff9e64'];
const SIZES = [null, 11, 12, 13, 14, 16, 18] as const;

/**
 * Colour and text size for a tab standing on its own — the same two things a group
 * decides for its members. Inside a group there is nothing to decide here, so it
 * says who is deciding instead of showing controls that would not take effect.
 */
function LookSection({ session }: { session: Session }) {
  const group = useStore((s) => s.groups.find((g) => g.id === session.groupId) ?? null);
  const updateSessionLook = useStore((s) => s.updateSessionLook);

  if (group) {
    return (
      <>
        <div className="menu-separator" />
        <div className="menu-label">
          <i className="group-dot" style={{ background: group.color, marginRight: 7 }} />
          {group.name} sets the colour and text size
        </div>
      </>
    );
  }

  return (
    <>
      <div className="menu-separator" />
      <div className="menu-label">This tab</div>
      <div className="group-swatches">
        <button
          className={`swatch is-none${session.color ? '' : ' is-selected'}`}
          title="No colour of its own"
          aria-label="no colour"
          onClick={() => updateSessionLook(session.id, { color: null })}
        />
        {TAB_COLORS.map((color) => (
          <button
            key={color}
            className={`swatch${session.color === color ? ' is-selected' : ''}`}
            style={{ background: color }}
            aria-label={color}
            onClick={() => updateSessionLook(session.id, { color })}
          />
        ))}
      </div>
      <label className="field">
        <span>Text size for this tab</span>
        <div className="segmented">
          {SIZES.map((size) => (
            <button
              key={String(size)}
              className={session.fontSize === size ? 'is-on' : ''}
              onClick={() => updateSessionLook(session.id, { fontSize: size })}
            >
              {size ?? 'default'}
            </button>
          ))}
        </div>
      </label>
    </>
  );
}

/**
 * Putting a tab into a group without dragging it. The group it is already in
 * comes first, as the thing to leave; the rest are places to go.
 */
function GroupSection({
  session,
  onClose,
}: {
  session: { id: string; groupId: string | null };
  onClose(): void;
}) {
  const groups = useStore((s) => s.groups);
  const addToGroup = useStore((s) => s.addToGroup);
  const assignToGroup = useStore((s) => s.assignToGroup);
  const createGroup = useStore((s) => s.createGroup);
  const requestCloseGroup = useStore((s) => s.requestCloseGroup);
  const [naming, setNaming] = useState(false);

  const current = groups.find((group) => group.id === session.groupId);
  const others = groups.filter((group) => group.id !== session.groupId);

  if (naming) {
    return (
      <label className="field">
        <span>New group</span>
        <input
          autoFocus
          placeholder="KS-ERP"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setNaming(false);
            if (event.key !== 'Enter') return;
            const name = (event.target as HTMLInputElement).value.trim();
            if (!name) return;
            createGroup(name, [session.id]);
            onClose();
          }}
        />
      </label>
    );
  }

  return (
    <>
      <div className="menu-label">Group</div>
      {current && (
        <>
          <button
            className="menu-item"
            onClick={() => {
              onClose();
              assignToGroup(session.id, null);
            }}
          >
            <span>Remove from {current.name}</span>
            <kbd title="leaves it open">leaves it open</kbd>
          </button>
          <button
            className="menu-item"
            onClick={() => {
              onClose();
              requestCloseGroup(current.id);
            }}
          >
            <span>Close all of {current.name}</span>
            <kbd title="reopen from History">reopen from History</kbd>
          </button>
        </>
      )}
      {others.map((group) => (
        <button
          key={group.id}
          className="menu-item"
          onClick={() => {
            onClose();
            addToGroup(session.id, group.id);
          }}
        >
          <span>
            <i className="group-dot" style={{ background: group.color, marginRight: 7 }} />
            Add to {group.name}
          </span>
        </button>
      ))}
      <button className="menu-item" onClick={() => setNaming(true)}>
        <span>New group…</span>
      </button>
    </>
  );
}

function MenuItem({
  label,
  hint,
  danger,
  onClick,
}: {
  label: string;
  hint?: string;
  danger?: boolean;
  onClick(): void;
}) {
  return (
    <button className={`menu-item${danger ? ' is-danger' : ''}`} onClick={onClick}>
      <span>{label}</span>
      {/* The hint is trimmed before the label is, so hovering is how the rest of it is read. */}
      {hint && <kbd title={hint}>{hint}</kbd>}
    </button>
  );
}
