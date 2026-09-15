'use strict';

/**
 * An extension that changed and did not say so.
 *
 * The version in an `extension.json` is not decoration. It is the whole of what
 * the gallery compares against the version somebody has installed, and the only
 * thing that turns a row into "Update to v1.1.0" — so an extension that is
 * improved without its version moving is an improvement nobody is ever offered.
 * That is not a theoretical worry: it had happened three times before this test
 * existed, to the Code Reviewer, the Maven panel and the Spring Boot panel, and
 * each of those was hundreds of lines of work that the app had no way to mention.
 *
 * So the rule is: **if the files under `extensions/<id>/` differ from the
 * integration branch, the version must differ too.**
 *
 * Checked against the branch rather than against the last commit on purpose. A
 * branch that bumps the version first and then goes on editing the panel is
 * doing exactly the right thing, and a test that compared neighbouring commits
 * would fail it for the ordering. What matters is the state somebody is asked to
 * merge, which is what this compares.
 *
 * Nothing here runs when there is no branch to compare against — a fresh clone
 * without the remote ref, a tarball, a detached CI checkout. A test that cannot
 * do its job says so rather than failing, since the alternative is a red suite
 * that teaches people to ignore it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** The branch this work would be merged into, if it can be worked out at all. */
function integrationBase() {
  for (const ref of ['origin/develop', 'origin/main']) {
    try {
      git(['rev-parse', '--verify', `${ref}^{commit}`]);
      return git(['merge-base', 'HEAD', ref]);
    } catch {
      /* Not every checkout has every remote branch. */
    }
  }
  return null;
}

const versionIn = (text) => JSON.parse(text).version ?? null;

test('an extension whose files changed has a version that changed with them', (t) => {
  let base;
  try {
    base = integrationBase();
  } catch {
    base = null;
  }
  if (!base) {
    t.skip('no integration branch to compare against in this checkout');
    return;
  }

  const dir = path.join(root, 'extensions');
  const ids = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => fs.existsSync(path.join(dir, id, 'extension.json')));

  assert.ok(ids.length > 0, 'there are extensions to check');

  const missed = [];
  for (const id of ids) {
    const where = `extensions/${id}`;

    /*
     * Nothing changed here, so there is nothing to have announced.
     *
     * Untracked files are asked about separately, and finding that out was
     * worth the trouble: `git diff` does not see a file that was never added,
     * so an extension that *gains* one — a second panel, an icon, a renderer —
     * looked unchanged to the first version of this test. Half the extensions
     * in this repository are one file plus a manifest, so gaining a file is a
     * perfectly ordinary way for one of them to change.
     */
    const edited = (() => {
      try {
        git(['diff', '--quiet', base, '--', where]);
        return false;
      } catch {
        return true;
      }
    })();
    const added = git(['ls-files', '--others', '--exclude-standard', '--', where]).length > 0;
    if (!edited && !added) continue;

    const now = versionIn(fs.readFileSync(path.join(dir, id, 'extension.json'), 'utf8'));
    let before;
    try {
      before = versionIn(git(['show', `${base}:${where}/extension.json`]));
    } catch {
      // New on this branch: there is no installed version to be newer than.
      continue;
    }

    if (now === before) {
      const files = [
        ...git(['diff', '--name-only', base, '--', where]).split('\n'),
        ...git(['ls-files', '--others', '--exclude-standard', '--', where]).split('\n'),
      ].filter(Boolean);
      missed.push(`  ${id} (still ${now}) — changed: ${files.join(', ')}`);
    }
  }

  assert.deepStrictEqual(
    missed,
    [],
    `These extensions changed without their version moving, so nobody will be offered the change:\n${missed.join(
      '\n',
    )}\n\nBump "version" in each extension.json.`,
  );
});
