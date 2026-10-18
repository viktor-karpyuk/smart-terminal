'use strict';

/**
 * Asking before taking worktrees away. The questions and the answers; the dialog itself and where the folders of live
 * sessions come from are handed in, so this can be run without a window.
 *
 * `quiet` is the background check: it says nothing when there is nothing, does not ask again about what was
 * declined in this run, and waits if it cannot tell where a live session is standing. From the menu it always answers.
 */

const path = require('node:path');

const SHOWN = 12;

/**
 * @param {object} deps
 * @param {{scan: Function, clean: Function}} deps.cleanup
 * @param {(box: {message: string, detail: string, buttons: string[]}) => Promise<number>} deps.ask  index of the button pressed, -1 for none
 * @param {(box: {type: string, message: string, detail: string}) => Promise<unknown>} deps.tell
 * @param {() => boolean} deps.sessionsKnown  every live session's folder is known
 */
function createOffer({ cleanup, ask, tell, sessionsKnown }) {
  const declined = new Set();
  let busy = false;

  async function offer({ quiet = false } = {}) {
    // Two answers at once would be two dialogs about the same folders.
    if (busy) return { shown: false, why: 'busy' };
    busy = true;
    try {
      if (quiet && !sessionsKnown()) return { shown: false, why: 'sessions-unknown' };
      let found;
      try {
        found = (await cleanup.scan()).filter((one) => !quiet || !declined.has(one.path));
      } catch (error) {
        if (!quiet) await tell({ type: 'error', message: 'The worktrees could not be checked.', detail: String(error?.message ?? error) });
        return { shown: false, why: 'error' };
      }
      if (!found.length) {
        if (!quiet) await tell({ type: 'info', message: 'There are no finished worktrees to clean up.', detail: 'A worktree is finished when its work is merged, it has no changes of its own, and no session is inside it.' });
        return { shown: false, why: 'nothing' };
      }
      const lines = found.slice(0, SHOWN).map((one) => `• ${one.label} — ${one.why}`);
      if (found.length > SHOWN) lines.push(`…and ${found.length - SHOWN} more`);
      const pressed = await ask({
        message: found.length === 1 ? 'Clean up 1 finished worktree?' : `Clean up ${found.length} finished worktrees?`,
        detail: `${lines.join('\n')}\n\nOnly what has no changes of its own is removed. git refuses the rest.`,
        buttons: [`Clean up ${found.length}`, 'Not now'],
      });
      if (pressed !== 0) {
        for (const one of found) declined.add(one.path);
        return { shown: true, cleaned: 0 };
      }
      const results = await cleanup.clean(found.map((one) => one.path));
      const failed = results.filter((one) => !one.ok);
      const kept = results.filter((one) => one.ok && one.branchKept);
      if (failed.length || kept.length) {
        const detail = [
          ...failed.map((one) => `• ${path.basename(one.path)}: ${one.error}`),
          ...kept.map((one) => `• ${path.basename(one.path)}: the folder is gone; its branch was kept because it has commits that are not merged.`),
        ].join('\n');
        await tell({ type: 'warning', message: failed.length ? `${failed.length} could not be cleaned up.` : 'Cleaned up, with a note.', detail });
      }
      return { shown: true, cleaned: results.filter((one) => one.ok).length, failed: failed.length };
    } finally {
      busy = false;
    }
  }

  return { offer, declined };
}

module.exports = { createOffer };
