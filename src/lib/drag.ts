export const SESSION_MIME = 'application/x-smart-terminal-session';
export const GROUP_MIME = 'application/x-smart-terminal-group';
/** A folder tab. Its own kind, so a group's label refuses it and a pane does not. */
export const PANEL_MIME = 'application/x-smart-terminal-panel';
/** A whole pane, dragged onto another to trade places with it. */
export const PANE_MIME = 'application/x-smart-terminal-pane';

export type Side = 'left' | 'right' | 'top' | 'bottom' | 'center';

/** Which quadrant of a pane the pointer is in — the edges split, the middle stacks. */
export function sideFromPoint(rect: DOMRect, x: number, y: number): Side {
  const px = (x - rect.left) / rect.width;
  const py = (y - rect.top) / rect.height;
  const edge = 0.22;
  const distances: Array<[Side, number]> = [
    ['left', px],
    ['right', 1 - px],
    ['top', py],
    ['bottom', 1 - py],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  const [side, distance] = distances[0];
  return distance < edge ? side : 'center';
}
