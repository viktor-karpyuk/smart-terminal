'use strict';

/**
 * Code Reviewer: GitHub and Bitbucket, as one interface.
 *
 * Everything that crosses the network lives here and nowhere else — a panel
 * cannot fetch at all, by its CSP — and `fetch` and `sleep` are handed in, so
 * the retry rules can be tested without a network and without waiting.
 *
 * Two things about Bitbucket shape the whole retry policy, both measured rather
 * than read in documentation:
 *
 * - **A 401 does not mean a bad token.** Bitbucket rate-limits with 401 instead
 *   of 429, and around 40% of requests fail at Atlassian's edge before the
 *   credential is even looked at. The bad 401 is recognisable by what it lacks
 *   (`x-asap-succeeded`, `x-credential-type`) and by rendering in ~1 ms. So 401
 *   is always retried — even on a POST, because the edge never got to act on it
 *   — and the backoff starts at 250 ms, because the immediate retry usually works.
 * - **Only `Bearer` works.** Basic `email:token` fails every time against
 *   api.bitbucket.org, and app passwords are gone.
 *
 * And Bitbucket returns JSON with raw control characters inside strings (PR
 * descriptions with literal newlines), which a strict parser rejects — hence
 * `lenientParse`.
 */

class ForgeError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/** JSON with raw control characters inside strings escaped first. */
function lenientParse(text) {
  const raw = String(text ?? '');
  try {
    return JSON.parse(raw);
  } catch {
    let out = '';
    let inString = false;
    let escaped = false;
    for (const ch of raw) {
      if (inString) {
        if (escaped) {
          escaped = false;
          out += ch;
        } else if (ch === '\\') {
          escaped = true;
          out += ch;
        } else if (ch === '"') {
          inString = false;
          out += ch;
        } else if (ch.charCodeAt(0) < 0x20) {
          out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
        } else {
          out += ch;
        }
      } else {
        if (ch === '"') inString = true;
        out += ch;
      }
    }
    return JSON.parse(out);
  }
}

/** 250 ms, 500 ms, then doubling from a second up to twenty, with jitter. */
function retryDelay(attempt, random = Math.random) {
  const base = attempt === 0 ? 250 : attempt === 1 ? 500 : Math.min(20000, 1000 * 2 ** (attempt - 2));
  return base + Math.floor(random() * (base / 2 + 1));
}

/**
 * Whether an answer is worth asking again. A 401 is, from Bitbucket only: its
 * edge answers 401 to requests it never checked and to rate limiting. From
 * GitHub a 401 means the token, and ten tries would only make the error late.
 */
function isRetryable(status, body, idempotent, retry401 = true) {
  if (status === 401) return retry401;
  if (status === 403 && /rate limit/i.test(body)) return true;
  if (!idempotent) return false;
  return status === 429 || status >= 500;
}

function describe(context, status, body, attempts) {
  const where = context ? `[${context}] ` : '';
  const tries = attempts ? ` after ${attempts} attempts` : '';
  const hint =
    status === 401
      ? '\n\nA 401 from Bitbucket does not necessarily mean the token expired: part of the requests fail at ' +
        "Atlassian's edge without validating the credential, and it also answers 401 — not 429 — when it rate-limits. " +
        'If other calls to the same repository work, the token is fine: retry. If ALL of them fail, check the token.'
      : '';
  return `${where}HTTP ${status}${tries} — ${String(body).slice(0, 300)}${hint}`;
}

const BITBUCKET_API = 'https://api.bitbucket.org/2.0';
const GITHUB_API = 'https://api.github.com';

/**
 * A PR's branch, named the way the forges show one from a fork — `owner/repo:branch`
 * — when it lives in another repository. The clone's origin does not have that
 * branch, and a bare name would read the upstream branch of the same name, so the
 * colon is what the reviewer refuses on.
 */
function forkBranch(headRepo, baseRepo, name, missingMeansFork = false) {
  const branch = name ?? '?';
  // GitHub names no head repository once the fork is deleted: still not a branch of this one.
  if (!headRepo && baseRepo && missingMeansFork) return `deleted-fork:${branch}`;
  return headRepo && baseRepo && headRepo !== baseRepo ? `${headRepo}:${branch}` : branch;
}

