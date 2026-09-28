import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { PERMISSIONS as PERMISSION_TEXT } from '../lib/extensionHost';
import type { ExtensionOffer, ExtensionRow } from '../global';

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
type Scope = 'all' | 'installed' | 'published';

export function ExtensionsPanel() {
  const rows = useStore((s) => s.extensions.rows);
  const [chosen, setChosen] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [catalog, setCatalog] = useState<{ error: string | null; loading: boolean }>({ error: null, loading: true });
  const [fromRepo, setFromRepo] = useState(false);
  const [offer, setOffer] = useState<OfferState>(null);

  /*
   * The registry is asked when this opens, not when the app starts: an app that
   * phones a server on every launch to list things nobody asked to see is an app
   * that phones a server on every launch.
   */
  const readCatalog = (refresh = false) => {
    setCatalog((was) => ({ ...was, loading: true }));
    void window.api.extensions
      .catalog(refresh)
      .then((answer) => setCatalog({ error: answer.catalog.error, loading: false }))
      .catch((error: Error) => setCatalog({ error: error.message, loading: false }));
  };
  useEffect(() => readCatalog(false), []);

  const inspect = (from: { repo?: string; id?: string }) => {
    setOffer({ loading: true, from });
    void window.api.extensions.inspect(from).then((answer) => {
      setOffer(answer.ok ? { offer: answer.offer } : { error: answer.error, from });
    });
  };

  const term = filter.trim().toLowerCase();
  const inScope = rows.filter((row) =>
    scope === 'installed'
      ? row.status !== 'available'
      : scope === 'published'
        ? Boolean(row.remote || row.listed || row.source)
        : true,
  );
  const shown = term
    ? inScope.filter((row) =>
        [row.name, row.id, row.summary, row.description].some((field) => field?.toLowerCase().includes(term)),
      )
    : inScope;

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
        <div className="segmented is-compact extensions-scope" role="radiogroup" aria-label="Which extensions">
          {(['all', 'installed', 'published'] as Scope[]).map((value) => (
            <button
              key={value}
              role="radio"
              aria-checked={scope === value}
              className={scope === value ? 'is-on' : ''}
              onClick={() => setScope(value)}
            >
              {value === 'all' ? 'All' : value === 'installed' ? 'Installed' : 'Published'}
            </button>
          ))}
        </div>
        {updates > 0 && <span className="extensions-updates">{updates} to update</span>}
        <span className="extensions-spacer" />
        {catalog.error && (
          <span className="extensions-catalog-error" title={catalog.error}>
            registry unreachable
          </span>
        )}
        <button
          className="ghost-btn tiny"
          disabled={catalog.loading}
          title="Ask the registry again for what has been published"
          onClick={() => readCatalog(true)}
        >
          {catalog.loading ? 'Reading…' : 'Refresh'}
        </button>
        <button className="ghost-btn tiny is-primary" onClick={() => setFromRepo((open) => !open)}>
          From a repository…
        </button>
      </header>

      {fromRepo && <FromRepository onLookUp={(repo) => inspect({ repo })} busy={Boolean(offer && 'loading' in offer)} />}

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
                {!row.builtIn && (row.source || row.listed) && (
                  <span>· {shortRepo((row.source ?? row.listed)!.repo)}</span>
                )}
              </span>
            </button>
          ))}
        </div>

        <div className="extension-detail">
          {!open && <p className="usage-note">Pick one to read what it does.</p>}
          {open && <Detail row={open} onReview={(id) => inspect({ id })} />}
        </div>
      </div>

      {offer && (
        <Consent
          state={offer}
          onCancel={() => {
            if (offer && 'offer' in offer) void window.api.extensions.discard(offer.offer.token);
            setOffer(null);
          }}
          onInstall={(token) => {
            setOffer({ loading: true, installing: true, from: {} });
            void window.api.extensions.commit(token).then((answer) => {
              if (answer.ok) {
                useStore.setState({ extensions: answer.state });
                setOffer(null);
              } else setOffer({ error: answer.error, from: {} });
            });
          }}
        />
      )}
    </div>
  );
}

