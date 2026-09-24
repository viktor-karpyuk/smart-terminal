/**
 * A pointer drag that always ends.
 *
 * Every divider in the app does the same thing: listen on the window while the
 * pointer is down, and stop when it comes up. The trouble is everything that is
 * not the pointer coming up — a trackpad force-gesture taken over by the system,
 * a dialog stealing the pointer, the panel unmounting mid-drag because something
 * else reshaped the layout. `pointerup` never arrives, so the move handler goes
 * on firing for the rest of the session against a panel that may not exist any
 * more, and worse: a drag also sets `body.resizing`, which is
 * `pointer-events: none` on everything, so the whole window stops answering the
 * mouse until it is reloaded.
 *
 * A drag here therefore ends on `pointerup`, on `pointercancel`, when the window
 * loses focus, and when anything starts another one. Written once because five
 * places had five copies of only the half that works.
 */

let endCurrent: (() => void) | null = null;

/**
 * Begin a drag. Returns the function that ends it, for a caller that has to end
 * one itself — an unmount, say.
 */
export function startDrag(onMove: (event: PointerEvent) => void, onEnd?: () => void): () => void {
  // Only ever one. A second starting while a first is somehow still armed is
  // itself the evidence that the first never ended.
  endCurrent?.();

  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    window.removeEventListener('blur', stop);
    document.body.classList.remove('resizing');
    if (endCurrent === stop) endCurrent = null;
    onEnd?.();
  };

  document.body.classList.add('resizing');
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);
  endCurrent = stop;
  return stop;
}

/** End whatever drag is running, if any. For a teardown that cannot wait. */
export function endDrag() {
  endCurrent?.();
}
