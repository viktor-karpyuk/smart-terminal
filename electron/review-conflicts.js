'use strict';

/*
 * Merge conflicts, resolved from the reviewer.
 *
 * In three steps, each a decision somebody makes:
 *
 *   1. analyze — the merge of the target into the branch is tried in a copy of
 *      the repository and undone at once; the model reads the three sides and
 *      the history and says what happened and what it proposes for each file.
 *      Nothing is written anywhere.
 *   2. resolve — once that proposal has been read: the merge again, the model
 *      carries the proposal out, the tool checks no marker is left, commits the
 *      merge and runs the repository's check. Still nothing leaves the copy.
 *   3. push — the merge commit to the pull request's branch, never forced. If
 *      somebody pushed in the meantime git refuses, and that is right.
 *
 * The copy is its own directory, not the fix workshop: fixes waiting to be
 * handed back live there, and a merge in progress on top of them would hand
 * them back half-merged.
 */

const fs = require('node:fs');
const path = require('node:path');
const rules = require('./review-rules');
const prompts = require('./review-prompts');
const { describeEvent } = require('./review-engine');

/** Long enough for a large merge and its check; short enough that a hung run is noticed. */
const RUN_TIMEOUT = 30 * 60 * 1000;
const CHECK_TIMEOUT = 15 * 60 * 1000;

/** Never let a resolution undo itself or leave the copy: the tool merges, commits and pushes. */
const RESOLVE_DENIED = [...rules.FIX_DENIED, 'Bash(git merge*)', 'Bash(git rebase*)', 'Bash(git stash*)', 'Bash(git pull*)', 'Bash(git fetch*)'];

const MARKER = /^(<{7}|>{7})( |$)|^={7}$/m;

class ConflictResolver {
  constructor({ store, git, claude, engine, forge = null, scratch, language = () => 'español' }) {
    this.store = store;
    this.git = git;
    this.claude = claude;
    this.engine = engine;
    this.forge = forge;
    this.scratch = scratch;
    this.language = language;
  }

  key(repoId, prId) {
    return `conflicts:${repoId}#${Number(prId)}`;
  }

  /** Where this pull request's merge is worked out. Kept between the steps, removed by discard. */
  dirFor(repo, prId) {
    return path.join(this.scratch, `conflicts-${rules.slug(repo.name)}-pr${Number(prId)}`);
  }

  /** What has been done so far for this pull request, or null. */
  state(repoId, prId) {
    const raw = this.store.pref(this.key(repoId, prId));
    if (!raw) return null;
    try {
      const job = JSON.parse(raw);
      return { ...job, busy: this.engine.activity.has(this.key(repoId, prId)) };
    } catch {
      return null;
    }
  }

  save(repoId, prId, job) {
    this.store.setPref(this.key(repoId, prId), job ? JSON.stringify({ ...job, at: new Date().toISOString() }) : null);
    this.engine.changed(repoId, prId);
  }

  /** The copy, on the branch as the remote has it, with the target fetched beside it. */
  async prepare(repo, pr, log) {
    await this.engine.inClone(repo.localPath, () => this.git.fetch(repo.localPath, pr.targetBranch, pr.sourceBranch));
    const dir = this.dirFor(repo, pr.id);
    // Whatever an earlier run left half-done goes first: a merge in progress is not something to build on.
    if (this.git.isRepo(dir)) await this.git.run(dir, ['merge', '--abort']);
    await this.git.prepareWorkshop({ origin: repo.localPath, dir, branch: pr.sourceBranch, hasPendingReturn: async () => false, log });
    const targetRef = `refs/remotes/pr-target/${pr.targetBranch}`;
    const got = await this.git.run(dir, ['fetch', 'origin', `+refs/remotes/origin/${pr.targetBranch}:${targetRef}`]);
    if (!got.ok) throw new Error(`Could not read ${pr.targetBranch}: ${got.output.slice(0, 300)}`);
    // The copy follows the remote branch exactly: anything left from an earlier attempt is not the pull request.
    const tip = await this.git.revParse(dir, `refs/remotes/pr-head/${pr.sourceBranch}`);
    if (tip) await this.git.run(dir, ['reset', '--hard', tip]);
    await this.git.run(dir, ['clean', '-fd']);
    const head = await this.git.head(dir);
    const target = await this.git.revParse(dir, targetRef);
    if (!head || !target) throw new Error('The branch or its target could not be read.');
    const base = (await this.git.run(dir, ['merge-base', head, target])).stdout.trim();
    return { dir, head, target, targetRef, base };
  }

