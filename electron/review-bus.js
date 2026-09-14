'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const rules = require('./review-rules');

/**
 * Code Reviewer: the bus — so the things writing in a repository can see each other.
 *
 * In AI Code Reviewer this let the Constructor's parallel tasks stop colliding:
 * two tasks took the same migration number, or edited the same file on two
 * branches, and nobody found out until the merge. Here the writers are the
 * reviewer's fixes — each in its own workshop, several PRs at once — and the
 * person's own Claude sessions in Smart Terminal, working in the same clones.
 * Both get the same seven tools, and each sees the others.
 *
 * **Identity is the app's, never the model's.** A fix is given a token the app
 * made when it started the run; a session is known by the id Smart Terminal put
 * in its environment, and its repository and PR are worked out from where it is
 * standing. Nothing a model writes can make it someone else.
 *
 * **A claim is advisory.** Every branch has its own copy, so nobody can overwrite
 * anybody now; a claim is so two writers do not edit the same file on two
 * branches and meet at the merge, when it is expensive. It never blocks.
 *
 * **Touched files come from real branches.** `who_touched` answers from the
 * diffs of the repository's other open PRs, read from git — not only from what
 * the bus happened to hear — and from what the reviewer's own fixes committed.
 *
 * **Migration numbers are reserved, not guessed.** The floor is the highest
 * number on disk *and* on every other open PR's branch, so a number a colleague
 * already took in a PR that is not merged yet is not handed out again — which is
 * exactly the collision one of these reviews found by hand.
 */

const SCOPES = ['PR', 'REPO', 'ALL'];
const KINDS = ['note', 'warning', 'question', 'answer'];
const MIGRATION = /^V(\d+)__(.+)\.sql$/i;
const IGNORED_DIRS = new Set(['.git', 'target', 'build', 'node_modules', 'out', 'dist', '.gradle', '.idea', '.next']);
const SCAN_LIMIT = 200000;

/** What each tool is, for the MCP server's `tools/list`. The server has its own copy; a test keeps the two in step. */
const TOOL_NAMES = ['peers', 'inbox', 'notify', 'claim', 'who_touched', 'release', 'migration_number'];

const now = () => new Date().toISOString();

/**
 * Message ids that sort in the order they were made. Two messages in the same
 * millisecond are ordinary — a fix posting a warning right after a note — and
 * with random ids the inbox cursor `(at, id)` would hand them back in either order.
 */
let sequence = 0;
const orderedId = () => `${Date.now().toString(36).padStart(10, '0')}-${(sequence++ % 1e9).toString(36).padStart(6, '0')}-${randomUUID().slice(0, 8)}`;

/** How far back a fix reads when it joins: a fix is a new writer each run, and what was said about its PR today is still news to it. */
const FIX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function scope(value) {
  const wanted = String(value ?? '').trim().toUpperCase();
  if (wanted === 'PROJECT') return 'PR';
  return SCOPES.includes(wanted) ? wanted : 'PR';
}

function pathList(value) {
  const list = Array.isArray(value) ? value.map(String) : String(value ?? '').split(',');
  return [...new Set(list.map((item) => item.trim().replace(/^\.\//, '')).filter(Boolean))];
}

/** Every `V<number>__<name>.sql` under a folder, skipping build output and dependencies. */
function scanMigrations(root) {
  const found = [];
  let seen = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > SCAN_LIMIT) return;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const match = MIGRATION.exec(entry.name);
        if (match) found.push({ path: path.join(dir, entry.name), number: Number(match[1]), width: match[1].length });
      }
    }
  };
  if (root) walk(root);
  return found;
}

function migrationLabel(number, width) {
  return `V${String(number).padStart(width, '0')}`;
}

class ReviewBus {
  /**
   * @param {object} deps
   * @param {import('./review-store').ReviewStore} deps.store
   * @param {import('./review-git').ReviewGit} deps.git
   * @param {string} deps.workshopRoot where the fix engine keeps its workshops
   * @param {(event: object) => void} [deps.emit]
   */
  constructor({ store, git, workshopRoot, emit = () => {} }) {
    this.store = store;
    this.git = git;
    this.workshopRoot = workshopRoot;
    this.emit = emit;
    /** The files each open PR's branch changes, by `repo#pr@head`, so a question does not re-run git. */
    this.branchFiles = new Map();
  }

