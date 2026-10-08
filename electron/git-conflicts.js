'use strict';

/*
 * A merge that stopped on conflicts in somebody's own working copy, fixed from
 * the Git panel.
 *
 *   analyze  — Claude reads the markers, the three sides and the history, and
 *              says what happened and what it proposes per file. Read only.
 *   resolve  — once the proposal has been read: Claude edits the files in
 *              conflict and nothing else; the tool refuses to stage anything
 *              while a marker is left, then stages what was resolved.
 *   conclude — the merge commit, with git's own message, when no file is left
 *              in conflict.
 *
 * The working copy is the person's, so nothing here commits on its own, pushes,
 * resets or aborts: what Claude may run is the fix's list minus all of that,
 * and the commit is a button.
 */

const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');
const rules = require('./review-rules');
const prompts = require('./review-prompts');
const { describeEvent } = require('./review-engine');
const { parsePlan } = require('./review-conflicts');

const RUN_TIMEOUT = 30 * 60 * 1000;
const RESOLVE_DENIED = [...rules.FIX_DENIED, 'Bash(git merge*)', 'Bash(git rebase*)', 'Bash(git stash*)', 'Bash(git pull*)', 'Bash(git fetch*)', 'Bash(git checkout*)', 'Bash(git switch*)', 'Bash(git restore*)', 'Bash(git add*)', 'Bash(git rm*)'];

class LocalConflicts {
  /**
   * @param {object} options
   * @param {() => ({ run(options: object): Promise<object> } | null)} options.claude the runner, asked for when it is needed
   * @param {() => string} [options.language]
   */
  constructor({ claude, language = () => 'español' }) {
    this.claude = claude;
    this.language = language;
    /** One job per repository root: its step, its proposal, its progress. */
    this.jobs = new Map();
    this.handles = new Map();
  }

  job(root) {
    const job = this.jobs.get(root);
    return job ? { ...job, lines: job.lines.slice(-12) } : null;
  }

  set(root, patch) {
    const job = { ...(this.jobs.get(root) ?? { lines: [] }), ...patch };
    this.jobs.set(root, job);
    return job;
  }

  line(root, text) {
    const job = this.jobs.get(root);
    if (!job || !text) return;
    job.lines.push(String(text).slice(0, 300));
    if (job.lines.length > 60) job.lines.splice(0, job.lines.length - 60);
  }

  runner() {
    const claude = this.claude();
    if (!claude) throw new Error('Claude is not available: the Code Reviewer, which runs it, is not running.');
    return claude;
  }

  async state(root) {
    const status = await git.status(root);
    if (!status.ok) throw new Error(status.error || 'Could not read the repository.');
    if (!status.merge) throw new Error('No merge is in progress here.');
    return status;
  }

  async logOf(root, range, file = null) {
    const args = ['log', '--format=%h %an: %s', '-n', '40', range];
    if (file) args.push('--', file);
    const res = await git.run(root, args);
    return res.ok ? res.stdout.split('\n').filter(Boolean) : [];
  }

