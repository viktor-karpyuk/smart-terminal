'use strict';

/**
 * Removals as jobs: queued, run one item at a time, stoppable, and resumable
 * after the app was closed.
 *
 * Removing two hundred gigabytes of worktrees is minutes, not a click. A job
 * owns that: it is written to the database before it starts, every item it
 * finishes is written as it finishes, and the window is told each step. Pause
 * stops it after the item in hand; cancel ends it and keeps what was done;
 * resume carries on from the first item not yet done. A job that was running
 * when the app quit is found at the next start marked interrupted, with its
 * place kept, and offered to resume — nothing is restarted on its own.
 *
 * Each item goes through `housekeeping.act(kind, [id])`, so a job has exactly
 * the checks a button has: a worktree a session has since walked into is
 * refused by the same code, one item at a time.
 */

const STATES = ['queued', 'running', 'paused', 'interrupted', 'done', 'cancelled', 'failed'];
const KINDS = new Set(['free', 'remove-worktrees', 'forget-transcripts', 'delete-sessions', 'discard-workshops', 'repair-worktrees']);

class JobRunner {
  /**
   * @param {object} deps
   * @param {object} deps.store         HousekeepingStore with the job table
   * @param {object} deps.housekeeping  the Housekeeping (act, inventory)
   * @param {(name: string, payload: unknown) => void} [deps.emit]
   * @param {() => number} [deps.now]
   */
  constructor({ store, housekeeping, emit = () => {}, now = () => Date.now() }) {
    this.store = store;
    this.housekeeping = housekeeping;
    this.emit = emit;
    this.now = now;
    /** The job running now, if one is: one at a time, since two removals race over the same disk. */
    this.current = null;
    this.stopAsked = null;
    // A previous run that did not get to finish: its jobs keep their place and wait to be asked.
    for (const job of this.store.jobs(['running', 'queued'])) {
      this.store.updateJob(job.id, { status: 'interrupted', updatedAt: this.now() });
    }
  }

  /** Jobs, newest first: the ones in flight, the ones waiting to be resumed, and what finished lately. */
  list(limit = 20) {
    return this.store.jobs(null, limit);
  }

  /**
   * Queue a job and start it unless another is running. `ids` are item ids as
   * the inventory names them; `labels` are what to show for each, kept with
   * the job so a resumed one can still say what it is doing.
   */
  start({ kind, ids, labels = {}, title = null }) {
    if (!KINDS.has(kind)) throw new Error(`Not a job kind: ${kind}`);
    const wanted = [...new Set((ids ?? []).map(String))];
    if (!wanted.length) throw new Error('Nothing to do.');
    const job = this.store.createJob({
      kind,
      title: title ?? `${wanted.length} item${wanted.length === 1 ? '' : 's'}`,
      ids: wanted,
      labels,
      createdAt: this.now(),
    });
    this.#tell(job);
    this.#kick();
    return job;
  }

  /** Stop after the item in hand; the job keeps its place. */
  pause(id) {
    const job = this.store.job(id);
    if (!job) throw new Error('No such job.');
    if (job.status === 'running') {
      this.stopAsked = { id, to: 'paused' };
      return job;
    }
    if (job.status === 'queued') return this.#set(id, { status: 'paused' });
    return job;
  }

  /** End it; what was done stays done. */
  cancel(id) {
    const job = this.store.job(id);
    if (!job) throw new Error('No such job.');
    if (job.status === 'running') {
      this.stopAsked = { id, to: 'cancelled' };
      return job;
    }
    if (['queued', 'paused', 'interrupted'].includes(job.status)) return this.#set(id, { status: 'cancelled', finishedAt: this.now() });
    return job;
  }

  /** Carry on from the first item not yet done. */
  resume(id) {
    const job = this.store.job(id);
    if (!job) throw new Error('No such job.');
    if (!['paused', 'interrupted', 'failed'].includes(job.status)) return job;
    const next = this.#set(id, { status: 'queued' });
    this.#kick();
    return next;
  }

  /** Forget a finished job's record. */
  dismiss(id) {
    const job = this.store.job(id);
    if (job && ['done', 'cancelled', 'failed'].includes(job.status)) this.store.deleteJob(id);
    return true;
  }

  // --- running ----------------------------------------------------------------

  #kick() {
    if (this.current) return;
    const next = this.store.jobs(['queued'], 1)[0];
    if (!next) return;
    this.current = next.id;
    this.#run(next.id).catch(() => {}).finally(() => {
      this.current = null;
      this.#kick();
    });
  }

  async #run(id) {
    let job = this.#set(id, { status: 'running', startedAt: this.store.job(id).startedAt ?? this.now() });
    const done = new Set(Object.keys(job.results));
    for (let index = 0; index < job.ids.length; index++) {
      const itemId = job.ids[index];
      if (done.has(itemId)) continue;
      if (this.stopAsked?.id === id) {
        const to = this.stopAsked.to;
        this.stopAsked = null;
        this.#set(id, { status: to, finishedAt: to === 'cancelled' ? this.now() : null });
        return;
      }
      this.#set(id, { current: itemId, index });
      let result;
      try {
        const out = await this.housekeeping.act(job.kind, [itemId]);
        const one = (out.results ?? [])[0] ?? (out.deleted ? { ok: out.deleted.length > 0, bytes: out.bytes ?? 0 } : { ok: true, bytes: out.bytes ?? out.freed ?? 0 });
        result = { ok: Boolean(one.ok), bytes: one.ok ? Number(one.bytes ?? 0) : 0, error: one.error ?? one.note ?? null, at: this.now() };
      } catch (error) {
        result = { ok: false, bytes: 0, error: String(error?.message ?? error), at: this.now() };
      }
      job = this.store.job(id);
      const results = { ...job.results, [itemId]: result };
      this.#set(id, { results, freed: job.freed + result.bytes, failed: job.failed + (result.ok ? 0 : 1) });
    }
    this.#set(id, { status: 'done', current: null, finishedAt: this.now() });
  }

  #set(id, patch) {
    const job = this.store.updateJob(id, { ...patch, updatedAt: this.now() });
    this.#tell(job);
    return job;
  }

  #tell(job) {
    this.emit('job', job);
  }
}

module.exports = { JobRunner, STATES, KINDS };