  changed() {
    this.emit({ type: 'bus' });
  }

  // --- members ----------------------------------------------------------------------

  member(token) {
    const row = this.store.get('SELECT * FROM cr_bus_member WHERE token = ?', token);
    return row ? this.memberRow(row) : null;
  }

  memberRow(row) {
    return { token: row.token, kind: row.kind, sessionId: row.session_id, repoId: row.repo_id, prId: row.pr_id === null ? null : Number(row.pr_id), label: row.label, branch: row.branch, workDir: row.work_dir, startedAt: row.started_at, endedAt: row.ended_at };
  }

  /** A fix run joins the bus. Its token is the app's; it is handed to the run's MCP server and to nobody else. */
  openFix({ repoId, prId, label, branch, workDir }) {
    const token = `fix:${randomUUID()}`;
    this.store.run('INSERT INTO cr_bus_member (token, kind, repo_id, pr_id, label, branch, work_dir, started_at) VALUES (?,?,?,?,?,?,?,?)', token, 'fix', repoId, prId, String(label).slice(0, 80), branch ?? null, workDir ?? null, now());
    // Unlike a session, which starts from the moment it joins, a fix reads back a day.
    this.store.run('INSERT INTO cr_bus_read (token, last_at) VALUES (?, ?)', token, `${new Date(Date.now() - FIX_LOOKBACK_MS).toISOString()}|`);
    this.changed();
    return token;
  }

  /** Leaving: the member is marked gone and its claims are released. */
  close(token) {
    this.store.run('UPDATE cr_bus_member SET ended_at = ? WHERE token = ? AND ended_at IS NULL', now(), token);
    this.store.run('DELETE FROM cr_bus_claim WHERE token = ?', token);
    this.changed();
  }

  /** At startup nothing is running yet: whatever was open belonged to a process that is gone. */
  sweep() {
    this.store.run('DELETE FROM cr_bus_claim WHERE token IN (SELECT token FROM cr_bus_member WHERE ended_at IS NULL)');
    return Number(this.store.run('UPDATE cr_bus_member SET ended_at = ? WHERE ended_at IS NULL', now()).changes);
  }

  /**
   * Where a folder is, in the reviewer's terms: which configured repository's
   * clone it is inside, or which PR's workshop. The deepest match wins, so a
   * clone nested inside another folder is still its own repository.
   */
  locate(dir) {
    const folder = path.resolve(String(dir ?? ''));
    if (!dir) return { repoId: null, prId: null };
    const inside = (root) => Boolean(root) && (folder === root || folder.startsWith(`${root}${path.sep}`));
    if (this.workshopRoot && inside(path.resolve(this.workshopRoot))) {
      const name = path.relative(this.workshopRoot, folder).split(path.sep)[0];
      const match = /^(.*)-pr(\d+)$/.exec(name);
      if (match) {
        const repo = this.store.repos().find((candidate) => rules.slug(candidate.name) === match[1]);
        if (repo) return { repoId: repo.id, prId: Number(match[2]) };
      }
    }
    // A workshop imported from AI Code Reviewer lives elsewhere; its fixes know where.
    const fix = this.store.get('SELECT repo_id, pr_id, workspace FROM cr_finding_fix WHERE workspace IS NOT NULL AND (? = workspace OR ? LIKE workspace || \'/%\') ORDER BY length(workspace) DESC LIMIT 1', folder, folder);
    if (fix) return { repoId: fix.repo_id, prId: Number(fix.pr_id) };
    let best = null;
    for (const repo of this.store.repos()) {
      const root = path.resolve(repo.localPath);
      if (inside(root) && (!best || root.length > best.root.length)) best = { root, repoId: repo.id };
    }
    return best ? { repoId: best.repoId, prId: null } : { repoId: null, prId: null };
  }

