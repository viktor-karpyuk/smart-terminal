'use strict';

const fs = require('node:fs');
const path = require('node:path');
const rules = require('./review-rules');
const prompts = require('./review-prompts');
const { describeEvent } = require('./review-engine');
const { busSection, TOOL_NAMES } = require('./review-bus');

/** How long a repository's own check may take before it is called a timeout rather than an answer. */
const CHECK_TIMEOUT = 15 * 60 * 1000;

/**
 * Code Reviewer: fixing a finding, in a workshop, never in anybody's clone.
 *
 * The same model with the opposite brief: the review looks and touches nothing;
 * this touches one thing. The invariants it keeps:
 *
 * - **It writes only in the workshop** — `<data>/code-review/fixes/<repo>-pr<n>`,
 *   a `git clone --local` of the person's clone — and `git push` is denied to it.
 *   The commit reaches the person's clone only when someone hands it back, and
 *   the remote only when someone presses push.
 * - **The tool commits, not the model**, and only when `git status` shows a
 *   change: the working tree is the truth about whether anything was fixed.
 * - **A written fix closes its finding and says so in its thread.** Closed, or
 *   automatic mode would take it again and write the same change twice. Said,
 *   because whoever received the comment has no other way of knowing, and would
 *   fix again what was fixed. The words come from a template and always say the
 *   commit is not on the branch yet. If saying it fails, the error is kept on the
 *   fix and can be retried; the commit is never touched.
 * - **Someone else's comment is fixed the same way but not passed off as ours**:
 *   adopted as a finding with `asked_by`, its reply landing in *their* thread.
 */

class FixEngine {
  constructor({ store, forge, git, claude, engine, root, notify = () => {}, emit = () => {}, bus = null, busServer = () => null }) {
    this.store = store;
    this.forge = forge;
    this.git = git;
    this.claude = claude;
    this.engine = engine;
    this.root = root;
    this.notify = notify;
    this.emit = emit;
    this.bus = bus;
    this.busServer = busServer;
    /** One queue per PR: fixes of one PR share a workshop and run in turn; different PRs run side by side. */
    this.queues = new Map();
  }

  /**
   * The workshop of a PR. A fix imported from AI Code Reviewer still lives in
   * that app's workshop, and its commit is only there: while such a workshop
   * exists it is the one used, or handing those fixes back would find nothing.
   */
  dirFor(repo, prId) {
    const inherited = this.store.fixesForPr(repo.id, prId).find((fix) => fix.workspace && !fix.workspace.startsWith(this.root) && fs.existsSync(fix.workspace));
    return inherited ? inherited.workspace : path.join(this.root, `${rules.slug(repo.name)}-pr${prId}`);
  }

  isFixing(findingId) {
    return this.engine.activity.has(`fix:${findingId}`);
  }

  running() {
    return this.engine.activity.list().filter((run) => run.kind === 'fix');
  }

  serial(key, fn) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.queues.set(key, next);
    return next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  /** Fix one finding. Resolves with the fix row; a failure is written on the row and thrown. */
  async fix(findingId, { note = '' } = {}) {
    const finding = this.store.finding(findingId);
    if (!finding) throw new Error('That finding is gone.');
    const repo = this.engine.requireRepo(finding.repoId);
    if (repo.fixMode === 'OFF') throw new Error(`Fixes are switched off for ${repo.name}.`);
    if (this.isFixing(findingId)) throw new Error('That finding is already being fixed.');
    this.engine.requireClone(repo);
    const pr = this.engine.prOrThrow(finding.repoId, finding.prId);
    const key = `fix:${findingId}`;
    const activity = this.engine.activity;
    activity.start(key, { kind: 'fix', repoId: repo.id, prId: pr.id, repoName: repo.name, title: finding.title, findingId });
    activity.line(key, 'Waiting for the workshop…');
    this.engine.changed(repo.id, pr.id);
    try {
      return await this.serial(`${repo.id}#${pr.id}`, () => this.fixNow(repo, pr, finding, key, note));
    } finally {
      activity.end(key);
      this.engine.changed(repo.id, pr.id);
    }
  }