  /** What happened, and a proposal per file. Reads only. */
  async analyze(root) {
    if (this.jobs.get(root)?.busy) throw new Error('Already working on these conflicts.');
    const status = await this.state(root);
    const paths = status.merge.conflicted;
    if (!paths.length) throw new Error('No file is in conflict: the merge can be concluded.');
    this.jobs.set(root, { step: 'ANALYZING', busy: true, lines: [], paths });
    try {
      const base = (await git.run(root, ['merge-base', 'HEAD', 'MERGE_HEAD'])).stdout.trim();
      const incoming = status.merge.message.match(/^Merge (?:remote-tracking )?branch '([^']+)'/)?.[1] ?? status.merge.head.slice(0, 7);
      const files = [];
      for (const file of paths) {
        const code = status.files.find((one) => one.path === file)?.unmerged ?? '';
        files.push({ path: file, kind: kindOf(code), incomingLog: await this.logOf(root, `${base}..MERGE_HEAD`, file), branchLog: await this.logOf(root, `${base}..HEAD`, file) });
      }
      const result = await this.runner().run({
        kind: 'conflicts',
        cwd: root,
        prompt: prompts.localConflictAnalysisPrompt({
          branch: status.branch,
          incoming,
          message: status.merge.message,
          base,
          files,
          incomingLog: await this.logOf(root, `${base}..MERGE_HEAD`),
          branchLog: await this.logOf(root, `${base}..HEAD`),
          language: this.language(),
        }),
        model: rules.DEPTHS.HEAVY.model,
        allowedTools: rules.DEPTHS.HEAVY.tools,
        disallowedTools: rules.REVIEW_DENIED,
        schema: prompts.CONFLICT_PLAN_SCHEMA,
        timeout: RUN_TIMEOUT,
        register: (handle) => this.handles.set(root, handle),
        onEvent: (event) => this.line(root, describeEvent(event)),
      });
      if (result.cancelled) throw new Error('Cancelled.');
      if (!result.ok) throw new Error((result.stderr || 'The analysis finished without an answer.').slice(0, 500));
      const plan = parsePlan(result.structured ?? result.text, paths);
      return this.set(root, { step: 'PROPOSED', busy: false, plan, head: status.merge.head, branch: status.branch, incoming, error: null });
    } catch (error) {
      this.set(root, { step: 'FAILED', busy: false, error: String(error?.message ?? error).slice(0, 800) });
      throw error;
    } finally {
      this.handles.delete(root);
    }
  }

  /** Carry the read proposal out on the files in conflict, then stage them. Never commits. */
  async resolve(root, { note = '' } = {}) {
    const job = this.jobs.get(root);
    if (!job || job.step !== 'PROPOSED') throw new Error('There is no proposal to carry out. Fix the conflicts again.');
    if (job.busy) throw new Error('Already working on these conflicts.');
    const status = await this.state(root);
    if (status.merge.head !== job.head) throw new Error('This is a different merge from the one analyzed. Analyze again.');
    const paths = status.merge.conflicted;
    this.set(root, { step: 'RESOLVING', busy: true, error: null, lines: [] });
    // What was already changed before Claude starts, so what it changes besides the conflicts can be told from the person's own work.
    const before = fingerprints(root, status.files);
    try {
      if (paths.length) {
        const result = await this.runner().run({
          kind: 'conflicts',
          cwd: root,
          prompt: prompts.conflictResolvePrompt({
            pr: { id: '', title: '', sourceBranch: status.branch || 'HEAD' },
            target: job.incoming,
            files: paths.map((one) => ({ path: one })),
            plan: job.plan,
            note,
            language: this.language(),
          }),
          model: rules.DEPTHS.HEAVY.model,
          allowedTools: rules.FIX_TOOLS,
          disallowedTools: RESOLVE_DENIED,
          schema: prompts.CONFLICT_RESOLVE_SCHEMA,
          timeout: RUN_TIMEOUT,
          register: (handle) => this.handles.set(root, handle),
          onEvent: (event) => this.line(root, describeEvent(event)),
        });
        if (result.cancelled) throw new Error('Cancelled. Files may be half edited: look at them before going on.');
        if (!result.ok) throw new Error((result.stderr || 'The resolution finished without an answer.').slice(0, 500));
        const outcome = result.structured && typeof result.structured === 'object' ? result.structured : {};
        if (outcome.resolved === false) throw new Error(`Not resolved: ${String(outcome.reason || outcome.summary || 'no reason given').slice(0, 600)}`);
        job.summary = String(outcome.summary ?? '').slice(0, 1500);
      }
      // The model's word is not the check: every file that was in conflict is read for a marker.
      const left = paths.filter((file) => git.hasConflictMarkers(path.join(root, file)));
      if (left.length) throw new Error(`Conflict markers are still in ${left.join(', ')}. Nothing was staged.`);
      /*
       * Staged: the files that were in conflict, and whatever else Claude had
       * to touch to make them work (an import, a type) — told apart from the
       * person's own changes by what each changed file looked like before it
       * started. Their work stays where they left it.
       */
      const after = await git.status(root);
      const touched = after.ok
        ? after.files.filter((file) => !file.untracked && !paths.includes(file.path) && fingerprint(root, file.path) !== before.get(file.path)).map((file) => file.path)
        : [];
      const staged = await git.stage(root, [...paths, ...touched]);
      if (staged && staged.ok === false) throw new Error(`Could not stage the resolved files: ${String(staged.error ?? '').slice(0, 300)}`);
      return this.set(root, { step: 'RESOLVED', busy: false, resolved: paths, touched, summary: job.summary || job.plan?.summary || '' });
    } catch (error) {
      this.set(root, { step: 'PROPOSED', busy: false, error: String(error?.message ?? error).slice(0, 800) });
      throw error;
    } finally {
      this.handles.delete(root);
    }
  }

  cancel(root) {
    const handle = this.handles.get(root);
    if (!handle) return false;
    handle.cancel();
    return true;
  }

  discard(root) {
    if (this.jobs.get(root)?.busy) throw new Error('Still working on it. Cancel it first.');
    this.jobs.delete(root);
    return true;
  }

  /** The merge commit, with git's own message — only when no file is left in conflict. */
  async conclude(root) {
    const status = await this.state(root);
    if (status.merge.conflicted.length) throw new Error(`${status.merge.conflicted.length} file(s) still have conflicts: ${status.merge.conflicted.join(', ')}.`);
    // Only what belongs to the merge: files fixed by hand and not added yet. Anything else changed stays out of the commit.
    if (status.merge.settled.length) {
      const added = await git.stage(root, status.merge.settled);
      if (added && added.ok === false) throw new Error(String(added.error ?? 'Could not stage the merge.'));
    }
    const done = await git.run(root, ['commit', '--no-edit']);
    if (!done.ok) throw new Error(done.error || done.stderr || 'git commit failed.');
    this.jobs.delete(root);
    return { ok: true };
  }
}

/** A conflict's kind in words, from git's two letters (us, them). */
function kindOf(code) {
  return (
    { DU: 'esta rama lo borró, lo mergeado lo cambió', UD: 'esta rama lo cambió, lo mergeado lo borró', AU: 'lo agregó sólo esta rama', UA: 'lo agregó sólo lo mergeado', DD: 'los dos lo borraron', AA: 'los dos lo agregaron' }[code] ?? ''
  );
}

/** What one file holds now, cheaply: its size and modification time, or 'gone'. */
function fingerprint(root, file) {
  try {
    const stat = fs.statSync(path.join(root, file));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'gone';
  }
}

function fingerprints(root, files) {
  return new Map(files.filter((file) => !file.untracked).map((file) => [file.path, fingerprint(root, file.path)]));
}

module.exports = { LocalConflicts, RESOLVE_DENIED };