const trimDate = (value) => (value ? String(value).slice(0, 16).replace('T', ' ') : '');

class Forge {
  /**
   * @param {object} deps
   * @param {typeof fetch} deps.fetch
   * @param {(ms: number) => Promise<void>} [deps.sleep]
   */
  constructor({ fetch, sleep, random } = {}) {
    this.fetch = fetch ?? globalThis.fetch;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = random ?? Math.random;
  }

  /**
   * One request with the retry rules. Returns `{status, body, headers}` for a 2xx
   * (or a 304 when `conditional`), and throws a `ForgeError` otherwise.
   */
  async send(url, { method = 'GET', headers = {}, body, idempotent = method === 'GET', attempts = 10, context = '', conditional = false, backoff, retry401 = true } = {}) {
    let lastStatus = 0;
    let lastBody = '';
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response;
      try {
        response = await this.fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
      } catch (error) {
        // The network itself failed. Safe to retry only when nothing could have happened on the other side.
        lastStatus = 0;
        lastBody = String(error?.message ?? error);
        if (!idempotent || attempt === attempts - 1) break;
        await this.sleep(retryDelay(attempt, this.random));
        continue;
      }
      const text = await response.text();
      if ((response.status >= 200 && response.status < 300) || (conditional && response.status === 304)) {
        return { status: response.status, body: text, headers: response.headers };
      }
      lastStatus = response.status;
      lastBody = text;
      if (!isRetryable(lastStatus, lastBody, idempotent || conditional, retry401)) {
        throw new ForgeError(describe(context, lastStatus, lastBody), lastStatus);
      }
      if (attempt === attempts - 1) break;
      await this.sleep(backoff ? backoff(attempt) : retryDelay(attempt, this.random));
    }
    throw new ForgeError(
      lastStatus ? describe(context, lastStatus, lastBody, attempts) : `${context ? `[${context}] ` : ''}${lastBody}`,
      lastStatus,
    );
  }

  of(repo) {
    if (repo.provider === 'GITHUB') return new GitHub(this, repo);
    if (repo.provider === 'BITBUCKET') return new Bitbucket(this, repo);
    throw new ForgeError(`Unknown provider: ${repo.provider}`);
  }
}

class Bitbucket {
  constructor(forge, repo) {
    this.forge = forge;
    this.repo = repo;
    this.base = `${BITBUCKET_API}/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.slug)}`;
    this.context = `${repo.name} · ${repo.owner}/${repo.slug}`;
  }

  headers(extra = {}) {
    const headers = { Accept: 'application/json', ...extra };
    if (this.repo.token) headers.Authorization = `Bearer ${this.repo.token}`;
    return headers;
  }

  async json(url, options = {}) {
    const response = await this.forge.send(url, { headers: this.headers(options.body ? { 'Content-Type': 'application/json' } : {}), context: this.context, ...options });
    return response.body ? lenientParse(response.body) : {};
  }

  async paged(url, maxPages = 20) {
    const out = [];
    let next = url;
    let page = 0;
    while (next && page < maxPages) {
      const object = await this.json(next);
      out.push(...(Array.isArray(object.values) ? object.values : []));
      next = object.next ?? null;
      page++;
    }
    return out;
  }

  static state(value) {
    const state = String(value ?? '').toUpperCase();
    if (state === 'OPEN' || state === 'MERGED') return state;
    // SUPERSEDED and anything unknown read as declined: it is not open, and "merged" would be a happy ending that did not happen.
    return 'DECLINED';
  }

