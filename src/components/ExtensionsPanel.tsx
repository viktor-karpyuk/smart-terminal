import { useState } from 'react';
import { useStore } from '../state/store';
import type { ExtensionRow } from '../global';

/**
 * The extensions, and what has been decided about each.
 *
 * Four states rather than a checkbox, because they are four different
 * questions. *Available* is an offer — something the app can do that has not
 * been turned on. *Installed* is done. *Update* is the same extension at a
 * version newer than the one that was installed. And *gone* is one that was
 * installed and whose folder is no longer there, which is shown rather than
 * quietly dropped: something has stopped contributing, and that is worth being
 * told rather than noticing later.
 *
 * What an extension can do is worth saying plainly, because it is no longer
 * only a switch. It decides which files the app offers to render and under
 * which names; it can bring the code that does that rendering; and it can bring
 * a whole panel. Both kinds of code run, and neither runs here: a renderer runs
 * in a worker with no DOM, a panel in a frame with an origin of its own, and
 * the only thing either can reach is a fixed list of operations the app agreed
 * to perform.
 */
export function ExtensionsPanel() {
  const rows = useStore((s) => s.extensions.rows);
  const [chosen, setChosen] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const term = filter.trim().toLowerCase();
  const shown = term
    ? rows.filter((row) =>
        [row.name, row.id, row.summary, row.description].some((field) => field?.toLowerCase().includes(term)),
      )
    : rows;

  const updates = rows.filter((row) => row.status === 'update').length;
  const open = chosen ? (rows.find((row) => row.id === chosen) ?? null) : null;

  return (
    <div className="extensions">
      <header className="extensions-head">
        <input
          className="db-table-search"
          placeholder="Search extensions"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {updates > 0 && <span className="extensions-updates">{updates} to update</span>}
      </header>

      <div className="extensions-body">
        <div className="extensions-list">
          {!shown.length && <p className="usage-note">Nothing matches.</p>}
          {shown.map((row) => (
            <button
              key={row.id}
              className={`extension${chosen === row.id ? ' is-on' : ''}`}
              onClick={() => setChosen(chosen === row.id ? null : row.id)}
            >
              <span className="extension-top">
                <span className="extension-name">{row.name}</span>
                <Badge row={row} />
              </span>
              <span className="extension-summary">{row.summary || row.id}</span>
              <span className="extension-foot">
                <span>v{row.installedVersion ?? row.version}</span>
                {row.author && <span>· {row.author}</span>}
                {row.builtIn && <span>· ships with the app</span>}
              </span>
            </button>
          ))}
        </div>

        <div className="extension-detail">
          {!open && <p className="usage-note">Pick one to read what it does.</p>}
          {open && <Detail row={open} />}
        </div>
      </div>
    </div>
  );
}

function Badge({ row }: { row: ExtensionRow }) {
  if (row.status === 'update') return <span className="extension-badge is-update">update</span>;
  if (row.status === 'gone') return <span className="extension-badge is-gone">missing</span>;
  if (row.status === 'available') return <span className="extension-badge">not installed</span>;
  if (!row.enabled) return <span className="extension-badge is-off">off</span>;
  return <span className="extension-badge is-on">installed</span>;
}

function Detail({ row }: { row: ExtensionRow }) {
  const act = useStore((s) => s.setExtension);
  const previews = row.contributes?.previews ?? [];

  return (
    <>
      <header className="extension-detail-head">
        <div>
          <h3>{row.name}</h3>
          <small>
            {row.id} · v{row.version}
            {row.installedVersion && row.installedVersion !== row.version ? ` (installed v${row.installedVersion})` : ''}
            {row.author ? ` · ${row.author}` : ''}
          </small>
        </div>
        <Badge row={row} />
      </header>

      <p className="extension-text">{row.description || row.summary}</p>

      {previews.length > 0 && (
        <>
          <h4 className="monitor-heading">What it opens</h4>
          <div className="extension-files">
            {previews.map((preview) => (
              <div className="extension-file" key={preview.kind}>
                <span className="extension-kind">{preview.kind}</span>
                <span>
                  {[
                    ...(preview.files ?? []),
                    ...(preview.prefixes ?? []).map((prefix) => `${prefix}*`),
                    ...(preview.extensions ?? []).map((value) => `.${value}`),
                  ].join('  ')}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="extension-actions">
        {row.status === 'available' && (
          <button className="primary-btn" onClick={() => act(row.id, 'install')}>
            Install
          </button>
        )}
        {row.status === 'update' && (
          <button className="primary-btn" onClick={() => act(row.id, 'install')}>
            Update to v{row.version}
          </button>
        )}
        {(row.status === 'installed' || row.status === 'update') && (
          <>
            <button className="ghost-btn" onClick={() => act(row.id, row.enabled ? 'disable' : 'enable')}>
              {row.enabled ? 'Turn off' : 'Turn on'}
            </button>
            <button className="ghost-btn" onClick={() => act(row.id, 'remove')}>
              Uninstall
            </button>
          </>
        )}
        {row.status === 'gone' && (
          <>
            <p className="usage-note">
              This was installed, and its folder is no longer there. It is contributing nothing.
            </p>
            <button className="ghost-btn" onClick={() => act(row.id, 'remove')}>
              Forget it
            </button>
          </>
        )}
      </div>

      <p className="usage-footnote">
        An extension decides which files the app offers to render and under what names. It does not
        run code of its own — turning one on changes what is offered, not what is executed.
      </p>
    </>
  );
}
