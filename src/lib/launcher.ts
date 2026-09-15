/**
 * Where a view opened from the activity bar goes.
 *
 * A launcher in the sidebar is a promise about *here*: press it and the view is
 * in front of you, in the section you were working in — not wherever it was
 * last left, three splits away or folded into the dock. There is one of each
 * such view (it is about the app, not about a folder), so pressing the button
 * again brings that one over instead of opening a second copy with its own
 * state that disagrees with the first.
 *
 * Pure, so the four cases are held still by a test rather than by a click.
 */

export interface LeafTabs {
  id: string;
  tabs: string[];
  active?: string | null;
}

export type LaunchPlan =
  /** Not open anywhere: open it, in the section in front. */
  | { action: 'open' }
  /** Already the section in front's: select it there. */
  | { action: 'focus'; panelId: string; leafId: string }
  /** Open in another section: bring it into the one in front. */
  | { action: 'move'; panelId: string; leafId: string }
  /** Folded into the dock: bring it back, into the section in front. */
  | { action: 'restore'; panelId: string; leafId: string | null };

export function launchPlan({
  leaves,
  activeLeafId,
  existingId,
  minimizedIds,
}: {
  leaves: LeafTabs[];
  activeLeafId: string | null;
  existingId: string | null;
  minimizedIds: string[];
}): LaunchPlan {
  if (!existingId) return { action: 'open' };
  // A section that no longer exists is no section: fall back to the first one there is.
  const target = leaves.find((leaf) => leaf.id === activeLeafId) ?? leaves[0] ?? null;
  if (minimizedIds.includes(existingId)) return { action: 'restore', panelId: existingId, leafId: target?.id ?? null };
  const holder = leaves.find((leaf) => leaf.tabs.includes(existingId));
  // Open but in no section at all is a layout that lost it: opening again is the honest repair.
  if (!holder) return { action: 'open' };
  if (!target || holder.id === target.id) return { action: 'focus', panelId: existingId, leafId: holder.id };
  return { action: 'move', panelId: existingId, leafId: target.id };
}
