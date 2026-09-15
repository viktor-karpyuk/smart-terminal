'use strict';

const rules = require('./review-rules');
const prompts = require('./review-prompts');

/**
 * Code Reviewer: the reviewer itself — loading PRs, running reviews, publishing.
 *
 * Everything outside is handed in (store, forge, git, claude runner, a notifier
 * and an event sink), which is what lets the tests drive a whole review with a
 * fake CLI and a fake forge.
 *
 * The invariants it keeps, from the app it clones:
 *
 * - **Nothing is published on its own.** A review is a draft until a person
 *   publishes it. The one exception here is reply mode AUTO, which is opt-in per
 *   repository and warned about where it is chosen.
 * - **A review is read-only.** `dontAsk` with a whitelist of reading tools and
 *   read-only git; Edit, Write, WebFetch and WebSearch denied.
 * - **A review that used no tool did not read the diff.** The model sometimes
 *   answers "I cannot access the diff" without having tried, with no permission
 *   denial to show for it. That run is failed, not finished — otherwise an
 *   apology is saved as a publishable review.
 */

const PR_TTL = 60 * 1000;
const REPLY_SLOTS = 3;

/** Work in progress, by key, told to every panel as it changes. */
class Activity {
  constructor(emit) {
    this.emit = emit;
    this.runs = new Map();
  }

  start(key, info) {
    const run = { key, lines: [], startedAt: Date.now(), ...info };
    this.runs.set(key, run);
    this.emit({ type: 'activity', run: this.view(run) });
    return run;
  }

  line(key, text) {
    const run = this.runs.get(key);
    if (!run || !text) return;
    run.lines.push(String(text));
    if (run.lines.length > 200) run.lines.splice(0, run.lines.length - 200);
    this.emit({ type: 'activity', run: this.view(run) });
  }

  patch(key, fields) {
    const run = this.runs.get(key);
    if (!run) return;
    Object.assign(run, fields);
    // Cancelled before its process existed: the process is stopped the moment it does.
    if (fields.handle && run.cancelled) fields.handle.cancel();
    this.emit({ type: 'activity', run: this.view(run) });
  }

  /**
   * Stop a run, whatever it is doing. A process that exists is killed; a run
   * still fetching, planning or waiting for the workshop is marked, and its
   * process is killed as it starts (and a fix still queued does not start).
   * False when nothing by that key is running, so a stale Cancel is not
   * remembered and turned on the next run of the same PR.
   */
  cancel(key) {
    const run = this.runs.get(key);
    if (!run) return false;
    run.cancelled = true;
    run.lines.push('Cancelling…');
    run.handle?.cancel();
    this.emit({ type: 'activity', run: this.view(run) });
    return true;
  }

  cancelled(key) {
    return Boolean(this.runs.get(key)?.cancelled);
  }

  end(key) {
    const run = this.runs.get(key);
    if (!run) return;
    this.runs.delete(key);
    this.emit({ type: 'activity', run: { ...this.view(run), done: true } });
  }

  has(key) {
    return this.runs.has(key);
  }

  view(run) {
    const { handle, ...rest } = run;
    return { ...rest, lines: run.lines.slice(-60) };
  }

  list() {
    return [...this.runs.values()].map((run) => this.view(run));
  }
}

function describeEvent(event) {
  switch (event.kind) {
    case 'started':
      return `Session ${String(event.sessionId ?? '').slice(0, 8)} · model ${event.model}`;
    case 'thinking':
      return event.text;
    case 'tool':
      return event.detail ? `· ${event.tool}: ${event.detail}` : `· ${event.tool}`;
    case 'account':
      return `Account out of room (${event.from}) · continuing on ${event.to}`;
    case 'limit':
      return event.status === 'allowed' ? null : `Limit ${event.type ?? ''}: ${event.status} (${Math.round(event.utilization * 100)}%)`;
    default:
      return null;
  }
}

class Semaphore {
  constructor(size) {
    this.size = size;
    this.active = 0;
    this.queue = [];
  }

