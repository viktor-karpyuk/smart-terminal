import { compactPath } from '../lib/labels';

/**
 * A path that keeps its tail. When there is not enough room, the parent folders
 * are the part to lose: `~/dev/kubrik/kubrik-timelogbook` clipped from the right
 * reads as `~/dev/kubrik`, which is a different folder and looks like a bug.
 */
export function PathLabel({ path, home, className }: { path: string; home: string; className?: string }) {
  const shown = compactPath(path, home);
  const cut = shown.lastIndexOf('/');
  const head = cut > 0 ? shown.slice(0, cut + 1) : '';
  const tail = cut > 0 ? shown.slice(cut + 1) : shown;

  return (
    <span className={`path${className ? ` ${className}` : ''}`} title={path}>
      {head && <span className="path-head">{head}</span>}
      <span className="path-tail">{tail}</span>
    </span>
  );
}
