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

/**
 * A commit as the panel names it: hex and nothing else. It reaches `git show`
 * where an option would be read as one, and `--output=<file>` writes.
 */
function commitId(sha) {
  const value = String(sha ?? '');
  if (!/^[0-9a-f]{4,64}$/i.test(value)) throw new Error(`Not a commit: ${value.slice(0, 60)}`);
  return value;
}

/**
 * A push of a branch to the branch of the same name, spelled out in full. A bare
 * name is a refspec, and a branch called `+main` — a legal name — would be a
 * forced push of `main`.
 */
function headRefspec(branch) {
  const name = String(branch ?? '');
  if (!name || name.startsWith('-') || name.includes(':')) throw new Error(`Not a branch that can be pushed: ${name.slice(0, 60)}`);
  return `refs/heads/${name}:refs/heads/${name}`;
}

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

  /**
   * The named branches from origin. A name git would read as something else is
   * not passed at all: `a:b` is a refspec that writes `b` (and is how a fork's
   * branch is named), `+a` forces, `-a` is an option.
   */
  async fetch(dir, ...branches) {
    const names = branches.filter(Boolean);
    const odd = names.find((name) => /^[-+]|:/.test(name));
    if (odd) {
      const output = odd.includes(':')
        ? `${odd} is a branch of a fork: origin does not have it, and reviewing a fork's pull request is not supported.`
        : `${odd} is not a branch name git can be given safely.`;
      return { ok: false, stdout: '', output, code: 1 };
    }
    return this.run(dir, ['fetch', 'origin', ...names]);
  }

  async remoteUrl(dir) {
    const res = await this.run(dir, ['remote', 'get-url', 'origin']);
    return res.ok ? res.stdout.trim() : null;
  }

  async isAncestor(dir, ancestor, descendant) {
    if (!ancestor || !descendant) return false;
    return (await this.run(dir, ['merge-base', '--is-ancestor', ancestor, descendant])).ok;
  }

  /**
   * Whether this branch would land on its target, and what stands in the way.
   *
   * `merge-tree --write-tree` performs the merge in the object database and
   * writes nothing to the working tree, so this can be asked of a clone that
   * somebody is using without disturbing them — no checkout, no index, no
   * stash. It answers with the tree when the merge is clean and a non-zero code
   * plus the conflicted paths when it is not.
   *
   * Asked of the fetched refs rather than of the provider, on purpose. GitHub
   * answers `mergeable: null` while it works the same thing out in the
   * background, and Bitbucket does not answer at all — while the clone has both
   * sides of the merge already, because a review has just fetched them.
   *
   * `null` for "could not tell", which is a different answer from "no
   * conflicts" and must never be shown as one: a git too old for
   * `--write-tree` (it arrived in 2.38) or a ref that is not there says nothing
   * rather than says clean.
   */
  async conflicts(dir, target, source) {
    if (!target || !source) return null;
    const res = await this.run(dir, ['merge-tree', '--write-tree', '--name-only', '--no-messages', target, source]);
    if (res.ok) return [];

    /*
     * The exit code alone cannot be trusted here, and finding that out was the
     * point of testing it: a branch that does not exist exits 1 as well, with
     * `merge-tree: no-such-branch - not something we can merge` on stdout — so
     * reading the code and parsing what follows reports a missing ref as a
     * clean merge, which is the one answer this must never invent.
     *
     * What separates them is the first line. A merge that ran writes the tree
     * it produced, forty hex characters, and lists the conflicted paths under
     * it until a blank line. A merge that never ran writes a sentence.
     */
    const lines = res.stdout.split('\n');
    if (!/^[0-9a-f]{40}$/.test(lines[0]?.trim() ?? '')) return null;

    const paths = [];
    for (const line of lines.slice(1)) {
      if (!line.trim()) break;
      paths.push(line.trim());
    }
    return paths;
  }

  async numstat(dir, range) {
    const res = await this.run(dir, ['diff', '--numstat', range]);
    return res.ok ? parseNumstat(res.stdout) : [];
  }

  /** What happened to each file in a range: A added, M modified, D deleted, R renamed (to its new path). */
  async nameStatus(dir, range) {
    const res = await this.run(dir, ['diff', '--name-status', '-M', range]);
    const out = {};
    if (!res.ok) return out;
    for (const line of res.stdout.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const letter = parts[0][0];
      out[parts[parts.length - 1]] = { status: letter, from: letter === 'R' || letter === 'C' ? parts[1] : null };
    }
    return out;
  }

  /** A file as it is at a ref, as lines. Null when the file is not there. */
  async fileAt(dir, ref, file) {
    const res = await this.run(dir, ['show', `${ref}:${file}`]);
    if (!res.ok) return null;
    const lines = res.stdout.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
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
    const res = await this.run(dir, ['show', '--numstat', '--format=', commitId(sha)]);
    return res.ok ? parseNumstat(res.stdout) : [];
  }

  async commitDiff(dir, sha, file) {
    return (await this.run(dir, ['show', '--unified=5', '--format=', commitId(sha), '--', file])).stdout;
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

  async hasRef(dir, ref) {
    return (await this.run(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok;
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
    return this.run(dir, ['push', 'origin', headRefspec(branch)]);
  }

  pushToLocal(workshop, dest, branch) {
    return this.run(workshop, ['push', dest, headRefspec(branch)]);
  }

  /**
   * Everything in the tree, as one commit. A commit that fails throws with what
   * git said: returning nothing would read as "nothing changed", and the edits
   * left behind would be committed under the next finding.
   */
  async commitAll(dir, message) {
    const added = await this.run(dir, ['add', '-A']);
    if (!added.ok) throw new Error(`git add failed: ${added.output.slice(0, 400)}`);
    const res = await this.run(dir, ['commit', '-m', message]);
    if (!res.ok) throw new Error(`git commit failed: ${res.output.slice(0, 400)}`);
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

module.exports = { ReviewGit, LOG_FORMAT, commitId, headRefspec };
