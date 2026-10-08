'use strict';

/*
 * A merge stopped on conflicts in a working copy, fixed from the Git panel —
 * against real git, with Claude played by a script.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const git = require('../electron/git');
const { LocalConflicts } = require('../electron/git-conflicts');

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

/** main and feature both changed one line; feature is merged into main and stops. */
function conflicted() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-conflicts-'));
  sh(root, 'init', '-q');
  sh(root, 'config', 'user.name', 'T');
  sh(root, 'config', 'user.email', 't@t');
  fs.writeFileSync(path.join(root, 'a.scss'), '.a { color: red; }\n');
  fs.writeFileSync(path.join(root, 'NOTES.md'), 'Title\n=======\n\ntext\n');
  sh(root, 'add', '.');
  sh(root, 'commit', '-qm', 'base');
  sh(root, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(root, 'a.scss'), '.a { color: blue; }\n');
  sh(root, 'commit', '-qam', 'blue');
  sh(root, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(root, 'a.scss'), '.a { color: green; }\n');
  fs.writeFileSync(path.join(root, 'NOTES.md'), 'Title\n=======\n\nmore text\n');
  sh(root, 'commit', '-qam', 'green');
  try {
    sh(root, 'merge', '--no-edit', 'feature');
  } catch {
    // Stops on the conflict, as it should.
  }
  return root;
}

function script(...answers) {
  const runs = [];
  return {
    runs,
    run: async (options) => {
      runs.push(options);
      const answer = answers.shift();
      if (!answer) throw new Error('no scripted answer');
      return { ok: true, text: '', stderr: '', toolUses: 2, denials: [], limits: [], costUsd: 0, ...(await answer(options)) };
    },
  };
}

const plan = { cause: 'Both sides changed the colour.', summary: 'Keep blue.', files: [{ path: 'a.scss', approach: 'THEIRS', what: 'green vs blue', proposal: 'blue' }], risks: '' };

test('a merge in progress is reported with the files in conflict, and a Markdown heading is not one', async () => {
  const root = conflicted();
  const status = await git.status(root);
  assert.ok(status.merge, 'the merge is seen');
  assert.match(status.merge.message, /Merge branch 'feature'/);
  assert.deepEqual(status.merge.conflicted, ['a.scss']);
  // Added with its markers still in: git calls it resolved, the panel does not.
  sh(root, 'add', 'a.scss');
  const added = await git.status(root);
  assert.deepEqual(added.merge.conflicted, ['a.scss']);
  assert.equal(added.files.find((file) => file.path === 'a.scss').markers, true);
  sh(root, 'merge', '--abort');
  assert.equal((await git.status(root)).merge, null, 'no merge, nothing reported');
});