  async fixNow(repo, pr, queued, key, note = '') {
    const activity = this.engine.activity;
    // Read again now that it is this fix's turn: another run may have closed it while this one waited.
    if (activity.cancelled(key)) throw new Error('Cancelled before it started.');
    const finding = this.store.finding(queued.id) ?? queued;
    if (rules.closed(finding)) {
      activity.line(key, 'Already closed while it waited: nothing to fix.');
      return null;
    }
    const dir = this.dirFor(repo, pr.id);
    await this.git.prepareWorkshop({
      origin: repo.localPath,
      dir,
      branch: pr.sourceBranch,
      hasPendingReturn: async () => this.store.pendingReturn(repo.id, pr.id).length > 0,
      log: (text) => activity.line(key, text),
    });
    // Changes nobody committed belong to no finding: fixing on top of them would hand them to this one.
    if (await this.git.isDirty(dir)) {
      throw new Error('The workshop has uncommitted changes left by an earlier fix whose commit failed. Discard the workshop, or commit them there, before fixing again.');
    }
    const fixId = this.store.startFix({ findingId: finding.id, reviewId: finding.reviewId, repoId: repo.id, prId: pr.id, branch: pr.sourceBranch, workspace: dir, note: String(note ?? '').trim() || null });
    const language = this.engine.language();
    const label = `Fix #${pr.id}: ${finding.title}`.slice(0, 80);
    const attached = this.attach({ repo, pr, dir, label });
    try {
      const before = await this.git.head(dir);
      const result = await this.claude.run({
        kind: 'fix',
        cwd: dir,
        prompt: prompts.fixPrompt({
          finding,
          prTitle: pr.title,
          branch: pr.sourceBranch,
          language,
          guidelines: prompts.guidelinesSection(this.store.guidelinesForReview(repo.id)),
          bus: attached?.section ?? '',
          thread: this.threadFor(repo.id, pr.id, finding),
          note,
          previous: this.lastAttempt(finding.id, fixId),
        }),
        model: repo.defaultModel || rules.DEPTHS.INTERMEDIATE.model,
        mcpConfig: attached?.config,
        allowedTools: attached ? [...rules.FIX_TOOLS, ...attached.tools] : rules.FIX_TOOLS,
        disallowedTools: rules.FIX_DENIED,
        schema: prompts.FIX_SCHEMA,
        timeout: 30 * 60 * 1000,
        register: (handle) => activity.patch(key, { handle }),
        onEvent: (event) => activity.line(key, describeEvent(event)),
      });
      if (!result.ok) {
        const message = (result.stderr || 'The fix finished without a result.').slice(0, 500);
        this.store.fixFailed(fixId, message, result.sessionId, result.costUsd);
        throw new Error(message);
      }
      const outcome = rules.parseFix(result.structured ?? result.text);
      const dirty = await this.git.isDirty(dir);
      const sha = dirty ? await this.git.commitAll(dir, rules.fixCommitMessage(finding, outcome.summary)) : null;
      const after = await this.git.head(dir);
      // A commit the model made anyway, despite the denial, is still this finding's.
      const commit = sha ?? (after && after !== before ? after : null);
      if (commit) {
        this.store.fixCommitted(fixId, commit, outcome.summary, result.sessionId, result.costUsd);
        this.store.setResolution(finding.id, 'RESOLVED', rules.fixResolutionNote(commit, outcome.summary));
        this.store.closeFinding(finding.id, true);
        activity.line(key, `Committed ${commit.slice(0, 7)} in the workshop.`);
        await this.check({ repo, dir, fixId, log: (text) => activity.line(key, text) });
        await this.recordTouch({ repo, pr, dir, commit, before, label, log: (text) => activity.line(key, text) });
        await this.answer(repo, pr, finding, fixId, commit, outcome.summary, (text) => activity.line(key, text));
        this.notify(`Fix ready in ${repo.name}`, `${finding.title.slice(0, 80)} — commit ${commit.slice(0, 7)} in the workshop.`);
      } else {
        this.store.fixNothing(fixId, outcome.reason || outcome.summary || 'It finished without changing any file and without saying why.', result.sessionId, result.costUsd);
      }
      return this.store.fix(fixId);
    } catch (error) {
      const row = this.store.fix(fixId);
      if (row?.state === 'RUNNING') this.store.fixFailed(fixId, String(error?.message ?? error));
      throw error;
    } finally {
      // Leaving releases its claims: a fix that is over holds nothing up.
      if (attached) this.bus.close(attached.token);
    }
  }