  toPr(pr) {
    if (pr?.id === undefined || pr?.id === null) return null;
    const participants = Array.isArray(pr.participants) ? pr.participants : [];
    const withState = (state) => participants.filter((p) => (p.state ?? null) === state).map((p) => p.user?.display_name).filter(Boolean);
    return {
      id: Number(pr.id),
      title: pr.title ?? '(untitled)',
      author: pr.author?.display_name ?? '?',
      sourceBranch: forkBranch(pr.source?.repository?.full_name, pr.destination?.repository?.full_name, pr.source?.branch?.name),
      targetBranch: pr.destination?.branch?.name ?? '?',
      headSha: pr.source?.commit?.hash ?? '',
      commentCount: Number(pr.comment_count ?? 0),
      updatedOn: trimDate(pr.updated_on),
      createdOn: trimDate(pr.created_on),
      state: Bitbucket.state(pr.state),
      url: pr.links?.html?.href ?? '',
      // Bitbucket has no draft flag; the skip rules look at the title instead.
      isDraft: false,
      approvedBy: withState('approved'),
      changesRequestedBy: withState('changes_requested'),
      participantsIdle: withState(null),
      description: pr.description ?? '',
    };
  }

  /**
   * Open PRs, conditionally. The ETag is only worth sending when the answer fits
   * on one page: with more pages a 304 on the first says nothing about the rest.
   */
  async listOpen({ etag } = {}) {
    const url = `${this.base}/pullrequests?state=OPEN&pagelen=50`;
    const headers = this.headers(etag ? { 'If-None-Match': etag } : {});
    const response = await this.forge.send(url, { headers, context: this.context, conditional: true });
    if (response.status === 304) return { prs: [], etag, notModified: true };
    const object = lenientParse(response.body);
    if (object.next) return { prs: (await this.paged(url)).map((pr) => this.toPr(pr)).filter(Boolean), etag: null, notModified: false };
    return {
      prs: (object.values ?? []).map((pr) => this.toPr(pr)).filter(Boolean),
      etag: response.headers?.get?.('etag') ?? null,
      notModified: false,
    };
  }

  async search(states, maxPages = 3) {
    if (!states.length) return [];
    const filter = states.map((state) => `state=${state}`).join('&');
    return (await this.paged(`${this.base}/pullrequests?${filter}&pagelen=50`, maxPages)).map((pr) => this.toPr(pr)).filter(Boolean);
  }

  /** Only this call returns `participants[].state` — approvals live here. */
  async get(prId) {
    return this.toPr(await this.json(`${this.base}/pullrequests/${prId}`));
  }

  async comments(prId) {
    const values = await this.paged(`${this.base}/pullrequests/${prId}/comments?pagelen=100`);
    return values.map((comment) => ({
      commentId: String(comment.id ?? ''),
      author: comment.user?.display_name ?? '?',
      body: comment.content?.raw ?? '',
      inlinePath: comment.inline?.path ?? null,
      inlineLine: comment.inline ? (comment.inline.to ?? comment.inline.from ?? null) : null,
      deleted: comment.deleted === true,
      createdOn: String(comment.created_on ?? ''),
      parentId: comment.parent?.id !== undefined && comment.parent?.id !== null ? String(comment.parent.id) : null,
    }));
  }

  posted(object, prId) {
    const id = String(object.id ?? '');
    return { id, url: `https://bitbucket.org/${this.repo.owner}/${this.repo.slug}/pull-requests/${prId}#comment-${id}` };
  }

  async comment(prId, body) {
    return this.posted(await this.json(`${this.base}/pullrequests/${prId}/comments`, { method: 'POST', body: { content: { raw: body } }, idempotent: false }), prId);
  }

  async reply(prId, parentId, body) {
    const payload = { content: { raw: body }, parent: { id: Number(parentId) || 0 } };
    return this.posted(await this.json(`${this.base}/pullrequests/${prId}/comments`, { method: 'POST', body: payload, idempotent: false }), prId);
  }

  /** A null line has no anchor: it goes as a general comment that names the file. */
  async inline(prId, body, path, line) {
    if (line === null || line === undefined) return this.comment(prId, `\`${path}\`\n\n${body}`);
    const payload = { content: { raw: body }, inline: { path, to: Number(line) } };
    return this.posted(await this.json(`${this.base}/pullrequests/${prId}/comments`, { method: 'POST', body: payload, idempotent: false }), prId);
  }