test('fix conflicts: a proposal first, then the files resolved and staged, then the merge concluded', async () => {
  const root = conflicted();
  const claude = script(
    async () => ({ structured: plan }),
    async ({ cwd }) => {
      fs.writeFileSync(path.join(cwd, 'a.scss'), '.a { color: blue; }\n');
      return { structured: { resolved: true, summary: 'Kept blue.' } };
    },
  );
  const fixer = new LocalConflicts({ claude: () => claude });

  const analyzed = await fixer.analyze(root);
  assert.equal(analyzed.step, 'PROPOSED');
  assert.match(analyzed.plan.cause, /colour/);
  assert.equal(claude.runs[0].disallowedTools.includes('Edit'), true, 'analysis cannot edit');
  assert.match(fs.readFileSync(path.join(root, 'a.scss'), 'utf8'), /^<{7}/m, 'analysis changed nothing');

  const resolved = await fixer.resolve(root);
  assert.equal(resolved.step, 'RESOLVED');
  assert.ok(claude.runs[1].disallowedTools.some((rule) => /git commit/.test(rule)), 'resolving cannot commit');
  const status = await git.status(root);
  assert.deepEqual(status.merge.conflicted, []);
  assert.equal(status.files.find((file) => file.path === 'a.scss').staged, true, 'left staged to be looked at');
  assert.ok(status.merge, 'and not committed');

  await fixer.conclude(root);
  assert.equal((await git.status(root)).merge, null);
  assert.equal(sh(root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'a merge commit');
});

test('a resolution that leaves a marker stages nothing, and conclude refuses while anything is in conflict', async () => {
  const root = conflicted();
  const fixer = new LocalConflicts({ claude: () => script(async () => ({ structured: plan }), async () => ({ structured: { resolved: true, summary: 'says so' } })) });
  await fixer.analyze(root);
  await assert.rejects(fixer.resolve(root), /markers are still in a\.scss/);
  assert.equal(fixer.job(root).step, 'PROPOSED', 'back to the proposal');
  await assert.rejects(fixer.conclude(root), /still have conflicts/);
  assert.ok((await git.status(root)).merge, 'the merge is still there to fix');
});

/** A repository whose merge of `feature` into main stops, built by `shape(root, commit)`. */
function repoWith(shape) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-conflicts-'));
  sh(root, 'init', '-q');
  sh(root, 'config', 'user.name', 'T');
  sh(root, 'config', 'user.email', 't@t');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  shape({ root, write, git: (...args) => sh(root, ...args) });
  try {
    sh(root, 'merge', '--no-edit', 'feature');
  } catch {
    // Stops on the conflict.
  }
  return root;
}

const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');

test('a file fixed by hand and not added is not a conflict, and concluding adds it — and only it', async () => {
  const root = repoWith(({ write, git }) => {
    write('a.scss', 'red\n');
    write('mine.txt', 'mine\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature');
    write('a.scss', 'blue\n');
    git('commit', '-qam', 'blue');
    git('checkout', '-q', 'main');
    write('a.scss', 'green\n');
    git('commit', '-qam', 'green');
    // Somebody's own work, nothing to do with the merge.
    write('mine.txt', 'mine, edited\n');
  });
  fs.writeFileSync(path.join(root, 'a.scss'), 'blue and green\n');
  const status = await git.status(root);
  assert.deepEqual(status.merge.conflicted, [], 'no markers left: not a conflict');
  assert.deepEqual(status.merge.settled, ['a.scss']);

  await new LocalConflicts({ claude: () => null }).conclude(root);
  assert.equal((await git.status(root)).merge, null);
  assert.equal(sh(root, 'show', 'HEAD:a.scss'), 'blue and green');
  assert.equal(sh(root, 'show', 'HEAD:mine.txt'), 'mine', 'the unrelated edit is not in the merge commit');
  assert.equal(read(root, 'mine.txt'), 'mine, edited\n', 'and it is still there, uncommitted');
});