  /** Start the merge and leave it in progress; the conflicted paths, or [] if it went in clean. */
  async startMerge(dir, targetRef, target) {
    const merged = await this.git.run(dir, ['-c', 'user.name=Code Reviewer', '-c', 'user.email=code-reviewer@localhost', 'merge', '--no-commit', '--no-ff', targetRef]);
    const listed = await this.git.run(dir, ['diff', '--name-only', '--diff-filter=U']);
    const paths = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!merged.ok && !paths.length) throw new Error(`git merge ${target.slice(0, 7)} failed: ${merged.output.slice(0, 300)}`);
    return paths;
  }

  async logOf(dir, range, file = null) {
    const args = ['log', '--format=%h %an: %s', '-n', '40', range];
    if (file) args.push('--', file);
    const res = await this.git.run(dir, args);
    return res.ok ? res.stdout.split('\n').filter(Boolean) : [];
  }

  /** Step one: what happened, and a proposal. Writes nothing outside the copy, and leaves the copy clean. */
  async analyze(repoId, prId) {
    const repo = this.engine.requireRepo(repoId);
    this.engine.requireClone(repo);
    const pr = this.engine.prOrThrow(repoId, prId);
    const key = this.key(repoId, prId);
    const activity = this.engine.activity;
    if (activity.has(key)) throw new Error('The conflicts of this pull request are already being worked on.');
    activity.start(key, { kind: 'conflicts', repoId, prId: pr.id, repoName: repo.name, title: `Conflicts of #${pr.id}` });
    this.save(repoId, prId, { state: 'ANALYZING' });
    const log = (text) => activity.line(key, text);
    try {
      log(`Merging ${pr.targetBranch} into ${pr.sourceBranch} in a separate copy…`);
      const { dir, head, target, targetRef, base } = await this.prepare(repo, pr, log);
      const paths = await this.startMerge(dir, targetRef, target);
      await this.git.run(dir, ['merge', '--abort']);
      if (!paths.length) {
        this.store.setConflicts(repoId, prId, []);
        this.save(repoId, prId, { state: 'CLEAN', head, target });
        log('It merges cleanly now: nothing to resolve.');
        return this.state(repoId, prId);
      }
      this.store.setConflicts(repoId, prId, paths);
      log(`${paths.length} file(s) in conflict. Reading what each side did…`);
      const files = [];
      for (const file of paths) {
        files.push({ path: file, targetLog: await this.logOf(dir, `${base}..${target}`, file), branchLog: await this.logOf(dir, `${base}..${head}`, file) });
      }
      const targetLog = await this.logOf(dir, `${base}..${target}`);
      const branchLog = await this.logOf(dir, `${base}..${head}`);
      const result = await this.claude.run({
        kind: 'conflicts',
        cwd: dir,
        prompt: prompts.conflictAnalysisPrompt({ pr, target: targetRef, base, files, targetLog, branchLog, language: this.language() }),
        model: rules.DEPTHS.HEAVY.model,
        allowedTools: rules.DEPTHS.HEAVY.tools,
        disallowedTools: rules.REVIEW_DENIED,
        schema: prompts.CONFLICT_PLAN_SCHEMA,
        timeout: RUN_TIMEOUT,
        register: (handle) => activity.patch(key, { handle }),
        onEvent: (event) => log(describeEvent(event)),
      });
      if (!result.ok) throw new Error((result.stderr || 'The analysis finished without an answer.').slice(0, 500));
      const plan = parsePlan(result.structured ?? result.text, paths);
      this.save(repoId, prId, { state: 'PROPOSED', head, target, base, targetBranch: pr.targetBranch, branch: pr.sourceBranch, paths, plan, costUsd: result.costUsd ?? 0 });
      log('Proposal ready.');
      return this.state(repoId, prId);
    } catch (error) {
      this.save(repoId, prId, { state: 'FAILED', step: 'analyze', error: String(error?.message ?? error).slice(0, 800) });
      throw error;
    } finally {
      activity.end(key);
      this.engine.changed(repoId, prId);
    }
  }

  /** Step two: carry the read proposal out, in the copy, and commit the merge there. */
  async resolve(repoId, prId, { note = '' } = {}) {
    const repo = this.engine.requireRepo(repoId);
    this.engine.requireClone(repo);
    const pr = this.engine.prOrThrow(repoId, prId);
    const job = this.state(repoId, prId);
    if (!job || job.state !== 'PROPOSED') throw new Error('There is no proposal to carry out. Analyze the conflicts first.');
    const key = this.key(repoId, prId);
    const activity = this.engine.activity;
    if (activity.has(key)) throw new Error('The conflicts of this pull request are already being worked on.');
    activity.start(key, { kind: 'conflicts', repoId, prId: pr.id, repoName: repo.name, title: `Resolving #${pr.id}` });
    const log = (text) => activity.line(key, text);
    this.save(repoId, prId, { ...job, state: 'RESOLVING' });
    try {
      const { dir, head, target, targetRef } = await this.prepare(repo, pr, log);
      // The proposal was about two particular commits. If either side moved, it is about something else now.
      if (head !== job.head || target !== job.target) {
        const moved = head !== job.head ? pr.sourceBranch : pr.targetBranch;
        this.save(repoId, prId, { state: 'FAILED', step: 'resolve', error: `${moved} moved since the analysis, so the proposal may no longer fit. Analyze again.` });
        throw new Error(`${moved} moved since the analysis. Analyze again.`);
      }
      const paths = await this.startMerge(dir, targetRef, target);
      if (!paths.length) log('It merged without conflicts this time.');
      else {
        log(`Resolving ${paths.length} file(s) as proposed…`);
        const result = await this.claude.run({
          kind: 'conflicts',
          cwd: dir,
          prompt: prompts.conflictResolvePrompt({ pr, target: pr.targetBranch, files: paths.map((one) => ({ path: one })), plan: job.plan, note, language: this.language() }),
          model: rules.DEPTHS.HEAVY.model,
          allowedTools: rules.FIX_TOOLS,
          disallowedTools: RESOLVE_DENIED,
          schema: prompts.CONFLICT_RESOLVE_SCHEMA,
          timeout: RUN_TIMEOUT,
          register: (handle) => activity.patch(key, { handle }),
          onEvent: (event) => log(describeEvent(event)),
        });
        if (!result.ok) throw new Error((result.stderr || 'The resolution finished without an answer.').slice(0, 500));
        const outcome = result.structured && typeof result.structured === 'object' ? result.structured : {};
        if (outcome.resolved === false) throw new Error(`Not resolved: ${String(outcome.reason || outcome.summary || 'no reason given').slice(0, 600)}`);
        // The model's word is not the check: every file that was in conflict is read for a marker.
        const left = paths.filter((file) => {
          try {
            return MARKER.test(fs.readFileSync(path.join(dir, file), 'utf8'));
          } catch {
            return false;
          }
        });
        if (left.length) throw new Error(`Conflict markers are still in ${left.join(', ')}. Nothing was committed.`);
        job.summary = String(outcome.summary ?? '').slice(0, 1500);
      }
      const added = await this.git.run(dir, ['add', '-A']);
      if (!added.ok) throw new Error(`git add failed: ${added.output.slice(0, 300)}`);
      const message = `Merge ${pr.targetBranch} into ${pr.sourceBranch}, resolving conflicts\n\n${job.summary || job.plan?.summary || ''}`.trim();
      const committed = await this.git.run(dir, ['commit', '--no-verify', '-m', message]);
      if (!committed.ok) throw new Error(`git commit failed: ${committed.output.slice(0, 300)}`);
      const sha = await this.git.head(dir);
      log(`Merge committed as ${sha.slice(0, 7)} in the copy.`);
      const check = await this.check(repo, dir, log);
      const stat = (await this.git.run(dir, ['diff', '--stat', `${head}`, sha])).stdout.trim().slice(0, 4000);
      const diff = (await this.git.run(dir, ['diff', `${head}`, sha])).stdout.slice(0, 200000);
      this.save(repoId, prId, { ...job, state: 'RESOLVED', sha, check, stat, diff, note: String(note ?? '').trim() || null });
      return this.state(repoId, prId);
    } catch (error) {
      const now = this.state(repoId, prId);
      if (now?.state === 'RESOLVING') this.save(repoId, prId, { ...job, state: 'PROPOSED', error: String(error?.message ?? error).slice(0, 800) });
      throw error;
    } finally {
      activity.end(key);
      this.engine.changed(repoId, prId);
    }
  }

  async check(repo, dir, log) {
    const command = String(repo.checkCommand ?? '').trim();
    if (!command) return null;
    log(`Checking: ${command}`);
    const started = Date.now();
    const result = await this.git.shell(dir, command, { timeout: CHECK_TIMEOUT });
    const seconds = Math.round((Date.now() - started) / 1000);
    const state = result.timedOut ? 'TIMEOUT' : result.ok ? 'PASSED' : 'FAILED';
    log(state === 'PASSED' ? `Check passed in ${seconds}s.` : `Check ${state.toLowerCase()} after ${seconds}s.`);
    return { state, seconds, output: String(result.output ?? '').slice(-4000) };
  }

  /** Step three: the merge commit to the pull request's branch. Never forced. */
  async push(repoId, prId) {
    const repo = this.engine.requireRepo(repoId);
    const pr = this.engine.prOrThrow(repoId, prId);
    const job = this.state(repoId, prId);
    if (!job || job.state !== 'RESOLVED' || !job.sha) throw new Error('There is no resolved merge to push.');
    const dir = this.dirFor(repo, prId);
    if (!this.git.isRepo(dir)) throw new Error('The copy with the merge is gone. Analyze again.');
    const remote = await this.git.remoteUrl(repo.localPath);
    if (!remote) throw new Error('The clone has no origin to push to.');
    const pushed = await this.git.run(dir, ['push', remote, `${job.sha}:refs/heads/${pr.sourceBranch}`]);
    if (!pushed.ok) {
      throw new Error(/rejected|non-fast-forward|fetch first/i.test(pushed.output)
        ? `${pr.sourceBranch} moved since it was read; nothing was pushed. Analyze again.`
        : pushed.output.slice(-300));
    }
    this.save(repoId, prId, { state: 'PUSHED', sha: job.sha, branch: pr.sourceBranch, targetBranch: pr.targetBranch });
    fs.rmSync(dir, { recursive: true, force: true });
    // What the branch is now, and whether it lands.
    await this.engine.checkConflicts(repoId, prId, { fetch: true }).catch(() => null);
    return { ok: true, sha: job.sha };
  }

  /** Throw the copy and the proposal away. */
  discard(repoId, prId) {
    if (this.engine.activity.has(this.key(repoId, prId))) throw new Error('Still working on it. Cancel the run first.');
    const repo = this.engine.requireRepo(repoId);
    fs.rmSync(this.dirFor(repo, prId), { recursive: true, force: true });
    this.save(repoId, prId, null);
    return { ok: true };
  }
}

/** The model's proposal, shaped, with every conflicted file accounted for. */
function parsePlan(raw, paths) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      value = { cause: value, summary: '', files: [] };
    }
  }
  const approaches = ['OURS', 'THEIRS', 'COMBINE', 'MANUAL'];
  const files = (Array.isArray(value?.files) ? value.files : [])
    .filter((file) => file && typeof file.path === 'string')
    .map((file) => ({
      path: file.path,
      approach: approaches.includes(String(file.approach).toUpperCase()) ? String(file.approach).toUpperCase() : 'MANUAL',
      what: String(file.what ?? '').slice(0, 3000),
      proposal: String(file.proposal ?? '').slice(0, 3000),
    }));
  for (const missing of paths.filter((one) => !files.some((file) => file.path === one))) {
    files.push({ path: missing, approach: 'MANUAL', what: '', proposal: 'The analysis did not say what to do with this file.' });
  }
  return { cause: String(value?.cause ?? '').slice(0, 4000), summary: String(value?.summary ?? '').slice(0, 1000), files, risks: String(value?.risks ?? '').slice(0, 3000) };
}

module.exports = { ConflictResolver, parsePlan, MARKER };
