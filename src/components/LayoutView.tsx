import { Fragment, useCallback, useRef } from 'react';
import type { LayoutNode, SplitNode } from '../state/types';
import { useStore } from '../state/store';
import { Pane } from './Pane';

const SASH = 6;
const MIN_FRACTION = 0.06;

export function LayoutView({ node }: { node: LayoutNode }) {
  if (node.type === 'leaf') return <Pane leaf={node} />;
  return <Split node={node} />;
}

function Split({ node }: { node: SplitNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeSplit = useStore((s) => s.resizeSplit);

  const startDrag = useCallback(
    (index: number, event: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      event.preventDefault();
      (event.target as HTMLElement).setPointerCapture(event.pointerId);

      const horizontal = node.direction === 'row';
      const rect = container.getBoundingClientRect();
      const usable = (horizontal ? rect.width : rect.height) - SASH * (node.children.length - 1);
      const startPos = horizontal ? event.clientX : event.clientY;
      const startSizes = node.sizes.slice();
      const pairTotal = startSizes[index] + startSizes[index + 1];

      const onMove = (moveEvent: PointerEvent) => {
        const delta = ((horizontal ? moveEvent.clientX : moveEvent.clientY) - startPos) / usable;
        const first = Math.min(
          Math.max(startSizes[index] + delta, MIN_FRACTION),
          pairTotal - MIN_FRACTION,
        );
        const next = startSizes.slice();
        next[index] = first;
        next[index + 1] = pairTotal - first;
        resizeSplit(node.id, next);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.classList.remove('resizing');
      };

      document.body.classList.add('resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [node, resizeSplit],
  );

  return (
    <div
      ref={containerRef}
      className={`split split-${node.direction}`}
      data-split-id={node.id}
    >
      {node.children.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 && (
            <div
              className={`sash sash-${node.direction}`}
              onPointerDown={(event) => startDrag(index - 1, event)}
              role="separator"
              aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
            />
          )}
          <div
            className="split-child"
            style={{ flexGrow: node.sizes[index] ?? 1, flexBasis: 0 }}
          >
            <LayoutView node={child} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}
