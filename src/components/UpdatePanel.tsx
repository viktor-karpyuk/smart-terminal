import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { formatBytes } from '../lib/labels';
import { parseNotes, type NotesBlock, type Span } from '../lib/releaseNotes';
import type { UpdateState } from '../global';

/**
 * What version this is, what version there is, and the one button in between.
 *
 * The whole thing is drawn from a single `phase` rather than from a handful of
 * booleans, because the states genuinely exclude one another: there is no
 * moment at which an update is both downloading and ready, and a panel written
 * as though there were is a panel that eventually shows both.
 *
 * The install is not modelled as something that finishes here. The app is what
 * gets replaced, so the last thing this panel does is ask for it and then go
 * away with the window — and if the quit is refused, which it is whenever
 * sessions are live and somebody says keep them, the panel comes back to
 * "ready" rather than sitting on a promise nothing kept.
 */
export function UpdatePanel() {
  const update = useStore((s) => s.update);
  const close = () => useStore.getState().setUpdatePanelOpen(false);

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal modal-narrow" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2>Updates</h2>
          <button className="ghost-btn tiny" onClick={close}>
            &times;
          </button>
        </header>
        <div className="usage-body update-body">
          {update ? <UpdateBody update={update} /> : <p className="update-quiet">Starting up…</p>}
        </div>
      </div>
    </div>
  );
}

function UpdateBody({ update }: { update: UpdateState }) {
  const api = window.api.updates;
  const release = update.release;
  const running = `${update.current.version}${update.current.build ? ` · build ${update.current.build}` : ''}`;

  return (
    <>
      <section className="form-section update-head">
        <Headline update={update} />
        <p className="update-running">
          You are running <strong>{running}</strong>
          {release && <> · this update is {release.asset ? formatBytes(release.asset.size) : 'an unknown size'}</>}
        </p>
        {update.error && <p className="update-error">{update.error}</p>}
        <Actions update={update} />
        {update.phase === 'downloading' && <Progress update={update} />}
        {/* Why it cannot install itself, said once, where the button would be. */}
        {release && !update.install.can && update.install.why && (
          <p className="update-quiet">{update.install.why}</p>
        )}
      </section>

      {release && <Notes release={release} />}

      <ExtensionUpdates />

      <section className="form-section update-settings">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={update.auto}
            onChange={(event) => api.configure({ auto: event.target.checked })}
          />
          <span>Look for updates on its own</span>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={update.prereleases}
            onChange={(event) => api.configure({ prereleases: event.target.checked })}
          />
          <span>Include pre-releases — early builds, and not always the steadier one</span>
        </label>
        <p className="update-quiet">
          {update.checkedAt ? `Last checked ${new Date(update.checkedAt).toLocaleString()}.` : 'Not checked yet.'}
          {/* Not while that same version is being offered two inches above it. */}
          {update.skipped && update.skipped !== update.release?.version
            ? ` Skipping ${update.skipped} until something newer is published.`
            : null}
        </p>
      </section>
    </>
  );
}

/** The one line somebody reads before deciding whether to read anything else. */
function Headline({ update }: { update: UpdateState }) {
  const version = update.release?.version;
  const line = {
    idle: 'Smart Terminal is up to date.',
    checking: 'Looking for a newer version…',
    available: `Smart Terminal ${version} is available.`,
    downloading: `Downloading Smart Terminal ${version}…`,
    ready: `Smart Terminal ${version} is downloaded and checked.`,
    installing: 'Closing to finish the update…',
    'handed-off': 'The installer is in the folder that just opened.',
    error: 'Could not check for updates.',
  }[update.phase];

  return (
    <h3 className={`update-headline is-${update.phase}`}>
      {update.phase === 'available' || update.phase === 'ready' ? <span className="update-dot" /> : null}
      {line}
    </h3>
  );
}

function Actions({ update }: { update: UpdateState }) {
  const api = window.api.updates;
  const check = useStore((s) => s.checkForUpdates);
  const release = update.release;

  if (update.phase === 'checking') {
    return <p className="update-quiet">Asking GitHub what has been published.</p>;
  }

  if (update.phase === 'installing') {
    return (
      <>
        <p className="update-quiet">
          The new build is waiting outside and goes in as soon as this app has quit. Sessions that are
          running will ask to be confirmed first — and if you keep them, nothing is replaced.
        </p>
        <div className="update-actions">
          <button className="link-btn" onClick={() => api.openLog()}>
            Open the install log
          </button>
        </div>
      </>
    );
  }

  if (update.phase === 'downloading') return null;

  if ((update.phase === 'ready' || update.phase === 'handed-off') && release) {
    return (
      <div className="update-actions">
        {update.install.can ? (
          <button className="primary-btn" onClick={() => api.install()}>
            Install and restart
          </button>
        ) : (
          <button className="primary-btn" onClick={() => api.install()}>
            Show the download
          </button>
        )}
        <button className="ghost-btn" onClick={() => api.skip()}>
          Not now
        </button>
        <a className="link-btn" href={release.url} onClick={openOutside}>
          Release notes on GitHub
        </a>
      </div>
    );
  }

  if (update.phase === 'available' && release) {
    return (
      <div className="update-actions">
        {release.asset ? (
          <button className="primary-btn" onClick={() => api.download()}>
            {update.install.can ? 'Download and install' : 'Download'}
          </button>
        ) : (
          <a className="primary-btn" href={release.url} onClick={openOutside}>
            Open the release
          </a>
        )}
        <button className="ghost-btn" onClick={() => api.skip()}>
          Skip this version
        </button>
      </div>
    );
  }

  return (
    <div className="update-actions">
      <button className="ghost-btn" onClick={() => check(true)}>
        Check now
      </button>
      {update.phase === 'error' && update.release?.url && (
        <a className="link-btn" href={update.release.url} onClick={openOutside}>
          Open the release page
        </a>
      )}
    </div>
  );
}

