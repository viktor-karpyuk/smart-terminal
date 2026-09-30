/*
 * The frames extensions draw in, kept out of React's hands.
 *
 * A pane that changes shape — a terminal opening under a panel, that terminal
 * or its Claude session closing again, a section minimised and brought back —
 * is a different position in a different tree, so React unmounts the panel and
 * mounts it again. With the <iframe> as a React child that meant a new frame:
 * a new document, a cluster's worth of JSON read again, a followed log and
 * everything on screen gone. `whereEachPanelWas` put the navigation back, but
 * the reload itself was still there for everybody to watch.
 *
 * So the frame is made here, once per panel, and only ever *moved*.
 * `moveBefore` is the one DOM move that keeps a frame's document running; an
 * ordinary insert reloads it. Between two homes — the old pane gone, the new
 * one not yet laid out, or the panel minimised — it waits in a hidden lot on
 * the body, still connected, which is what `moveBefore` needs of both ends.
 *
 * A frame is thrown away for two reasons only: its panel closed, or it was made
 * for something else — another theme, another version of the extension — which
 * is what `key` says.
 */

type Kept = { key: string; frame: HTMLIFrameElement };

const kept = new Map<string, Kept>();
let lot: HTMLDivElement | null = null;

type Movable = Element & { moveBefore?: (node: Node, child: Node | null) => void };

function parkingLot(): HTMLDivElement {
  if (lot && lot.isConnected) return lot;
  lot = document.createElement('div');
  lot.className = 'extension-frame-lot';
  lot.setAttribute('aria-hidden', 'true');
  document.body.appendChild(lot);
  return lot;
}

/** Into `parent`, keeping the document alive where the engine can. */
function place(parent: Element, frame: HTMLIFrameElement) {
  if (frame.parentElement === parent) return;
  const target = parent as Movable;
  if (typeof target.moveBefore === 'function' && frame.isConnected) {
    try {
      target.moveBefore(frame, null);
      return;
    } catch {
      // Not movable between these two (another document, say): fall through.
    }
  }
  parent.appendChild(frame);
}

/**
 * The frame for this panel, in `slot`. `reused` says whether it already has a
 * document running — in which case nobody should give it a new address.
 */
export function attachFrame(
  panelId: string,
  key: string,
  slot: Element,
  make: () => HTMLIFrameElement,
): { frame: HTMLIFrameElement; reused: boolean } {
  const held = kept.get(panelId);
  if (held && held.key === key) {
    place(slot, held.frame);
    return { frame: held.frame, reused: true };
  }
  if (held) held.frame.remove();
  const frame = make();
  slot.appendChild(frame);
  kept.set(panelId, { key, frame });
  return { frame, reused: false };
}

/** Its pane went away: wait in the lot, still running, for the next one. */
export function parkFrame(panelId: string, frame: HTMLIFrameElement) {
  const held = kept.get(panelId);
  if (!held || held.frame !== frame || !frame.isConnected) return;
  place(parkingLot(), frame);
}

/** The panel really closed. */
export function dropFrame(panelId: string) {
  kept.get(panelId)?.frame.remove();
  kept.delete(panelId);
}