type OfferState =
  | null
  | { loading: true; installing?: boolean; from: { repo?: string; id?: string } }
  | { error: string; from: { repo?: string; id?: string } }
  | { offer: ExtensionOffer };

const shortRepo = (url: string) => url.replace(/^https:\/\/github\.com\//, '');

/** Installing straight from somebody's repository, with nobody else having read it. */
function FromRepository({ onLookUp, busy }: { onLookUp(repo: string): void; busy: boolean }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="extensions-from-repo"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onLookUp(value.trim());
      }}
    >
      <input
        autoFocus
        placeholder="https://github.com/someone/their-extension  (optionally @v1.2.0)"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button className="primary-btn" type="submit" disabled={busy || !value.trim()}>
        Look it up
      </button>
      <p className="form-hint">
        Downloads it at one exact commit and shows you what it is and what it asks for. Nothing is
        installed until you say so.
      </p>
    </form>
  );
}

/**
 * The one screen between a download and an install.
 *
 * It says who wrote it, where it came from down to the commit, whether anybody
 * but its author has read it, and every permission it wants in a sentence each.
 * The files that are installed if you say yes are the ones that were just read:
 * nothing is downloaded again.
 */
function Consent({
  state,
  onCancel,
  onInstall,
}: {
  state: Exclude<OfferState, null>;
  onCancel(): void;
  onInstall(token: string): void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal modal-narrow extension-consent" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2>{'offer' in state ? `Install ${state.offer.name}?` : 'Installing an extension'}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onCancel}>
            &times;
          </button>
        </header>
        <div className="extension-consent-body">
          {'loading' in state && (
            <p className="usage-note">{state.installing ? 'Installing…' : 'Downloading it and reading what it asks for…'}</p>
          )}
          {'error' in state && <p className="extension-consent-error">{state.error}</p>}
          {'offer' in state && <OfferDetail offer={state.offer} />}
        </div>
        <footer className="extension-consent-actions">
          <button className="ghost-btn" onClick={onCancel}>
            {'offer' in state ? 'Cancel' : 'Close'}
          </button>
          {'offer' in state && (
            <button className="primary-btn" onClick={() => onInstall(state.offer.token)}>
              {state.offer.replacing ? `Replace v${state.offer.replacing.version} with v${state.offer.version}` : 'Install'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function OfferDetail({ offer }: { offer: ExtensionOffer }) {
  const parts = [
    offer.contributes.panels ? `${offer.contributes.panels} view${offer.contributes.panels === 1 ? '' : 's'}` : '',
    offer.contributes.previews ? `${offer.contributes.previews} file preview${offer.contributes.previews === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return (
    <>
      <p className="extension-consent-who">
        <strong>{offer.name}</strong> v{offer.version}
        {offer.author ? ` by ${offer.author}` : ''}
        {parts.length ? ` · brings ${parts.join(' and ')}` : ''}
      </p>
      {offer.summary && <p className="extension-text">{offer.summary}</p>}

      {offer.reviewed ? (
        <p className="extension-consent-note is-ok">Listed in the registry: this exact commit was reviewed before it was published.</p>
      ) : (
        <p className="extension-consent-note is-warn">
          Not from the registry. Nobody but its author has necessarily read this code. Install it only if you
          trust where it came from.
        </p>
      )}

      <dl className="extension-consent-source">
        <dt>From</dt>
        <dd>
          <button className="link-btn" onClick={() => window.api.system.openExternal(`${offer.repo}/tree/${offer.commit}`)}>
            {shortRepo(offer.repo)}
          </button>
        </dd>
        <dt>Commit</dt>
        <dd>
          <code>{offer.commit.slice(0, 12)}</code>
          {offer.ref && offer.ref !== offer.commit ? ` (${offer.ref}, ${offer.how})` : ` (${offer.how})`}
        </dd>
      </dl>

      <h4 className="monitor-heading">What it may do</h4>
      <PermissionList permissions={offer.permissions} />
      {offer.replacing?.downgrade && (
        <p className="extension-consent-note is-warn">This is older than the v{offer.replacing.version} installed now.</p>
      )}
    </>
  );
}

function PermissionList({ permissions }: { permissions: Array<{ name: string; text: string; added?: boolean }> }) {
  if (!permissions.length) {
    return <p className="usage-note">Nothing beyond drawing its own view. It cannot read or change anything through the app.</p>;
  }
  return (
    <ul className="extension-permissions">
      {permissions.map((permission) => (
        <li key={permission.name} className={permission.name.endsWith('.write') || ['deliver', 'terminal', 'review', 'spring'].includes(permission.name) ? 'is-strong' : ''}>
          <span>{permission.text}</span>
          {permission.added && <span className="extension-badge is-update">new</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * What it looks like, before you decide whether to install it.
 *
 * A paragraph describing a panel is a paragraph; a picture of it is the thing.
 * They are fetched one at a time as this renders rather than travelling with
 * the gallery, because the gallery is re-broadcast every time anything is
 * installed or turned off and screenshots would make that cost megabytes.
 */
function Screenshots({ row }: { row: ExtensionRow }) {
  const shots = row.screenshots ?? [];
  const [loaded, setLoaded] = useState<Array<{ src: string; caption: string }>>([]);
  const [open, setOpen] = useState<{ src: string; caption: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoaded([]);
    if (!shots.length) return;
    void Promise.all(
      shots.map((shot) =>
        window.api.extensions
          .picture(row.id, shot.file)
          .then((src) => (src ? { src, caption: shot.caption } : null))
          .catch(() => null),
      ),
    ).then((all) => {
      // The panel may have moved on to another extension while these were read.
      if (alive) setLoaded(all.filter((one): one is { src: string; caption: string } => Boolean(one)));
    });
    return () => {
      alive = false;
    };
    // The id is the extension; the files are its manifest's and change with it.
  }, [row.id, shots.map((shot) => shot.file).join('|')]);

  if (!loaded.length) return null;

  return (
    <>
      <div className="extension-shots">
        {loaded.map((shot) => (
          <button
            key={shot.src.slice(-40)}
            className="extension-shot"
            onClick={() => setOpen(shot)}
            title={shot.caption || 'See it bigger'}
          >
            <img src={shot.src} alt={shot.caption} loading="lazy" />
            {shot.caption && <span>{shot.caption}</span>}
          </button>
        ))}
      </div>
      {open && (
        <div className="modal-backdrop" onMouseDown={() => setOpen(null)}>
          <figure className="extension-shot-full" onMouseDown={(event) => event.stopPropagation()}>
            <img src={open.src} alt={open.caption} />
            {open.caption && <figcaption>{open.caption}</figcaption>}
          </figure>
        </div>
      )}
    </>
  );
}

function Badge({ row }: { row: ExtensionRow }) {
  if (row.status === 'update') return <span className="extension-badge is-update">update</span>;
  if (row.status === 'gone') return <span className="extension-badge is-gone">missing</span>;
  if (row.status === 'available') return <span className="extension-badge">not installed</span>;
  if (!row.enabled) return <span className="extension-badge is-off">off</span>;
  return <span className="extension-badge is-on">installed</span>;
}

function Detail({ row, onReview }: { row: ExtensionRow; onReview(id: string): void }) {
  const act = useStore((s) => s.setExtension);
  const openExtensionView = useStore((s) => s.openExtensionView);
  const previews = row.contributes?.previews ?? [];
  const panels = row.contributes?.panels ?? [];
  const running = row.status === 'installed' || row.status === 'update';

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

      <Screenshots row={row} />

      <p className="extension-text">{row.description || row.summary}</p>

      <h4 className="monitor-heading">What it may do</h4>
      {row.builtIn ? (
        <p className="usage-note">It ships with the app, so it can use everything the app offers extensions.</p>
      ) : (
        <PermissionList permissions={row.permissions.map((name) => ({ name, text: PERMISSION_TEXT[name] ?? name }))} />
      )}

      {!row.builtIn && (row.source || row.listed) && (
        <>
          <h4 className="monitor-heading">Where it comes from</h4>
          <dl className="extension-consent-source">
            <dt>Repository</dt>
            <dd>
              <button className="link-btn" onClick={() => window.api.system.openExternal((row.source ?? row.listed)!.repo)}>
                {shortRepo((row.source ?? row.listed)!.repo)}
              </button>
            </dd>
            {row.source?.commit && (
              <>
                <dt>Installed</dt>
                <dd>
                  <code>{row.source.commit.slice(0, 12)}</code> · {row.source.reviewed ? 'reviewed in the registry' : 'installed directly, not reviewed'}
                </dd>
              </>
            )}
            {row.listed && (
              <>
                <dt>Registry</dt>
                <dd>
                  v{row.listed.version} at <code>{row.listed.commit.slice(0, 12)}</code>
                </dd>
              </>
            )}
          </dl>
        </>
      )}

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

      {panels.length > 0 && (
        <>
          <h4 className="monitor-heading">Views it brings</h4>
          <div className="extension-panels">
            {panels.map((panel) => (
              <div className="extension-panel-row" key={panel.id}>
                <div>
                  <strong>{panel.title ?? panel.id}</strong>
                  <small>
                    {panel.summary ||
                      (panel.needs === 'repository'
                        ? 'Works on a repository.'
                        : panel.needs === 'folder'
                          ? 'Works on a folder.'
                          : panel.needs === 'kubernetes'
                            ? 'Works on a Kubernetes cluster.'
                            : panel.needs === 'build'
                              ? 'Works on a Maven or Gradle project.'
                            : '')}
                  </small>
                </div>
                {/* A view that is about a folder is opened from that folder, so
                    it knows which one. Anything else opens from here. */}
                {panel.needs === 'repository' || panel.needs === 'folder' || panel.needs === 'build' ? (
                  <span className="extension-panel-note">from a folder</span>
                ) : (
                  <button
                    className="ghost-btn"
                    disabled={!running || !row.enabled}
                    onClick={() => openExtensionView(panel.id, null)}
                  >
                    Open
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="extension-actions">
        {row.status === 'available' && (
          <button className="primary-btn" onClick={() => (row.remote ? onReview(row.id) : act(row.id, 'install'))}>
            {row.remote ? 'Review and install' : 'Install'}
          </button>
        )}
        {row.status === 'update' && (
          <button
            className="primary-btn"
            onClick={() => (row.listed && !row.builtIn ? onReview(row.id) : act(row.id, 'install'))}
          >
            Update to v{row.listed && !row.builtIn ? row.listed.version : row.version}
          </button>
        )}
        {(row.status === 'installed' || row.status === 'update') && (
          <>
            <button className="ghost-btn" onClick={() => act(row.id, row.enabled ? 'disable' : 'enable')}>
              {row.enabled ? 'Turn off' : 'Turn on'}
            </button>
            <button
              className="ghost-btn"
              onClick={() => {
                if (row.builtIn) return act(row.id, 'remove');
                // Downloaded: off the disk as well, not only out of the record.
                void window.api.extensions.uninstall(row.id).then((answer) => {
                  if (answer.ok) useStore.setState({ extensions: answer.state });
                });
              }}
            >
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
        An extension decides which files the app offers to render and under what names. One that
        brings a view brings code with it, and that code runs where it can be wrong without taking
        anything with it: in a frame with an origin of its own, reaching the app only through a
        fixed list of operations, some of which stop to ask you first.
      </p>
    </>
  );
}
