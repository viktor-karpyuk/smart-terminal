import type { Direction, DropSide, LayoutNode, LeafNode, SplitNode } from './types';

const uid = () => crypto.randomUUID();

export const makeLeaf = (tabs: string[] = []): LeafNode => ({
  id: uid(),
  type: 'leaf',
  tabs,
  active: tabs[0] ?? null,
});

export const isLeaf = (node: LayoutNode): node is LeafNode => node.type === 'leaf';
export const isSplit = (node: LayoutNode): node is SplitNode => node.type === 'split';

export function allLeaves(node: LayoutNode): LeafNode[] {
  return isLeaf(node) ? [node] : node.children.flatMap(allLeaves);
}

export function findLeaf(node: LayoutNode, leafId: string): LeafNode | null {
  return allLeaves(node).find((leaf) => leaf.id === leafId) ?? null;
}

export function leafOfTab(node: LayoutNode, tabId: string): LeafNode | null {
  return allLeaves(node).find((leaf) => leaf.tabs.includes(tabId)) ?? null;
}

export function allTabs(node: LayoutNode): string[] {
  return allLeaves(node).flatMap((leaf) => leaf.tabs);
}

/** Rebuild the tree, replacing whichever node matches `id` with `replacer`'s result. */
function replaceNode(
  node: LayoutNode,
  id: string,
  replacer: (found: LayoutNode) => LayoutNode | null,
): LayoutNode | null {
  if (node.id === id) return replacer(node);
  if (isLeaf(node)) return node;

  let changed = false;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const next = replaceNode(child, id, replacer);
    if (next !== child) changed = true;
    if (next) {
      children.push(next);
      sizes.push(node.sizes[i]);
    }
  });
  if (!changed) return node;
  return { ...node, children, sizes: normalize(sizes) };
}

function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!total || !Number.isFinite(total)) return sizes.map(() => 1 / Math.max(1, sizes.length));
  return sizes.map((s) => s / total);
}

/** Collapse splits with one child and merge nested splits sharing an axis. */
export function prune(node: LayoutNode): LayoutNode {
  if (isLeaf(node)) return node;

  const children: LayoutNode[] = [];
  const sizes: number[] = [];

  node.children.forEach((rawChild, i) => {
    const child = prune(rawChild);
    const size = node.sizes[i] ?? 1 / node.children.length;

    // An empty pane survives if it was asked for, or if it is the whole workspace.
    if (isLeaf(child) && child.tabs.length === 0 && !child.placeholder) return;

    if (isSplit(child) && child.direction === node.direction) {
      // Inline the nested split so dividers stay in one continuous row/column.
      child.children.forEach((grand, gi) => {
        children.push(grand);
        sizes.push(size * (child.sizes[gi] ?? 1 / child.children.length));
      });
      return;
    }
    children.push(child);
    sizes.push(size);
  });

  if (children.length === 0) return makeLeaf();
  if (children.length === 1) return children[0];
  return { ...node, children, sizes: normalize(sizes) };
}

export function insertTab(
  root: LayoutNode,
  leafId: string,
  tabId: string,
  index?: number,
  activate = true,
): LayoutNode {
  const next = replaceNode(root, leafId, (found) => {
    if (!isLeaf(found)) return found;
    const tabs = found.tabs.filter((t) => t !== tabId);
    const at = index === undefined ? tabs.length : Math.max(0, Math.min(index, tabs.length));
    tabs.splice(at, 0, tabId);
    const active = activate || !found.active ? tabId : found.active;
    // It has something in it now, so it is a pane like any other.
    return { ...found, tabs, active, placeholder: false };
  });
  return next ?? root;
}

/** Remove a tab everywhere it appears; empty panes are pruned away. */
export function removeTab(root: LayoutNode, tabId: string): LayoutNode {
  const strip = (node: LayoutNode): LayoutNode => {
    if (isLeaf(node)) {
      if (!node.tabs.includes(tabId)) return node;
      const tabs = node.tabs.filter((t) => t !== tabId);
      const wasActive = node.active === tabId;
      const fallbackIndex = Math.min(node.tabs.indexOf(tabId), tabs.length - 1);
      return {
        ...node,
        tabs,
        active: wasActive ? (tabs[fallbackIndex] ?? null) : node.active,
      };
    }
    return { ...node, children: node.children.map(strip) };
  };
  return prune(strip(root));
}

