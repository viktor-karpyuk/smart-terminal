'use strict';

/**
 * Housekeeping: what Smart Terminal and the work around it leave on disk, and
 * giving it back.
 *
 * This file knows no filesystem layout of its own. It asks the parts that do —
 * the database for sessions, the context store for their saved copies, the
 * Code Reviewer for its clones, the folders the person named for worktrees and
 * build caches — and turns each answer into items of one shape (see
 * `housekeeping-items.js`). The panel adds them up and asks for removals by id;
 * every removal comes back here, is checked again against what is on disk
 * now, and is written to the log with what it gave back.
 *
 * Two kinds of removal, never mixed. `free` takes what comes back by itself
 * (caches, old installers, backups of installations long replaced) and runs
 * behind one button. `deleteSessions` and `discardWorkshops` take the only
 * copy of something and are asked for by name, item by item.
 *
 * Measuring is separate from listing. `inventory` answers at once with the
 * sizes it already knows and marks the rest unknown; `measure` walks those on
 * a worker and reports each as it lands. A panel is never kept waiting on the
 * slowest directory to show the first number.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { item, totals, byWeight, formatBytes, KINDS } = require('./housekeeping-items');
const caches = require('./build-caches');
const { WorktreeInventory } = require('./worktree-inventory');
const { WorktreePulls } = require('./worktree-prs');
const { execFile } = require('node:child_process');
const { fileSize } = require('./disk-usage');

const DAY = 86_400_000;
/** How long the last inventory is trusted to resolve ids for a removal. */
const LAST_INVENTORY_MS = 10 * 60_000;

class Housekeeping {
  /**
   * @param {object} options
   * @param {object} options.db the app database (`sessionFootprints`, `deleteSessions`, `health`)
   * @param {object} options.store a HousekeepingStore
   * @param {object} options.sizes a DiskUsage
   * @param {string} options.userData the app's data folder
   * @param {object} [options.context] the context store (`forget`, `trackedIds`)
   * @param {object} [options.review] `{ workshops(): Promise<[]>, discard(repoId, prId) }`
   * @param {object} [options.browser] `{ size(): Promise<number>, clear(): Promise<void> }`
   * @param {() => string[]} [options.live] the folders live sessions are standing in
   * @param {() => string[]} [options.repoFolders] repositories the app knows apart from the roots (the Code Reviewer's)
   * @param {boolean} [options.fetch] let the worktree inventory fetch origin once in a while
   * @param {() => number} [options.now]
   */
  constructor({ db, store, sizes, userData, context = null, review = null, browser = null, live = () => [], repoFolders = () => [], fetch = true, now = () => Date.now(), emit = () => {} }) {
    this.db = db;
    this.store = store;
    this.sizes = sizes;
    this.userData = userData;
    this.context = context;
    this.review = review;
    this.browser = browser;
    this.live = live;
    this.now = now;
    this.emit = emit;
    /** The last inventory, so a removal asked for a moment later resolves its ids without reading the disk again. */
    this.last = null;
    /** When a session was last active under a folder, from the database, rebuilt per inventory. */
    this.#activity = [];
    this.worktrees = new WorktreeInventory({
      folders: () => [...(this.#checkouts ?? this.checkouts()), ...this.live(), ...(repoFolders() ?? [])].filter(Boolean),
      live: () => this.live(),
      sessionActivity: (dir) => this.#sessionActivityUnder(dir),
      fetch,
      now,
      regenerable: () => this.regenerable(),
    });
    /** The pull requests of each worktree's branch, remembered in the store and refreshed in the background. */
    this.pulls = new WorktreePulls({
      get: (key) => this.store.setting?.(key),
      set: (key, value) => this.store.setSetting(key, value),
      now,
      emit: (event, payload) => this.emit(event, payload),
      forgeFor: (root) => this.#forgeFor(root),
    });
  }

  /**
   * The Code Reviewer's adapter for the repository at a root, matched by its remote:
   * the way to ask Bitbucket, with the token the person gave that repository there.
   */
  async #forgeFor(root) {
    if (!this.review?.forgeByRemote) return null;
    const remotes = await new Promise((resolve) => {
      execFile('git', ['remote', '-v'], { cwd: root, timeout: 10_000 }, (error, stdout) => resolve(error ? '' : String(stdout)));
    });
    const urls = [...new Set(remotes.split('\n').map((line) => line.split(/\s+/)[1]).filter(Boolean))];
    for (const url of urls) {
      const found = this.review.forgeByRemote(url);
      if (found) return found;
    }
    return null;
  }

  #activity = [];
  #footprints = [];

  /** The session that last worked in or under a folder — open, or one that can be picked up. */
  #sessionUnder(dir) {
    let best = null;
    const target = realOf(dir);
    for (const row of this.#footprints) {
      const cwd = realOf(row.lastCwd || row.startCwd);
      if (!cwd || !(cwd === target || cwd.startsWith(target + path.sep))) continue;
      const live = row.endedAt === null;
      const score = (live ? 1e15 : 0) + (row.lastActivityAt ?? 0);
      if (!best || score > best.score) best = { score, row };
    }
    if (!best) return null;
    const row = best.row;
    return { id: row.id, title: row.title ?? null, kind: row.kind, live: row.endedAt === null, resumable: row.kind === 'claude' && Boolean(row.claudeSessionId), lastActivityAt: row.lastActivityAt, profile: row.profileName ?? null };
  }

