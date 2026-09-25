'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');

/**
 * Code Reviewer: one migration number, taken twice.
 *
 * Two branches each add the next migration, each take the next number, and
 * each is right on its own. Git sees two different files and merges both
 * without a word; the database sees two migrations claiming the same place in
 * the sequence and refuses to start — on the deploy, which is the most
 * expensive moment there is to find out. The bus already hands out numbers so
 * the writers *in this app* do not collide; this is for everybody else: the
 * pull requests people opened from their own machines.
 *
 * A repository names the folder its migrations are created in, and from then
 * on every open pull request's branch is read for the migrations it *adds*
 * there. Two different files with the same number is a clash; so is a pull
 * request adding a number its target branch already has.
 *
 * What it does about one:
 * - the pull requests in it are flagged on the board and in their own screen,
 *   and the merge gate says why;
 * - a pull request whose number is **already on its target** is not merged
 *   from here at all: that merge is the duplicate. Two open pull requests
 *   sharing one are not refused — neither merge creates the duplicate on its
 *   own, and refusing both would leave nothing mergeable — but the moment one
 *   of them lands, the other is in the first case;
 * - the repository's room is told once, and again only if somebody else joins
 *   the clash. The same two still clashing ten minutes later is not news.
 *
 * Read from real branches with git, like `who_touched`: the answer is what the
 * branches say, not what anybody reported.
 */

/**
 * The number a migration file claims, normalised, or `null` for a file that
 * claims none.
 *
 * - Flyway: `V12__add_orders.sql`, `V012__…`, `V1_2__…` and `V1.2__…` (a
 *   dotted version is a version: `1.2`, not `1`).
 * - A leading sequence: `0012_add_orders.sql`, `12-add-orders.xml`, `012.sql`.
 *
 * Leading zeros are not part of the number: `V012` and `V12` are the same
 * place in the sequence, which is exactly the collision a zero-padded folder
 * hides from a person reading file names. A repeatable Flyway migration
 * (`R__…`) has no number and never clashes.
 */
function migrationNumber(fileName) {
  const name = path.posix.basename(String(fileName ?? '').replace(/\\/g, '/'));
  const flyway = /^[Vv](\d+(?:[._]\d+)*)__/.exec(name);
  if (flyway) return normalise(flyway[1]);
  const leading = /^(\d+)(?=[_\-.]|$)/.exec(name);
  if (leading) return normalise(leading[1]);
  return null;
}

function normalise(version) {
  return version
    .split(/[._]/)
    .map((part) => part.replace(/^0+(?=\d)/, ''))
    .join('.');
}

/** Whether a path is inside the migrations folder (at any depth: Flyway reads subfolders too). */
function inFolder(file, folder) {
  const clean = String(folder ?? '').replace(/\/+$/, '');
  return Boolean(clean) && String(file).startsWith(`${clean}/`);
}

/**
 * Every clash among what the open pull requests add and what their targets
 * already have.
 *
 * `prs` is `[{prId, title, author, url, sourceBranch, targetBranch, added: [path]}]`
 * — `added` being only files the branch adds, already limited to the folder.
 * `targets` maps a target branch to the migration paths it has.
 *
 * The same *path* on two branches is one migration, not two: a pull request
 * stacked on another carries its parent's migration in its own diff, and
 * calling that a clash would flag every stacked pull request there is. A clash
 * is two different files claiming one number.
 */
