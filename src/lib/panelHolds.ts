/**
 * What an extension panel is holding on to, kept outside the frame.
 *
 * A panel's frame is rebuilt without the panel going anywhere — opening a
 * terminal underneath one splits its pane, which replaces a leaf with a split,
 * and React unmounts the old frame and mounts a new one. Anything kept inside
 * the frame therefore dies on an ordinary layout change: a followed log stopped,
 * a port-forward closed, the panel's Claude session forgotten, all done by the
 * app's own act of doing what was asked.
 *
 * So these live beside the panel, keyed by its id, and are let go of in exactly
 * one place — when the panel itself closes. That place is also what stops them
 * growing for ever: nothing used to delete from these maps at all.
 */

/** Where a panel last sat, so a rebuilt frame can be given its place back. */
export const whereEachPanelWas = new Map<string, unknown>();

/** The Claude session a cluster panel talks to, one per panel. */
export const claudeForPanel = new Map<string, string>();

/** Panels already given one, so a rebuilt frame does not open a second. */
export const alreadyOffered = new Set<string>();

/** What each panel started and still owns: a followed log, a held-open port. */
const streamsByPanel = new Map<string, Set<string>>();

export function streamsFor(panelId: string): Set<string> {
  const held = streamsByPanel.get(panelId) ?? new Set<string>();
  streamsByPanel.set(panelId, held);
  return held;
}

/**
 * The panel has really closed: stop what it was holding open, and forget it.
 *
 * Called from `closePanel` and nowhere else. A frame being rebuilt must never
 * reach this, which is the whole reason any of it is out here.
 */
export function forgetPanel(panelId: string) {
  for (const id of streamsByPanel.get(panelId) ?? []) window.api.kube.stopStream(id);
  streamsByPanel.delete(panelId);
  whereEachPanelWas.delete(panelId);
  claudeForPanel.delete(panelId);
  alreadyOffered.delete(panelId);
}
