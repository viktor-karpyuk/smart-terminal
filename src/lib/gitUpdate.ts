import type { GitResult } from '../global';

/**
 * What a git command did, said in the number of things it did it to.
 *
 * "Updating — done." is true and tells nobody anything: the question after an
 * update is always *did anything come in, and what*. So a pull that brought
 * nothing says so outright, and one that brought something counts it — files
 * first, because that is what a person is about to go and read, and commits
 * after, because that is how many times somebody else pressed save.
 *
 * Its own module so the wording is tested rather than read. A sentence that
 * says "1 files" is the kind of thing nobody fixes and everybody notices.
 */
export type Notice = {
  kind: 'ok' | 'warn' | 'bad';
  text: string;
  files?: Array<{ status: string; path: string }>;
};

export function whatItDid(name: string, label: string | undefined, result: GitResult): Notice {
  const changed = result.changed;
  if (name !== 'pull' || !changed) return { kind: 'ok', text: `${label ?? name} — done.` };
  if (!changed.total) return { kind: 'ok', text: 'All files are up to date.' };

  const parts: string[] = [];
  if (changed.updated) parts.push(`${changed.updated} updated`);
  if (changed.added) parts.push(`${changed.added} new`);
  if (changed.removed) parts.push(`${changed.removed} deleted`);
  if (changed.renamed) parts.push(`${changed.renamed} moved`);
  const files = `${changed.total} ${changed.total === 1 ? 'file' : 'files'}`;
  const commits = changed.commits
    ? ` in ${changed.commits} ${changed.commits === 1 ? 'commit' : 'commits'}`
    : '';
  return { kind: 'ok', text: `Updated ${files}${commits} — ${parts.join(', ')}.`, files: changed.files ?? [] };
}