const AXIS: Record<Exclude<DropSide, 'center'>, Direction> = {
  left: 'row',
  right: 'row',
  top: 'column',
  bottom: 'column',
};

/**
 * Drop `tabId` onto `targetLeafId`. `center` appends it as a tab; the four edges
 * split the pane along the matching axis. When the parent already splits along
 * that axis the tab joins it as a sibling instead of nesting a new split, which
 * keeps dividers aligned the way VS Code's editor grid does.
 */
export function dropTab(
  root: LayoutNode,
  tabId: string,
  targetLeafId: string,
  side: DropSide,
  index?: number,
): LayoutNode {
  const target = findLeaf(root, targetLeafId);
  if (!target) return root;

  if (side === 'center') {
    const detached = detach(root, tabId, targetLeafId);
    return prune(insertTab(detached, targetLeafId, tabId, index));
  }

  // A lone tab dropped on the edge of its own pane would be a no-op split.
  if (target.tabs.length === 1 && target.tabs[0] === tabId) return root;

  const direction = AXIS[side];
  const before = side === 'left' || side === 'top';
  const detached = detach(root, tabId, targetLeafId);
  const newLeaf = makeLeaf([tabId]);

  const parent = parentOf(detached, targetLeafId);
  if (parent && isSplit(parent) && parent.direction === direction) {
    const at = parent.children.findIndex((c) => c.id === targetLeafId);
    const share = parent.sizes[at] ?? 1 / parent.children.length;
    const children = parent.children.slice();
    const sizes = parent.sizes.slice();
    children.splice(before ? at : at + 1, 0, newLeaf);
    sizes[at] = share / 2;
    sizes.splice(before ? at : at + 1, 0, share / 2);
    const updated: SplitNode = { ...parent, children, sizes: normalize(sizes) };
    return prune(replaceNode(detached, parent.id, () => updated) ?? detached);
  }

  const wrapped = replaceNode(detached, targetLeafId, (found) => ({
    id: uid(),
    type: 'split',
    direction,
    children: before ? [newLeaf, found] : [found, newLeaf],
    sizes: [0.5, 0.5],
  }));
  return prune(wrapped ?? detached);
}

/**
 * Pull a tab out of the tree without pruning the pane it is being dropped on —
 * otherwise moving the last tab of a pane would delete the very drop target.
 */
function detach(root: LayoutNode, tabId: string, keepLeafId: string): LayoutNode {
  const strip = (node: LayoutNode): LayoutNode => {
    if (isLeaf(node)) {
      if (!node.tabs.includes(tabId)) return node;
      const tabs = node.tabs.filter((t) => t !== tabId);
      return { ...node, tabs, active: node.active === tabId ? (tabs[0] ?? null) : node.active };
    }
    return { ...node, children: node.children.map(strip) };
  };

  const stripped = strip(root);

  // Sizes are collected in the same pass as children. Matching them up afterwards
  // by id does not work: a split that collapses to its last child comes back with
  // that child's id, so its slot size would be dropped and every sibling silently
  // resized.
  const keepAlive = (node: LayoutNode): LayoutNode => {
    if (isLeaf(node)) return node;

    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((rawChild, index) => {
      const child = keepAlive(rawChild);
      // An emptied pane goes away, unless it is the one being dropped onto.
      if (child.id !== keepLeafId && isLeaf(child) && child.tabs.length === 0 && !child.placeholder) return;
      children.push(child);
      sizes.push(node.sizes[index] ?? 1 / node.children.length);
    });

    if (children.length === 0) return makeLeaf();
    if (children.length === 1) return children[0];
    return { ...node, children, sizes: normalize(sizes) };
  };
  return keepAlive(stripped);
}