  /** What was said under this finding's comment, oldest first: the author's own words. */
  threadFor(repoId, prId, finding) {
    if (!finding.publishedId) return [];
    return this.store.comments(repoId, prId)
      .filter((comment) => !comment.deleted && (comment.parentId === finding.publishedId || comment.commentId === finding.publishedId))
      .sort((a, b) => String(a.createdOn).localeCompare(String(b.createdOn)))
      .map((comment) => ({ author: comment.author, body: comment.body, ours: comment.ours }));
  }

  /** What the last attempt on this finding did, so a retry is told not to repeat it. */
  lastAttempt(findingId, exceptFixId) {
    const previous = this.store.fixesForFinding(findingId).filter((fix) => fix.id !== exceptFixId);
    const last = previous[0];
    if (!last) return null;
    return last.summary || last.error || null;
  }

  /**
   * Whether the repository still builds, asked of the repository itself.
   *
   * A fix commits whatever changed the moment `git status` is dirty — which is
   * the right rule for "did anything happen" and no rule at all for "is it any
   * good". The command is the project's own (`npm test`, `mvn -q test`), run in
   * the workshop on the commit that was just made, and its answer is written on
   * the fix so nobody hands back a red build without being told.
   *
   * Nothing configured means nothing ran, which is recorded as nothing ran: a
   * check that did not happen must never read as one that passed.
   */
  async check({ repo, dir, fixId, log }) {
    const command = String(repo.checkCommand ?? '').trim();
    if (!command) return null;
    log(`Checking: ${command}`);
    const started = Date.now();
    const result = await this.git.shell(dir, command, { timeout: CHECK_TIMEOUT });
    const seconds = (Date.now() - started) / 1000;
    const state = result.timedOut ? 'TIMEOUT' : result.ok ? 'PASSED' : 'FAILED';
    this.store.fixChecked(fixId, { state, output: result.output, seconds });
    log(state === 'PASSED' ? `Check passed in ${Math.round(seconds)}s.` : `Check ${state.toLowerCase()} after ${Math.round(seconds)}s.`);
    return state;
  }

  /**
   * Take one fix back out of the workshop.
   *
   * The commit goes (dropped if it is the tip, reverted if something sits on
   * top of it) and the finding comes back: it was marked resolved and closed
   * *because* of that commit, and with the commit gone that is no longer true.
   * What stays is the row and the answer already posted in the thread — the
   * thread was told the commit existed, and the honest correction to that is a
   * word from a person, not a quiet edit.
   */
  async dropFix(fixId) {
    const fix = this.store.fix(fixId);
    if (!fix) throw new Error('That fix is gone.');
    if (fix.state !== 'COMMITTED' || !fix.sha) throw new Error('That attempt left no commit to take out.');
    if (fix.returnedAt) throw new Error('That fix is already in your clone; undo it there.');
    const repo = this.engine.requireRepo(fix.repoId);
    const dir = this.dirFor(repo, fix.prId);
    if (!this.git.isRepo(dir)) throw new Error(`There is no workshop for PR #${fix.prId}.`);
    const result = await this.git.dropCommit(dir, fix.branch, fix.sha);
    if (!result.ok) throw new Error(result.output.slice(0, 300) || 'git could not take that commit out.');
    this.store.dropFix(fixId);
    const finding = this.store.finding(fix.findingId);
    if (finding && !finding.dismissedAt) {
      this.store.setResolution(finding.id, null, null, null);
      this.store.closeFinding(finding.id, false);
    }
    this.engine.changed(fix.repoId, fix.prId);
    return { ok: true, how: result.how };
  }

