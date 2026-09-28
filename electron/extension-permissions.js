'use strict';

/**
 * What an extension from outside the app may be allowed to do.
 *
 * The extensions that ship with the app can call anything the host offers; they
 * were written with it. One downloaded from somebody's repository gets only what
 * its manifest asks for, and the person installing it reads that list first.
 * The list is short and in plain words on purpose: a permission nobody can
 * explain in a sentence is one nobody can decide about.
 *
 * The renderer keeps the same list (src/lib/extensionHost.ts) and a test holds
 * the two together.
 */
const PERMISSIONS = {
  'git.read': 'Read the repository open in its panel: history, branches, changes',
  'git.write': 'Change that repository: commit, push, pull, switch and delete branches',
  'kube.read': 'Read your Kubernetes clusters: resources, logs, events',
  'kube.write': 'Change your clusters: delete, scale, restart, apply, forward ports',
  'helm.read': 'Read Helm releases and their values',
  'helm.write': 'Roll back or uninstall Helm releases',
  build: 'Read Maven and Gradle projects',
  spring: 'Run and stop Spring Boot applications',
  review: 'Use the Code Reviewer: pull requests, findings, comments, merges',
  teams: "Change the Teams connection's settings",
  deliver: 'Send messages to people in Teams, in its own name',
  terminal: 'Open terminals and Claude sessions about what it shows',
};

const KNOWN = Object.keys(PERMISSIONS);

/** The permissions a manifest asks for, or an error saying which one is wrong. */
function readPermissions(value) {
  if (value == null) return { permissions: [], error: null };
  if (!Array.isArray(value)) return { permissions: [], error: 'permissions has to be a list' };
  const unknown = value.filter((name) => !KNOWN.includes(name));
  if (unknown.length) return { permissions: [], error: `asks for permissions this app does not have: ${unknown.join(', ')}` };
  return { permissions: [...new Set(value)].sort(), error: null };
}

module.exports = { PERMISSIONS, KNOWN, readPermissions };