export function parentOf(node: LayoutNode, childId: string): SplitNode | null {
  if (isLeaf(node)) return null;
  if (node.children.some((c) => c.id === childId)) return node;
  for (const child of node.children) {
    const found = parentOf(child, childId);
    if (found) return found;
  }
  return null;
}

/** Split a pane in place and put a brand-new tab in the created half. */
export function splitLeaf(
  root: LayoutNode,
  leafId: string,
  direction: Direction,
  newTabId: string,
): { root: LayoutNode; leafId: string } {
  const newLeaf = makeLeaf([newTabId]);
  const parent = parentOf(root, leafId);

  if (parent && parent.direction === direction) {
    const at = parent.children.findIndex((c) => c.id === leafId);
    const share = parent.sizes[at] ?? 1 / parent.children.length;
    const children = parent.children.slice();
    const sizes = parent.sizes.slice();
    children.splice(at + 1, 0, newLeaf);
    sizes[at] = share / 2;
    sizes.splice(at + 1, 0, share / 2);
    const next = replaceNode(root, parent.id, () => ({ ...parent, children, sizes: normalize(sizes) }));
    return { root: next ?? root, leafId: newLeaf.id };
  }

  const next = replaceNode(root, leafId, (found) => ({
    id: uid(),
    type: 'split',
    direction,
    children: [found, newLeaf],
    sizes: [0.5, 0.5],
  }));
  return { root: next ?? root, leafId: newLeaf.id };
}

export function setSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  const next = replaceNode(root, splitId, (found) =>
    isSplit(found) ? { ...found, sizes: normalize(sizes) } : found,
  );
  return next ?? root;
}

export function setActiveTab(root: LayoutNode, leafId: string, tabId: string): LayoutNode {
  const next = replaceNode(root, leafId, (found) =>
    isLeaf(found) ? { ...found, active: tabId } : found,
  );
  return next ?? root;
}

export function evenOut(node: LayoutNode): LayoutNode {
  if (isLeaf(node)) return node;
  return {
    ...node,
    children: node.children.map(evenOut),
    sizes: node.children.map(() => 1 / node.children.length),
  };
}

/**
 * Split a pane and leave the new half empty.
 *
 * Splitting the screen is a layout decision, not a request to start work: what
 * goes in the new pane, and under which account, is a separate choice the empty
 * pane offers.
 */
export function splitEmpty(
  root: LayoutNode,
  leafId: string,
  direction: Direction,
): { root: LayoutNode; leafId: string } {
  const created: LeafNode = { id: uid(), type: 'leaf', tabs: [], active: null, placeholder: true };
  const parent = parentOf(root, leafId);

  if (parent && parent.direction === direction) {
    const at = parent.children.findIndex((child) => child.id === leafId);
    const share = parent.sizes[at] ?? 1 / parent.children.length;
    const children = parent.children.slice();
    const sizes = parent.sizes.slice();
    children.splice(at + 1, 0, created);
    sizes[at] = share / 2;
    sizes.splice(at + 1, 0, share / 2);
    const next = replaceNode(root, parent.id, () => ({ ...parent, children, sizes: normalize(sizes) }));
    return { root: next ?? root, leafId: created.id };
  }

  const next = replaceNode(root, leafId, (found) => ({
    id: uid(),
    type: 'split',
    direction,
    children: [found, created],
    sizes: [0.5, 0.5],
  }));
  return { root: next ?? root, leafId: created.id };
}

/**
 * Relocate a whole pane, keeping it one pane.
 *
 * Moving a pane is not the same as moving each of its tabs: the tabs would be
 * absorbed into whatever pane they land on, while this keeps the section intact
 * and puts it beside the target.
 */