  /** A PR's commits as the provider keeps them — there even after its branch was merged and deleted. */
  async commits(prId) {
    const values = await this.paged(`${this.base}/pullrequests/${prId}/commits?pagelen=100`, 5);
    return values.map((commit) => ({
      sha: String(commit.hash ?? ''),
      author: commit.author?.user?.display_name ?? String(commit.author?.raw ?? '?').replace(/\s*<.*>$/, ''),
      date: String(commit.date ?? '').slice(0, 10),
      subject: String(commit.message ?? '').split('\n')[0],
      body: String(commit.message ?? '').split('\n').slice(1).join('\n').trim(),
    }));
  }

  async approve(prId) {
    await this.json(`${this.base}/pullrequests/${prId}/approve`, { method: 'POST', idempotent: false });
  }

  async unapprove(prId) {
    await this.json(`${this.base}/pullrequests/${prId}/approve`, { method: 'DELETE', idempotent: false });
  }

  async requestChanges(prId) {
    await this.json(`${this.base}/pullrequests/${prId}/request-changes`, { method: 'POST', idempotent: false });
  }

  async undoRequestChanges(prId) {
    await this.json(`${this.base}/pullrequests/${prId}/request-changes`, { method: 'DELETE', idempotent: false });
  }

  async decline(prId, reason) {
    if (reason && reason.trim()) await this.comment(prId, reason);
    await this.json(`${this.base}/pullrequests/${prId}/decline`, { method: 'POST', idempotent: false });
  }

  async merge(prId, { message, closeSourceBranch, strategy }) {
    const merge_strategy = { MERGE_COMMIT: 'merge_commit', SQUASH: 'squash', FAST_FORWARD: 'fast_forward' }[strategy] ?? 'merge_commit';
    const object = await this.json(`${this.base}/pullrequests/${prId}/merge`, {
      method: 'POST',
      body: { message, close_source_branch: Boolean(closeSourceBranch), merge_strategy },
      idempotent: false,
    });
    return object.links?.html?.href ?? object.merge_commit?.hash ?? '';
  }
}

class GitHub {
  constructor(forge, repo) {
    this.forge = forge;
    this.repo = repo;
    this.base = `${GITHUB_API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.slug)}`;
    this.context = `${repo.name} · ${repo.owner}/${repo.slug}`;
  }

