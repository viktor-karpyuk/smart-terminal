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


/**
 * Where a pane sits, described so it can be put back there later.
 *
 * Not by split id and index: removing a pane rebuilds the tree above it, and a
 * split with two children collapses into its surviving child, so both of those
 * are gone by the time anyone wants to undo it. What survives is a *tab* — a
 * session or a panel keeps its id wherever the tree moves it — so the place is
 * remembered as "the side of whichever pane holds this tab".
 */
export interface PanePlace {
  /** A tab in the pane this one sat next to. Kept for places recorded before
   *  `anchorTabs` existed, so a section set aside by an older build still lands. */
  anchorTabId: string | null;
  /**
   * Every tab that was in the neighbouring *block*, not just the nearest pane.
   *
   * One tab is not enough. A pane whose neighbour is a column of three sits
   * beside the whole column, and naming a single tab inside it brings the pane
   * back wedged against that one pane instead — the column loses its left-hand
   * neighbour and gains an intruder in the middle of it. Remembering the block
   * lets the restore find what those tabs have in common and hang the pane off
   * that instead.
   */
  anchorTabs: string[];
  side: Exclude<DropSide, 'center'> | null;
  /** Its share of the split, so it comes back the width it was. */
  share: number;
}

export function panePlace(root: LayoutNode, leafId: string): PanePlace {
  const parent = parentOf(root, leafId);
  if (!parent) return { anchorTabId: null, anchorTabs: [], side: null, share: 1 };

  const at = parent.children.findIndex((child) => child.id === leafId);
  const share = parent.sizes[at] ?? 1 / parent.children.length;
  // The neighbour on either side; the one before it is preferred, so a pane that
  // was second comes back second rather than drifting to the front.
  const before = at > 0 ? parent.children[at - 1] : null;
  const after = at < parent.children.length - 1 ? parent.children[at + 1] : null;
  const neighbour = before ?? after;
  if (!neighbour) return { anchorTabId: null, anchorTabs: [], side: null, share };

  const anchorTabs = allTabs(neighbour);
  const side = parent.direction === 'row'
    ? (before ? 'right' : 'left')
    : (before ? 'bottom' : 'top');
  return { anchorTabId: anchorTabs[0] ?? null, anchorTabs, side, share };
}

/** Any node by id, split or leaf — the restore hangs a pane off either. */
function findNode(node: LayoutNode, id: string): LayoutNode | null {
  if (node.id === id) return node;
  if (node.type === 'leaf') return null;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** The chain of nodes from the root down to the leaf holding `tabId`. */
function chainTo(node: LayoutNode, tabId: string, trail: LayoutNode[] = []): LayoutNode[] | null {
  const here = [...trail, node];
  if (node.type === 'leaf') return node.tabs.includes(tabId) ? here : null;
  for (const child of node.children) {
    const found = chainTo(child, tabId, here);
    if (found) return found;
  }
  return null;
}

/**
 * The smallest node containing all of these tabs.
 *
 * How a block is found again after the tree around it has changed. Tabs that
 * have since been closed are simply not there, so a neighbour that has lost some
 * of its panes still resolves — to whatever is left of it, which is the right
 * answer.
 */
export function commonAncestor(root: LayoutNode, tabIds: string[]): LayoutNode | null {
  const chains = tabIds.map((tabId) => chainTo(root, tabId)).filter(Boolean) as LayoutNode[][];
  if (!chains.length) return null;
  let deepest = chains[0];
  for (let depth = 0; ; depth += 1) {
    const node = chains[0][depth];
    if (!node || !chains.every((chain) => chain[depth]?.id === node.id)) break;
    deepest = chains[0].slice(0, depth + 1);
  }
  return deepest[deepest.length - 1] ?? null;
}

/**
 * Put a pane back where `panePlace` said it was.
 *
 * When the anchor is gone — its tab closed while the pane was away — the pane
 * still comes back, beside `fallbackLeafId`. Refusing to restore something
 * because its neighbour left would be the worst of both.
 */
export function restorePaneAt(
  root: LayoutNode,
  tabs: string[],
  active: string | null,
  place: PanePlace,
  fallbackLeafId: string,
): { root: LayoutNode; leafId: string } {
  const restored: LeafNode = { id: uid(), type: 'leaf', tabs, active: active ?? tabs[0] ?? null };

  // The whole block it sat beside, when that was recorded; a single pane when the
  // place was written by a build that only knew how to remember one.
  const remembered = place.anchorTabs?.length ? place.anchorTabs : (place.anchorTabId ? [place.anchorTabId] : []);
  const anchor = remembered.length ? commonAncestor(root, remembered) : null;
  const target = anchor?.id ?? fallbackLeafId;
  const side = place.side ?? 'right';
  if (!findNode(root, target)) {
    // Nothing left to hang it on: it becomes the workspace.
    return { root: prune(restored), leafId: restored.id };
  }

  const direction = AXIS[side];
  const before = side === 'left' || side === 'top';
  const parent = parentOf(root, target);

  if (parent && isSplit(parent) && parent.direction === direction) {
    const at = parent.children.findIndex((child) => child.id === target);
    const neighbourShare = parent.sizes[at] ?? 1 / parent.children.length;
    const children = parent.children.slice();
    const sizes = parent.sizes.slice();
    children.splice(before ? at : at + 1, 0, restored);
    // The neighbour gives back what this pane had; if that is not on record,
    // they halve it, which is what a fresh split does.
    const mine = Math.min(Math.max(place.share, 0.05), 0.95);
    const total = neighbourShare;
    sizes[at] = Math.max(0.05, total * (1 - mine));
    sizes.splice(before ? at : at + 1, 0, Math.max(0.05, total * mine));
    const updated: SplitNode = { ...parent, children, sizes: normalize(sizes) };
    return { root: prune(replaceNode(root, parent.id, () => updated) ?? root), leafId: restored.id };
  }

  const wrapped = replaceNode(root, target, (found) => ({
    id: uid(),
    type: 'split',
    direction,
    children: before ? [restored, found] : [found, restored],
    sizes: before
      ? [place.share, 1 - place.share]
      : [1 - place.share, place.share],
  }));
  return { root: prune(wrapped ?? root), leafId: restored.id };
}


/**
 * Trade two panes' contents.
 *
 * Swapping what they hold rather than where they sit, which looks identical and
 * is the only version that always makes sense: two panes can be anywhere in the
 * tree, in splits of different axes and different depths, and there is no
 * general "exchange these two positions" that leaves the rest of the layout
 * alone. Their sizes stay with the places, not with the contents — which is
 * what someone means by putting this one over there.
 */
export function swapPanes(root: LayoutNode, a: string, b: string): LayoutNode {
  if (a === b) return root;
  const first = findLeaf(root, a);
  const second = findLeaf(root, b);
  if (!first || !second) return root;

  const swap = (node: LayoutNode): LayoutNode => {
    if (isLeaf(node)) {
      if (node.id === a) return { ...node, tabs: second.tabs, active: second.active };
      if (node.id === b) return { ...node, tabs: first.tabs, active: first.active };
      return node;
    }
    return { ...node, children: node.children.map(swap) };
  };
  // No prune: an empty pane on either side was deliberate, and pruning here
  // would delete the very thing that was just moved into place.
  return swap(root);
}
