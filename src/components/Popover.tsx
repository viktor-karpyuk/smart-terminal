import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  /** Anchor the menu under an element (a button that opens it). */
  anchorEl?: HTMLElement | null;
  /** Or anchor it at a point (a right-click). */
  anchorPoint?: { x: number; y: number } | null;
  onClose(): void;
  children: ReactNode;
}

/**
 * Floats next to its trigger. Rendered into <body> so no ancestor's `overflow:
 * hidden` can clip it, and clamped to the viewport so a trigger near an edge
 * still gets a fully visible menu.
 */
export function Popover({ anchorEl, anchorPoint, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    function place() {
      if (!el) return;
      const margin = 8;
      const gap = 6;
      const size = el.getBoundingClientRect();
      const anchor = anchorEl?.getBoundingClientRect();

      let top: number;
      let left: number;
      if (anchorPoint) {
        // Below-right of the cursor, flipping up or left when it would run off.
        top = anchorPoint.y + 2;
        left = anchorPoint.x + 2;
        if (top + size.height > window.innerHeight - margin) top = anchorPoint.y - size.height - 2;
        if (left + size.width > window.innerWidth - margin) left = anchorPoint.x - size.width - 2;
      } else {
        // Right-aligned under the trigger; flips above when there is no room below.
        top = anchor ? anchor.bottom + gap : margin;
        left = anchor ? anchor.right - size.width : margin;
        if (anchor && top + size.height > window.innerHeight - margin) {
          top = anchor.top - size.height - gap;
        }
      }
      /*
       * A menu taller than the screen has to scroll, or its last item cannot be
       * reached at all.
       *
       * Clamping alone cannot save it: with a menu taller than the viewport the
       * lower bound passes the upper one, and whichever end wins, the other is
       * off-screen with no way to get to it. On a laptop the session menu is
       * long enough for that to be an ordinary Tuesday rather than an edge case.
       *
       * So the height is capped to the room there actually is — the whole
       * viewport less its margins, since the position is clamped into that
       * anyway — and the body scrolls inside it.
       */
      const room = window.innerHeight - margin * 2;
      const height = Math.min(size.height, room);

      top = clamp(top, margin, Math.max(margin, window.innerHeight - height - margin));
      left = clamp(left, margin, Math.max(margin, window.innerWidth - size.width - margin));
      setPosition({ top, left, maxHeight: room });
    }

    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  // Depend on the coordinates, not the object: callers pass a fresh literal each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorEl, anchorPoint?.x, anchorPoint?.y]);

  useEffect(() => {
    function onDown(event: MouseEvent) {
      const target = event.target as Node;
      // Clicks on the trigger are its own business — otherwise the button would
      // close the menu here and immediately reopen it on click.
      if (ref.current?.contains(target) || anchorEl?.contains(target)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorEl, onClose]);

  return createPortal(
    <div
      ref={ref}
      className={`popover${anchorPoint ? ' popover-menu' : ''}`}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        // Measured before it is capped: the cap is applied after the first
        // layout, so the menu is sized by its content and then held to the room.
        maxHeight: position?.maxHeight,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}
