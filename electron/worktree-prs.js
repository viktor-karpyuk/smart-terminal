'use strict';
/**
 * The pull requests a worktree's branch opened, read through `gh`, so a worktree
 * row can say whether the work it holds already left through a PR — merged, open
 * or closed — instead of counting commits that a squash merge made unrecognizable.
 *
 * A branch may have several PRs, against develop or anything else; all of them are
 * kept. A repository that is not on GitHub (Bitbucket) is asked through the Code
 * Reviewer's forge, with the token the person gave that repository there. Answers are remembered per branch and head for a while and refreshed in
 * the background, so the inventory never waits for the network.
 */
const { execFile } = require('node:child_process');

const MINUTE = 60 * 1000;
const FIELDS = 'number,title,state,baseRefName,url,mergedAt,isDraft,updatedAt,reviewDecision';

function run(cmd, args, cwd, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: error?.code ?? 0 });
    });
  });
}

/** The one-line verdict over a branch's PRs: what can be done with the worktree. */
function summarize(prs) {
  const merged = prs.filter((p) => p.state === 'MERGED').length;
  const open = prs.filter((p) => p.state === 'OPEN').length;
  const closed = prs.length - merged - open;
  const allMerged = prs.length > 0 && merged === prs.length;
  /** Every PR either landed or is waiting; the work left the worktree. Closed-without-merge counts against it. */
  const closable = prs.length > 0 && closed === 0;
  return { merged, open, closed, allMerged, closable };
}

class WorktreePulls {
  /**
   * @param {object} deps
   * @param {(key:string)=>any} deps.get       read a remembered answer
   * @param {(key:string,value:any)=>void} deps.set
   * @param {() => number} [deps.now]
   * @param {number} [deps.ttl]                 how long an answer is trusted
   * @param {(cmd:string,args:string[],cwd:string,timeout:number)=>Promise<any>} [deps.exec]
   * @param {(event:string, payload:any)=>void} [deps.emit]
   * @param {(root:string)=>Promise<null|{forBranch:(branch:string)=>Promise<any[]>}>} [deps.forgeFor] a forge adapter for a repository that gh cannot read
   */
  constructor({ get, set, now = () => Date.now(), ttl = 3 * MINUTE, exec = run, emit = () => {}, forgeFor = async () => null }) {
    this.forgeFor = forgeFor;
    this.get = get;
    this.set = set;
    this.now = now;
    this.ttl = ttl;
    this.exec = exec;
    this.emit = emit;
    this.inflight = new Map();
    this.available = null;
  }

  key(root, branch) {
    return `prs:${root}:${branch}`;
  }

  /** What is known now, without asking anyone: the remembered answer, or null. */
  known(root, branch) {
    if (!branch) return null;
    const kept = this.get(this.key(root, branch));
    if (!kept || !Array.isArray(kept.prs)) return null;
    return { ...kept, ...summarize(kept.prs), stale: this.now() - (kept.checkedAt ?? 0) > this.ttl };
  }

  /**
   * Refresh the stale ones in the background, a few at a time. Resolves when done;
   * each answer is emitted as it lands so a panel can repaint that row.
   */
  async refresh(rows, { force = false, concurrency = 3 } = {}) {
    const todo = rows.filter((row) => row.branch && !row.main && !row.base && (force || !this.known(row.root, row.branch) || this.known(row.root, row.branch).stale));
    if (!todo.length) return [];
    if (this.available === null) this.available = (await this.exec('gh', ['--version'], process.cwd(), 10_000)).ok;
    const out = [];
    let index = 0;
    const worker = async () => {
      while (index < todo.length) {
        const row = todo[index++];
        out.push(await this.lookup(row.root, row.branch, row.head, row.upstream ? String(row.upstream).split('/')[0] : null));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
    return out;
  }

  async lookup(root, branch, head = null, remote = null) {
    const key = this.key(root, branch);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const job = (async () => {
      const done = this.available ? await this.exec('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '30', '--json', FIELDS], root, 30_000) : { ok: false, stdout: '', stderr: 'gh is not installed' };
      let prs = null;
      let error = null;
      // Not a GitHub repository, or gh is missing: the Code Reviewer may know this repository and hold its token.
      if (!done.ok) {
        try {
          const forge = await this.forgeFor(root, remote);
          if (forge) {
            prs = (await forge.forBranch(branch)).map((pr) => ({
              number: pr.id,
              title: pr.title,
              state: pr.state === 'MERGED' ? 'MERGED' : pr.state === 'OPEN' ? 'OPEN' : 'CLOSED',
              base: pr.targetBranch,
              url: pr.url,
              mergedAt: pr.state === 'MERGED' ? pr.updatedOn || null : null,
              draft: Boolean(pr.isDraft),
              updatedAt: pr.updatedOn || null,
              review: pr.changesRequestedBy?.length ? 'CHANGES_REQUESTED' : pr.approvedBy?.length ? 'APPROVED' : null,
            }));
          }
        } catch (e) {
          error = String(e?.message ?? e);
        }
      }
      if (prs) {
        /* answered by the forge */
      } else if (done.ok) {
        try {
          prs = JSON.parse(done.stdout || '[]').map((p) => ({
            number: p.number,
            title: p.title,
            state: p.state,
            base: p.baseRefName,
            url: p.url,
            mergedAt: p.mergedAt ?? null,
            draft: Boolean(p.isDraft),
            updatedAt: p.updatedAt ?? null,
            review: p.reviewDecision || null,
          }));
        } catch {
          error = 'gh answered something that is not JSON';
        }
      } else {
        error = done.stderr.trim().split('\n').pop() || 'gh failed';
      }
      const previous = this.get(key);
      const record = prs ? { prs, head, checkedAt: this.now(), error: null } : { ...(previous ?? { prs: [], head }), checkedAt: this.now(), error };
      this.set(key, record);
      const answer = { root, branch, ...record, ...summarize(record.prs) };
      this.emit('prs', answer);
      return answer;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }
}

module.exports = { WorktreePulls, summarize, FIELDS };