  /** The latest a session was active in or under a folder, or null. */
  #sessionActivityUnder(dir) {
    let latest = null;
    for (const [cwd, at] of this.#activity) {
      if (cwd === dir || cwd.startsWith(dir + path.sep)) latest = Math.max(latest ?? 0, at);
    }
    return latest;
  }

  // --- roots ------------------------------------------------------------------

  /** The folders looked through for checkouts: the ones the person added. */
  roots() {
    return this.store.roots();
  }

  addRoot(folder) {
    const given = path.resolve(String(folder || '').replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(given) || !fs.statSync(given).isDirectory()) throw new Error(`${given} is not a folder.`);
    // Kept as the filesystem spells it, so what is stored matches what git prints for the worktrees inside.
    const resolved = fs.realpathSync(given);
    // The root of the disk or a home folder is not a folder of worktrees. Only their direct children would be looked at
    // anyway, and a cache found directly under one of them is somebody's, not a build's.
    if (resolved === path.parse(resolved).root || resolved === os.homedir()) throw new Error('Choose a folder of worktrees or a checkout, not the whole disk or your home folder.');
    this.store.addRoot(resolved);
    return this.roots();
  }

  removeRoot(folder) {
    this.store.removeRoot(folder);
    return this.roots();
  }

  /**
   * The checkouts under the roots: each root itself when it is one, and its
   * direct children that are. One level, on purpose — a root is a folder of
   * worktrees, not a home directory to crawl.
   */
  checkouts() {
    const found = new Set();
    // As the filesystem spells them: git prints resolved paths, and a worktree listed by git must match a checkout listed here.
    const real = (one) => {
      try {
        return fs.realpathSync(one);
      } catch {
        return one;
      }
    };
    for (const { path: given } of this.roots()) {
      const root = real(given);
      if (caches.isCheckout(root)) found.add(root);
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const full = path.join(root, entry.name);
        if (caches.isCheckout(full)) found.add(full);
      }
    }
    return [...found].sort();
  }

  // --- inventory ----------------------------------------------------------------

  /** Everything, as items, with the sizes already known. Unknown sizes are 0 and `sized: false`. */
  async inventory() {
    // The checkouts are read once per inventory: three of the lists below want them, and a root of
    // two hundred worktrees is two hundred stats each time it is asked.
    this.#checkouts = this.checkouts();
    // Sessions first: the worktree rows name the session that worked in each.
    this.sessionItems();
    this.emit('progress', { op: 'inventory', phase: 'worktrees', detail: `${this.#checkouts.length} checkouts, asking git`, done: false });
    const worktrees = await this.worktreeItems();
    this.emit('progress', { op: 'inventory', phase: 'caches', detail: 'build caches and the app\'s own folders', done: false });
    const inside = new Set(worktrees.map((one) => one.path));
    const cacheItems = (await this.buildCacheItems()).map((one) =>
      inside.has(one.meta?.checkout) ? { ...one, meta: { ...one.meta, nested: true } } : one,
    );
    const items = [
      ...this.sessionItems(),
      ...worktrees,
      ...cacheItems,
      ...(await this.workshopItems()),
      ...this.appItems(),
      ...(await this.browserItems()),
    ];
    const sized = items.filter((one) => one.meta?.sized === false).map((one) => one.path);
    this.last = { items, at: this.now() };
    this.emit('progress', { op: 'inventory', phase: 'done', detail: `${items.length} items`, done: true });
    // Kept, so the next open of the panel shows this at once while a fresh one is read.
    try {
      this.store.setSetting('last-inventory', { items, totals: totals(items), checkouts: this.#checkouts.length, roots: this.roots(), disk: diskFree(this.userData), readAt: this.now() });
    } catch {
      /* a snapshot not kept costs one slow open */
    }
    return {
      items: byWeight(items, this.now()),
      totals: totals(items),
      unsized: sized,
      roots: this.roots(),
      checkouts: this.#checkouts.length,
      disk: diskFree(this.userData),
      log: this.store.recentLog(20),
      readAt: this.now(),
    };
  }

  /**
   * Walk the paths whose size is not known or not fresh, telling the window about each.
   *
   * Only paths that are an item's own folder are walked — a cache, a clone, a copied data folder. A
   * session's path is the folder it worked in, which may be a whole repository, and walking that
   * because somebody pressed "measure again" would be minutes spent on a number nobody asked for.
   */
  async measure(paths = [], { force = false } = {}) {
    const allowed = new Set(this.measurable());
    const wanted = paths.filter((one) => typeof one === 'string' && allowed.has(one));
    if (!wanted.length) return {};
    const out = {};
    await this.sizes.measure(wanted, {
      force,
      onEach: (target, kept) => {
        if (!kept.partial) out[target] = kept.bytes;
        this.emit('size', { path: target, bytes: kept.bytes, files: kept.files, partial: Boolean(kept.partial) });
      },
    });
    return out;
  }

  /** The last inventory kept, for a panel to open on while a fresh one is read; null when there is none yet. */
  snapshot() {
    const roots = this.roots();
    if (this.last) return { items: this.last.items, totals: totals(this.last.items), readAt: this.last.at, disk: diskFree(this.userData), roots, checkouts: this.#checkouts?.length ?? 0, log: this.store.recentLog(20), unsized: [], stale: this.now() - this.last.at > 10 * 60_000 };
    const kept = this.store.setting?.('last-inventory');
    if (!kept?.items) return null;
    // The shape the window expects, whatever an older snapshot kept: roots are the list, never a count.
    return { ...kept, roots: Array.isArray(kept.roots) ? kept.roots : roots, checkouts: Number(kept.checkouts) || 0, log: this.store.recentLog(20), unsized: [], stale: true };
  }

  /**
   * One of the panel's quick actions, by name. Each maps onto a removal this
   * file already does, with the same checks; the name is only the shortcut.
   */
  async act(id, ids = []) {
    switch (id) {
      case 'free':
        return this.free(ids);
      case 'remove-worktrees':
        return this.removeWorktrees(ids);
      case 'remove-worktrees-forced':
        return this.removeWorktrees(ids, { force: true });
      case 'repair-worktrees':
        return this.repairWorktrees(ids);
      case 'forget-transcripts':
        return this.forgetTranscripts(ids);
      case 'delete-sessions':
        return this.deleteSessions(ids);
      case 'db-checkpoint': {
        const out = this.db.maintain({ checkpoint: true });
        const bytes = out.done.find((d) => d.op === 'checkpoint')?.bytes ?? 0;
        this.store.log({ action: 'db-checkpoint', kind: 'db-backup', label: 'write-ahead log', bytes, ok: true });
        return { freed: bytes, results: [{ id, ok: true, bytes }] };
      }
      case 'db-reclaim': {
        const out = this.db.maintain({ reclaim: true });
        this.store.log({ action: 'db-reclaim', kind: 'db-backup', label: 'database file', bytes: out.freed, ok: true });
        return { freed: out.freed, results: [{ id, ok: true, bytes: out.freed }] };
      }
      default:
        throw new Error(`Not an action: ${id}`);
    }
  }

  /** The folders whose size is a thing of their own: what `measure` agrees to walk. */
  measurable() {
    const checkouts = this.#checkouts ?? this.checkouts();
    const out = [];
    for (const checkout of checkouts) for (const found of caches.findIn(checkout)) out.push(found.path);
    for (const trash of caches.pendingTrash(checkouts)) out.push(trash);
    const parent = path.dirname(this.userData);
    const aside = new RegExp(`^${escapeRegExp(path.basename(this.userData))}[.-](backup|state)[-.]`);
    for (const name of readdir(parent)) if (aside.test(name) && isDir(path.join(parent, name))) out.push(path.join(parent, name));
    if (this.review?.dirs) for (const dir of this.review.dirs()) out.push(dir);
    for (const one of this.last?.items ?? []) if (one.kind === 'worktree' && one.path) out.push(one.path);
    return out;
  }

  /**
   * Every worktree of every repository the app knows, except each repository's
   * main working tree: that one is never removable and its size is the repository's,
   * not housekeeping's business.
   */
  async worktreeItems() {
    let rows;
    try {
      rows = await this.worktrees.list();
    } catch {
      return [];
    }
    // PRs refresh after the rows are out: every answer is emitted and the panel repaints that row.
    void this.pulls.refresh(rows).catch(() => {});
    return rows
      .filter((row) => !row.main)
      .map((row) => {
        const known = this.sizes.known(row.path);
        const prs = this.pulls.known(row.root, row.branch);
        return item({
          id: `worktree:${row.path}`,
          kind: 'worktree',
          label: `${row.repo}/${row.label}`,
          path: row.path,
          bytes: known?.bytes ?? 0,
          lastActivityAt: row.lastActivityAt,
          state: row.state,
          blockers: row.blockers,
          detail: [row.branch ? `branch ${row.branch}` : null, row.upstream ? `tracks ${row.upstream}` : row.ownWork ? 'no upstream' : null].filter(Boolean).join(' · ') || null,
          meta: { root: row.root, branch: row.branch, finished: row.finished, prunable: row.prunable, broken: row.broken, work: prs?.allMerged && row.work === 'unmerged' && !row.dirty ? 'done' : row.work, prs, aheadOfBase: row.aheadOfBase, dirtyCount: row.dirtyCount, dirty: row.dirty, forceable: row.forceable, loses: row.loses, session: this.#sessionUnder(row.path), sized: Boolean(known) || row.prunable },
        });
      });
  }

  sessionItems() {
    const live = new Set(this.context?.trackedIds?.() ?? []);
    const snapshots = path.join(this.userData, 'context-snapshots');
    const footprints = this.db.sessionFootprints();
    this.#activity = footprints.flatMap((row) => [row.lastCwd, row.startCwd].filter(Boolean).map((cwd) => [cwd, row.lastActivityAt]));
    this.#footprints = footprints;
    return footprints.map((row) => {
      const snapshot = snapshotBytes(path.join(snapshots, row.id));
      const blockers = [];
      if (row.endedAt === null) blockers.push('still running');
      else if (live.has(row.id)) blockers.push('still being recorded');
      const where = row.lastCwd || row.startCwd || '';
      return item({
        id: `session:${row.id}`,
        kind: 'session',
        label: row.title || path.basename(where) || row.id.slice(0, 8),
        path: where,
        bytes: row.transcriptBytes + snapshot,
        lastActivityAt: row.lastActivityAt,
        state: row.endedAt === null ? 'open' : 'ended',
        blockers,
        detail: [row.profileName, row.kind, snapshot ? `${fmt(snapshot)} saved copy` : null].filter(Boolean).join(' · '),
        meta: { sessionId: row.id, transcriptBytes: row.transcriptBytes, snapshotBytes: snapshot, profile: row.profileName ?? null, sessionKind: row.kind ?? null, cwd: where, startedAt: row.startedAt, sized: true },
      });
    });
  }

  /** A preference by name, with a default: a small switch the panel shows. */
  pref(key, fallback = null) {
    const kept = this.store.setting?.(`pref:${key}`);
    return kept === undefined ? fallback : kept;
  }

  setPref(key, value) {
    this.store.setSetting(`pref:${key}`, value);
    return value;
  }

  /** Names or globs the person said a build makes again, beyond the cache list. */
  regenerable() {
    const kept = this.store.setting?.('regenerable');
    return Array.isArray(kept) ? kept.filter((one) => typeof one === 'string' && one.trim()).map((one) => one.trim()) : [];
  }

  setRegenerable(list) {
    const clean = [...new Set((Array.isArray(list) ? list : String(list ?? '').split(/[\n,]/)).map((one) => String(one).trim()).filter(Boolean))].slice(0, 100);
    this.store.setSetting('regenerable', clean);
    this.worktrees.memo.clear();
    return clean;
  }

  /** The checkouts as of the last inventory, so one pass does not stat the roots three times. */
  #checkouts = null;

  async buildCacheItems() {
    const live = this.live().filter(Boolean);
    const out = [];
    const checkouts = this.#checkouts ?? this.checkouts();
    // Up to eight checkouts at a time asked which names they ignore: enough to hide the latency, few enough not to fork a storm.
    const answers = await mapLimit(checkouts, 8, async (checkout) => {
      const list = caches.findIn(checkout);
      const ignored = await caches.ignoredIn(checkout, list.map((one) => one.name));
      return { checkout, list, ignored };
    });
    for (const { checkout, list, ignored } of answers) {
      const inside = live.some((cwd) => cwd === checkout || cwd.startsWith(checkout + path.sep));
      for (const found of list) {
        const known = this.sizes.known(found.path);
        const blockers = [];
        if (!ignored.has(found.name)) blockers.push('not ignored by git, so it may be committed work');
        if (inside) blockers.push('a session is working in this checkout');
        out.push(
          item({
            id: `cache:${found.path}`,
            kind: 'build-cache',
            label: `${path.basename(checkout)}/${found.name}`,
            path: found.path,
            bytes: known?.bytes ?? 0,
            lastActivityAt: mtime(found.path),
            state: found.tool,
            blockers,
            detail: `${found.tool} output in ${checkout}`,
            meta: { checkout, name: found.name, sized: Boolean(known) },
          }),
        );
      }
    }
    return out;
  }

  async workshopItems() {
    if (!this.review) return [];
    let shops = [];
    try {
      shops = await this.review.workshops();
    } catch {
      return [];
    }
    return shops.map((shop) => {
      const known = this.sizes.known(shop.dir);
      const blockers = [];
      if (shop.busy) blockers.push('a fix is being written in it');
      if (shop.pendingReturn) blockers.push(`${shop.pendingReturn} fix(es) not handed back`);
      if (!shop.prState || shop.prState === 'OPEN') blockers.push('the pull request is still open');
      return item({
        id: `workshop:${shop.repoId}:${shop.prId}`,
        kind: 'workshop',
        label: `${shop.repoName} #${shop.prId}`,
        path: shop.dir,
        bytes: known?.bytes ?? 0,
        lastActivityAt: mtime(shop.dir),
        state: shop.prState ? String(shop.prState).toLowerCase() : 'unknown',
        blockers,
        detail: shop.title || null,
        meta: { repoId: shop.repoId, prId: shop.prId, sized: Boolean(known) },
      });
    });
  }

  appItems() {
    const out = [];
    const dbFile = path.join(this.userData, 'smart-terminal.db');
    const parent = path.dirname(this.userData);
    const base = path.basename(this.userData);

    // Copies of the database left by hand or by an older build. The live file is not one of them.
    for (const name of readdir(this.userData)) {
      if (!name.startsWith('smart-terminal.db.backup')) continue;
      const full = path.join(this.userData, name);
      out.push(
        item({ id: `dbbackup:${full}`, kind: 'db-backup', label: name, path: full, bytes: fileSize(full), lastActivityAt: mtime(full), detail: `beside ${path.basename(dbFile)}`, meta: { sized: true } }),
      );
    }

    // Whole data folders copied aside before an upgrade: `Smart Terminal.backup-…`, `Smart Terminal-backup-…`, `Smart Terminal.state-…`.
    const aside = new RegExp(`^${escapeRegExp(base)}[.-](backup|state)[-.]`);
    for (const name of readdir(parent)) {
      if (!aside.test(name)) continue;
      const full = path.join(parent, name);
      if (!isDir(full)) continue;
      const known = this.sizes.known(full);
      out.push(
        item({ id: `installbackup:${full}`, kind: 'install-backup', label: name, path: full, bytes: known?.bytes ?? 0, lastActivityAt: mtime(full), detail: `a copy of the data folder in ${parent}`, meta: { sized: Boolean(known) } }),
      );
    }

    // Installers already downloaded. The newest is the one waiting to be installed; it is listed and said so.
    const updates = path.join(this.userData, 'updates');
    const installers = readdir(updates)
      .filter((name) => /\.(dmg|appimage|deb|exe|zip)$/i.test(name))
      .map((name) => ({ name, full: path.join(updates, name), at: mtime(path.join(updates, name)) }))
      .sort((a, b) => b.at - a.at);
    installers.forEach((one, index) => {
      out.push(
        item({
          id: `installer:${one.full}`,
          kind: 'installer',
          label: one.name,
          path: one.full,
          bytes: fileSize(one.full),
          lastActivityAt: one.at,
          state: index === 0 ? 'latest' : 'superseded',
          detail: index === 0 ? 'the newest download — removing it means downloading again to install' : 'replaced by a newer download',
          meta: { sized: true },
        }),
      );
    });

    // Pasted images older than a week, which the paste itself normally sweeps.
    const pasted = path.join(this.userData, 'pasted');
    const old = readdir(pasted).filter((name) => name.startsWith('pasted-') && this.now() - mtime(path.join(pasted, name)) > 7 * DAY);
    if (old.length) {
      const bytes = old.reduce((sum, name) => sum + fileSize(path.join(pasted, name)), 0);
      out.push(
        item({ id: 'pasted:old', kind: 'pasted', label: `${old.length} pasted image${old.length === 1 ? '' : 's'} older than a week`, path: pasted, bytes, lastActivityAt: Math.max(...old.map((name) => mtime(path.join(pasted, name)))), meta: { names: old, sized: true } }),
      );
    }

    // Removals a previous run started and did not finish.
    for (const trash of caches.pendingTrash(this.#checkouts ?? this.checkouts())) {
      out.push(item({ id: `trash:${trash}`, kind: 'trash', label: path.basename(trash), path: trash, bytes: this.sizes.known(trash)?.bytes ?? 0, lastActivityAt: mtime(trash), detail: 'being deleted in the background', meta: { sized: Boolean(this.sizes.known(trash)) } }));
    }
    return out;
  }

  async browserItems() {
    if (!this.browser) return [];
    let bytes = 0;
    try {
      bytes = await this.browser.size();
    } catch {
      return [];
    }
    return [
      item({ id: 'browser:cache', kind: 'browser-cache', label: 'Browser cache', path: path.join(this.userData, 'Cache'), bytes, lastActivityAt: mtime(path.join(this.userData, 'Cache')), detail: 'pages and images the window fetched; refilled as they are needed', meta: { sized: true } }),
    ];
  }

  // --- removing -------------------------------------------------------------------

  /**
   * Remove reversible items by id. Each is looked at again now: an id for a
   * folder that is gone is a success, an id for something that is not
   * reversible is refused rather than quietly done.
   */
  async free(ids = []) {
    const current = this.last && this.now() - this.last.at < LAST_INVENTORY_MS ? this.last : await this.inventory();
    const byId = new Map(current.items.map((one) => [one.id, one]));
    const results = [];
    let freed = 0;
    let index = 0;
    for (const id of ids) {
      const one = byId.get(id);
      index += 1;
      this.emit('progress', { op: 'free', index, total: ids.length, label: one?.label ?? id, freed, done: false });
      if (!one) {
        results.push({ id, ok: true, bytes: 0, note: 'already gone' });
        continue;
      }
      if (!one.reversible) {
        results.push({ id, ok: false, error: `${KINDS[one.kind].label} is not something this button removes.` });
        continue;
      }
      try {
        this.#guard(one);
        await this.#freeOne(one);
        freed += one.bytes;
        this.store.log({ action: 'free', kind: one.kind, label: one.label, bytes: one.bytes, ok: true });
        results.push({ id, ok: true, bytes: one.bytes });
      } catch (error) {
        const message = String(error?.message ?? error);
        this.store.log({ action: 'free', kind: one.kind, label: one.label, bytes: 0, ok: false, detail: message });
        results.push({ id, ok: false, error: message });
      }
    }
    this.emit('progress', { op: 'free', index: ids.length, total: ids.length, label: null, freed, done: true, failed: results.filter((one) => !one.ok).length });
    return { results, freed };
  }

  /**
   * Before anything is removed, its path is checked against where its kind lives.
   *
   * The ids come from the window, and the window is trusted — but an id made
   * from a path is still a path, and the cheapest defence against a mistake
   * anywhere upstream is to refuse to delete a database backup that is not
   * beside the database, or a copied data folder that is not beside this one.
   */
  #guard(one) {
    const target = one.path ? path.resolve(one.path) : null;
    const under = (parent) => target && (target === parent || target.startsWith(parent + path.sep));
    const userData = path.resolve(this.userData);
    switch (one.kind) {
      case 'build-cache':
      case 'trash': {
        const checkouts = this.#checkouts ?? this.checkouts();
        const checkout = checkouts.find((candidate) => target && path.dirname(target) === path.resolve(candidate));
        if (!checkout) throw new Error(`${one.label} is not directly inside a checkout this app looks through.`);
        // Asked again now, not at inventory time: a session may have walked into this checkout since the list was made.
        const root = path.resolve(checkout);
        if (one.kind === 'build-cache' && this.live().some((cwd) => cwd && (cwd === root || cwd.startsWith(root + path.sep)))) {
          throw new Error(`a session is working in ${path.basename(checkout)} right now; its cache is left alone.`);
        }
        return;
      }
      case 'db-backup':
        if (!target || path.dirname(target) !== userData || !path.basename(target).startsWith('smart-terminal.db.backup')) throw new Error(`${one.label} is not a database backup beside the database.`);
        return;
      case 'install-backup':
        if (!target || path.dirname(target) !== path.dirname(userData) || target === userData) throw new Error(`${one.label} is not a copy of the data folder beside this one.`);
        return;
      case 'installer':
        if (!under(path.join(userData, 'updates'))) throw new Error(`${one.label} is not in the updates folder.`);
        return;
      case 'pasted':
        if (target !== path.join(userData, 'pasted')) throw new Error('Not the pasted-images folder.');
        return;
      default:
        return;
    }
  }

  async #freeOne(one) {
    switch (one.kind) {
      case 'build-cache': {
        // Renamed aside at once, then deleted here with the worker saying how far it is: a cache can be seventy gigabytes.
        const result = await caches.discard(one.path, { now: this.now(), remove: async () => {} });
        if (result.trash) await this.#removeTree(result.trash, one.label, one.bytes);
        this.sizes.forget(one.path);
        return result;
      }
      case 'db-backup':
      case 'installer':
        await fsp.rm(one.path, { force: true });
        return { ok: true };
      case 'install-backup':
      case 'trash':
        await fsp.rm(one.path, { recursive: true, force: true, maxRetries: 2 });
        this.sizes.forget(one.path);
        return { ok: true };
      case 'pasted':
        for (const name of one.meta?.names ?? []) await fsp.rm(path.join(one.path, name), { force: true }).catch(() => {});
        return { ok: true };
      case 'browser-cache':
        await this.browser?.clear?.();
        return { ok: true };
      default:
        throw new Error(`${one.kind} is not reversible.`);
    }
  }

  /**
   * Delete ended sessions and their saved copies, in one transaction for the
   * database and one pass for the files. A session still being recorded is an
   * ended tab whose copy is still being written; it is skipped like a running
   * one, because deleting under a writer leaves a copy with no session.
   */
  deleteSessions(sessionIds = []) {
    const recording = new Set(this.context?.trackedIds?.() ?? []);
    const wanted = [...new Set(sessionIds)].filter((id) => !recording.has(id));
    const gone = this.db.deleteSessions(wanted);
    let bytes = 0;
    for (const id of gone) {
      const dir = path.join(this.userData, 'context-snapshots', id);
      bytes += snapshotBytes(dir);
      try {
        this.context?.forget?.(id);
      } catch {
        /* the folder may already be gone */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (gone.length) this.store.log({ action: 'delete-sessions', kind: 'session', label: `${gone.length} session${gone.length === 1 ? '' : 's'}`, bytes, ok: true });
    this.emit('progress', { op: 'delete-sessions', index: gone.length, total: wanted.length, label: null, freed: bytes, done: true });
    return { deleted: gone, skipped: sessionIds.filter((id) => !gone.includes(id)), bytes };
  }

  /** Delete only the kept conversations of sessions, leaving the record of what ran. */
  forgetTranscripts(sessionIds = []) {
    let bytes = 0;
    let count = 0;
    for (const id of new Set(sessionIds)) {
      const dir = path.join(this.userData, 'context-snapshots', id);
      const before = (this.db.sessionSizes([id])[id] ?? 0) + snapshotBytes(dir);
      this.db.forgetTranscript(id);
      try {
        this.context?.setRecording?.(id, false);
        this.context?.forget?.(id);
      } catch {
        /* not tracked */
      }
      fs.rmSync(dir, { recursive: true, force: true });
      bytes += before;
      count += 1;
    }
    if (count) this.store.log({ action: 'forget-transcripts', kind: 'session', label: `${count} conversation${count === 1 ? '' : 's'}`, bytes, ok: true });
    this.emit('progress', { op: 'forget-transcripts', index: count, total: count, label: null, freed: bytes, done: true });
    return { count, bytes };
  }

  /**
   * Remove worktrees by item id. The inventory looks at each again now and refuses
   * anything with a blocker; git refuses anything that changed since. A finished
   * branch is deleted, an unfinished one keeps its commits.
   */
  async removeWorktrees(ids = [], { force = false } = {}) {
    const paths = ids.map((id) => String(id)).filter((id) => id.startsWith('worktree:')).map((id) => id.slice('worktree:'.length));
    this.emit('progress', { op: 'remove-worktrees', index: 0, total: paths.length, label: 'looking at each worktree again', freed: 0, done: false });
    /*
     * The caches inside go first, by hand and with progress: git worktree remove deletes the
     * folder in one opaque call, and a worktree is mostly its .angular and node_modules. Once
     * those are gone the git step is instant. Only caches git ignores, only in worktrees the
     * inventory says are removable — the same checks the removal itself makes a moment later.
     */
    const rows = new Map((await this.worktrees.list()).map((row) => [row.path, row]));
    let cleared = 0;
    /** Bytes of caches deleted per worktree, so each result says what it gave back even after its size was forgotten. */
    const clearedBy = new Map();
    for (const target of paths) {
      const row = rows.get(target);
      if (!row || (row.blockers.length && !(force && row.forceable))) continue;
      const inside = caches.findIn(target);
      const ignored = await caches.ignoredIn(target, inside.map((one) => one.name));
      for (const found of inside) {
        if (!ignored.has(found.name)) continue;
        try {
          const expected = this.sizes.known(found.path)?.bytes ?? 0;
          const aside = await caches.discard(found.path, { now: this.now(), confirmIgnored: false, remove: async () => {} });
          if (aside.trash) {
            const out = await this.#removeTree(aside.trash, `${path.basename(target)}/${found.name}`, expected);
            cleared += out.bytes;
            clearedBy.set(target, (clearedBy.get(target) ?? 0) + out.bytes);
          }
        } catch {
          /* git will say if the worktree cannot go */
        }
      }
    }
    const results = await this.worktrees.remove(paths, { force, onEach: ({ index, total, label }) => this.emit('progress', { op: 'remove-worktrees', index, total, label, freed: cleared, done: false }) });
    let freed = cleared;
    const bytesOf = new Map();
    for (const one of results) {
      const rest = Math.max(0, (this.sizes.known(one.path)?.bytes ?? 0) - (clearedBy.get(one.path) ?? 0));
      const bytes = one.ok ? rest + (clearedBy.get(one.path) ?? 0) : clearedBy.get(one.path) ?? 0;
      bytesOf.set(one.path, bytes);
      if (one.ok) {
        freed += rest;
        this.sizes.forget(one.path);
      }
      this.store.log({ action: one.forced ? 'remove-worktree-forced' : 'remove-worktree', kind: 'worktree', label: path.basename(one.path), bytes, ok: one.ok, detail: one.ok ? [one.forced ? 'work inside discarded' : null, one.branchKept ? 'branch kept' : null].filter(Boolean).join(', ') || null : one.error });
    }
    this.emit('progress', { op: 'remove-worktrees', index: paths.length, total: paths.length, label: null, freed, done: true, failed: results.filter((one) => !one.ok).length });
    return { results: results.map((one) => ({ id: `worktree:${one.path}`, ok: one.ok, bytes: bytesOf.get(one.path) ?? 0, error: one.error, note: one.branchKept ? 'branch kept' : undefined })), freed };
  }

  #closing = new Map();

  /** The panel is about to close a worktree and end the session inside: remember it, so the session's end offers nothing. */
  markClosing(target) {
    this.#closing.set(target, this.now() + 60_000);
    return true;
  }

  /** Is a folder under a worktree the panel is closing right now? */
  closing(dir) {
    const now = this.now();
    for (const [target, until] of this.#closing) {
      if (until < now) this.#closing.delete(target);
      else if (dir === target || dir.startsWith(target + path.sep)) return true;
    }
    return false;
  }

  /** Ask GitHub again about the PRs of these worktrees (or all of them), now. */
  async refreshPulls(ids = null) {
    const rows = await this.worktrees.list();
    const wanted = ids ? new Set(ids.map((id) => String(id).replace(/^worktree:/, ''))) : null;
    return this.pulls.refresh(wanted ? rows.filter((row) => wanted.has(row.path)) : rows, { force: true });
  }

  /** Point broken worktrees back at their repository. Nothing is removed. */
  async repairWorktrees(ids = []) {
    const paths = ids.map((id) => String(id)).filter((id) => id.startsWith('worktree:')).map((id) => id.slice('worktree:'.length));
    const results = await this.worktrees.repair(paths);
    for (const one of results) this.store.log({ action: 'repair-worktree', kind: 'worktree', label: path.basename(one.path), bytes: 0, ok: one.ok, detail: one.error ?? null });
    return { results: results.map((one) => ({ id: `worktree:${one.path}`, ok: one.ok, error: one.error })) };
  }

  /** Delete a tree on the worker, telling the window every few thousand files how many bytes are gone. */
  async #removeTree(target, label, expected = 0) {
    const out = await this.sizes.remove(target, {
      onProgress: ({ bytes, files }) => this.emit('progress', { op: 'delete', label, itemBytes: bytes, itemExpected: expected, files, done: false }),
    });
    this.emit('progress', { op: 'delete', label, itemBytes: out.bytes, itemExpected: expected, files: out.files, failed: out.failed, done: true });
    return out;
  }

  /** git in a folder, resolving to trimmed stdout or '' — and the error text on `.error` when asked. */
  #git(cwd, args, { timeout = 60_000 } = {}) {
    return new Promise((resolve) => {
      execFile('git', args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() }));
    });
  }

  /** The bases of a root, remote first; a repository with no origin still has its local trunk. */
  async #basesOf(root) {
    const bases = await this.worktrees.helper.basesOf(root);
    if (bases.length) return bases;
    const local = [];
    for (const name of ['develop', 'main', 'master', 'trunk']) {
      if ((await this.#git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).ok) local.push(name);
    }
    return local;
  }

  /**
   * What a pull request from this worktree would be, before anyone writes it:
   * the bases it could go against with how far ahead of each it is, a title
   * from the commits, whether the branch must be pushed first, and who would
   * take the request (the reviewer's forge for the repository, or gh).
   */
  /**
   * One worktree, read directly with five git calls instead of the whole inventory:
   * a form that opens on a click cannot wait for sixty worktrees to be looked at.
   */
  async #quickRow(target) {
    const where = fs.existsSync(target) ? target : realOf(target);
    if (!fs.existsSync(path.join(where, '.git'))) throw new Error('That is not a worktree the app knows; look again.');
    const [common, branch, head] = await Promise.all([
      this.#git(where, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      this.#git(where, ['symbolic-ref', '--short', '-q', 'HEAD']),
      this.#git(where, ['rev-parse', 'HEAD']),
    ]);
    if (!common.ok) throw new Error('git cannot read this worktree; repair it first.');
    const root = path.dirname(common.out.replace(/[\\/]\.git$/, '/.git'));
    const row = { path: where, root, label: path.basename(where), branch: branch.out || null, head: head.out, upstream: null, ahead: 0, dirtyCount: 0 };
    if (row.branch) {
      const [track, status] = await Promise.all([this.#git(root, ['for-each-ref', '--format=%(upstream:short) %(upstream:track)', `refs/heads/${row.branch}`]), this.#git(where, ['status', '--porcelain'])]);
      const [upstream, ...rest] = track.out.split(' ');
      row.upstream = upstream || null;
      row.ahead = Number((rest.join(' ').match(/ahead (\d+)/) ?? [])[1]) || 0;
      row.dirtyCount = status.out ? status.out.split('\n').filter(Boolean).length : 0;
    }
    return row;
  }

  async prDraft(target) {
    const row = await this.#quickRow(target);
    if (!row.branch) throw new Error('A detached worktree has no branch to open a pull request from.');
    const bases = [];
    for (const name of await this.#basesOf(row.root)) {
      const count = Number((await this.#git(row.root, ['rev-list', '--count', `${name}..${row.head}`])).out);
      bases.push({ name, remoteless: name.replace(/^origin\//, ''), ahead: Number.isFinite(count) ? count : null });
    }
    bases.sort((a, b) => (a.ahead ?? Infinity) - (b.ahead ?? Infinity));
    const base = bases[0] ?? null;
    const log = base ? (await this.#git(row.path, ['log', '--format=%s', '-30', `${base.name}..HEAD`])).out.split('\n').filter(Boolean) : [];
    const subject = log.length === 1 ? log[0] : row.branch.split('/').pop().replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    const remote = row.upstream ? row.upstream.split('/')[0] : (await this.#git(row.root, ['remote'])).out.split('\n').filter(Boolean)[0] ?? null;
    const forge = await this.#forgeFor(row.root);
    const url = remote ? (await this.#git(row.root, ['remote', 'get-url', remote])).out : '';
    const via = forge ? (/bitbucket/.test(url) ? 'Bitbucket' : 'GitHub') : /github\.com/.test(url) ? 'gh' : null;
    return {
      path: row.path,
      branch: row.branch,
      upstream: row.upstream,
      ahead: row.ahead,
      mustPush: !row.upstream || row.ahead > 0,
      remote,
      dirtyCount: row.dirtyCount,
      bases,
      base: base?.remoteless ?? null,
      title: subject.slice(0, 120),
      body: log.length > 1 ? log.map((line) => `- ${line}`).join('\n') : '',
      via,
      reason: via ? null : remote ? `The remote ${url || remote} is not on GitHub, and the Code Reviewer does not have this repository. Add it there (Review › Repositories) with its token.` : 'The repository has no remote to push to.',
    };
  }

  /** Push if it must, open the pull request, remember it, and say where it is. One POST: never retried. */
  async createPr(target, { title, body = '', base, push = true } = {}) {
    const draft = await this.prDraft(target);
    if (!draft.via) throw new Error(draft.reason);
    if (!title?.trim()) throw new Error('The pull request needs a title.');
    const destination = String(base || draft.base || '').replace(/^origin\//, '');
    if (!destination) throw new Error('Choose the branch the pull request goes against.');
    if (draft.mustPush) {
      if (!push) throw new Error(`${draft.branch} is not on ${draft.remote ?? 'the remote'} yet; it has to be pushed first.`);
      this.emit('progress', { op: 'create-pr', label: `pushing ${draft.branch}`, done: false });
      const pushed = await this.#git(draft.path, ['push', '-u', draft.remote, `${draft.branch}:${draft.branch}`], { timeout: 5 * 60_000 });
      if (!pushed.ok) throw new Error(`git push failed: ${pushed.err.split('\n').pop() || 'unknown'}`);
      this.worktrees.memo.delete(draft.path);
    }
    this.emit('progress', { op: 'create-pr', label: `opening the pull request against ${destination}`, done: false });
    let created;
    const row = await this.#quickRow(draft.path);
    if (draft.via === 'gh') {
      const done = await new Promise((resolve) => {
        execFile('gh', ['pr', 'create', '--head', draft.branch, '--base', destination, '--title', title.trim(), '--body', body ?? ''], { cwd: draft.path, timeout: 60_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() }));
      });
      if (!done.ok) throw new Error(`gh pr create failed: ${done.err.split('\n').pop() || 'unknown'}`);
      const url = done.out.split('\n').pop();
      created = { id: Number(url.split('/').pop()) || null, url };
    } else {
      const forge = await this.#forgeFor(row.root);
      created = await forge.createPr({ title: title.trim(), description: body ?? '', source: draft.branch, destination });
    }
    this.store.log({ action: 'create-pr', kind: 'worktree', label: path.basename(draft.path), bytes: 0, ok: true, detail: `#${created.id} → ${destination}` });
    this.worktrees.memo.delete(draft.path);
    await this.pulls.refresh([row], { force: true }).catch(() => {});
    this.emit('progress', { op: 'create-pr', label: null, done: true });
    return { ...created, base: destination, branch: draft.branch };
  }

  /**
   * What a Claude session opened in a worktree is told: where it stands, what
   * is unmerged or uncommitted, and the ask — finish it or say why not. Facts
   * from git and the inventory, then the question; nothing runs.
   */
  async worktreeBrief(target) {
    const rows = await this.worktrees.list();
    const row = rows.find((one) => one.path === target || one.path === realOf(target));
    if (!row) throw new Error('That is not a worktree the app knows; look again.');
    const git = (args) =>
      new Promise((resolve) => {
        require('node:child_process').execFile('git', args, { cwd: row.path, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : String(stdout ?? '').trim()));
      });
    let bases = await this.worktrees.helper.basesOf(row.root);
    // A repository with no origin still has a trunk: the local base branches, when origin/* is not there.
    if (!bases.length) {
      for (const name of ['develop', 'main', 'master', 'trunk']) {
        if (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) bases.push(name);
      }
    }
    let base = null;
    let least = Infinity;
    for (const candidate of bases) {
      const count = Number(await git(['rev-list', '--count', `${candidate}..${row.head}`]));
      if (Number.isFinite(count) && count < least) {
        least = count;
        base = candidate;
      }
    }
    const commits = base ? await git(['log', '--oneline', '--no-decorate', '-25', `${base}..HEAD`]) : '';
    const status = await git(['status', '--short']);
    const lines = [];
    lines.push(`# Worktree ${row.label} (${row.repo})`);
    lines.push('');
    lines.push(`- Path: ${row.path}`);
    lines.push(`- Branch: ${row.branch ?? '(detached)'}${row.upstream ? `, tracks ${row.upstream}` : row.ownWork ? ', no upstream (never pushed)' : ''}`);
    lines.push(`- State: ${row.state}${row.finished ? ' (its work is already on a base branch)' : ''}`);
    if (base) lines.push(`- Nearest base: ${base}, ${least} commit${least === 1 ? '' : 's'} ahead`);
    if (row.dirtyCount) lines.push(`- Uncommitted: ${row.dirtyCount} file${row.dirtyCount === 1 ? '' : 's'}`);
    if (row.lastCommitAt) lines.push(`- Last commit: ${new Date(row.lastCommitAt).toISOString().slice(0, 10)}`);
    if (commits) {
      lines.push('');
      lines.push(`## Commits not on ${base}`);
      for (const line of commits.split('\n')) lines.push(`- ${line}`);
    }
    if (status) {
      lines.push('');
      lines.push('## Uncommitted changes (git status --short)');
      for (const line of status.split('\n').slice(0, 30)) lines.push(`    ${line}`);
    }
    lines.push('');
    lines.push('## Ask');
    lines.push(
      row.finished
        ? 'This worktree\'s work is already merged. Check nothing uncommitted here still matters; if it does not, say so plainly and I will remove the worktree from Housekeeping. Do not remove it yourself.'
        : 'Finish this worktree\'s work. Read the commits and the uncommitted changes, run the tests if they are cheap, then either: commit what is worth committing, push the branch (set its upstream if it has none) and open a pull request against the nearest base with a clear description — through the `bitbucket` tools (pull_requests to see whether one exists, create_pull_request to open it; the user confirms in a dialog) when they are listed, with `gh` otherwise; or, if this work should be dropped, say so and why. Do not remove or force-reset the worktree; Housekeeping does that once you report.',
    );
    return lines.join('\n');
  }

  /** Discard the Code Reviewer's clones for pull requests that are finished. The reviewer's own checks still apply. */
  async discardWorkshops(ids = []) {
    const results = [];
    for (const id of ids) {
      const [, repoId, prId] = String(id).split(':');
      if (!repoId || !prId || !this.review?.discard) {
        results.push({ id, ok: false, error: 'Not a review clone.' });
        continue;
      }
      try {
        const bytes = this.sizes.known(this.review.dirOf?.(repoId, prId) ?? '')?.bytes ?? 0;
        await this.review.discard(repoId, prId);
        this.store.log({ action: 'discard-workshop', kind: 'workshop', label: `PR #${prId}`, bytes, ok: true });
        results.push({ id, ok: true, bytes });
      } catch (error) {
        const message = String(error?.message ?? error);
        this.store.log({ action: 'discard-workshop', kind: 'workshop', label: `PR #${prId}`, bytes: 0, ok: false, detail: message });
        results.push({ id, ok: false, error: message });
      }
    }
    return { results };
  }

  /**
   * The tidying of the tidier, once at start: removals a previous run left half
   * done are finished, sizes of folders that no longer exist are forgotten, and
   * the log is cut to a year. Nothing that was not already going is removed.
   */
  async sweep() {
    const swept = await caches.sweep(this.checkouts());
    const forgotten = this.sizes.pruneMissing?.() ?? 0;
    const trimmed = this.store.trimLog();
    const readings = this.store.trimReadings?.() ?? 0;
    const jobs = this.store.trimJobs?.() ?? 0;
    this.store.trimDaily?.();
    return { swept, forgotten, trimmed, readings, jobs };
  }

  log(limit = 50) {
    return this.store.recentLog(limit);
  }
}

// --- small helpers -----------------------------------------------------------

/** A path as the filesystem spells it, or as given when it is not there; cached, since the same folder is asked hundreds of times per inventory. */
const realCache = new Map();
function realOf(target) {
  if (!target) return target;
  const kept = realCache.get(target);
  if (kept) return kept;
  let real = target;
  try {
    real = fs.realpathSync(target);
  } catch {
    /* as given */
  }
  if (realCache.size > 5000) realCache.clear();
  realCache.set(target, real);
  return real;
}

/** `Promise.all` with at most `limit` in flight, in the order given. */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const index = next++;
      out[index] = await fn(list[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function readdir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function mtime(target) {
  try {
    return Math.floor(fs.statSync(target).mtimeMs);
  } catch {
    return null;
  }
}

/** A snapshot folder is two files; adding them up here is cheaper than asking the worker. */
function snapshotBytes(dir) {
  let bytes = 0;
  for (const name of readdir(dir)) bytes += fileSize(path.join(dir, name));
  return bytes;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Free and total bytes of the volume holding `where`; nulls where the platform will not say. */
function diskFree(where) {
  try {
    const stat = fs.statfsSync(where);
    return { free: Number(stat.bavail) * Number(stat.bsize), total: Number(stat.blocks) * Number(stat.bsize) };
  } catch {
    return { free: null, total: null };
  }
}

const fmt = formatBytes;

module.exports = { Housekeeping, diskFree, snapshotBytes };
