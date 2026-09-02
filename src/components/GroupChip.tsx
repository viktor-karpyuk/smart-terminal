import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import type { GroupArrangement } from '../state/types';
import { Popover } from './Popover';
import { GROUP_MIME, SESSION_MIME } from '../lib/drag';

const ARRANGEMENTS: Array<{ id: GroupArrangement; label: string; hint: string }> = [
  { id: 'tabs', label: 'Stack as tabs', hint: 'one pane' },
  { id: 'columns', label: 'Side by side', hint: 'left to right' },
  { id: 'rows', label: 'Stacked', hint: 'top to bottom' },
  { id: 'grid', label: 'Grid', hint: 'two per row' },
];

const SIZES = [null, 11, 12, 13, 14, 16, 18] as const;

/**
 * The label a group wears in the tab strip, and everything you can do to the
 * group from there: rename it, recolour it, set its own text size, and lay its
 * sessions out as a unit.
 */
export function GroupChip({ groupId, leafId }: { groupId: string; leafId: string }) {
  const group = useStore((s) => s.groups.find((g) => g.id === groupId));
  const memberCount = useStore(
    (s) => Object.values(s.sessions).filter((session) => session.groupId === groupId).length,
  );
  const updateGroup = useStore((s) => s.updateGroup);
  const removeGroupOnly = useStore((s) => s.removeGroupOnly);
  const arrangeGroupAs = useStore((s) => s.arrangeGroupAs);
  const moveGroup = useStore((s) => s.moveGroup);
  const requestCloseGroup = useStore((s) => s.requestCloseGroup);
  const minimizeGroup = useStore((s) => s.minimizeGroup);
  const toggleZoomOf = useStore((s) => s.toggleZoomOf);
  const setDraggingGroupId = useStore((s) => s.setDraggingGroupId);
  const ownsSection = useStore((s) => s.groupSection(groupId) !== null);
  const draggingSession = useStore((s) => s.draggingSessionId);
  const setDraggingSession = useStore((s) => s.setDraggingSessionId);
  const addToGroup = useStore((s) => s.addToGroup);
  const [over, setOver] = useState(false);

  const chipRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);

  if (!group) return null;

  return (
    <>
      <button
        ref={chipRef}
        className={`group-chip${over ? ' is-drop-target' : ''}`}
        style={{ color: group.color, borderColor: group.color }}
        onDragOver={(event) => {
          // The chip is the group made clickable, so it is also the group made
          // droppable: dragging a tab onto the label puts it in.
          if (!draggingSession) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'move';
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          const sessionId = event.dataTransfer.getData(SESSION_MIME) || draggingSession;
          setOver(false);
          if (!sessionId) return;
          event.preventDefault();
          event.stopPropagation();
          setDraggingSession(null);
          addToGroup(sessionId, groupId);
        }}
        draggable={!renaming}
        onDragStart={(event) => {
          setDraggingGroupId(groupId);
          event.dataTransfer.setData(GROUP_MIME, groupId);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => setDraggingGroupId(null)}
        title={`${group.name} — ${memberCount} session${memberCount === 1 ? '' : 's'}\nDrag a tab onto this label to add it; drag the label to move the group`}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onDoubleClick={() => {
          setOpen(false);
          setRenaming(true);
        }}
      >
        <span className="group-dot" style={{ background: group.color }} />
        {renaming ? (
          <input
            className="group-rename"
            autoFocus
            defaultValue={group.name}
            onClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name) updateGroup(groupId, { name });
              setRenaming(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
              if (event.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span className="group-name">{group.name}</span>
        )}
      </button>

      {open && (
        <Popover anchorEl={chipRef.current} onClose={() => setOpen(false)}>
          <div className="popover-header">
            <span>{group.name}</span>
            <button className="link-btn" onClick={() => { setOpen(false); setRenaming(true); }}>
              Rename
            </button>
          </div>

          <div className="group-swatches">
            {['#7dcfff', '#f7768e', '#9ece6a', '#e0af68', '#bb9af7', '#41a6b5', '#ff9e64'].map((color) => (
              <button
                key={color}
                className={`swatch${group.color === color ? ' is-selected' : ''}`}
                style={{ background: color }}
                aria-label={color}
                onClick={() => updateGroup(groupId, { color })}
              />
            ))}
          </div>

          <label className="field">
            <span>Text size for this group</span>
            <div className="segmented">
              {SIZES.map((size) => (
                <button
                  key={String(size)}
                  className={group.fontSize === size ? 'is-on' : ''}
                  onClick={() => updateGroup(groupId, { fontSize: size })}
                >
                  {size ?? 'default'}
                </button>
              ))}
            </div>
          </label>

          <div className="menu-label">Arrange its sessions</div>
          {ARRANGEMENTS.map((option) => (
            <button
              key={option.id}
              className="menu-item"
              onClick={() => {
                setOpen(false);
                arrangeGroupAs(groupId, option.id);
              }}
            >
              <span>{option.label}</span>
              <kbd>{option.hint}</kbd>
            </button>
          ))}

          <div className="menu-separator" />
          <div className="menu-label">
            {ownsSection ? 'Move this whole section' : 'Gather it beside this pane'}
          </div>
          <div className="group-moves">
            {(['left', 'right', 'top', 'bottom'] as const).map((side) => (
              <button
                key={side}
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  moveGroup(groupId, leafId, side);
                }}
              >
                <span>{side}</span>
              </button>
            ))}
          </div>

          <p className="form-hint">
            {ownsSection
              ? 'This group has the pane to itself, so it travels as one section. Drag its label onto another pane to move it there.'
              : 'Its tabs share a pane with others, so they are gathered where they land. Give it a section of its own to move it whole.'}
          </p>

          <div className="menu-separator" />
          {/* Two ways to give the group the room it needs: all of it, or none of
              it. Both are here because both are about the group as a whole. */}
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              minimizeGroup(groupId);
            }}
          >
            <span>Set the group aside</span>
            <kbd>keeps running</kbd>
          </button>
          {ownsSection && (
            <button
              className="menu-item"
              onClick={() => {
                const section = useStore.getState().groupSection(groupId);
                setOpen(false);
                if (section) toggleZoomOf(section);
              }}
            >
              <span>Fill the window with it</span>
              <kbd>⌥⌘⏎</kbd>
            </button>
          )}

          <div className="menu-separator" />
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              requestCloseGroup(groupId);
            }}
          >
            <span>Close these sessions</span>
            <kbd>reopen from History</kbd>
          </button>
          <button
            className="menu-item is-danger"
            onClick={() => {
              setOpen(false);
              removeGroupOnly(groupId);
            }}
          >
            <span>Ungroup</span>
            <kbd>keeps the sessions</kbd>
          </button>
        </Popover>
      )}
    </>
  );
}