  /**
   * A Smart Terminal session, as a member. It joins the first time it asks
   * anything, standing wherever it is standing now — a session that moved to
   * another repository is in that one. Sessions that are no longer running are
   * let go on the way, and their claims with them.
   */
  sessionMember(sessionId, roster) {
    const live = new Map((roster ?? []).map((entry) => [entry.id, entry]));
    for (const row of this.store.all("SELECT token, session_id FROM cr_bus_member WHERE kind = 'session' AND ended_at IS NULL")) {
      if (!live.has(row.session_id)) this.close(row.token);
    }
    const entry = live.get(sessionId);
    if (!entry) return null;
    const token = `session:${sessionId}`;
    const where = this.locate(entry.cwd);
    let branch = null;
    const existing = this.store.get('SELECT * FROM cr_bus_member WHERE token = ?', token);
    if (existing) {
      const moved = existing.repo_id !== where.repoId || (existing.pr_id ?? null) !== where.prId;
      if (moved) this.store.run('DELETE FROM cr_bus_claim WHERE token = ?', token);
      this.store.run('UPDATE cr_bus_member SET repo_id = ?, pr_id = ?, label = ?, work_dir = ?, ended_at = NULL WHERE token = ?', where.repoId, where.prId, `${entry.name} (session)`.slice(0, 80), entry.cwd, token);
    } else {
      if (where.prId) branch = this.store.pr(where.repoId, where.prId)?.sourceBranch ?? null;
      this.store.run('INSERT INTO cr_bus_member (token, kind, session_id, repo_id, pr_id, label, branch, work_dir, started_at) VALUES (?,?,?,?,?,?,?,?,?)', token, 'session', sessionId, where.repoId, where.prId, `${entry.name} (session)`.slice(0, 80), branch, entry.cwd, now());
      this.changed();
    }
    return this.member(token);
  }

  liveMembers() {
    return this.store.all('SELECT * FROM cr_bus_member WHERE ended_at IS NULL ORDER BY started_at').map((row) => this.memberRow(row));
  }

  repoName(repoId) {
    return repoId ? this.store.repo(repoId)?.name ?? 'a repository that is no longer configured' : null;
  }

  whereWords(member) {
    if (!member.repoId) return 'outside any repository the reviewer knows';
    return `${this.repoName(member.repoId)}${member.prId ? ` #${member.prId}` : ''}`;
  }

  // --- messages ---------------------------------------------------------------------

  post({ scopeName, from, kind = 'note', subject = null, body }) {
    const id = orderedId();
    const at = now();
    this.store.run(
      'INSERT INTO cr_bus_message (id, scope, repo_id, pr_id, from_token, from_label, kind, subject, body, at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id,
      scope(scopeName),
      from?.repoId ?? null,
      from?.prId ?? null,
      from?.token ?? null,
      from?.label ?? 'the tool',
      KINDS.includes(kind) ? kind : 'note',
      subject ? String(subject).slice(0, 200) : null,
      String(body).trim().slice(0, 4000),
      at,
    );
    this.changed();
    return id;
  }

  /**
   * What reached this member since it last looked: its own messages never; a PR
   * message only to the same PR; a repository message to anyone in that
   * repository. A session that has never read starts from when it joined — it is
   * not handed the backlog of work that finished before it began; a fix starts a
   * day back (see `openFix`).
   */
  inbox(member, { limit = 50 } = {}) {
    const read = this.store.get('SELECT last_at FROM cr_bus_read WHERE token = ?', member.token)?.last_at ?? null;
    const [sinceAt, sinceId] = read ? [read.split('|')[0], read.split('|')[1] ?? ''] : [member.startedAt, ''];
    return this.store
      .all(
        `SELECT * FROM cr_bus_message
          WHERE (at > ? OR (at = ? AND id > ?))
            AND (from_token IS NULL OR from_token <> ?)
            AND (scope = 'ALL'
                 OR (scope = 'REPO' AND repo_id IS NOT NULL AND repo_id = ?)
                 OR (scope = 'PR' AND repo_id IS NOT NULL AND repo_id = ? AND (pr_id IS NULL OR ? IS NULL OR pr_id = ?)))
          ORDER BY at, id LIMIT ?`,
        sinceAt,
        sinceAt,
        sinceId,
        member.token,
        member.repoId,
        member.repoId,
        member.prId,
        member.prId,
        limit,
      )
      .map((row) => ({ id: row.id, scope: row.scope, repoId: row.repo_id, prId: row.pr_id, fromLabel: row.from_label, kind: row.kind, subject: row.subject, body: row.body, at: row.at }));
  }