  /**
   * Put this run on the bus: a token of the app's making, an MCP config naming
   * the bus server with that token in its environment, the tools allowed by
   * name, and the prompt section — with whatever was already left for this PR
   * folded in and marked read, so it is not read twice. Without the socket (the
   * app has not opened it, or this is a test) the fix runs alone, as before.
   */
  attach({ repo, pr, dir, label }) {
    const server = this.bus ? this.busServer() : null;
    if (!server) return null;
    const token = this.bus.openFix({ repoId: repo.id, prId: pr.id, label, branch: pr.sourceBranch, workDir: dir });
    const member = this.bus.member(token);
    const pending = this.bus.inbox(member);
    if (pending.length) this.bus.markRead(member, pending[pending.length - 1]);
    const config = {
      mcpServers: {
        'code-review': { command: server.command, args: [server.script], env: { ELECTRON_RUN_AS_NODE: '1', SMART_TERMINAL_BRIDGE: server.socketPath, SMART_TERMINAL_BUS_TOKEN: token } },
      },
    };
    return { token, config, tools: TOOL_NAMES.map((name) => `mcp__code-review__${name}`), section: busSection(pending) };
  }

  /**
   * What a committed fix changed, remembered against its PR's branch — and if
   * another open PR's branch changes the same files, everyone writing in the
   * repository is told now, not at the merge.
   */
  async recordTouch({ repo, pr, dir, commit, before, label, log }) {
    if (!this.bus) return;
    const range = before && before !== commit ? `${before}..${commit}` : `${commit}~1..${commit}`;
    const changed = await this.git.run(dir, ['diff', '--name-only', range]);
    const files = changed.ok ? changed.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];
    if (!files.length) return;
    this.bus.touch({ repoId: repo.id, prId: pr.id, branch: pr.sourceBranch, label, paths: files });
    const { hits } = await this.bus.whoTouched({ repoId: repo.id, prId: pr.id }, files);
    if (!hits.length) return;
    const lines = hits.map((hit) => `${hit.branch ?? 'another branch'}${hit.prId ? ` (PR #${hit.prId})` : ''}: ${hit.paths.join(', ')}`);
    this.bus.post({
      scopeName: 'REPO',
      from: { repoId: repo.id, prId: pr.id, token: null, label: 'the tool' },
      kind: 'warning',
      subject: `${files.length} file(s) changed by a fix on ${pr.sourceBranch}`,
      body: `A fix for PR #${pr.id} (${pr.sourceBranch}) changed files that other open branches also change — they will meet at the merge:\n${lines.join('\n')}`,
    });
    log(`Other branches change the same files: ${lines.join('; ')}`);
  }

  async notice(repo, pr, finding, summary, sha) {
    const language = this.engine.language();
    const forge = this.forge.of(repo);
    if (finding.publishedId) return forge.reply(pr.id, finding.publishedId, rules.fixReply(finding, summary, sha, language));
    return forge.inline(pr.id, rules.fixReplyStandalone(finding, summary, sha, language), finding.filePath, finding.lineNo, pr.headSha);
  }

  async answer(repo, pr, finding, fixId, sha, summary, log) {
    try {
      const posted = await this.notice(repo, pr, finding, summary, sha);
      this.store.fixReplied(fixId, posted.id, posted.url);
      log('Answered in the finding\'s thread.');
    } catch (error) {
      this.store.fixReplyFailed(fixId, String(error?.message ?? error));
      log(`Could not answer in the thread: ${String(error?.message ?? error).slice(0, 160)}`);
    }
  }

  async retryReply(fixId) {
    const fix = this.store.fix(fixId);
    if (!fix || fix.state !== 'COMMITTED' || !fix.sha) throw new Error('That attempt left no commit, so there is no fix to announce.');
    if (fix.replyId) throw new Error('That finding was already answered.');
    const finding = this.store.finding(fix.findingId);
    const repo = this.engine.requireRepo(fix.repoId);
    const pr = this.engine.prOrThrow(fix.repoId, fix.prId);
    try {
      const posted = await this.notice(repo, pr, finding, fix.summary, fix.sha);
      this.store.fixReplied(fix.id, posted.id, posted.url);
      return { ok: true, url: posted.url };
    } catch (error) {
      this.store.fixReplyFailed(fix.id, String(error?.message ?? error));
      throw error;
    } finally {
      this.engine.changed(fix.repoId, fix.prId);
    }
  }

  /** In turn, not side by side: they share one workshop. */
  async fixAll(findingIds) {
    let committed = 0;
    const errors = [];
    for (const findingId of findingIds) {
      try {
        const row = await this.fix(findingId);
        if (row?.sha) committed++;
      } catch (error) {
        errors.push(String(error?.message ?? error).slice(0, 200));
      }
    }
    return { committed, errors };
  }

  /** After a finished review, when the repository asked for it: every open finding of that review. */
  async autoFix(repo, pr, review) {
    if (repo.fixMode !== 'AUTO') return 0;
    const open = this.store.findingsForReview(review.id).filter((finding) => !rules.closed(finding));
    if (!open.length) return 0;
    const { committed } = await this.fixAll(open.map((finding) => finding.id));
    if (committed > 0) this.notify(`Automatic fixes in ${repo.name}`, `${committed} of ${open.length} finding(s) of PR #${pr.id} are committed in the workshop.`);
    return committed;
  }

  /**
   * The workshop's commits into the person's clone, on the same branch. It fails
   * when the clone has that branch checked out — git will not update a checked-out
   * branch — and the message says so, because that is nearly always why.
   */
  async giveBack(repoId, prId, { upToFixId = null } = {}) {
    const repo = this.engine.requireRepo(repoId);
    const pr = this.engine.prOrThrow(repoId, prId);
    const dir = this.dirFor(repo, prId);
    if (!this.git.isRepo(dir)) throw new Error(`There is no workshop for PR #${prId}.`);
    const pending = this.store.pendingReturn(repoId, prId);
    if (!pending.length) throw new Error('There are no fixes to hand back.');
    const branch = pr.sourceBranch;
    /*
     * Up to one commit, not a pick of any three.
     *
     * Handing back pushes a branch, so what arrives is everything up to the
     * commit chosen — offering to leave an earlier one behind would be a
     * promise git cannot keep. The refspec is that commit rather than the
     * branch tip; the rest stay in the workshop and are handed back next time.
     */
    const cut = upToFixId ? pending.findIndex((fix) => fix.id === upToFixId) : -1;
    if (upToFixId && cut < 0) throw new Error('That fix is not waiting to be handed back.');
    const chosen = cut >= 0 ? pending.slice(0, cut + 1) : pending;
    const partial = cut >= 0 && cut < pending.length - 1;
    const pushed = partial
      ? await this.git.pushRefToLocal(dir, repo.localPath, pending[cut].sha, branch)
      : await this.git.pushToLocal(dir, repo.localPath, branch);
    const want = partial ? pending[cut].sha : await this.git.branchHead(dir, branch);
    const same = want && want === (await this.git.branchHead(repo.localPath, branch));
    if (!pushed.ok && !same) {
      const checkedOut = (await this.git.currentBranch(repo.localPath)) === branch;
      throw new Error(checkedOut ? `The clone is on "${branch}": switch it to another branch and hand back again.` : pushed.output.slice(0, 300));
    }
    this.store.markReturned(repoId, prId, upToFixId);
    this.engine.changed(repoId, prId);
    return { ok: true, count: chosen.length, left: pending.length - chosen.length };
  }

  /** Refuses while fixes are waiting to be handed back: the workshop holds the only copy of them. */
  async discard(repoId, prId, { force = false } = {}) {
    const repo = this.engine.requireRepo(repoId);
    const dir = this.dirFor(repo, prId);
    if (!fs.existsSync(dir)) return { ok: true };
    if (!force) {
      const pending = this.store.pendingReturn(repoId, prId);
      if (pending.length) throw new Error(`${pending.length} fix(es) have not been handed back. Hand them back before discarding.`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    this.engine.changed(repoId, prId);
    return { ok: true };
  }

  /** The person's clone to origin, never forced: if the remote moved, git refuses, and that is right. */
  async push(repoId, prId) {
    const repo = this.engine.requireRepo(repoId);
    const pr = this.engine.prOrThrow(repoId, prId);
    const result = await this.git.pushBranch(repo.localPath, pr.sourceBranch);
    this.engine.changed(repoId, prId);
    if (!result.ok) throw new Error(result.output.slice(-240) || 'git push failed.');
    return { ok: true, output: result.output.slice(-240) };
  }

  workshopState(repo, prId) {
    const dir = this.dirFor(repo, prId);
    return { dir, exists: fs.existsSync(dir), pendingReturn: this.store.pendingReturn(repo.id, prId).length };
  }
}

module.exports = { FixEngine, CHECK_TIMEOUT };
