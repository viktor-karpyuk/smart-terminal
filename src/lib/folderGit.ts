/**
 * What a folder's tab has to say about the repository it is in.
 *
 * Two different things, and the difference is the whole reason for saying
 * either. Work that is not committed exists in one place — this machine, this
 * folder, and nowhere else. Work that is committed and not pushed survives
 * everything except losing the machine, and what it is waiting for is a
 * different action entirely.
 *
 * They are never both shown. A repository with uncommitted changes very often
 * has unpushed commits as well, and a tab that says both says neither: the
 * question somebody answers at a glance is "is there something for me to do
 * here", and the answer is whichever of the two comes first.
 *
 * Pure, because a badge that is wrong about a repository is worse than no badge
 * — it is a thing people learn to stop believing.
 */

/** Only what `git status --porcelain=v2 --branch` already knows. */
export type RepoSummary = {
  files?: Array<unknown>;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  detached?: boolean;
} | null | undefined;

export type FolderGit =
  | { state: 'clean' }
  | { state: 'uncommitted'; count: number; title: string }
  | { state: 'unpushed'; count: number; title: string };

const CLEAN: FolderGit = { state: 'clean' };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function folderGit(repo: RepoSummary): FolderGit {
  if (!repo) return CLEAN;

  const changed = Array.isArray(repo.files) ? repo.files.length : 0;
  if (changed > 0) {
    const where = repo.detached ? 'here' : repo.branch ? `on ${repo.branch}` : 'here';
    return {
      state: 'uncommitted',
      count: changed,
      title: `${plural(changed, 'changed file', 'changed files')} ${where}, not committed`,
    };
  }

  /*
   * Committed, and still only here.
   *
   * `ahead` is what git has already worked out against the upstream this branch
   * tracks, so nothing is fetched to answer this and the number is as true as
   * the last time anything talked to the remote.
   *
   * A branch with no upstream at all is deliberately not counted. Git has
   * nothing to compare it against — "unpushed" would mean every commit on it
   * back to some ancestor nobody named — and a repository with no remote would
   * then wear a badge for ever, which is the fastest way to teach somebody that
   * the badge means nothing.
   */
  const ahead = Number(repo.ahead) || 0;
  if (ahead > 0) {
    return {
      state: 'unpushed',
      count: ahead,
      title: `${plural(ahead, 'commit', 'commits')} on ${repo.branch ?? 'this branch'} not pushed${
        repo.upstream ? ` to ${repo.upstream}` : ''
      }`,
    };
  }

  return CLEAN;
}
