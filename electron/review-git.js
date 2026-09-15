'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { parseNumstat, parseLog } = require('./review-rules');

/**
 * Code Reviewer: the git a reviewer needs, which is not the git a Files tab needs.
 *
 * `electron/git.js` is about a working tree someone is editing. This is about
 * ranges between remote branches, a merge base, the commits a PR brings, and the
 * workshop — a `git clone --local` beside the person's clone where fixes are
 * written, so nothing a model writes ever lands in anyone's working copy.
 *
 * Every call is argv, never a shell string, and git is told it has no terminal:
 * a credential prompt with nobody to answer it would hang a review forever. SSH
 * gets BatchMode for the same reason, unless the repository set its own command.
 */

const TIMEOUT = 120000;
const LOG_FORMAT = '%H%x1f%an%x1f%ad%x1f%s%x1f%b%x1e';

class ReviewGit {
  constructor({ resolvePath } = {}) {
    this.resolvePath = resolvePath ?? (async () => process.env.PATH ?? '');
  }

  async run(dir, args, { timeout = TIMEOUT } = {}) {
    const env = { ...process.env, PATH: await this.resolvePath(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' };
    if (!process.env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new';
    return new Promise((resolve) => {
      execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd: dir, env, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`.trim();
        resolve({ ok: !error, stdout: String(stdout ?? ''), output, code: error?.code ?? 0 });
      });
    });
  }

  isRepo(dir) {
    try {
      return Boolean(dir) && fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, '.git'));
    } catch {
      return false;
    }
  }

  fetch(dir, ...branches) {
    return this.run(dir, ['fetch', 'origin', ...branches.filter(Boolean)]);
  }

  async remoteUrl(dir) {
    const res = await this.run(dir, ['remote', 'get-url', 'origin']);
    return res.ok ? res.stdout.trim() : null;
  }

  async isAncestor(dir, ancestor, descendant) {
    if (!ancestor || !descendant) return false;
    return (await this.run(dir, ['merge-base', '--is-ancestor', ancestor, descendant])).ok;
  }

  async numstat(dir, range) {
    const res = await this.run(dir, ['diff', '--numstat', range]);
    return res.ok ? parseNumstat(res.stdout) : [];
  }

  async diffFile(dir, range, file) {
    return (await this.run(dir, ['diff', '--unified=5', range, '--', file])).stdout;
  }

  async logRange(dir, range) {
    const res = await this.run(dir, ['log', '--date=short', `--format=${LOG_FORMAT}`, range]);
    return res.ok ? parseLog(res.stdout) : [];
  }

  /** The commits a PR brings. */
  commits(dir, target, source) {
    return this.logRange(dir, `origin/${target}..origin/${source}`);
  }

  /** Commits in the clone that origin does not have yet: what the push button would send. */
  async localAhead(dir, branch) {
    if (!(await this.run(dir, ['rev-parse', '--verify', `refs/heads/${branch}`])).ok) return [];
    return this.logRange(dir, `origin/${branch}..${branch}`);
  }

  async commitFiles(dir, sha) {
    const res = await this.run(dir, ['show', '--numstat', '--format=', sha]);
    return res.ok ? parseNumstat(res.stdout) : [];
  }

  async commitDiff(dir, sha, file) {
    return (await this.run(dir, ['show', '--unified=5', '--format=', sha, '--', file])).stdout;
  }

  async currentBranch(dir) {
    const res = await this.run(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const name = res.ok ? res.stdout.trim() : '';
    return name && name !== 'HEAD' ? name : null;
  }

  async head(dir) {
    const res = await this.run(dir, ['rev-parse', 'HEAD']);
    return res.ok ? res.stdout.trim() : null;
  }

  async branchHead(dir, branch) {
    const res = await this.run(dir, ['rev-parse', `refs/heads/${branch}`]);
    return res.ok ? res.stdout.trim() : null;
  }

  async revParse(dir, ref) {
    const res = await this.run(dir, ['rev-parse', '--verify', ref]);
    return res.ok ? res.stdout.trim() : null;
  }

  async isDirty(dir) {
    return Boolean((await this.run(dir, ['status', '--porcelain'])).stdout.trim());
  }

  cloneLocal(origin, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    return this.run(path.dirname(dest), ['clone', '--local', origin, dest]);
  }

  /** Never `--force`: if the remote moved, git refuses, and that is the right answer. */
  pushBranch(dir, branch) {
    return this.run(dir, ['push', 'origin', branch]);
  }

  pushToLocal(workshop, dest, branch) {
    return this.run(workshop, ['push', dest, `${branch}:${branch}`]);
  }

  async commitAll(dir, message) {
    await this.run(dir, ['add', '-A']);
    const res = await this.run(dir, ['commit', '-m', message]);
    if (!res.ok) return null;
    return this.head(dir);
  }

  /**
   * The workshop for a PR's fixes, on the PR's branch, at the PR's tip.
   *
   * The tip is fetched from the person's clone as `pr-head/<branch>` rather than
   * trusted from the workshop's own origin, because that origin *is* the clone,
   * and the clone's local branch may be behind the remote. If the PR moved and
   * the workshop has nothing of its own, it follows; if it has fixes not handed
   * back yet, those are kept and the fix is written on top of them.
   */
  async prepareWorkshop({ origin, dir, branch, hasPendingReturn, log = () => {} }) {
    await this.fetch(origin, branch);
    if (!this.isRepo(dir)) {
      log('Cloning into the workshop…');
      const cloned = await this.cloneLocal(origin, dir);
      if (!cloned.ok) throw new Error(`Could not clone into the workshop: ${cloned.output.slice(0, 300)}`);
    }
    const tipRef = `refs/remotes/pr-head/${branch}`;
    const fetched = (await this.run(dir, ['fetch', 'origin', `+refs/remotes/origin/${branch}:${tipRef}`])).ok;
    let base = fetched && (await this.revParse(dir, tipRef)) ? tipRef : branch;
    if (base === branch && !(await this.revParse(dir, branch)) && !(await this.revParse(dir, `origin/${branch}`))) {
      // The clone only knows the branch as origin/<branch>; make it a branch there so the workshop can see it.
      if ((await this.revParse(origin, `origin/${branch}`)) && (await this.run(origin, ['branch', branch, `origin/${branch}`])).ok) {
        await this.run(dir, ['fetch', 'origin', '--quiet']);
        base = `origin/${branch}`;
      }
    }
    const exists = Boolean(await this.revParse(dir, `refs/heads/${branch}`));
    if (!exists) {
      const res = await this.run(dir, ['checkout', '-b', branch, base]);
      const now = await this.currentBranch(dir);
      if (now !== branch) throw new Error(`The workshop could not switch to "${branch}" (it is on "${now ?? '?'}"). git said: ${res.output.slice(0, 300)}`);
      return dir;
    }
    if ((await this.currentBranch(dir)) !== branch) await this.run(dir, ['checkout', branch]);
    if (!fetched) return dir;
    const here = await this.branchHead(dir, branch);
    const tip = await this.revParse(dir, tipRef);
    if (!tip || tip === here) return dir;
    if (await hasPendingReturn()) {
      log('The PR moved, but the workshop has fixes not handed back yet: fixing on top of those. Hand them back and discard the workshop to start from the new tip.');
    } else if (await this.isDirty(dir)) {
      log('The workshop has uncommitted changes; not moving it.');
    } else {
      log(`The PR moved: putting the workshop at ${tip.slice(0, 7)}.`);
      await this.run(dir, ['checkout', '-B', branch, tipRef]);
    }
    return dir;
  }
}

module.exports = { ReviewGit, LOG_FORMAT };