test('deleted on one side, changed on the other: a conflict with no markers, resolved by a decision', async () => {
  const root = repoWith(({ write, git }) => {
    write('old.ts', 'export const x = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature');
    git('rm', '-q', 'old.ts');
    git('commit', '-qm', 'drop old');
    git('checkout', '-q', 'main');
    write('old.ts', 'export const x = 2;\n');
    git('commit', '-qam', 'change old');
  });
  const status = await git.status(root);
  assert.deepEqual(status.merge.conflicted, ['old.ts']);
  const claude = script(
    async ({ prompt }) => {
      assert.match(prompt, /old\.ts \(.*borró/, 'the analysis is told what kind of conflict it is');
      return { structured: { cause: 'one side deleted it', summary: 'delete it', files: [{ path: 'old.ts', approach: 'THEIRS', what: '', proposal: 'delete' }] } };
    },
    async ({ cwd }) => {
      fs.rmSync(path.join(cwd, 'old.ts'));
      return { structured: { resolved: true, summary: 'Deleted, as the feature wanted.' } };
    },
  );
  const fixer = new LocalConflicts({ claude: () => claude });
  await fixer.analyze(root);
  await fixer.resolve(root);
  await fixer.conclude(root);
  assert.throws(() => sh(root, 'show', 'HEAD:old.ts'), 'the deletion is what was committed');
});

test('what Claude touches besides the conflict is staged with it; the person\'s own changes are not', async () => {
  const root = repoWith(({ write, git }) => {
    write('src/a b.ts', 'import { x } from "./x";\nx(1);\n');
    write('src/x.ts', 'export const x = (n) => n;\n');
    write('notes.txt', 'n\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature');
    write('src/a b.ts', 'import { x } from "./x";\nx(2);\n');
    git('commit', '-qam', 'two');
    git('checkout', '-q', 'main');
    write('src/a b.ts', 'import { x } from "./x";\nx(3);\n');
    git('commit', '-qam', 'three');
    write('notes.txt', 'n, mine\n');
  });
  assert.deepEqual((await git.status(root)).merge.conflicted, ['src/a b.ts'], 'a path with a space in it');
  const claude = script(
    async () => ({ structured: plan }),
    async ({ cwd }) => {
      fs.writeFileSync(path.join(cwd, 'src/a b.ts'), 'import { x } from "./x";\nx(2 + 3);\n');
      fs.writeFileSync(path.join(cwd, 'src/x.ts'), 'export const x = (n: number) => n;\n');
      return { structured: { resolved: true, summary: 'Both, and typed x.' } };
    },
  );
  const fixer = new LocalConflicts({ claude: () => claude });
  await fixer.analyze(root);
  const done = await fixer.resolve(root);
  assert.deepEqual(done.touched, ['src/x.ts']);
  const files = (await git.status(root)).files;
  assert.equal(files.find((file) => file.path === 'src/x.ts').staged, true);
  assert.equal(files.find((file) => file.path === 'notes.txt').staged, false, 'not theirs to stage');
});

test('the steps refuse what does not make sense: no merge, nothing in conflict, a different merge, no Claude', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'git-conflicts-'));
  sh(plain, 'init', '-q');
  const fixer = new LocalConflicts({ claude: () => script(async () => ({ structured: plan })) });
  await assert.rejects(fixer.analyze(plain), /No merge is in progress/);

  const root = conflicted();
  await assert.rejects(new LocalConflicts({ claude: () => null }).analyze(root), /Claude is not available/);
  await assert.rejects(fixer.resolve(root), /no proposal/);
  await fixer.analyze(root);
  // The merge is abandoned and another one started: the proposal was about something else.
  sh(root, 'merge', '--abort');
  sh(root, 'checkout', '-qb', 'other', 'feature');
  fs.writeFileSync(path.join(root, 'a.scss'), '.a { color: pink; }\n');
  sh(root, 'commit', '-qam', 'pink');
  sh(root, 'checkout', '-q', 'main');
  try {
    sh(root, 'merge', '--no-edit', 'other');
  } catch {
    // Stops.
  }
  await assert.rejects(fixer.resolve(root), /different merge/);

  const clean = repoWith(({ write, git }) => {
    write('a', '1\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature');
    write('b', '2\n');
    git('add', '.');
    git('commit', '-qm', 'b');
    git('checkout', '-q', 'main');
    write('c', '3\n');
    git('add', '.');
    git('commit', '-qm', 'c');
  });
  // That one merged by itself; a merge stopped with --no-commit has nothing in conflict.
  assert.equal((await git.status(clean)).merge, null);
});

test('a cancelled or failed run says so and leaves the merge as it was', async () => {
  const root = conflicted();
  const fixer = new LocalConflicts({
    claude: () => ({ run: async () => ({ ok: false, cancelled: true, stderr: '', toolUses: 0, denials: [], limits: [] }) }),
  });
  await assert.rejects(fixer.analyze(root), /Cancelled/);
  assert.equal(fixer.job(root).step, 'FAILED');
  assert.equal(fixer.job(root).busy, false);
  assert.match(read(root, 'a.scss'), /^<{7}/m);
});