  markRead(member, message) {
    this.store.run('INSERT INTO cr_bus_read (token, last_at) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET last_at = excluded.last_at', member.token, `${message.at}|${message.id}`);
  }

  // --- claims ------------------------------------------------------------------------

  claims(repoId = null) {
    return this.store.all(`SELECT * FROM cr_bus_claim ${repoId ? 'WHERE repo_id = ?' : ''} ORDER BY at`, ...(repoId ? [repoId] : [])).map((row) => ({ repoId: row.repo_id, path: row.path, token: row.token, label: row.label, reason: row.reason, at: row.at }));
  }

  /** Claims what is free, keeps what is already this member's, and says who holds the rest. */
  claim(member, paths, reason) {
    const taken = [];
    this.store.transaction(() => {
      for (const file of paths) {
        const holder = this.store.get('SELECT * FROM cr_bus_claim WHERE repo_id = ? AND path = ?', member.repoId, file);
        if (!holder) this.store.run('INSERT INTO cr_bus_claim (repo_id, path, token, label, reason, at) VALUES (?,?,?,?,?,?)', member.repoId, file, member.token, member.label, reason ?? null, now());
        else if (holder.token !== member.token) taken.push({ path: file, label: holder.label, reason: holder.reason });
      }
    });
    this.changed();
    return taken;
  }

  release(member, paths) {
    if (!paths.length) this.store.run('DELETE FROM cr_bus_claim WHERE token = ?', member.token);
    else for (const file of paths) this.store.run('DELETE FROM cr_bus_claim WHERE token = ? AND path = ?', member.token, file);
    this.changed();
  }

  // --- what other branches changed ------------------------------------------------------

  /** The files an open PR's branch changes against its target, cached per head commit. */
  async filesOfPr(repo, pr) {
    const key = `${repo.id}#${pr.id}@${pr.headSha}`;
    if (this.branchFiles.has(key)) return this.branchFiles.get(key);
    const result = await this.git.run(repo.localPath, ['diff', '--name-only', `origin/${pr.targetBranch}...origin/${pr.sourceBranch}`]);
    const files = result.ok ? result.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : null;
    if (files) this.branchFiles.set(key, files);
    return files;
  }

  /** After a fix is committed: which files it changed, remembered against its PR's branch. */
  touch({ repoId, prId, branch, label, paths }) {
    for (const file of pathList(paths)) {
      this.store.run(
        'INSERT INTO cr_bus_touch (repo_id, path, pr_id, branch, label, at) VALUES (?,?,?,?,?,?) ON CONFLICT(repo_id, path, pr_id) DO UPDATE SET branch = excluded.branch, label = excluded.label, at = excluded.at',
        repoId,
        file,
        prId,
        branch ?? null,
        label,
        now(),
      );
    }
    this.changed();
  }