/**
 * How much has arrived.
 *
 * With a cancel beside it, because 128 MB over a hotel connection is a thing
 * somebody starts and then regrets, and a download with no way out is one that
 * has to be quit out of.
 */
function Progress({ update }: { update: UpdateState }) {
  const received = update.progress?.received ?? 0;
  const total = update.progress?.total ?? 0;
  const share = total > 0 ? Math.min(1, received / total) : 0;

  return (
    <div className="update-progress">
      <div className="meter">
        <div className="meter-top">
          <strong>{formatBytes(received)}</strong>
          <small>{total > 0 ? `of ${formatBytes(total)} · ${Math.round(share * 100)}%` : 'downloading'}</small>
        </div>
        <div className="meter-track">
          <div className="meter-fill is-ok" style={{ width: `${share * 100}%` }} />
        </div>
      </div>
      <button className="ghost-btn tiny" onClick={() => window.api.updates.cancel()}>
        Cancel
      </button>
    </div>
  );
}

/**
 * The extensions that have a newer version than the one installed.
 *
 * They belong in this panel and not only in the gallery, and the reason is the
 * order things happen in. A built-in extension travels inside the app, so its
 * new version arrives with an app update — and the moment it arrives is the
 * moment somebody is looking at this panel, having just taken one. Leaving the
 * news in a gallery nobody has a reason to open is how three extensions came to
 * be improved by hundreds of lines that the app never mentioned to anyone.
 *
 * Nothing is fetched here. The gallery already works out which rows are behind,
 * and this reads the same answer rather than forming a second opinion about it.
 */
function ExtensionUpdates() {
  /*
   * `useShallow`, and not decoration.
   *
   * A selector that filters returns a new array every time it runs, and the
   * store compares results by identity to decide whether to re-render — so a
   * plain `filter` here is a component that re-renders because it rendered.
   * React ends that by tearing the tree down, which is what it did: the whole
   * window went blank, pill and panel together. The sidebar avoids it by
   * selecting a count, and says so in a comment; this needs the rows themselves,
   * so it compares them one level deep instead.
   */
  const rows = useStore(useShallow((s) => s.extensions.rows.filter((row) => row.status === 'update')));
  const setExtension = useStore((s) => s.setExtension);
  const openExtensions = useStore((s) => s.openExtensions);
  const closePanel = useStore((s) => s.setUpdatePanelOpen);
  const [working, setWorking] = useState(false);

  if (!rows.length) return null;

  const takeAll = async () => {
    setWorking(true);
    // One at a time: each is a write to the same table, and a failure part way
    // through should leave the ones that worked applied rather than unknown.
    for (const row of rows) await setExtension(row.id, 'install').catch(() => {});
    setWorking(false);
  };

  return (
    <section className="form-section update-extensions">
      <h3>
        {rows.length === 1 ? 'An extension has' : `${rows.length} extensions have`} a newer version
      </h3>
      <ul className="update-extension-list">
        {rows.map((row) => (
          <li key={row.id}>
            <strong>{row.name}</strong>
            <span>
              {row.installedVersion} → {row.version}
            </span>
          </li>
        ))}
      </ul>
      <div className="update-actions">
        <button className="primary-btn" onClick={takeAll} disabled={working}>
          {working
            ? 'Updating…'
            : rows.length === 1
              ? 'Update it'
              : `Update all ${rows.length}`}
        </button>
        <button
          className="ghost-btn"
          onClick={() => {
            closePanel(false);
            openExtensions();
          }}
        >
          See what changed
        </button>
      </div>
    </section>
  );
}

/** What changed, drawn as elements rather than parsed into markup. See `releaseNotes`. */
function Notes({ release }: { release: NonNullable<UpdateState['release']> }) {
  const blocks = useMemo(() => parseNotes(release.notes), [release.notes]);
  if (!blocks.length) return null;

  return (
    <section className="form-section update-notes">
      <h3>What is new in {release.version}</h3>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </section>
  );
}

function Block({ block }: { block: NotesBlock }) {
  if (block.kind === 'code') return <pre>{block.text}</pre>;
  if (block.kind === 'heading') {
    // Flattened to two levels: these sit inside a section that already has a
    // heading of its own, and a document with an h1 halfway down it is one
    // nobody can read the shape of.
    const Tag = (block.level <= 2 ? 'h4' : 'h5') as 'h4' | 'h5';
    return (
      <Tag>
        <Spans spans={block.spans} />
      </Tag>
    );
  }
  if (block.kind === 'list') {
    const items = block.items.map((spans, index) => (
      <li key={index}>
        <Spans spans={spans} />
      </li>
    ));
    return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
  }
  return (
    <p>
      <Spans spans={block.spans} />
    </p>
  );
}

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, index) => {
        if (span.kind === 'strong') return <strong key={index}>{span.text}</strong>;
        if (span.kind === 'em') return <em key={index}>{span.text}</em>;
        if (span.kind === 'code') return <code key={index}>{span.text}</code>;
        if (span.kind === 'link') {
          return (
            <a key={index} href={span.href} onClick={openOutside}>
              {span.text}
            </a>
          );
        }
        return <span key={index}>{span.text}</span>;
      })}
    </>
  );
}

/** A link in the notes belongs in a browser, not in this window. */
function openOutside(event: React.MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  const href = event.currentTarget.getAttribute('href');
  if (href) window.api.system.openExternal(href);
}