  headers(extra = {}) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
    if (this.repo.token) headers.Authorization = `Bearer ${this.repo.token}`;
    return headers;
  }

  async json(url, options = {}) {
    const response = await this.forge.send(url, { headers: this.headers(options.body ? { 'Content-Type': 'application/json' } : {}), context: this.context, retry401: false, ...options });
    return response.body ? lenientParse(response.body) : {};
  }

  /** GitHub pages by the Link header, and backs off from a second. */
  async paged(url, maxPages = 20) {
    const out = [];
    let next = url;
    let page = 0;
    while (next && page < maxPages) {
      const response = await this.forge.send(next, {
        headers: this.headers(),
        context: this.context,
        attempts: 7,
        retry401: false,
        backoff: (attempt) => Math.min(20000, 1000 * 2 ** attempt) + Math.floor(this.forge.random() * 400),
      });
      const value = lenientParse(response.body);
      if (Array.isArray(value)) out.push(...value);
      next = nextLink(response.headers?.get?.('link'));
      page++;
    }
    return out;
  }

  toPr(pr) {
    if (pr?.number === undefined || pr?.number === null) return null;
    const state = pr.merged_at || pr.merged ? 'MERGED' : pr.state === 'closed' ? 'DECLINED' : 'OPEN';
    return {
      id: Number(pr.number),
      title: pr.title ?? '(untitled)',
      author: pr.user?.login ?? '?',
      sourceBranch: forkBranch(pr.head?.repo?.full_name, pr.base?.repo?.full_name, pr.head?.ref, Boolean(pr.head)),
      targetBranch: pr.base?.ref ?? '?',
      headSha: pr.head?.sha ?? '',
      commentCount: Number(pr.comments ?? 0),
      updatedOn: trimDate(pr.updated_at),
      createdOn: trimDate(pr.created_at),
      state,
      url: pr.html_url ?? '',
      isDraft: pr.draft === true,
      approvedBy: [],
      changesRequestedBy: [],
      participantsIdle: [],
      description: pr.body ?? '',
    };
  }

  async listOpen() {
    return { prs: (await this.paged(`${this.base}/pulls?state=open&per_page=50`)).map((pr) => this.toPr(pr)).filter(Boolean), etag: null, notModified: false };
  }

  async search(states, maxPages = 3) {
    if (!states.length) return [];
    const api = states.length === 1 && states[0] === 'OPEN' ? 'open' : states.includes('OPEN') ? 'all' : 'closed';
    const found = (await this.paged(`${this.base}/pulls?state=${api}&per_page=50&sort=updated&direction=desc`, maxPages)).map((pr) => this.toPr(pr)).filter(Boolean);
    return found.filter((pr) => states.includes(pr.state));
  }

  /**
   * One PR with its stances. The original app never read these for GitHub, so
   * a per-PR refresh reported every GitHub PR as open with nobody approving; the
   * reviews endpoint says who stands where, latest review per person winning.
   */
  async get(prId) {
    const pr = this.toPr(await this.json(`${this.base}/pulls/${prId}`));
    if (!pr) return null;
    try {
      const reviews = await this.paged(`${this.base}/pulls/${prId}/reviews?per_page=100`, 5);
      const latest = new Map();
      for (const review of reviews) {
        const login = review.user?.login;
        if (!login || review.state === 'COMMENTED' || review.state === 'PENDING') continue;
        latest.set(login, review.state);
      }
      pr.approvedBy = [...latest].filter(([, state]) => state === 'APPROVED').map(([login]) => login);
      pr.changesRequestedBy = [...latest].filter(([, state]) => state === 'CHANGES_REQUESTED').map(([login]) => login);
    } catch {
      // Stances are a nicety on top of the PR; the PR itself was read. Unknown is
      // not "nobody": the stored stances stay as they were.
      pr.stancesUnknown = true;
    }
    return pr;
  }

  /** General and inline comments, merged by time. Ids are prefixed so the two kinds never collide. */
  async comments(prId) {
    const general = (await this.paged(`${this.base}/issues/${prId}/comments?per_page=100`)).map((comment) => ({
      commentId: `ic-${comment.id}`,
      author: comment.user?.login ?? '?',
      body: comment.body ?? '',
      inlinePath: null,
      inlineLine: null,
      deleted: false,
      createdOn: String(comment.created_at ?? ''),
      parentId: null,
    }));
    const inline = (await this.paged(`${this.base}/pulls/${prId}/comments?per_page=100`)).map((comment) => ({
      commentId: `rc-${comment.id}`,
      author: comment.user?.login ?? '?',
      body: comment.body ?? '',
      inlinePath: comment.path ?? null,
      inlineLine: comment.line ?? comment.original_line ?? null,
      deleted: false,
      createdOn: String(comment.created_at ?? ''),
      parentId: comment.in_reply_to_id ? `rc-${comment.in_reply_to_id}` : null,
    }));
    return [...general, ...inline].sort((a, b) => a.createdOn.localeCompare(b.createdOn));
  }

  /** Oldest first on GitHub; newest first everywhere else in the app, so it is turned round. */
  async commits(prId) {
    const values = await this.paged(`${this.base}/pulls/${prId}/commits?per_page=100`, 5);
    return values
      .map((commit) => ({
        sha: String(commit.sha ?? ''),
        author: commit.commit?.author?.name ?? commit.author?.login ?? '?',
        date: String(commit.commit?.author?.date ?? '').slice(0, 10),
        subject: String(commit.commit?.message ?? '').split('\n')[0],
        body: String(commit.commit?.message ?? '').split('\n').slice(1).join('\n').trim(),
      }))
      .reverse();
  }

  async comment(prId, body) {
    const object = await this.json(`${this.base}/issues/${prId}/comments`, { method: 'POST', body: { body }, idempotent: false });
    return { id: `ic-${object.id}`, url: object.html_url ?? '' };
  }

  /**
   * A reply hangs from a review comment. A general comment has no thread on
   * GitHub, so answering one is a new general comment quoting it.
   */
  async reply(prId, parentId, body) {
    const id = String(parentId);
    if (id.startsWith('rc-')) {
      const object = await this.json(`${this.base}/pulls/${prId}/comments/${id.slice(3)}/replies`, { method: 'POST', body: { body }, idempotent: false });
      return { id: `rc-${object.id}`, url: object.html_url ?? '' };
    }
    return this.comment(prId, body);
  }

  async inline(prId, body, path, line, headSha) {
    if (line === null || line === undefined) return this.comment(prId, `\`${path}\`\n\n${body}`);
    const object = await this.json(`${this.base}/pulls/${prId}/comments`, {
      method: 'POST',
      body: { body, commit_id: headSha, path, side: 'RIGHT', line: Number(line) },
      idempotent: false,
    });
    return { id: `rc-${object.id}`, url: object.html_url ?? '' };
  }

  async review(prId, event, body) {
    await this.json(`${this.base}/pulls/${prId}/reviews`, { method: 'POST', body: body ? { event, body } : { event }, idempotent: false });
  }

  approve(prId) {
    return this.review(prId, 'APPROVE');
  }

  /**
   * GitHub withdraws a review by dismissing it: the token's own latest review in
   * that state. A comment review would not replace it — GitHub goes on counting
   * the approval — so when dismissing is not allowed this says so and fails.
   */
  async withdraw(prId, state) {
    const me = (await this.json(`${GITHUB_API}/user`)).login;
    const reviews = await this.paged(`${this.base}/pulls/${prId}/reviews?per_page=100`, 5);
    const ours = reviews.filter((review) => review.user?.login === me && review.state === state).pop();
    if (!ours) throw new ForgeError(`There is no ${state === 'APPROVED' ? 'approval' : 'change request'} of yours on PR #${prId} to withdraw.`);
    try {
      await this.json(`${this.base}/pulls/${prId}/reviews/${ours.id}/dismissals`, { method: 'PUT', body: { message: 'Withdrawn.' }, idempotent: true });
    } catch (error) {
      throw new ForgeError(`GitHub did not let this token dismiss the review (it needs write access to the repository): ${error.message}`, error.status);
    }
  }

  unapprove(prId) {
    return this.withdraw(prId, 'APPROVED');
  }

  requestChanges(prId) {
    return this.review(prId, 'REQUEST_CHANGES', 'Hay cambios pedidos en los comentarios.');
  }

  undoRequestChanges(prId) {
    return this.withdraw(prId, 'CHANGES_REQUESTED');
  }

  async decline(prId, reason) {
    if (reason && reason.trim()) await this.comment(prId, reason);
    await this.json(`${this.base}/pulls/${prId}`, { method: 'PATCH', body: { state: 'closed' }, idempotent: false });
  }

  async merge(prId, { message, strategy }) {
    const merge_method = { MERGE_COMMIT: 'merge', SQUASH: 'squash', FAST_FORWARD: 'rebase' }[strategy] ?? 'merge';
    const [title, ...rest] = String(message ?? '').split('\n');
    const object = await this.json(`${this.base}/pulls/${prId}/merge`, {
      method: 'PUT',
      body: { commit_title: title, commit_message: rest.join('\n').trim(), merge_method },
      idempotent: false,
    });
    return object.sha ?? '';
  }
}

function nextLink(header) {
  if (!header) return null;
  for (const part of String(header).split(',')) {
    if (part.includes('rel="next"')) {
      const match = /<([^>]+)>/.exec(part);
      if (match) return match[1];
    }
  }
  return null;
}

/** `git@github.com:owner/repo.git`, `https://bitbucket.org/owner/repo` → provider, owner, slug. */
function parseRemote(url) {
  const text = String(url ?? '').trim();
  const match = /(github\.com|bitbucket\.org)[:/]+([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(text);
  if (!match) return null;
  return { provider: match[1] === 'github.com' ? 'GITHUB' : 'BITBUCKET', owner: match[2], slug: match[3] };
}

module.exports = { Forge, ForgeError, lenientParse, retryDelay, isRetryable, nextLink, parseRemote, forkBranch };
