'use strict';

const rules = require('./review-rules');

/**
 * Code Reviewer: the sweep that keeps up without anybody pressing anything.
 *
 * Every few minutes, for the repositories that asked for it: list the PRs,
 * verify the ones where something happened, review the ones nobody has reviewed
 * at this commit, and draft answers to replies. **It never publishes a finding.**
 * The only thing it can publish is an answer to a reply, and only for a
 * repository whose reply mode is AUTO — chosen on purpose, with a warning.
 *
 * Its spend is capped per cycle (`auto.max.per.cycle`, reviews and verifications
 * together), and a PR is reviewed at most once per commit whatever became of the
 * attempt: retrying a failed one is a person's decision, not a loop's.
 *
 * Two departures from the original, both deliberate:
 * - Replies are processed even when no repository reviews automatically. The
 *   original returned early and so never drafted a reply for a repository whose
 *   reply mode was on but whose automatic review was off.
 * - The thread of every open PR with published comments is read each cycle, so
 *   a reply is noticed without the PR being opened first.
 */

const START_DELAY = 15 * 1000;

/**
 * How often each repository is looked at.
 *
 * Two minutes: fast enough that a new pull request is noticed while somebody is
 * still looking at the screen, slow enough that nobody is asking anything flat
 * out. Fourteen repositories at two minutes is four hundred and twenty requests
 * an hour of Bitbucket's thousand, and most of those come back `304 Not
 * Modified` because the list is asked for with the tag it was last given.
 *
 * Still one repository per tick rather than all of them at once. The tick is
 * this divided by however many there are, so the setting keeps meaning what it
 * says while the asking stays spread out instead of arriving in a burst every
 * two minutes. Nothing about the cost changes; it is only kinder to the other
 * end, and to the ten minutes of review work sharing the same process.
 */
const WATCH_SECONDS = 120;

