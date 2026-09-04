import type { GitFile } from '../global';

/**
 * How the changed files are arranged.
 *
 * Apart from the panel that draws them because the arrangement is the part with
 * the decisions in it — what a module is, what to do with a folder holding one
 * thing — and those are worth being able to argue with in a test rather than by
 * clicking through a repository.
 */

/** A node of the changes tree: a folder that holds more, or one changed file. */
export type Node = { kind: 'dir'; key: string; label: string; children: Node[]; count: number } | { kind: 'file'; key: string; file: GitFile };

/**
 * Folders whose own name says nothing — what matters is the thing inside them.
 *
 * `packages/api` is a module; `packages` is where modules are kept. Without this
 * every monorepo groups into one heap called "packages", which is the directory
 * grouping with an extra step.
 */
const CONTAINERS = new Set(['packages', 'apps', 'services', 'libs', 'lib', 'modules', 'src', 'cmd', 'internal', 'projects']);

/**
 * Which module a file belongs to.
 *
 * The top of the repository it sits under: the first path segment, or the first
 * two when the first is only a container for modules. Decided from the path
 * alone — git reports paths and nothing else, and going to the disk to look for
 * a `package.json` beside each one would make the panel wait on I/O to draw a
 * heading.
 */
export function moduleOf(file: GitFile): string {
  const parts = file.path.split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  const [first, second] = parts;
  if (CONTAINERS.has(first.toLowerCase()) && parts.length > 2 && second) return `${first}/${second}`;
  return first;
}

/** A folder holding what was put in it, with the whole count underneath it. */
function folder(key: string, label: string, children: Node[]): Node {
  const count = children.reduce((sum, child) => sum + (child.kind === 'file' ? 1 : child.count), 0);
  return { kind: 'dir', key, label, count, children };
}

function filesUnder(files: GitFile[]): Node[] {
  return [...files]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((file) => ({ kind: 'file' as const, key: file.path, file }));
}

/** Group by something, in the order that something reads in. */
function by(files: GitFile[], pick: (file: GitFile) => string, label: (key: string) => string): Array<[string, GitFile[]]> {
  const buckets = new Map<string, GitFile[]>();
  for (const file of files) {
    const key = pick(file);
    buckets.set(key, [...(buckets.get(key) ?? []), file]);
  }
  return [...buckets.entries()].sort(([a], [b]) => label(a).localeCompare(label(b)));
}

/**
 * Group the changed files the way the panel is set to.
 *
 * Four groupings, and until now three of them did the same thing: only `files`
 * was distinguished, so **module** and **both** silently gave you the directory
 * listing. They are different questions. A directory is where a file is; a
 * module is which part of the repository it belongs to; and `both` is the one
 * that answers them together, module over directory.
 */
export function group(files: GitFile[], grouping: string): Node[] {
  if (grouping === 'files') return filesUnder(files);

  if (grouping === 'module') {
    return by(files, moduleOf, (key) => key || '\uffff').map(([name, kids]) =>
      folder(`mod:${name || '/'}`, name || '(repository root)', filesUnder(kids)),
    );
  }

  if (grouping === 'both') {
    return by(files, moduleOf, (key) => key || '\uffff').map(([name, kids]) => {
      // Inside a module, the directory *relative to it* — repeating the module's
      // own name on every folder under it is noise.
      const inside = by(kids, (file) => file.dir, (key) => key).map(([dir, own]) => {
        const relative = name && dir.startsWith(name) ? dir.slice(name.length).replace(/^\//, '') : dir;
        return folder(`mod:${name}/dir:${dir || '/'}`, relative || '.', filesUnder(own));
      });
      // A module with everything in one folder does not need the folder shown.
      const children = inside.length === 1 && inside[0].kind === 'dir' && inside[0].label === '.' ? inside[0].children : inside;
      return folder(`mod:${name || '/'}`, name || '(repository root)', children);
    });
  }

  return by(files, (file) => file.dir, (key) => key).map(([dir, kids]) =>
    folder(dir || '/', dir || '(root)', filesUnder(kids)),
  );
}

