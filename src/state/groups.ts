import type { GroupArrangement, LayoutNode, LeafNode } from './types';
import { allLeaves, dropTab, isLeaf, leafOfTab, makeLeaf, prune, removeTab, setActiveTab } from './layout';

/**
 * Gather a group's sessions into one place and arrange them there.
 *
 * The sessions may be scattered across panes, so they are pulled out one at a
 * time and rebuilt in the shape asked for. `tabs` stacks them in a single pane;
 * the others split that pane so every session is visible at once.
 */
export function arrangeGroup(
  root: LayoutNode,
  members: string[],
  arrangement: GroupArrangement,
  anchorLeafId?: string,
): LayoutNode {
  const present = members.filter((id) => leafOfTab(root, id));
  if (present.length === 0) return root;

  // Somewhere to put them: the pane holding the first member, unless told otherwise.
  const anchor =
    (anchorLeafId && allLeaves(root).find((leaf) => leaf.id === anchorLeafId)) ??
    leafOfTab(root, present[0]);
  if (!anchor) return root;

  let next = root;
  for (const id of present) next = dropTab(next, id, anchor.id, 'center');
  next = setActiveTab(next, anchor.id, present[present.length - 1]);
  if (arrangement === 'tabs') return prune(next);

  const gathered = allLeaves(next).find((leaf) => present.every((id) => leaf.tabs.includes(id)));
  if (!gathered) return prune(next);

  return prune(split(next, gathered, present, arrangement));
}

/** Replace the pane holding the members with a split of one pane per member. */
function split(
  root: LayoutNode,
  gathered: LeafNode,
  members: string[],
  arrangement: GroupArrangement,
): LayoutNode {
  const others = gathered.tabs.filter((id) => !members.includes(id));
  const panes: LayoutNode[] = members.map((id) => makeLeaf([id]));
  // Anything that was already sharing the pane keeps a home of its own.
  if (others.length) panes.unshift({ ...makeLeaf(others), active: others[0] });

  const replacement: LayoutNode =
    arrangement === 'grid' ? asGrid(panes) : asLine(panes, arrangement === 'columns' ? 'row' : 'column');

  const swap = (node: LayoutNode): LayoutNode => {
    if (isLeaf(node)) return node.id === gathered.id ? replacement : node;
    return { ...node, children: node.children.map(swap) };
  };
  return swap(root);
}

function asLine(panes: LayoutNode[], direction: 'row' | 'column'): LayoutNode {
  if (panes.length === 1) return panes[0];
  return {
    id: crypto.randomUUID(),
    type: 'split',
    direction,
    children: panes,
    sizes: panes.map(() => 1 / panes.length),
  };
}

/** Rows of two, which is the shape that keeps four terminals readable. */
function asGrid(panes: LayoutNode[]): LayoutNode {
  if (panes.length <= 2) return asLine(panes, 'row');
  const rows: LayoutNode[] = [];
  for (let i = 0; i < panes.length; i += 2) {
    rows.push(asLine(panes.slice(i, i + 2), 'row'));
  }
  return asLine(rows, 'column');
}

/**
 * Move a whole group to a pane, keeping its members side by side rather than
 * scattering them among whatever was already there.
 */
export function moveGroupTo(
  root: LayoutNode,
  members: string[],
  targetLeafId: string,
  side: 'left' | 'right' | 'top' | 'bottom' | 'center',
): LayoutNode {
  const present = members.filter((id) => leafOfTab(root, id));
  if (!present.length) return root;

  let next = dropTab(root, present[0], targetLeafId, side);
  const landed = leafOfTab(next, present[0]);
  if (!landed) return prune(next);
  for (const id of present.slice(1)) next = dropTab(next, id, landed.id, 'center');
  return prune(setActiveTab(next, landed.id, present[0]));
}

/** Take a group's sessions out of the workspace entirely. */
export function removeGroup(root: LayoutNode, members: string[]): LayoutNode {
  return members.reduce((tree, id) => removeTab(tree, id), root);
}