class AutoReviewer {
  constructor({ store, engine, fixer, remind = null, notify = () => {}, emit = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.store = store;
    this.engine = engine;
    this.fixer = fixer;
    /*
     * The reminder sweep, run on the same clock and behind its own switch.
     *
     * Deliberately not behind `enabled()`: "review new commits on their own" and
     * "chase a comment nobody answered" are two different promises, and somebody
     * who wants the second does not have to want the first. Without this, the
     * rules set to send on their own sat there and sent nothing, which is a
     * promise made on screen and not kept.
     */
    this.remind = remind;
    this.notify = notify;
    this.emit = emit;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    /** The light watch, on its own clock: which repository is next, and its timer. */
    this.watchTimer = null;
    this.watchAt = 0;
    this.stopped = false;
    this.busy = false;
    this.status = { running: false, lastRunAt: null, lastMessage: null, reviewedTotal: 0, nextRunAt: null };
  }

  enabled() {
    return this.store.pref('auto.enabled', 'true') !== 'false';
  }

  intervalMinutes() {
    return Math.max(1, Number.parseInt(this.store.pref('auto.interval.minutes', '10'), 10) || 10);
  }

  maxPerCycle() {
    return Math.max(1, Number.parseInt(this.store.pref('auto.max.per.cycle', '3'), 10) || 3);
  }

  /** How often each repository is looked at, whatever the fleet size. */
  watchSeconds() {
    const stored = Number.parseInt(this.store.pref('auto.watch.seconds', String(WATCH_SECONDS)), 10);
    // Below ten seconds is asking flat out; above an hour it is not watching.
    return Math.min(3600, Math.max(10, stored || WATCH_SECONDS));
  }

  /**
   * How long to wait before the next single repository.
   *
   * The round divided by the number of repositories, so each one comes up once
   * per round and the asking is spread through it. Floored at a second so a
   * fleet large enough to divide the round into nothing cannot turn into a busy
   * loop — past that point the round simply takes longer than it says, which is
   * the right way to run out of room.
   */
  watchTickMs() {
    return Math.max(1000, Math.round((this.watchSeconds() * 1000) / Math.max(1, this.watchedRepos().length)));
  }

  /**
   * Which repositories are looked at: all of them that are not hidden.
   *
   * Deliberately *not* only the ones that review by themselves. Looking and
   * reviewing are different jobs — one costs a request, the other costs money —
   * and somebody who reviews by hand has more use for knowing a pull request
   * arrived, not less, because they are the one who has to go and press it.
   * Tied to `autoReview` this watched nothing at all on a fleet where every
   * repository is reviewed by hand, which is the ordinary case.
   */
  watchedRepos() {
    return this.store.repos({ withHidden: false });
  }

  watching() {
    return this.store.pref('auto.watch', 'true') !== 'false';
  }

  /**
   * What the watch costs, so the screen can say it rather than imply it.
   *
   * One request per tick, whatever the number of repositories — the tick is what
   * is spent, not the fleet.
   */
  watchBudget() {
    const repos = this.watchedRepos().length;
    const every = this.watchSeconds();
    return {
      repos,
      /** How often each repository comes round, which is what the setting says. */
      everySeconds: every,
      eachSeenSeconds: every,
      /** And the gap between two single requests, which is what it costs. */
      tickMs: this.watchTickMs(),
      requestsPerHour: Math.round((repos * 3600) / every),
    };
  }

  setStatus(fields) {
    Object.assign(this.status, fields);
    this.emit({ type: 'auto', status: { ...this.status } });
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    // The light watch starts with everything else and runs on its own clock, so
    // a long review cycle never delays noticing that something moved.
    this.armWatch();
    this.schedule(START_DELAY, async () => {
      try {
        const resumed = await this.resumePending();
        if (resumed > 0) this.notify(`Resumed ${resumed} review(s)`, 'They were left half done when Smart Terminal closed.');
      } catch {
        /* resuming is a courtesy */
      }
      await this.tick();
    });
  }

  /*
   * The review clock only. `schedule` calls this between every cycle, so
   * anything taken down here is taken down six times an hour — which is how the
   * watch would have been killed on every tick and re-armed by luck.
   */
  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Both clocks, for good: the app closing, or the reviewer being switched off. */
  stopAll() {
    this.stopped = true;
    this.stop();
    if (this.watchTimer) this.clearTimer(this.watchTimer);
    this.watchTimer = null;
  }

  /**
   * One repository, looked at now: has anything moved?
   *
   * Deliberately nothing else. It lists, and if the list came back changed it
   * says so — the reviewing itself stays on its own clock and its own budget,
   * because a review costs money and noticing does not.
   */
  async watchOnce() {
    if (!this.watching() || this.busy) return null;
    const repos = this.watchedRepos();
    if (!repos.length) return null;

    const repo = repos[this.watchAt % repos.length];
    this.watchAt = (this.watchAt + 1) % repos.length;
    try {
      const listed = await this.engine.refreshPrs(repo.id, { notifyNew: true });
      if (listed?.fresh?.length) {
        this.setStatus({ lastMessage: `${repo.name}: ${listed.fresh.length} new pull request(s)` });
        this.emit({ type: 'watch', repoId: repo.id, fresh: listed.fresh.length });
      }
      return listed;
    } catch {
      // A repository that cannot be listed this second is listed next time
      // round. Saying so every five seconds would be its own kind of noise.
      return null;
    }
  }

  /**
   * Arm the watch, or leave it alone if it is switched off.
   *
   * Called when the ticker starts and again when the setting changes, so
   * turning it on takes effect now rather than at the end of a review cycle.
   * Switched off it arms nothing at all — a timer that wakes only to find it
   * has nothing to do is still a timer.
   */
  armWatch() {
    if (this.stopped || !this.watching() || this.watchTimer) return;
    this.watchTimer = this.setTimer(() => {
      this.watchTimer = null;
      void this.watchOnce().finally(() => this.armWatch());
    }, this.watchTickMs());
    this.watchTimer?.unref?.();
  }

  schedule(ms, fn) {
    this.stop();
    this.setStatus({ nextRunAt: new Date(Date.now() + ms).toISOString() });
    this.timer = this.setTimer(() => {
      this.timer = null;
      void fn();
    }, ms);
  }

  async tick() {
    if (this.enabled()) {
      try {
        await this.runOnce();
      } catch (error) {
        this.setStatus({ lastMessage: `error: ${String(error?.message ?? error).slice(0, 120)}` });
      }
    }
    // Its own promise, kept whether or not reviews run by themselves, and never
    // able to stop the next tick being scheduled.
    if (this.remind) {
      try {
        await this.remind();
      } catch (error) {
        this.setStatus({ lastMessage: `reminders: ${String(error?.message ?? error).slice(0, 120)}` });
      }
    }
    this.schedule(this.intervalMinutes() * 60 * 1000, () => this.tick());
  }

  /** Reviews that were running when the app closed, run again unless their commit was reviewed since. */
  async resumePending() {
    let done = 0;
    for (const job of this.store.pendingJobs().slice(0, this.maxPerCycle())) {
      const repo = this.store.repo(job.repo_id);
      if (!repo || job.attempts >= 3) {
        this.store.dropPendingJob(job.id);
        continue;
      }
      this.store.bumpPendingJob(job.id);
      try {
        await this.engine.refreshPrs(repo.id, { force: true });
      } catch {
        continue;
      }
      const pr = this.store.pr(repo.id, Number(job.pr_id));
      if (!pr || pr.state !== 'OPEN' || this.store.doneForHead(repo.id, pr.id, pr.headSha)) {
        this.store.dropPendingJob(job.id);
        continue;
      }
      this.setStatus({ lastMessage: `resuming ${repo.name} #${pr.id}` });
      await this.engine.review(repo.id, pr.id, { depth: job.depth || null, kind: job.kind || null, model: job.model || '', auto: Boolean(job.auto) });
      this.store.dropPendingJob(job.id);
      done++;
    }
    return done;
  }

  async processReplies(repo, budget) {
    if (repo.replyMode === 'OFF' || budget <= 0) return 0;
    const pending = this.store.pendingReplies().filter((reply) => reply.repoId === repo.id && reply.status === 'PENDING' && !(reply.body ?? '').trim());
    let done = 0;
    for (const draft of pending.slice(0, budget)) {
      const pr = this.store.pr(repo.id, draft.prId);
      if (!pr || pr.state !== 'OPEN') continue;
      try {
        const drafted = await this.engine.draftReply(draft.id);
        done++;
        if (repo.replyMode === 'AUTO') {
          try {
            await this.engine.publishReply(draft.id, drafted.body);
            this.notify(`Reply published · ${repo.name} #${draft.prId}`, `Answered ${draft.theirAuthor} automatically.`);
          } catch (error) {
            this.notify(`Could not publish the reply · ${repo.name} #${draft.prId}`, String(error?.message ?? error).slice(0, 120));
          }
        } else {
          this.notify(`Reply ready to check · ${repo.name} #${draft.prId}`, `${draft.theirAuthor} replied; an answer is drafted and waiting for you.`);
        }
      } catch {
        /* the failure is on the draft */
      }
    }
    return done;
  }

  /** Read the thread of open PRs we have published on, so replies are seen without opening each PR. */
  async syncThreads(repo) {
    const facts = this.store.boardFacts(repo.id);
    for (const pr of this.store.prs(repo.id, { states: ['OPEN'] })) {
      const fact = facts.get(`${repo.id}#${pr.id}`);
      if (!fact || fact.publishedLive === 0) continue;
      try {
        await this.engine.syncComments(repo, pr.id);
      } catch {
        /* next cycle */
      }
    }
  }

  async verifyUpdated(repo, budget) {
    let used = 0;
    const notes = [];
    for (const pr of this.store.prs(repo.id, { states: ['OPEN'] })) {
      if (used >= budget) break;
      const review = this.store.latestDone(repo.id, pr.id);
      if (!review) continue;
      const findings = this.store.findingsForReview(review.id);
      const published = new Set(findings.map((finding) => finding.publishedId).filter(Boolean));
      const answered = this.store.comments(repo.id, pr.id).filter((comment) => !comment.ours && comment.parentId && published.has(comment.parentId));
      const repliesPending = answered.filter((comment) => !review.resolutionAt || String(comment.createdOn) > String(review.resolutionAt)).length;
      const need = rules.verificationNeed({ pr, review, findings, repliesPending });
      if (!need.needed) continue;
      used++;
      try {
        const result = await this.engine.verify(repo.id, pr.id);
        const after = this.store.findingsForReview(review.id).filter((finding) => finding.publishedId && !finding.dismissedAt);
        const all = after.length > 0 && after.every((finding) => rules.resolutionClosed(finding.resolution));
        const open = after.filter((finding) => finding.resolution && !rules.resolutionClosed(finding.resolution)).length;
        notes.push(`${repo.name} #${pr.id}: verified`);
        this.notify(
          all ? `All fixed · ${repo.name} #${pr.id}` : `Verified · ${repo.name} #${pr.id}`,
          all ? 'The comments were addressed; it can be merged.' : open > 0 ? `${open} comment(s) are still unresolved.` : String(result.summary).slice(0, 140),
        );
      } catch (error) {
        notes.push(`${repo.name} #${pr.id}: could not verify (${String(error?.message ?? error).slice(0, 60)})`);
      }
    }
    return { used, notes };
  }

  /** One cycle. Returns how many runs it spent. A second call while one is running does nothing. */
  async runOnce() {
    if (this.busy) return 0;
    this.busy = true;
    this.setStatus({ running: true });
    let done = 0;
    const notes = [];
    const skipped = [];
    let crashed = null;
    try {
      // Anything a previous process left queued, a few at a time. `start()` took
      // one cycle's worth once and never looked again, so with more orphans than
      // the cap the rest sat in the table until the next launch — and a PR the
      // ordinary sweep skips sat there for ever.
      await this.resumePending();
      const repos = this.store.repos({ withHidden: false });
      /*
       * One budget for the cycle, not one for each repository.
       *
       * Each draft is a paid run, and this budget sat inside the loop — so
       * fourteen repositories with a cap of three spent forty-two runs a sweep,
       * every ten minutes, while the screen said "the spending cap of each
       * sweep".
       */
      let budget = this.maxPerCycle();
      for (const repo of repos) {
        /*
         * Reading the threads is not drafting.
         *
         * "Only detect — the reply shows up; nothing is drafted" used to skip
         * the reading as well, so a repository set that way never learned an
         * answer had arrived at all: no flag on the board, no verification
         * triggered, and nothing until somebody opened the pull request by
         * hand. `processReplies` already declines to draft for OFF on its own.
         */
        await this.syncThreads(repo);
        if (repo.replyMode === 'OFF' || budget <= 0) continue;
        const replied = await this.processReplies(repo, budget);
        budget -= replied;
        if (replied > 0) notes.push(`${repo.name}: ${replied} reply(ies) drafted`);
      }
      const targets = repos.filter((repo) => repo.autoReview);
      if (!targets.length) notes.push('no repository reviews automatically');
      for (const repo of targets) {
        if (done >= this.maxPerCycle()) break;
        let listed;
        try {
          listed = await this.engine.refreshPrs(repo.id, { force: true, notifyNew: true });
        } catch (error) {
          notes.push(`${repo.name}: could not list PRs (${String(error?.message ?? error).slice(0, 60)})`);
          continue;
        }
        if (listed.fresh?.length) notes.push(`${repo.name}: ${listed.fresh.length} new PR(s)`);
        const verified = await this.verifyUpdated(repo, this.maxPerCycle() - done);
        done += verified.used;
        notes.push(...verified.notes);
        const stances = new Map();
        for (const pr of listed.prs) {
          const stated = this.store.approvals(repo.id, pr.id).find((entry) => entry.state === 'APPROVED' || entry.state === 'CHANGES_REQUESTED');
          if (stated) stances.set(pr.id, stated);
        }
        for (const pr of listed.prs) {
          if (done >= this.maxPerCycle()) {
            notes.push(`stopped at the limit of ${done} per cycle`);
            break;
          }
          if (!pr.headSha) continue;
          const why = rules.skipReason(repo, pr);
          if (why) {
            skipped.push(`${repo.name} #${pr.id}: ${why}`);
            continue;
          }
          const stance = stances.get(pr.id);
          if (stance) {
            skipped.push(`${repo.name} #${pr.id}: ${stance.state === 'APPROVED' ? 'approved' : 'changes requested'} by ${stance.who}`);
            continue;
          }
          if (this.store.existsForHead(repo.id, pr.id, pr.headSha)) continue;
          if (this.engine.isReviewing(repo.id, pr.id)) continue;
          done++;
          const outcome = await this.engine.review(repo.id, pr.id, { auto: true });
          if (outcome.ok) {
            notes.push(`${repo.name} #${pr.id}: ready to publish`);
            this.notify(`Review ready · ${repo.name} #${pr.id}`, pr.title);
          } else {
            notes.push(`${repo.name} #${pr.id}: ${String(outcome.error).slice(0, 60)}`);
          }
        }
      }
    } catch (error) {
      crashed = String(error?.message ?? error);
      throw error;
    } finally {
      this.busy = false;
      const summary = crashed
        ? `error: ${crashed}`
        : [...notes.slice(0, 3), ...(skipped.length ? [`${skipped.length} skipped (${skipped[0]})`] : [])].join(' · ') || 'no new PRs';
      this.setStatus({ running: false, lastRunAt: new Date().toISOString(), lastMessage: summary, reviewedTotal: this.status.reviewedTotal + done });
    }
    return done;
  }
}

module.exports = { AutoReviewer, START_DELAY };