  /**
   * Other branches that changed any of these files: the repository's other open
   * PRs, from git, and what the reviewer's fixes committed for other PRs.
   * Returns `[{branch, prId, title, paths[]}]`; `unread` counts the PRs git could
   * not answer for — their branches were never fetched into the clone.
   */
  async whoTouched(member, paths) {
    const repo = this.store.repo(member.repoId);
    if (!repo) return { hits: [], unread: 0 };
    const wanted = new Set(paths);
    const byPr = new Map();
    let unread = 0;
    for (const pr of this.store.prs(repo.id, { states: ['OPEN'] })) {
      if (pr.id === member.prId || !pr.sourceBranch || !pr.targetBranch) continue;
      const files = await this.filesOfPr(repo, pr);
      if (!files) {
        unread++;
        continue;
      }
      const hit = files.filter((file) => wanted.has(file));
      if (hit.length) byPr.set(pr.id, { prId: pr.id, branch: pr.sourceBranch, title: pr.title, author: pr.author, paths: new Set(hit) });
    }
    for (const row of this.store.all(`SELECT * FROM cr_bus_touch WHERE repo_id = ? AND path IN (${paths.map(() => '?').join(',')})`, repo.id, ...paths)) {
      if (Number(row.pr_id) === member.prId) continue;
      const prId = Number(row.pr_id);
      if (!byPr.has(prId)) byPr.set(prId, { prId, branch: row.branch, title: null, author: null, paths: new Set() });
      byPr.get(prId).paths.add(row.path);
    }
    return { hits: [...byPr.values()].map((hit) => ({ ...hit, paths: [...hit.paths].sort() })), unread };
  }

  // --- migration numbers ------------------------------------------------------------------

  /**
   * Hands out `count` consecutive numbers and records them, in one transaction:
   * two writers asking at once would otherwise read the same maximum and leave
   * with the same number, which is the bug this exists to prevent.
   */
  async migrationNumbers(member, count) {
    const repo = this.store.repo(member.repoId);
    if (!repo) return { numbers: [], reason: 'no-repo' };
    const onDisk = scanMigrations(member.workDir && fs.existsSync(member.workDir) ? member.workDir : repo.localPath);
    if (!onDisk.length) return { numbers: [], reason: 'none' };
    let floor = Math.max(...onDisk.map((file) => file.number));
    const width = onDisk.sort((a, b) => a.number - b.number)[onDisk.length - 1].width;
    for (const pr of this.store.prs(repo.id, { states: ['OPEN'] })) {
      if (pr.id === member.prId) continue;
      for (const file of (await this.filesOfPr(repo, pr)) ?? []) {
        const match = MIGRATION.exec(path.basename(file));
        if (match) floor = Math.max(floor, Number(match[1]));
      }
    }
    const scopeKey = `r:${repo.id}`;
    const numbers = this.store.transaction(() => {
      const reserved = this.store.get('SELECT MAX(number) AS n FROM cr_migration_slot WHERE scope = ?', scopeKey)?.n ?? 0;
      const start = Math.max(floor, reserved);
      const out = [];
      for (let i = 1; i <= count; i++) {
        this.store.run('INSERT INTO cr_migration_slot (scope, number, token, repo_id, pr_id, label, created_at) VALUES (?,?,?,?,?,?,?)', scopeKey, start + i, member.token, repo.id, member.prId, member.label, now());
        out.push(start + i);
      }
      return out;
    });
    this.changed();
    return { numbers: numbers.map((number) => migrationLabel(number, width)) };
  }

  reservations(repoId = null) {
    return this.store.all(`SELECT * FROM cr_migration_slot ${repoId ? 'WHERE repo_id = ?' : ''} ORDER BY created_at DESC LIMIT 100`, ...(repoId ? [repoId] : [])).map((row) => ({ repoId: row.repo_id, number: row.number, prId: row.pr_id, label: row.label, at: row.created_at }));
  }

  // --- the tools, in words ---------------------------------------------------------------------