/** Turn the tabs already sitting together in this pane into a group. */
export function GroupTheseTabs({ leafId, tabs }: { leafId: string; tabs: string[] }) {
  const createGroup = useStore((s) => s.createGroup);
  const sessions = useStore((s) => s.sessions);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [naming, setNaming] = useState(false);

  useEffect(() => {
    if (!naming) return;
    const cancel = (event: KeyboardEvent) => event.key === 'Escape' && setNaming(false);
    document.addEventListener('keydown', cancel);
    return () => document.removeEventListener('keydown', cancel);
  }, [naming]);

  const loose = tabs.filter((id) => sessions[id] && !sessions[id].groupId);
  if (loose.length < 2) return null;

  return (
    <>
      <button
        ref={buttonRef}
        className="icon-btn"
        title={`Group the ${loose.length} ungrouped tabs in this pane`}
        onClick={() => setNaming(true)}
      >
        &#9678;
      </button>
      {naming && (
        <Popover anchorEl={buttonRef.current} onClose={() => setNaming(false)}>
          <div className="popover-header">
            <span>Group {loose.length} tabs</span>
          </div>
          <label className="field">
            <span>Name</span>
            <input
              autoFocus
              placeholder="KS-ERP"
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                const name = (event.target as HTMLInputElement).value.trim();
                if (!name) return;
                createGroup(name, loose);
                setNaming(false);
              }}
            />
          </label>
          <p className="form-hint">
            They stay where they are. The group is what lets you recolour, resize and rearrange them
            together afterwards.
          </p>
        </Popover>
      )}
    </>
  );
}
