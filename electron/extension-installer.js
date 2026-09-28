'use strict';

/**
 * Installing an extension from its repository, in two steps with a person
 * between them.
 *
 * `inspect` downloads the code at one commit, unpacks it into a staging folder,
 * and reads what it says it is and what it wants. Nothing is installed; the
 * answer is what the consent screen shows. `commit` moves exactly that folder
 * into place — the files the person was shown are the files that run, because
 * nothing is fetched a second time.
 *
 * An entry from the registry must match what it says: the id, the version and
 * the permissions in the downloaded manifest have to be the ones that were
 * reviewed, or it is refused. A direct install from a repository has no review
 * behind it, and the screen says so.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { extract, ArchiveError } = require('./extension-archive');
const { parseRepo, resolve, download, SourceError, repoUrl } = require('./extension-source');
const { readManifest, compareVersions } = require('./extensions');
const { PERMISSIONS } = require('./extension-permissions');

const STAGED_FOR_MS = 15 * 60 * 1000;

class InstallError extends Error {}

const sameSet = (a, b) => a.length === b.length && [...a].sort().every((value, i) => value === [...b].sort()[i]);

function installer({ root, fetch, registry, builtInIds, now = Date.now }) {
  const staged = new Map();
  const stagingRoot = path.join(root, '.staging');

  function discardDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /** Leftovers from a crash or a closed window: staging and old copies. */
  function sweep() {
    fs.mkdirSync(root, { recursive: true });
    discardDir(stagingRoot);
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith('.trash-')) discardDir(path.join(root, name));
    }
    staged.clear();
  }

  function expire() {
    for (const [token, entry] of staged) {
      if (now() - entry.at > STAGED_FOR_MS) {
        discardDir(entry.dir);
        staged.delete(token);
      }
    }
  }

  async function inspect({ repo: input, id } = {}) {
    expire();
    let owner;
    let repo;
    let sha;
    let ref;
    let how;
    let subdir = '';
    let listed = null;

    if (id) {
      const { entries } = await registry.list();
      listed = entries.find((entry) => entry.id === id) ?? null;
      if (!listed) throw new InstallError(`${id} is not in the registry`);
      ({ owner, repoName: repo, commit: sha, path: subdir } = listed);
      ref = listed.version;
      how = 'reviewed in the registry';
    } else {
      ({ owner, repo, ref } = parseRepo(input));
      ({ sha, ref, how } = await resolve(fetch, { owner, repo, ref }));
    }

    const archive = await download(fetch, { owner, repo, sha });
    const token = crypto.randomBytes(12).toString('hex');
    fs.mkdirSync(stagingRoot, { recursive: true });
    const dir = path.join(stagingRoot, token);
    try {
      const { comment } = extract(archive, dir, { strip: 1, subdir });
      // `git archive` writes the commit into the tarball; when it is there it must be this one.
      if (comment && /^[0-9a-f]{40}$/.test(comment) && comment !== sha) {
        throw new InstallError('The download is not the commit that was asked for');
      }
      // Provenance is the app's to write, after this.
      fs.rmSync(path.join(dir, '.source.json'), { force: true });

      const manifest = readManifest(dir);
      if (!manifest) {
        throw new InstallError(
          subdir
            ? `There is no extension.json in ${subdir} of that repository`
            : 'That repository has no extension.json at its top level, so it is not an extension',
        );
      }
      if (manifest.broken) throw new InstallError(`Its extension.json ${manifest.error.replace(/^its manifest /, '')}`);
      if (builtInIds().has(manifest.id)) {
        throw new InstallError(`It calls itself "${manifest.id}", which is the id of an extension that ships with this app`);
      }
      if (listed) {
        if (manifest.id !== listed.id) throw new InstallError(`The registry lists ${listed.id}, but the code calls itself ${manifest.id}`);
        if (manifest.version !== listed.version) {
          throw new InstallError(`The registry reviewed version ${listed.version}, but the code says ${manifest.version}`);
        }
        if (!sameSet(manifest.permissions, listed.permissions)) {
          throw new InstallError('The code asks for different permissions than the registry reviewed');
        }
      }

      const existing = readManifest(path.join(root, manifest.id));
      const had = existing && !existing.broken ? existing : null;
      const added = manifest.permissions.filter((name) => !(had?.permissions ?? []).includes(name));

      staged.set(token, {
        at: now(),
        dir,
        id: manifest.id,
        source: { repo: repoUrl({ owner, repo }), commit: sha, ref, reviewed: Boolean(listed) },
      });

      return {
        token,
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        author: manifest.author,
        summary: manifest.summary,
        permissions: manifest.permissions.map((name) => ({ name, text: PERMISSIONS[name], added: added.includes(name) })),
        contributes: {
          previews: (manifest.contributes?.previews ?? []).length,
          panels: (manifest.contributes?.panels ?? []).length,
        },
        repo: repoUrl({ owner, repo }),
        commit: sha,
        ref,
        how,
        reviewed: Boolean(listed),
        replacing: had
          ? { version: had.version, downgrade: compareVersions(manifest.version, had.version) < 0 }
          : null,
      };
    } catch (error) {
      discardDir(dir);
      throw error;
    }
  }

  /** Put what was inspected in place. Returns the manifest that is now installed. */
  function commit(token) {
    expire();
    const entry = staged.get(String(token ?? ''));
    if (!entry) throw new InstallError('That download expired. Look it up again.');
    staged.delete(token);
    const target = path.join(root, entry.id);
    const trash = path.join(root, `.trash-${entry.id}-${now()}`);
    const hadOld = fs.existsSync(target);
    if (hadOld) fs.renameSync(target, trash);
    try {
      fs.renameSync(entry.dir, target);
    } catch (error) {
      if (hadOld) fs.renameSync(trash, target);
      discardDir(entry.dir);
      throw error;
    }
    fs.writeFileSync(
      path.join(target, '.source.json'),
      JSON.stringify({ ...entry.source, installedAt: now() }, null, 2),
    );
    if (hadOld) discardDir(trash);
    const manifest = readManifest(target);
    return { id: manifest.id, name: manifest.name, version: manifest.version };
  }

  function discard(token) {
    const entry = staged.get(String(token ?? ''));
    if (!entry) return;
    staged.delete(token);
    discardDir(entry.dir);
  }

  /** Take a downloaded extension off the disk. The ones that ship with the app are not on it. */
  function uninstall(id) {
    const name = String(id ?? '');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new InstallError('That is not an extension id');
    if (builtInIds().has(name)) throw new InstallError('An extension that ships with the app can be turned off, not removed');
    discardDir(path.join(root, name));
  }

  return { inspect, commit, discard, uninstall, sweep };
}

module.exports = { installer, InstallError, ArchiveError, SourceError };