export function movePane(
  root: LayoutNode,
  paneId: string,
  targetLeafId: string,
  side: Exclude<DropSide, 'center'>,
): LayoutNode {
  if (paneId === targetLeafId) return root;
  const pane = findLeaf(root, paneId);
  const target = findLeaf(root, targetLeafId);
  if (!pane || !target) return root;

  // Lift it out first, keeping the target alive even if the pane was its neighbour.
  const lifted = removePane(root, paneId, targetLeafId);
  const direction = AXIS[side];
  const before = side === 'left' || side === 'top';

  const parent = parentOf(lifted, targetLeafId);
  if (parent && isSplit(parent) && parent.direction === direction) {
    const at = parent.children.findIndex((child) => child.id === targetLeafId);
    const share = parent.sizes[at] ?? 1 / parent.children.length;
    const children = parent.children.slice();
    const sizes = parent.sizes.slice();
    children.splice(before ? at : at + 1, 0, pane);
    sizes[at] = share / 2;
    sizes.splice(before ? at : at + 1, 0, share / 2);
    const updated: SplitNode = { ...parent, children, sizes: normalize(sizes) };
    return prune(replaceNode(lifted, parent.id, () => updated) ?? lifted);
  }

  const wrapped = replaceNode(lifted, targetLeafId, (found) => ({
    id: uid(),
    type: 'split',
    direction,
    children: before ? [pane, found] : [found, pane],
    sizes: [0.5, 0.5],
  }));
  return prune(wrapped ?? lifted);
}

/**
 * Close a pane and give its space back to its neighbours. Splitting the screen
 * has to be undoable, or an unwanted split is stuck there.
 */
export function closePane(root: LayoutNode, paneId: string): LayoutNode {
  if (isLeaf(root)) return root; // the last pane is the workspace itself
  return prune(removePane(root, paneId, ''));
}

/** Take a pane out of the tree without collapsing the pane it is moving next to. */
function removePane(root: LayoutNode, paneId: string, keepLeafId: string): LayoutNode {
  const strip = (node: LayoutNode): LayoutNode | null => {
    if (isLeaf(node)) return node.id === paneId ? null : node;
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, index) => {
      const next = strip(child);
      if (!next) return;
      children.push(next);
      sizes.push(node.sizes[index] ?? 1 / node.children.length);
    });
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    return { ...node, children, sizes: normalize(sizes) };
  };
  const stripped = strip(root);
  return stripped ?? makeLeaf();
  void keepLeafId;
}

/**
 * Split a set of tabs out of their pane into a new one beside it.
 *
 * Used when a group is made: the group gets a section of its own straight away,
 * which is what makes it something you can then move and arrange as a unit.
 */
export function splitOffTabs(
  root: LayoutNode,
  tabs: string[],
  direction: Direction = 'row',
): { root: LayoutNode; leafId: string } {
  const source = tabs.length ? leafOfTab(root, tabs[0]) : null;
  if (!source) return { root, leafId: '' };

  const moving = source.tabs.filter((id) => tabs.includes(id));
  const staying = source.tabs.filter((id) => !tabs.includes(id));
  // Already a section of its own: nothing to split.
  if (!staying.length) return { root, leafId: source.id };

  const created: LeafNode = { id: uid(), type: 'leaf', tabs: moving, active: moving[0] ?? null };
  const remaining: LeafNode = {
    ...source,
    tabs: staying,
    active: staying.includes(source.active ?? '') ? source.active : (staying[0] ?? null),
  };

  const next = replaceNode(root, source.id, () => ({
    id: uid(),
    type: 'split',
    direction,
    children: [remaining, created],
    sizes: [0.5, 0.5],
  }));
  return { root: prune(next ?? root), leafId: created.id };
}

/** Drop tabs that no longer have a live session behind them (e.g. after a restart). */
export function keepOnly(node: LayoutNode, validTabs: Set<string>): LayoutNode {
  const filter = (n: LayoutNode): LayoutNode => {
    if (isLeaf(n)) {
      const tabs = n.tabs.filter((t) => validTabs.has(t));
      return { ...n, tabs, active: tabs.includes(n.active ?? '') ? n.active : (tabs[0] ?? null) };
    }
    return { ...n, children: n.children.map(filter) };
  };
  return prune(filter(node));
}