  async use(fn) {
    if (this.active >= this.size) await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

class ReviewEngine {
  constructor({ store, forge, git, claude, notify = () => {}, emit = () => {} }) {
    this.store = store;
    this.forge = forge;
    this.git = git;
    this.claude = claude;
    this.notify = notify;
    this.emit = emit;
    this.activity = new Activity(emit);
    this.replySlots = new Semaphore(REPLY_SLOTS);
    /** Reviews claimed from the moment `review()` starts, not from when the CLI exists: fetch and planning take a minute under rate limiting. */
    this.inFlight = new Set();
    /** A cancel pressed before the process existed, applied when it does. */
    /** Hooked by the fix engine: what follows a finished review, from wherever the review was started. */
    this.onFinished = null;
  }

  language() {
    return this.store.pref('review.language', 'español') || 'español';
  }

  changed(repoId, prId) {
    this.emit({ type: 'changed', repoId, prId: prId ?? null });
  }

  key(kind, repoId, prId) {
    return `${kind}:${repoId}:${prId}`;
  }

  requireRepo(repoId) {
    const repo = this.store.repo(repoId);
    if (!repo) throw new Error('That repository is not configured any more.');
    return repo;
  }

  requireClone(repo) {
    if (!this.git.isRepo(repo.localPath)) {
      throw new Error(`[${repo.name} · ${repo.owner}/${repo.slug}] "${repo.localPath}" is not a git working copy.`);
    }
  }

  // --- pull requests -----------------------------------------------------------

  /**
   * The open PRs, from the forge unless they were read in the last minute. A
   * PR seen for the first time is news — except on a repository's first sweep,
   * when every PR is "new" and a notification per PR would be noise.
   */
  async refreshPrs(repoId, { force = false, notifyNew = false } = {}) {
    const repo = this.requireRepo(repoId);
    const meta = this.store.prMeta(repoId);
    const fresh = meta?.fetched_at && Date.now() - Date.parse(meta.fetched_at) < PR_TTL;
    if (fresh && !force) return { prs: this.store.prs(repoId, { states: ['OPEN'] }), cached: true };
    const firstSweep = !meta?.fetched_at;
    const cachedRows = this.store.prs(repoId, { states: ['OPEN'] });
    const needBody = cachedRows.some((pr) => !pr.createdOn);
    let result;
    try {
      result = await this.forge.of(repo).listOpen({ etag: needBody ? null : meta?.etag });
    } catch (error) {
      this.store.setReadError(repoId, String(error?.message ?? error));
      this.changed(repoId);
      throw error;
    }
    this.store.setReadError(repoId, null);
    const stamp = new Date().toISOString();
    if (result.notModified) {
      this.store.setPrMeta(repoId, { fetchedAt: stamp });
      return { prs: cachedRows, cached: false, notModified: true };
    }
    const fresh_ = [];
    for (const pr of result.prs) {
      if (this.store.upsertPr(repoId, pr)) fresh_.push(pr);
    }
    this.store.reconcileOpen(repoId, result.prs.map((pr) => pr.id));
    this.store.setPrMeta(repoId, { etag: result.etag ?? null, fetchedAt: stamp });
    if (notifyNew && !firstSweep) {
      for (const pr of fresh_) this.notify(`New PR · ${repo.name} #${pr.id}`, `${pr.title} — ${pr.author}`);
    }
    this.changed(repoId);
    return { prs: this.store.prs(repoId, { states: ['OPEN'] }), cached: false, fresh: fresh_ };
  }

  /** Merged and declined PRs are history: fetched only when asked for, three pages. */
  async searchHistory(repoId, { pages = 3 } = {}) {
    const repo = this.requireRepo(repoId);
    const found = await this.forge.of(repo).search(['MERGED', 'DECLINED'], pages);
    for (const pr of found) this.store.upsertPr(repoId, pr);
    this.changed(repoId);
    return found.length;
  }

  /** One PR, fresh from the forge: its state, its stances, its thread. */
  async loadPr(repoId, prId) {
    const repo = this.requireRepo(repoId);
    const pr = await this.forge.of(repo).get(prId);
    if (!pr) throw new Error(`PR #${prId} was not found.`);
    this.store.upsertPr(repoId, pr);
    if (!pr.stancesUnknown) this.store.syncApprovals(repoId, prId, pr);
    try {
      await this.syncComments(repo, prId);
    } catch (error) {
      this.changed(repoId, prId);
      return { pr: this.store.pr(repoId, prId), commentsError: String(error?.message ?? error) };
    }
    this.changed(repoId, prId);
    return { pr: this.store.pr(repoId, prId) };
  }

  prOrThrow(repoId, prId) {
    const pr = this.store.pr(repoId, prId);
    if (!pr) throw new Error(`PR #${prId} is not loaded yet.`);
    return pr;
  }

  /**
   * The stored copy of the thread, and who in it is us. Every road we publish
   * by is counted — the general comment, inline findings, notes, our replies,
   * and a fix's notice — or our own words come back as someone else's and the
   * app opens a draft to answer itself.
   */
  /**
   * Findings that are already on the PR, found in the stored thread and marked
   * published with the comment they are. Returns the comment ids it took as
   * ours, so replies to them are seen as replies to us.
   */
  reconcilePublished(repo, prId) {
    const thread = this.store.comments(repo.id, prId);
    const taken = new Set(this.store.findingsForPr(repo.id, prId).map((finding) => finding.publishedId).filter(Boolean));
    const adopted = [];
    for (const finding of this.store.findingsForPr(repo.id, prId)) {
      if (finding.publishedId || finding.dismissedAt || finding.askedBy) continue;
      const comment = rules.matchPublished(finding, thread.filter((entry) => !taken.has(entry.commentId)));
      if (!comment) continue;
      const url = repo.provider === 'BITBUCKET' ? `https://bitbucket.org/${repo.owner}/${repo.slug}/pull-requests/${prId}#comment-${comment.commentId}` : null;
      this.store.markFindingPublished(finding.id, comment.commentId, url);
      this.store.markCommentOurs(repo.id, prId, comment.commentId);
      this.store.markPublishedIfComplete(finding.reviewId, url);
      taken.add(comment.commentId);
      adopted.push(comment.commentId);
    }
    if (adopted.length) this.changed(repo.id, prId);
    return adopted;
  }

  async syncComments(repo, prId) {
    const fetched = await this.forge.of(repo).comments(prId);
    const ours = this.store.ourCommentIds(repo.id, prId);
    this.store.syncComments(repo.id, prId, fetched, ours);
    this.store.dismissRepliesTo(repo.id, prId, this.store.fixReplyIds(repo.id, prId));
    const adopted = this.reconcilePublished(repo, prId);
    for (const id of adopted) ours.add(id);
    const thread = this.store.comments(repo.id, prId);
    let registered = 0;
    for (const entry of rules.repliesToUs(thread, ours)) {
      if (this.store.registerReply(repo.id, prId, entry)) registered++;
    }
    if (registered > 0) this.notify(`They replied · ${repo.name} #${prId}`, `${registered} new reply(ies) to our comments.`);
    return { count: fetched.length, registered };
  }

  // --- review ------------------------------------------------------------------------

  isReviewing(repoId, prId) {
    return this.inFlight.has(`${repoId}:${prId}`);
  }

  cancel(repoId, prId, kind = 'review') {
    return this.activity.cancel(this.key(kind, repoId, prId)) ? { ok: true } : { ok: false, error: 'Nothing of that kind is running for this PR.' };
  }

  /**
   * The commit the clone has for the PR's branch after a fetch, in the forge's
   * own spelling (Bitbucket gives twelve characters, GitHub forty) so it compares
   * with the PR row. The row can be older than the fetch — the author pushed
   * after the list was read — and what was read is what gets recorded.
   */
  async fetchedHead(repo, pr) {
    const tip = await this.git.revParse(repo.localPath, `origin/${pr.sourceBranch}`);
    if (!tip) return pr.headSha;
    return pr.headSha ? tip.slice(0, Math.max(pr.headSha.length, 7)) : tip;
  }

  /** A fetch that failed, as an error that says where and why. */
  fetchError(repo, fetched) {
    return new Error(`git fetch failed in ${repo.localPath}: ${fetched.output.slice(0, 400)}${rules.fetchAdvice(fetched.output, repo)}`);
  }

  /**
   * One review. `depth`/`kind` null mean automatic, planned from the diff.
   * Returns `{ok, review}` or `{ok:false, error}`; it never throws for a failure
   * it can describe, and a failure after the review row exists is written on it.
   */
  async review(repoId, prId, { depth, kind, model, auto = false, forceFull = false } = {}) {
    const claim = `${repoId}:${prId}`;
    if (this.inFlight.has(claim)) return { ok: false, error: `A review of PR #${prId} is already running.` };
    this.inFlight.add(claim);
    const key = this.key('review', repoId, prId);
    let reviewId = null;
    try {
      const repo = this.requireRepo(repoId);
      this.requireClone(repo);
      const pr = this.prOrThrow(repoId, prId);
      depth = depth === undefined ? repo.defaultDepth : depth || null;
      kind = kind === undefined ? repo.projectKind : kind || null;
      model = model === undefined ? repo.defaultModel : model || '';
      this.activity.start(key, { kind: 'review', repoId, prId, repoName: repo.name, title: pr.title, auto });
      this.activity.line(key, 'Updating the local clone…');

      const fetched = await this.git.fetch(repo.localPath, pr.targetBranch, pr.sourceBranch);
      if (!fetched.ok) {
        const message = `[${repo.name} · ${repo.owner}/${repo.slug}] git fetch failed in ${repo.localPath}\n\n${fetched.output.slice(0, 600)}${rules.fetchAdvice(fetched.output, repo)}`;
        reviewId = this.store.startReview({ repoId, prId, prTitle: pr.title, headSha: pr.headSha, depth: depth ?? 'INTERMEDIATE', kind: kind ?? 'GENERIC', model: '', auto, prAuthor: pr.author });
        this.store.failReview(reviewId, message);
        return { ok: false, error: message };
      }
      if (this.activity.cancelled(key)) return { ok: false, error: 'Cancelled.' };
      const headSha = await this.fetchedHead(repo, pr);

      const decision = await rules.decideScope({
        previous: this.store.latestDone(repoId, prId),
        headSha,
        forceFull,
        isAncestor: (a, b) => this.git.isAncestor(repo.localPath, a, b),
      });
      const incremental = decision.scope === 'INCREMENTAL' ? decision : null;
      const range = `origin/${pr.targetBranch}...origin/${pr.sourceBranch}`;
      const planRange = incremental ? `${incremental.sinceSha}..origin/${pr.sourceBranch}` : range;
      const profile = rules.plan(await this.git.numstat(repo.localPath, planRange), depth, kind);
      const resolvedModel = model || rules.DEPTHS[profile.depth].model;
      this.activity.patch(key, { depth: profile.depth, model: resolvedModel });
      this.activity.line(key, `${profile.reason} · model ${resolvedModel}`);

      const previous = incremental ? this.store.findingsForReview(incremental.previousReviewId).filter(rules.openForCarry) : [];
      if (incremental) {
        this.activity.line(key, `Only what is new since ${incremental.sinceSha.slice(0, 7)}${previous.length ? `, carrying ${previous.length} open finding(s).` : '.'}`);
      }

      reviewId = this.store.startReview({
        repoId,
        prId,
        prTitle: pr.title,
        headSha,
        depth: profile.depth,
        kind: profile.kind,
        model: resolvedModel,
        auto,
        previousReviewId: incremental?.previousReviewId,
        sinceSha: incremental?.sinceSha,
        prAuthor: pr.author,
        planReason: profile.reason,
      });
      this.changed(repoId, prId);

      this.activity.line(key, 'Reading the PR thread…');
      try {
        await this.syncComments(repo, prId);
      } catch (error) {
        this.activity.line(key, `Could not read the thread (${String(error?.message ?? error).slice(0, 80)}); continuing without it.`);
      }
      const existing = this.store.comments(repoId, prId).filter((comment) => !comment.deleted);
      if (existing.length) this.activity.line(key, `${existing.length} earlier comment(s): they will not be repeated.`);

      const language = this.language();
      const guidelines = this.store.guidelinesForReview(repoId);
      const prompt = incremental
        ? prompts.incrementalPrompt({ pr, language, depth: profile.depth, kind: profile.kind, sinceSha: incremental.sinceSha, carried: previous, existing, guidelines })
        : prompts.reviewPrompt({ pr, language, depth: profile.depth, kind: profile.kind, existing, guidelines });

      const result = await this.claude.run({
        kind: 'review',
        cwd: repo.localPath,
        prompt,
        model: resolvedModel,
        allowedTools: rules.DEPTHS[profile.depth].tools,
        disallowedTools: rules.REVIEW_DENIED,
        schema: incremental ? prompts.INCREMENTAL_SCHEMA : prompts.SCHEMA,
        register: (handle) => this.activity.patch(key, { handle }),
        onEvent: (event) => this.activity.line(key, describeEvent(event)),
      });

      if (!result.ok) {
        const cancelled = result.cancelled;
        const message = cancelled ? 'Review cancelled.' : (result.stderr || 'Claude Code finished without returning a review.').slice(0, 1500);
        this.store.failReview(reviewId, message, cancelled ? 'CANCELLED' : 'FAILED');
        return { ok: false, error: message, cancelled };
      }
      // No tool at all: it did not open the diff, so what it said is not about this PR.
      if (result.toolUses === 0) {
        const message =
          'The model answered without opening the diff or reading a single file, so the review does not describe this PR. ' +
          'Retry, and if it happens again raise the depth: the higher levels use a more capable model.\n\nIt returned:\n' +
          String(result.text).slice(0, 500);
        this.store.failReview(reviewId, message);
        return { ok: false, error: message };
      }
      const denials = [...new Set(result.denials)];
      if (denials.length) this.activity.line(key, `WARNING: ${denials.length} tool(s) were denied: ${denials.join(', ')}`);

      const payload = result.structured ?? result.text;
      const parsed = rules.parseFindings(payload);
      // Carrying happens *after* the new findings are saved: saving deletes by review id first.
      this.store.replaceFindings(reviewId, repoId, prId, parsed.findings);
      let carry = null;
      if (incremental) {
        carry = { stillOpen: 0, fixed: 0, obsolete: 0 };
        const ids = new Set(previous.map((finding) => finding.id));
        for (const step of rules.carryPlan(previous, rules.parseCarried(payload, ids))) {
          if (step.verdict === 'STILL_OPEN') {
            this.store.carryForward(step.finding.id, reviewId, step.line);
            carry.stillOpen++;
          } else if (step.verdict === 'FIXED') {
            this.store.setResolution(step.finding.id, 'RESOLVED', step.evidence);
            carry.fixed++;
          } else {
            this.store.setResolution(step.finding.id, 'RESOLVED', step.evidence);
            this.store.closeFinding(step.finding.id, true);
            carry.obsolete++;
          }
        }
        this.activity.line(key, `Earlier findings: ${carry.stillOpen} still open, ${carry.fixed} fixed, ${carry.obsolete} no longer apply.`);
      }

      const spanish = rules.isSpanish(language);
      let body = rules.renderMarkdown(parsed.summary, parsed.findings, language);
      if (carry) {
        // An incremental review that says "found 2" while carrying 5 open undersells what is left.
        body += spanish ? `\n\n_Revisé sólo los commits nuevos desde \`${incremental.sinceSha.slice(0, 7)}\`.` : `\n\n_Reviewed only the new commits since \`${incremental.sinceSha.slice(0, 7)}\`.`;
        if (carry.stillOpen) body += spanish ? ` Quedan ${carry.stillOpen} observación(es) anterior(es) sin resolver.` : ` ${carry.stillOpen} earlier remark(s) are still open.`;
        if (carry.fixed) body += spanish ? ` ${carry.fixed} de la review anterior quedaron corregidas.` : ` ${carry.fixed} from the previous review were fixed.`;
        if (carry.obsolete) body += spanish ? ` ${carry.obsolete} dejaron de aplicar.` : ` ${carry.obsolete} no longer apply.`;
        body += '_';
      }
      if (denials.length) {
        body += spanish
          ? `\n\n> ⚠️ Esta review corrió con ${denials.length} herramienta(s) denegada(s) (${denials.join(', ')}), así que puede estar incompleta.`
          : `\n\n> ⚠️ This review ran with ${denials.length} tool(s) denied (${denials.join(', ')}), so it may be incomplete.`;
      }
      this.store.finishReview(reviewId, {
        body,
        sessionId: result.sessionId,
        costUsd: result.costUsd,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        cacheRead: result.cacheRead,
        cacheWrite: result.cacheWrite,
        deniedTools: denials.join('; ').slice(0, 1000),
        accountName: result.accountName,
      });
      const saved = this.store.review(reviewId);
      // Nothing that follows can turn a good review into an error: it is already saved.
      try {
        this.onFinished?.(repo, pr, saved);
      } catch {
        /* the review stands */
      }
      return { ok: true, review: saved };
    } catch (error) {
      const message = String(error?.message ?? error);
      if (reviewId) {
        try {
          this.store.failReview(reviewId, message);
        } catch {
          /* nothing more to do */
        }
      }
      return { ok: false, error: message };
    } finally {
      this.inFlight.delete(claim);
      this.activity.end(key);
      this.changed(repoId, prId);
    }
  }

  // --- verification and final pass ------------------------------------------------

  /**
   * Whether what we pointed out was fixed. Only what still waits for a verdict
   * is judged: a finding already closed — fixed by the app, dismissed, verified
   * before — would be asked about against a remote that does not have the fix
   * yet, and "unresolved" would overwrite a verdict that stood.
   */
  async verify(repoId, prId) {
    const repo = this.requireRepo(repoId);
    this.requireClone(repo);
    const pr = this.prOrThrow(repoId, prId);
    const review = this.store.latestDone(repoId, prId);
    if (!review) throw new Error('There is no finished review to verify.');
    const pending = this.store.findingsForReview(review.id).filter(rules.needsVerdict);
    if (!pending.length) throw new Error('Nothing left to verify: the published comments already have a verdict or are closed.');
    const key = this.key('verify', repoId, prId);
    if (this.activity.has(key)) throw new Error('A verification of this PR is already running.');
    this.activity.start(key, { kind: 'verify', repoId, prId, repoName: repo.name, title: pr.title });
    try {
      const fetched = await this.git.fetch(repo.localPath, pr.targetBranch, pr.sourceBranch);
      // A verdict on refs that could not be brought up to date would be stamped on commits it never saw.
      if (!fetched.ok) throw this.fetchError(repo, fetched);
      const headSha = await this.fetchedHead(repo, pr);
      const range = review.headSha && review.headSha !== headSha ? `${review.headSha}..origin/${pr.sourceBranch}` : `origin/${pr.targetBranch}...origin/${pr.sourceBranch}`;
      const { items, thread } = prompts.resolutionItems(pending, this.store.comments(repoId, prId));
      const result = await this.claude.run({
        kind: 'verify',
        cwd: repo.localPath,
        prompt: prompts.resolutionPrompt({ language: this.language(), prTitle: pr.title, range, items, thread }),
        model: repo.defaultModel || rules.DEPTHS.INTERMEDIATE.model,
        allowedTools: rules.DEPTHS.HEAVY.tools,
        disallowedTools: rules.REVIEW_DENIED,
        schema: prompts.RESOLUTION_SCHEMA,
        register: (handle) => this.activity.patch(key, { handle }),
        onEvent: (event) => this.activity.line(key, describeEvent(event)),
      });
      if (!result.ok) throw new Error(result.stderr || 'Claude Code returned no verdict.');
      // Believing a verdict that never looked at the diff would enable a merge.
      if (result.toolUses === 0) throw new Error('The model did not open the diff, so its verdict does not rest on the code.');
      const parsed = rules.parseResolution(result.structured ?? result.text, new Set(pending.map((finding) => finding.id)));
      for (const item of parsed.items) this.store.setResolution(item.id, item.resolution, item.evidence);
      let text = parsed.summary;
      const missing = pending.length - parsed.items.length;
      if (missing > 0) text += `\n\n⚠️ ${missing} remark(s) were left without a verdict: they stay unverified.`;
      this.store.setResolutionSummary(review.id, text, headSha);
      return { ok: true, summary: text, mergeable: parsed.mergeable };
    } finally {
      this.activity.end(key);
      this.changed(repoId, prId);
    }
  }

  /** The last look before merging: is there anything here that must not go in? */
  async finalPass(repoId, prId) {
    const repo = this.requireRepo(repoId);
    this.requireClone(repo);
    const pr = this.prOrThrow(repoId, prId);
    const review = this.store.latestDone(repoId, prId);
    if (!review) throw new Error('Run a review before the final pass.');
    const key = this.key('final', repoId, prId);
    if (this.activity.has(key)) throw new Error('A final pass of this PR is already running.');
    this.activity.start(key, { kind: 'final', repoId, prId, repoName: repo.name, title: pr.title });
    try {
      const fetched = await this.git.fetch(repo.localPath, pr.targetBranch, pr.sourceBranch);
      if (!fetched.ok) throw this.fetchError(repo, fetched);
      const headSha = await this.fetchedHead(repo, pr);
      const range = `origin/${pr.targetBranch}...origin/${pr.sourceBranch}`;
      const discussedList = this.store
        .findingsForReview(review.id)
        .filter((finding) => finding.publishedId)
        .map((finding) => `- [${finding.filePath}${finding.lineNo ? `:${finding.lineNo}` : ''}] ${finding.title}`)
        .join('\n');
      const discussed = `${discussedList ? `LO QUE YA SE DISCUTIO EN ESTE PR (no lo repitas)\n${discussedList}` : ''}\n\n${prompts.guidelinesSection(this.store.guidelinesForReview(repoId))}`;
      const result = await this.claude.run({
        kind: 'final-pass',
        cwd: repo.localPath,
        prompt: prompts.finalPassPrompt({ language: this.language(), prTitle: pr.title, range, discussed }),
        model: repo.defaultModel || rules.DEPTHS.HEAVY.model,
        allowedTools: rules.DEPTHS.HEAVY.tools,
        disallowedTools: rules.REVIEW_DENIED,
        schema: prompts.FINAL_PASS_SCHEMA,
        register: (handle) => this.activity.patch(key, { handle }),
        onEvent: (event) => this.activity.line(key, describeEvent(event)),
      });
      if (!result.ok) throw new Error(result.stderr || 'Claude Code returned no verdict.');
      if (result.toolUses === 0) throw new Error('The model did not open the diff: a final pass that did not look at the code cannot decide anything.');
      const parsed = rules.parseFinalPass(result.structured ?? result.text);
      const text = rules.finalPassText(parsed);
      this.store.setFinalPass(review.id, headSha, text, parsed.blockers.length);
      return { ok: true, summary: text, blockers: parsed.blockers.length, mergeable: parsed.mergeable };
    } finally {
      this.activity.end(key);
      this.changed(repoId, prId);
    }
  }

  // --- replies -----------------------------------------------------------------------

  /** Drafts the answer to one reply. Publishes nothing. At most three run at once; the rest queue. */
  draftReply(replyId) {
    return this.once(`draft:${replyId}`, () => this.draftReplyNow(replyId));
  }

  async draftReplyNow(replyId) {
    const draft = this.store.reply(replyId);
    if (!draft) throw new Error('That reply is gone.');
    const key = this.key('reply', draft.repoId, `${draft.prId}:${replyId}`);
    return this.replySlots.use(async () => {
      const repo = this.requireRepo(draft.repoId);
      const pr = this.prOrThrow(draft.repoId, draft.prId);
      this.activity.start(key, { kind: 'reply', repoId: repo.id, prId: pr.id, repoName: repo.name, title: `Reply to ${draft.theirAuthor}` });
      try {
        this.requireClone(repo);
        await this.git.fetch(repo.localPath, pr.targetBranch, pr.sourceBranch);
        const result = await this.claude.run({
          kind: 'reply',
          cwd: repo.localPath,
          prompt: prompts.replyPrompt({
            language: this.language(),
            prTitle: pr.title,
            range: `origin/${pr.targetBranch}...origin/${pr.sourceBranch}`,
            ourComment: draft.ourBody,
            theirAuthor: draft.theirAuthor,
            theirBody: draft.theirBody,
            filePath: draft.filePath,
            lineNo: draft.lineNo,
          }),
          // Intermediate: it has to be able to open the file to check what they say.
          model: repo.defaultModel || rules.DEPTHS.INTERMEDIATE.model,
          allowedTools: rules.DEPTHS.INTERMEDIATE.tools,
          disallowedTools: rules.REVIEW_DENIED,
          register: (handle) => this.activity.patch(key, { handle }),
          onEvent: (event) => this.activity.line(key, describeEvent(event)),
        });
        if (!result.ok || !result.text.trim()) throw new Error(result.stderr || 'Claude Code returned no answer.');
        this.store.saveReplyDraft(replyId, result.text.trim(), result.costUsd);
        return { ok: true, body: result.text.trim() };
      } catch (error) {
        this.store.failReply(replyId, String(error?.message ?? error));
        throw error;
      } finally {
        this.activity.end(key);
        this.changed(draft.repoId, draft.prId);
      }
    });
  }

  /** The answer hangs from the comment it answers. */
  publishReply(replyId, body) {
    return this.once(`reply:${replyId}`, () => this.publishReplyNow(replyId, body));
  }

  async publishReplyNow(replyId, body) {
    const draft = this.store.reply(replyId);
    if (!draft) throw new Error('That reply is gone.');
    const text = String(body ?? draft.body ?? '').trim();
    if (!text) throw new Error('The answer is empty.');
    const repo = this.requireRepo(draft.repoId);
    this.store.saveReplyDraft(replyId, text);
    const posted = await this.forge.of(repo).reply(draft.prId, draft.theirCommentId, text);
    this.store.markReplyPublished(replyId, posted.id, posted.url);
    await this.syncQuietly(repo, draft.prId);
    return { ok: true, url: posted.url };
  }

  /** A reminder hung from our own comment. A template the person edits; never sent on its own. */
  async followUp(findingId, body) {
    const finding = this.store.finding(findingId);
    if (!finding?.publishedId) throw new Error('That comment is not published yet, so there is no thread to remind in.');
    const repo = this.requireRepo(finding.repoId);
    const posted = await this.forge.of(repo).reply(finding.prId, finding.publishedId, String(body ?? '').trim() || rules.followUpText(finding, this.language()));
    this.store.markFollowedUp(findingId);
    await this.syncQuietly(repo, finding.prId);
    return { ok: true, url: posted.url };
  }

  async syncQuietly(repo, prId) {
    try {
      await this.syncComments(repo, prId);
    } catch {
      /* what was published stands; the copy of the thread catches up next time */
    }
    this.changed(repo.id, prId);
  }

  // --- publishing ----------------------------------------------------------------------

  /** The general comment. The publication stores the exact text sent, not what the draft says later. */
  async publishReview(reviewId, body) {
    const review = this.store.review(reviewId);
    if (!review) throw new Error('That review is gone.');
    const repo = this.requireRepo(review.repoId);
    const text = String(body ?? review.body ?? '').trim();
    if (!text) throw new Error('The comment is empty.');
    this.store.saveReviewBody(reviewId, text);
    const posted = await this.forge.of(repo).comment(review.prId, text);
    this.store.recordPublication(reviewId, repo.id, review.prId, posted.id, posted.url, text);
    this.store.markReviewPublished(reviewId, posted.url);
    await this.syncQuietly(repo, review.prId);
    return { ok: true, url: posted.url };
  }

  /** One finding as an inline comment. A failure is kept on the finding, not in a toast that goes away. */
  /**
   * One at a time per thing posted. Publish on a card while Publish all runs,
   * or a draft asked for twice, would otherwise both reach the forge before
   * either is stored: the second caller waits for the first and gets its answer.
   */
  once(key, work) {
    this.posting ??= new Map();
    const running = this.posting.get(key);
    if (running) return running;
    const promise = Promise.resolve().then(work).finally(() => this.posting.delete(key));
    this.posting.set(key, promise);
    return promise;
  }

  publishFinding(findingId) {
    return this.once(`finding:${findingId}`, () => this.publishFindingNow(findingId));
  }

  async publishFindingNow(findingId) {
    const finding = this.store.finding(findingId);
    if (!finding) throw new Error('That finding is gone.');
    if (finding.publishedId) return { ok: true, url: finding.publishedUrl };
    const repo = this.requireRepo(finding.repoId);
    const pr = this.prOrThrow(finding.repoId, finding.prId);
    // Already on the PR under another road? Then it is published, and posting it again would say it twice.
    this.reconcilePublished(repo, finding.prId);
    const again = this.store.finding(findingId);
    if (again.publishedId) return { ok: true, url: again.publishedUrl, alreadyThere: true };
    try {
      const posted = await this.forge.of(repo).inline(finding.prId, rules.findingComment(finding, this.language()), finding.filePath, finding.lineNo, this.store.review(finding.reviewId)?.headSha || pr.headSha);
      this.store.markFindingPublished(findingId, posted.id, posted.url);
      this.store.markPublishedIfComplete(finding.reviewId, posted.url);
      await this.syncQuietly(repo, finding.prId);
      return { ok: true, url: posted.url };
    } catch (error) {
      this.store.failFindingPublish(findingId, String(error?.message ?? error));
      this.changed(repo.id, finding.prId);
      throw error;
    }
  }

  /** Every finding still waiting, then every note. One failing does not stop the rest. */
  async publishAll(repoId, prId) {
    // The thread as it is now first: what was published elsewhere since it was last read is not published again.
    try {
      await this.syncComments(this.requireRepo(repoId), prId);
    } catch {
      /* publishing does not wait on reading; each finding still checks what is stored */
    }
    const review = this.store.latestDone(repoId, prId);
    const findings = review ? this.store.findingsForReview(review.id).filter((finding) => !rules.settled(finding)) : [];
    const notes = this.store.notes(repoId, prId).filter((note) => !note.publishedId);
    let published = 0;
    const errors = [];
    for (const finding of findings) {
      try {
        await this.publishFinding(finding.id);
        published++;
      } catch (error) {
        errors.push(`${finding.title}: ${String(error?.message ?? error).slice(0, 200)}`);
      }
    }
    for (const note of notes) {
      try {
        await this.publishNote(note.id);
        published++;
      } catch (error) {
        errors.push(`note on ${note.filePath}: ${String(error?.message ?? error).slice(0, 200)}`);
      }
    }
    return { ok: errors.length === 0, published, errors };
  }

  publishNote(noteId) {
    return this.once(`note:${noteId}`, () => this.publishNoteNow(noteId));
  }

  async publishNoteNow(noteId) {
    const note = this.store.note(noteId);
    if (!note) throw new Error('That note is gone.');
    if (note.publishedId) return { ok: true, url: note.publishedUrl };
    const repo = this.requireRepo(note.repoId);
    const pr = this.prOrThrow(note.repoId, note.prId);
    const posted = await this.forge.of(repo).inline(note.prId, note.body, note.filePath, note.lineNo, pr.headSha);
    this.store.markNotePublished(noteId, posted.id, posted.url);
    await this.syncQuietly(repo, note.prId);
    return { ok: true, url: posted.url };
  }

  // --- stances, decline, merge ------------------------------------------------------------

  async stance(repoId, prId, action) {
    const repo = this.requireRepo(repoId);
    const forge = this.forge.of(repo);
    const me = this.store.pref('me.author', '') || 'us';
    if (action === 'approve') {
      await forge.approve(prId);
      this.store.recordStance(repoId, prId, me, 'APPROVED');
    } else if (action === 'requestChanges') {
      await forge.requestChanges(prId);
      this.store.recordStance(repoId, prId, me, 'CHANGES_REQUESTED');
    } else if (action === 'unapprove') {
      await forge.unapprove(prId);
      this.store.clearOurStance(repoId, prId);
    } else if (action === 'undoRequestChanges') {
      await forge.undoRequestChanges(prId);
      this.store.clearOurStance(repoId, prId);
    } else {
      throw new Error(`Unknown stance: ${action}`);
    }
    this.changed(repoId, prId);
    return { ok: true };
  }

  async decline(repoId, prId, reason) {
    if (!String(reason ?? '').trim()) throw new Error('Declining needs a reason: it is posted as a comment first.');
    const repo = this.requireRepo(repoId);
    await this.forge.of(repo).decline(prId, reason);
    const pr = this.store.pr(repoId, prId);
    if (pr) this.store.upsertPr(repoId, { ...pr, state: 'DECLINED' });
    this.changed(repoId, prId);
    return { ok: true };
  }

  async merge(repoId, prId, { message, closeSourceBranch = true, strategy = 'MERGE_COMMIT' } = {}) {
    const repo = this.requireRepo(repoId);
    const pr = this.prOrThrow(repoId, prId);
    const text = String(message ?? '').trim() || `Merged in ${pr.sourceBranch} (pull request #${prId})\n\n${pr.title}`;
    const result = await this.forge.of(repo).merge(prId, { message: text, closeSourceBranch, strategy });
    this.store.setPref('merge.strategy', strategy);
    this.store.upsertPr(repoId, { ...pr, state: 'MERGED' });
    this.changed(repoId, prId);
    return { ok: true, result };
  }
}

module.exports = { ReviewEngine, Activity, Semaphore, describeEvent, PR_TTL };
