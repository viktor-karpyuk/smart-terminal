'use strict';

/**
 * The pull-request tools a Claude session can call: Bitbucket (and GitHub)
 * through the repositories the Code Reviewer knows, with the tokens the person
 * gave it there. The session never sees a token.
 *
 * Shared by the relay a session starts (`forge-mcp-stdio.js`), which answers
 * `tools/list` from it, and the app (`forge-mcp.js`), which checks every call
 * against it again: the relay runs where the model can reach it, so it is the
 * contract and not the guard. No Electron, no network, no secrets in here.
 *
 * The server is called `bitbucket` because that is where the person's work
 * lives; a GitHub repository the reviewer knows answers the same tools.
 */

class ToolError extends Error {}

const repo = { type: 'string', max: 200, optional: true, description: 'Which repository: its name, `owner/slug`, or the folder it is checked out in. Left out, `repo_for_cwd` is used with your working directory.' };

const TOOLS = [
  {
    name: 'repositories',
    description: 'The repositories Smart Terminal can open pull requests in: name, provider, owner/slug, and where it is checked out locally. Start here when you do not know which repository the user means. Never shows tokens.',
    props: {},
  },
  {
    name: 'repo_for_cwd',
    description: 'Which of those repositories a folder belongs to, by its git remotes — the worktree you are in, usually. Says so when none matches.',
    props: { cwd: { type: 'string', max: 1000, optional: true, description: 'A folder; left out, your working directory.' } },
  },
  {
    name: 'pull_requests',
    description: 'The pull requests of a repository: the ones a branch opened (any state), or the open ones. Use it before opening a PR, to see whether one already exists for the branch.',
    props: {
      repo,
      branch: { type: 'string', max: 300, optional: true, description: 'Only PRs from this source branch, in any state. Left out, the open PRs.' },
    },
  },
  {
    name: 'pull_request',
    description: 'One pull request with its description, who approved or asked for changes, and its comments — general and inline.',
    props: {
      repo,
      id: { type: 'number', min: 1, max: 1_000_000_000, description: 'The pull request number.' },
    },
  },
  {
    name: 'create_pull_request',
    description:
      'Open a pull request from a branch that is already pushed. The user confirms it in a dialog before anything is sent; if they decline, nothing is created. ' +
      'Check `pull_requests` for the branch first: a second PR for the same branch is a mess, not progress.',
    props: {
      repo,
      source: { type: 'string', max: 300, description: 'The source branch, as pushed.' },
      destination: { type: 'string', max: 300, description: 'The target branch: develop, main, or what the user named.' },
      title: { type: 'string', min: 1, max: 250, description: 'A title a reviewer understands without the diff.' },
      description: { type: 'string', max: 20_000, optional: true, description: 'What and why, in Markdown. Short is fine; empty is not nothing — say what changed.' },
    },
    required: ['source', 'destination', 'title'],
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function inputSchema(tool) {
  const properties = {};
  const required = [];
  for (const [name, def] of Object.entries(tool.props)) {
    properties[name] = { type: def.type === 'number' ? 'number' : 'string', description: def.description };
    if (!def.optional) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** What `tools/list` shows. */
const listing = (names) => TOOLS.filter((tool) => !names || names.includes(tool.name)).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: inputSchema(tool) }));

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** A clean copy of the call's arguments: only declared names, each the right kind and size; anything else is refused with a sentence. */
function validateArgs(tool, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ToolError('arguments have to be an object');
  const clean = {};
  for (const name of Object.keys(args)) {
    if (!(name in tool.props)) throw new ToolError(`${tool.name} does not take "${String(name).slice(0, 40)}"`);
  }
  for (const [name, def] of Object.entries(tool.props)) {
    const value = args[name];
    if (value === undefined || value === null || value === '') {
      if (!def.optional) throw new ToolError(`${name} is missing`);
      continue;
    }
    if (def.type === 'number') {
      const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
      if (typeof number !== 'number' || !Number.isFinite(number)) throw new ToolError(`${name} has to be a number`);
      if (number < def.min || number > def.max) throw new ToolError(`${name} is out of range`);
      clean[name] = number;
      continue;
    }
    if (typeof value !== 'string') throw new ToolError(`${name} has to be text`);
    const text = value.trim();
    if (def.min && text.length < def.min) throw new ToolError(`${name} is empty`);
    if (text.length > def.max) throw new ToolError(`${name} is too long (${def.max} characters at most)`);
    if (CONTROL.test(text)) throw new ToolError(`${name} has a control character in it`);
    if ((name === 'source' || name === 'destination' || name === 'branch') && !/^[\w./+-]+$/u.test(text)) throw new ToolError(`${name} is not a branch name`);
    clean[name] = text;
  }
  return clean;
}

module.exports = { TOOLS, BY_NAME, ToolError, inputSchema, listing, validateArgs };
