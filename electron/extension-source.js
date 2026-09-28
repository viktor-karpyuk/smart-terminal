'use strict';

/**
 * Where an extension's code comes from: a repository on GitHub, at one commit.
 *
 * Always one commit, never a branch. A branch is a promise that the code will
 * change under you; a commit is the code. The registry names the commit it
 * reviewed, and a direct install turns whatever was asked for — a tag, a branch,
 * nothing — into the commit it was at that moment, and records that.
 *
 * GitHub only, for now. Bitbucket and GitLab serve archives the same way and
 * belong here when somebody publishes from one.
 */

const { LIMITS } = require('./extension-archive');

class SourceError extends Error {}

const NAME = /^[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

/**
 * `https://github.com/owner/repo`, with or without `.git`, `/tree/<ref>` or
 * `/releases/tag/<ref>`; or `owner/repo`; either with `@ref` or `#ref` after it.
 */
function parseRepo(input) {
  let value = String(input ?? '').trim();
  let ref = null;
  const at = /^(.*?)(?:[@#]([^@#\s]+))$/.exec(value);
  if (at && !/^git@/.test(value)) {
    value = at[1];
    ref = at[2];
  }
  let match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(?:tree|releases\/tag)\/([^?#\s]+))?\/?$/i.exec(value);
  if (!match) match = /^([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/.exec(value);
  if (!match) throw new SourceError('That is not a GitHub repository. Paste its address, like https://github.com/someone/their-extension');
  const [, owner, repo, pathRef] = match;
  if (!NAME.test(owner) || !NAME.test(repo)) throw new SourceError('That repository name has characters GitHub does not allow');
  return { owner, repo, ref: ref ?? (pathRef ? decodeURIComponent(pathRef) : null) };
}

const repoUrl = ({ owner, repo }) => `https://github.com/${owner}/${repo}`;

async function api(fetch, url, accept = 'application/vnd.github+json') {
  const response = await fetch(url, { headers: { accept, 'user-agent': 'smart-terminal', 'x-github-api-version': '2022-11-28' } });
  if (response.status === 404) return null;
  if (response.status === 403 || response.status === 429) {
    throw new SourceError('GitHub is limiting how often it can be asked. Try again in a few minutes.');
  }
  if (!response.ok) throw new SourceError(`GitHub answered ${response.status}`);
  return accept === 'application/vnd.github.sha' ? (await response.text()).trim() : response.json();
}

/**
 * The commit to install. With no ref, the latest release; with no release, the
 * tip of the default branch — said so in `how`, so the screen can say it too.
 */
async function resolve(fetch, { owner, repo, ref }) {
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  let wanted = ref;
  let how = 'as asked';
  if (!wanted) {
    const release = await api(fetch, `${base}/releases/latest`);
    if (release?.tag_name) {
      wanted = release.tag_name;
      how = 'latest release';
    } else {
      const info = await api(fetch, base);
      if (!info) throw new SourceError(`There is no public repository at ${repoUrl({ owner, repo })}`);
      wanted = info.default_branch;
      how = 'no release yet; the tip of its default branch';
    }
  }
  if (SHA.test(wanted)) return { sha: wanted, ref: wanted, how };
  const sha = await api(fetch, `${base}/commits/${encodeURIComponent(wanted)}`, 'application/vnd.github.sha');
  if (!sha) throw new SourceError(`${repoUrl({ owner, repo })} has nothing called ${wanted}`);
  if (!SHA.test(sha)) throw new SourceError('GitHub did not answer with a commit');
  return { sha, ref: wanted, how };
}

/** The repository at that commit, as a .tar.gz, refused as soon as it is too big. */
async function download(fetch, { owner, repo, sha }, limit = LIMITS.compressed) {
  if (!SHA.test(sha)) throw new SourceError('A download needs an exact commit');
  const response = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`, {
    headers: { 'user-agent': 'smart-terminal' },
  });
  if (response.status === 404) throw new SourceError(`${repoUrl({ owner, repo })} has no commit ${sha.slice(0, 7)}`);
  if (!response.ok) throw new SourceError(`Downloading answered ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) throw new SourceError('The extension is larger than an extension may be');
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new SourceError('The extension is larger than an extension may be');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

module.exports = { parseRepo, resolve, download, repoUrl, SourceError, SHA };