  /**
   * One tool call from a member, answered in text the model reads. Never throws
   * for something the model did wrong; a missing argument is an answer, not an error.
   */
  async call(member, name, args = {}) {
    const str = (key) => (typeof args[key] === 'string' && args[key].trim() ? args[key].trim() : null);
    const needRepo = () => (member.repoId ? null : 'You are not in a repository the Code Reviewer knows, so there is nothing to coordinate here. Work from its clone, or from a fix workshop.');

    if (name === 'peers') {
      const others = this.liveMembers().filter((other) => other.token !== member.token);
      const lines = [`You are ${member.label}, in ${this.whereWords(member)}.`];
      if (!others.length) {
        lines.push('Nobody else is writing right now.');
      } else {
        lines.push('', 'Writing right now, besides you:');
        for (const other of others) {
          const same = other.repoId && other.repoId === member.repoId;
          lines.push(`- ${other.label} — ${this.whereWords(other)}${same ? (other.prId && other.prId === member.prId ? '  (same PR)' : '  (same repository)') : ''}`);
        }
      }
      const held = this.claims(member.repoId).filter((claim) => claim.token !== member.token);
      if (member.repoId && held.length) {
        lines.push('', 'Files others have claimed in this repository — leave them alone or coordinate first:');
        for (const claim of held) lines.push(`- ${claim.path}  (${claim.label}${claim.reason ? `: ${claim.reason}` : ''})`);
      }
      return lines.join('\n');
    }

    if (name === 'notify') {
      const body = str('body');
      if (!body) return 'Missing `body`: without text there is nothing to say.';
      const where = scope(args.scope);
      if (where !== 'ALL' && !member.repoId) return 'You are not in a repository the Code Reviewer knows, so only scope ALL reaches anyone.';
      this.post({ scopeName: where, from: member, kind: str('kind') ?? 'note', subject: str('subject'), body });
      const audience = where === 'ALL' ? 'every session and fix' : where === 'REPO' ? `anyone writing in ${this.repoName(member.repoId)}` : member.prId ? `anyone working on PR #${member.prId}` : `anyone writing in ${this.repoName(member.repoId)}`;
      return `Noted. It reaches ${audience}.`;
    }

    if (name === 'inbox') {
      const messages = this.inbox(member);
      if (!messages.length) return 'Nothing new since you last looked.';
      this.markRead(member, messages[messages.length - 1]);
      return [`${messages.length} new message(s):`, ...messages.map((m) => `- [${m.kind}] ${m.fromLabel}${m.subject ? ` · ${m.subject}` : ''}\n  ${m.body.replace(/\n/g, '\n  ')}`)].join('\n');
    }

    if (name === 'claim') {
      const missing = needRepo();
      if (missing) return missing;
      const paths = pathList(args.paths);
      if (!paths.length) return 'Missing `paths`: say which files you are about to change.';
      const taken = this.claim(member, paths, str('reason'));
      if (!taken.length) return `Claimed ${paths.length} file(s). They are released on their own when your ${member.kind === 'fix' ? 'fix ends' : 'session ends or moves'}.`;
      return [
        'Not everything could be claimed. These are already someone else\'s:',
        ...taken.map((claim) => `- ${claim.path}  → ${claim.label}${claim.reason ? `: ${claim.reason}` : ''}`),
        '',
        'The rest are yours. Editing the others anyway breaks nothing now — you have your own copy — but it will show at the merge. Coordinate with `notify`, or solve it another way.',
      ].join('\n');
    }

    if (name === 'who_touched') {
      const missing = needRepo();
      if (missing) return missing;
      const paths = pathList(args.paths);
      if (!paths.length) return 'Missing `paths`: say which files you want to ask about.';
      const { hits, unread } = await this.whoTouched(member, paths);
      const lines = [];
      if (!hits.length) lines.push('No other branch changes those files. Clear.');
      else {
        lines.push('Other branches already change some of those files:');
        for (const hit of hits) lines.push(`- ${hit.branch ?? 'another branch'}${hit.prId ? ` (PR #${hit.prId}${hit.author ? `, ${hit.author}` : ''})` : ''}: ${hit.paths.join(', ')}`);
        lines.push('', 'It does not block you: you have your own copy. But they will meet at the merge, so change as little as you can in those files and do not reorder or reformat them.');
      }
      if (unread) lines.push('', `${unread} open PR(s) could not be checked: their branches are not fetched into the clone.`);
      return lines.join('\n');
    }

    if (name === 'release') {
      const paths = pathList(args.paths);
      this.release(member, paths);
      return paths.length ? `Released ${paths.length} file(s).` : 'Released everything you had claimed.';
    }

    if (name === 'migration_number') {
      const missing = needRepo();
      if (missing) return missing;
      const count = Math.min(10, Math.max(1, Number.parseInt(String(args.count ?? '1'), 10) || 1));
      const { numbers } = await this.migrationNumbers(member, count);
      if (!numbers.length) return 'This repository has no numbered migrations (V<n>__name.sql): name the file like the ones that are already there.';
      return `Use exactly ${numbers.join(', ')}. They are reserved for you: no other session or fix will be given them.`;
    }

    return `There is no tool called \`${name}\`.`;
  }

  /**
   * A request from the socket. `token` is a fix's; `from` is a session's id,
   * and only counts if that session is in the live roster.
   */
  async handle(request, roster) {
    const tool = String(request?.tool ?? '');
    if (!TOOL_NAMES.includes(tool)) return { ok: false, error: `There is no tool called ${tool}.` };
    let member = null;
    if (request.token) {
      member = this.member(String(request.token));
      if (!member || member.endedAt || member.kind !== 'fix') return { ok: false, error: 'This run is not on the bus any more.' };
    } else if (request.from) {
      member = this.sessionMember(String(request.from), roster);
      if (!member) return { ok: false, error: 'Smart Terminal does not have this session as running.' };
    } else {
      return { ok: false, error: 'This caller did not identify itself.' };
    }
    return { ok: true, text: await this.call(member, tool, request.args ?? {}) };
  }

  /** What the panel shows: who is writing where, what is claimed, what was said, what was reserved. */
  overview() {
    const members = this.liveMembers().map((member) => ({ ...member, where: this.whereWords(member), claims: this.claims().filter((claim) => claim.token === member.token).map((claim) => claim.path) }));
    const messages = this.store.all('SELECT * FROM cr_bus_message ORDER BY at DESC LIMIT 60').map((row) => ({ id: row.id, scope: row.scope, repoName: this.repoName(row.repo_id), prId: row.pr_id, fromLabel: row.from_label, kind: row.kind, subject: row.subject, body: row.body, at: row.at }));
    const reservations = this.reservations().map((slot) => ({ ...slot, repoName: this.repoName(slot.repoId) }));
    return { members, messages, reservations };
  }
}

/**
 * What a fix is told about the bus, in the words the original gave its tasks,
 * with whatever was left for it already folded in.
 */
function busSection(pending) {
  const lines = ['NO ESTÁS SOLO'];
  if (pending.length) {
    lines.push('', 'TE DEJARON DICHO:', ...pending.map((m) => `· [${m.kind}] ${m.fromLabel}${m.subject ? ` · ${m.subject}` : ''}: ${m.body.replace(/\n/g, ' ')}`), '');
  }
  lines.push(
    'Puede haber otras sesiones escribiendo ahora en este mismo repositorio: otros arreglos, en',
    'otros PRs, y las sesiones de Claude de la persona. Tenés herramientas para verlas y **no son',
    'opcionales**:',
    '',
    '1. Empezá con `peers` e `inbox`. Antes de leer una línea de código: si otra sesión está en',
    '   los mismos archivos o dejó un aviso sobre lo que vas a tocar, saberlo después es tarde.',
    '2. `claim` sobre los archivos que vas a editar, antes de editarlos. Si ya los tiene otro, no',
    '   esperes: avisá con `notify` y resolvé por otro lado lo que puedas.',
    '3. `who_touched` sobre esos archivos: si la rama de otro PR abierto ya los cambia, tocá lo',
    '   mínimo y no los reordenes ni los reformatees.',
    '4. `notify` cuando hagas algo que a otro le cambia el trabajo — renombraste un tipo, una tabla',
    '   o un endpoint; cambiaste una firma; encontraste algo roto. No narres tu avance.',
    '5. Si tenés que crear una migración, pedí el número con `migration_number`. El que parece',
    '   libre mirando el repositorio puede estar tomado en la rama de otro PR o reservado por otra',
    '   sesión, y dos migraciones con el mismo número se descubren recién al mergear.',
  );
  return lines.join('\n');
}

module.exports = { ReviewBus, TOOL_NAMES, SCOPES, busSection, scanMigrations, migrationLabel, pathList, scope };