function findClashes({ prs = [], targets = new Map() }) {
  const byNumber = new Map();
  const add = (number, member) => {
    if (!byNumber.has(number)) byNumber.set(number, []);
    const list = byNumber.get(number);
    if (!list.some((one) => one.prId === member.prId && one.path === member.path && one.branch === member.branch)) list.push(member);
  };
  for (const pr of prs) {
    for (const file of pr.added ?? []) {
      const number = migrationNumber(file);
      if (number === null) continue;
      add(number, { prId: pr.prId, title: pr.title ?? '', author: pr.author ?? '', url: pr.url ?? null, branch: pr.sourceBranch ?? '', target: pr.targetBranch ?? '', path: file });
    }
  }
  // What the targets already have, for the numbers some pull request is adding.
  for (const [number, members] of byNumber) {
    for (const target of new Set(members.map((member) => member.target).filter(Boolean))) {
      for (const file of targets.get(target) ?? []) {
        if (migrationNumber(file) === number) add(number, { prId: null, title: '', author: '', url: null, branch: target, target, path: file });
      }
    }
  }
  const out = [];
  for (const [number, members] of byNumber) {
    const paths = new Set(members.map((member) => member.path));
    if (paths.size < 2) continue;
    const sorted = members.slice().sort((a, b) => (a.prId ?? -1) - (b.prId ?? -1) || a.path.localeCompare(b.path));
    out.push({ number, members: sorted, signature: signatureOf(sorted) });
  }
  return out.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

function signatureOf(members) {
  return members.map((member) => `${member.prId ?? `@${member.branch}`}:${member.path}`).sort().join('|');
}

/**
 * The clash as far as one pull request is concerned: `null` when it is not in
 * one, otherwise what it clashes with and whether merging it is the duplicate.
 */
function clashFor(prId, clashes = []) {
  const mine = clashes.filter((clash) => clash.members.some((member) => member.prId === prId));
  if (!mine.length) return null;
  return {
    numbers: mine.map((clash) => clash.number),
    // Its own number is on the branch it merges into: merging it *is* the duplicate.
    onTarget: mine.some((clash) => {
      const own = clash.members.filter((member) => member.prId === prId);
      return clash.members.some((member) => member.prId === null && own.some((one) => one.target === member.branch && one.path !== member.path));
    }),
    with: mine.flatMap((clash) =>
      clash.members
        .filter((member) => member.prId !== prId)
        .map((member) => ({ number: clash.number, prId: member.prId, branch: member.branch, path: member.path })),
    ),
  };
}

/** One sentence, for the merge gate and the board. */
function clashSentence(clash) {
  if (!clash) return null;
  const others = clash.with.map((one) => (one.prId === null ? `${one.branch} already has ${path.posix.basename(one.path)}` : `#${one.prId} adds ${path.posix.basename(one.path)}`));
  const numbers = clash.numbers.join(', ');
  return clash.onTarget
    ? `Migration ${numbers} is already taken on the target branch (${others.join('; ')}). Renumber it before merging.`
    : `Migration ${numbers} is also taken by another pull request (${others.join('; ')}). One of them has to be renumbered.`;
}

/** The message for the room, as the delivery extension's contract wants it. */
function clashMessage(repo, clash) {
  const prs = clash.members.filter((member) => member.prId !== null);
  const onTarget = clash.members.filter((member) => member.prId === null);
  const who = prs.map((member) => `#${member.prId}`);
  const body = onTarget.length
    ? `${who.join(' and ')} ${prs.length === 1 ? 'adds' : 'add'} a migration numbered ${clash.number}, and ${onTarget[0].branch} already has one. Whichever is not on ${onTarget[0].branch} has to be renumbered before it is merged.`
    : `${who.join(' and ')} each add a migration numbered ${clash.number}. Git will merge both without complaint and the database will refuse the second: one of them has to be renumbered before either is merged.`;
  return {
    title: `${repo.name}: two migrations numbered ${clash.number}`,
    body,
    facts: clash.members.slice(0, 8).map((member) => ({
      label: member.prId === null ? member.branch : `#${member.prId}`,
      value: member.prId === null
        ? `${path.posix.basename(member.path)} (already merged)`
        : `${path.posix.basename(member.path)} · ${member.branch}${member.author ? ` · ${member.author}` : ''}`,
    })),
    links: prs.filter((member) => member.url).slice(0, 5).map((member) => ({ text: `Open #${member.prId}`, url: member.url })),
    // Who is in it, not when: the same clash is said once, somebody new joining it is said again.
    key: `code-review:migration:${repo.id}:${clash.number}:${createHash('sha1').update(clash.signature).digest('hex').slice(0, 12)}`,
    // Somebody may be about to press Merge; this does not wait for the morning.
    level: 'urgent',
  };
}

/** A fork's branch is `owner:branch` and origin does not have it. */
const readable = (pr) => pr.sourceBranch && pr.targetBranch && !/^[-+]|:/.test(pr.sourceBranch) && !/^[-+]|:/.test(pr.targetBranch);

class MigrationWatch {
  /**
   * @param {object} deps
   * @param {import('./review-store').ReviewStore} deps.store
   * @param {import('./review-git').ReviewGit} deps.git
   * @param {(message: object) => Promise<{ok: boolean, why?: string}>} deps.deliver
   * @param {(repo: object) => string} deps.channelFor the room a repository's alerts go to, '' for none
   */
  constructor({ store, git, deliver, channelFor, notify = () => {}, emit = () => {} }) {
    this.store = store;
    this.git = git;
    this.deliver = deliver;
    this.channelFor = channelFor;
    this.notify = notify;
    this.emit = emit;
    /** What a branch adds, by `repo#pr@head:targetTip`: git is asked again only when either end moves. */
    this.added = new Map();
    /** What a target has, by `repo@target:tip`. */
    this.listed = new Map();
    this.running = new Map();
  }

  /** One repository, now. A second call while one runs gets the first one's answer. */
  check(repoId) {
    const running = this.running.get(repoId);
    if (running) return running;
    const work = this.#check(repoId).finally(() => this.running.delete(repoId));
    this.running.set(repoId, work);
    return work;
  }

  async #check(repoId) {
    const repo = this.store.repo(repoId);
    if (!repo) return [];
    if (!repo.migrationsPath || !repo.localPath) {
      // Switched off: whatever it said before stops being said.
      if (this.store.migrationClashes(repoId).length) {
        this.store.setMigrationClashes(repoId, []);
        this.emit({ type: 'changed', repoId, prId: null });
      }
      return [];
    }
    const open = this.store.prs(repoId, { states: ['OPEN'] }).filter(readable);
    const prs = [];
    const targets = new Map();
    for (const pr of open) {
      const added = await this.addedBy(repo, pr);
      // A branch never fetched into the clone says nothing, rather than "adds nothing".
      if (added === null) continue;
      prs.push({ prId: pr.id, title: pr.title, author: pr.author, url: pr.url, sourceBranch: pr.sourceBranch, targetBranch: pr.targetBranch, added });
      if (!targets.has(pr.targetBranch)) targets.set(pr.targetBranch, (await this.onTarget(repo, pr.targetBranch)) ?? []);
    }
    const before = new Map(this.store.migrationClashes(repoId).map((clash) => [clash.number, clash.signature]));
    const clashes = findClashes({ prs, targets });
    this.store.setMigrationClashes(repoId, clashes);
    const moved = clashes.length !== before.size || clashes.some((clash) => before.get(clash.number) !== clash.signature);
    for (const clash of this.store.migrationClashes(repoId)) {
      if (clash.notifiedSignature !== clash.signature) await this.tell(repo, clash);
    }
    if (moved) this.emit({ type: 'changed', repoId, prId: null });
    return clashes;
  }

  /** The migrations a pull request's branch adds in the folder, or `null` when git cannot say. */
  async addedBy(repo, pr) {
    /*
     * Keyed by what the clone's branches point at, not by the head the pull
     * request row remembers: the row can be a list-read behind a fetch, and
     * an answer cached under a stale head is an answer about old code.
     */
    const tip = await this.git.revParse(repo.localPath, `origin/${pr.targetBranch}`);
    const head = await this.git.revParse(repo.localPath, `origin/${pr.sourceBranch}`);
    if (!tip || !head) return null;
    const key = `${repo.id}#${pr.id}@${head}:${tip}:${repo.migrationsPath}`;
    if (this.added.has(key)) return this.added.get(key);
    const result = await this.git.run(repo.localPath, ['diff', '--name-only', '--diff-filter=A', `origin/${pr.targetBranch}...origin/${pr.sourceBranch}`, '--', repo.migrationsPath]);
    if (!result.ok) return null;
    const files = result.stdout.split('\n').map((line) => line.trim()).filter((file) => inFolder(file, repo.migrationsPath));
    this.added.set(key, files);
    return files;
  }

  /** The migrations a branch already has in the folder, or `null` when git cannot say. */
  async onTarget(repo, branch) {
    const tip = await this.git.revParse(repo.localPath, `origin/${branch}`);
    if (!tip) return null;
    const key = `${repo.id}@${branch}:${tip}:${repo.migrationsPath}`;
    if (this.listed.has(key)) return this.listed.get(key);
    const result = await this.git.run(repo.localPath, ['ls-tree', '-r', '--name-only', `origin/${branch}`, '--', repo.migrationsPath]);
    if (!result.ok) return null;
    const files = result.stdout.split('\n').map((line) => line.trim()).filter((file) => inFolder(file, repo.migrationsPath));
    this.listed.set(key, files);
    return files;
  }

  /**
   * Tell the room, and remember having told it — whatever the answer was.
   *
   * A delivery that could not happen (no room named, nothing installed) is
   * written down and shown, not retried every two minutes: the delivery
   * extension keeps its own record of a failure and its own Retry.
   */
  async tell(repo, clash) {
    const channel = String(this.channelFor(repo) ?? '').trim();
    const message = clashMessage(repo, clash);
    this.notify(message.title, message.body);
    let result = 'no-channel';
    if (channel) {
      const sent = await Promise.resolve(this.deliver({ ...message, to: { channel } })).catch((error) => ({ ok: false, why: 'failed', detail: String(error?.message ?? error) }));
      result = sent?.ok ? `sent to ${channel}` : `${sent?.why ?? 'failed'}${sent?.detail ? `: ${sent.detail}` : ''}`;
    }
    this.store.noteMigrationClashTold(repo.id, clash.number, clash.signature, result.slice(0, 300));
    return result;
  }

  /**
   * Just before a merge, asked of the branches as they are this second.
   *
   * The board's answer can be two minutes old, and a merge is the one moment
   * that cannot be taken back, so both branches are fetched and read again.
   * Returns the sentence that stops it, or `null`.
   */
  async blockMerge(repo, pr) {
    if (!repo.migrationsPath || !repo.localPath || !readable(pr)) return null;
    await this.git.fetch(repo.localPath, pr.targetBranch, pr.sourceBranch);
    const added = await this.addedBy(repo, pr);
    const have = await this.onTarget(repo, pr.targetBranch);
    if (!added?.length || !have) return null;
    const clashes = findClashes({ prs: [{ prId: pr.id, sourceBranch: pr.sourceBranch, targetBranch: pr.targetBranch, added }], targets: new Map([[pr.targetBranch, have]]) });
    const mine = clashFor(pr.id, clashes);
    return mine?.onTarget ? clashSentence(mine) : null;
  }
}

module.exports = { migrationNumber, findClashes, clashFor, clashSentence, clashMessage, inFolder, MigrationWatch };
