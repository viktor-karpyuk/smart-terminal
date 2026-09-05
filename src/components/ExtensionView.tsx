import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import type { ExtensionPanelView } from '../global';
import { allowed, needsConsent, panelDocument, readTheme } from '../lib/extensionHost';

/**
 * A panel an extension brought, and the only door between it and the app.
 *
 * Everything the frame is allowed to do passes through the handler below. It is
 * a short function on purpose: a bridge with branches in it is a bridge whose
 * behaviour nobody can hold in their head, and this one is the whole of the
 * app's exposure to code it did not write.
 *
 * Messages are matched by `event.source`, not by origin. A sandboxed frame has
 * no origin to check — `event.origin` is the string "null" for every one of
 * them, including any other page that manages to post at us — so identity of
 * the window object is the only check worth making, and it is exact.
 */
export function ExtensionView({ panelId }: { panelId: string }) {
  const panel = useStore((s) => {
    const found = s.panels[panelId];
    return found?.kind === 'extension' ? found : null;
  });
  const view = useStore((s) =>
    panel ? (s.extensions.panels.find((candidate) => candidate.id === panel.viewId) ?? null) : null,
  );
  const root = panel?.root ?? null;
  const theme = useStore((s) => s.settings.theme);

  if (!panel) return null;

  if (!view) {
    return (
      <div className="extension-view is-empty">
        <p>
          The extension that draws this is not installed any more. Install it again from Extensions,
          or close this tab.
        </p>
      </div>
    );
  }
  if (view.error || !view.source) {
    return (
      <div className="extension-view is-empty">
        <p>
          <strong>{view.title}</strong> could not be loaded: {view.error ?? 'it brought no document.'}
        </p>
      </div>
    );
  }
  if (view.needs === 'repository' && !root) {
    return (
      <div className="extension-view is-empty">
        <p>
          <strong>{view.title}</strong> needs a repository. Open a folder in a Files tab and start it
          from there.
        </p>
      </div>
    );
  }

  // Keyed on the theme so a light/dark switch rebuilds the document rather than
  // trying to repaint a frame from the outside, which is not something the app
  // is allowed to reach into and do.
  return <Frame key={`${view.from}:${view.id}:${theme}`} panelId={panelId} view={view} root={root} />;
}

function Frame({
  panelId,
  view,
  root,
}: {
  panelId: string;
  view: ExtensionPanelView;
  root: string | null;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const revealFile = useStore((s) => s.revealFile);
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(null);
  const doc = useMemo(() => panelDocument(view.source ?? '', readTheme()), [view.source]);

  /** Anything the app pushes at the panel. Safe when the frame is not up yet. */
  const tell = (type: string, payload: unknown) => {
    frame.current?.contentWindow?.postMessage({ type, payload }, '*');
  };

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      // Identity, not origin: see the note at the top of the file.
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const message = event.data;
      if (!message || typeof message !== 'object') return;

      if (message.type === 'ready') {
        tell('context', { root, panelId, title: view.title });
        return;
      }

      if (message.type === 'event') {
        if (message.name === 'openFile' && typeof message.payload?.path === 'string' && root) {
          // The panel says which file; the app says where it opens. A panel that
          // could choose the tab could also take over the one you were reading.
          revealFile(root, message.payload.path);
        } else if (message.name === 'notify' && typeof message.payload?.text === 'string') {
          setNotice({ text: message.payload.text, bad: message.payload.kind === 'bad' });
        }
        return;
      }

      if (message.type !== 'call') return;
      const reply = (ok: boolean, data: unknown, error?: string) =>
        frame.current?.contentWindow?.postMessage({ type: 'reply', id: message.id, ok, data, error }, '*');

      const name = String(message.name ?? '');
      if (!allowed(name)) {
        // Named, rather than a generic refusal: an extension asking for
        // something that does not exist is a bug its author has to be able to
        // see, and "no" with no noun in it tells nobody anything.
        reply(false, null, `"${name}" is not something an extension may ask the app to do`);
        return;
      }
      if (!root) {
        reply(false, null, 'this panel has no repository');
        return;
      }

      const args = (message.args ?? {}) as Record<string, unknown>;
      const question = needsConsent(name, args);
      // eslint-disable-next-line no-alert
      if (question && !window.confirm(`${view.title}\n\n${question}`)) {
        reply(false, null, 'the person said no');
        return;
      }

      try {
        const result = await window.api.git.call(name, root, args);
        reply(true, result, undefined);
      } catch (error) {
        reply(false, null, String((error as Error)?.message ?? error));
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [panelId, root, view.title, revealFile]);

  // The working tree moved: the panel is told, and decides for itself what of
  // its picture is now wrong. The app does not guess on its behalf.
  useEffect(() => {
    if (!root) return;
    const stop = window.api.files.onTreeChanged((change) => {
      if (change.root === root) tell('changed', { kind: change.kind });
    });
    return stop;
  }, [root]);

  return (
    <div className="extension-view">
      {notice && (
        <div className={`git-notice ${notice.bad ? 'is-bad' : 'is-ok'}`}>
          <span className="file-bar-dot" />
          <span className="file-bar-text">{notice.text}</span>
          <button className="link-btn" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      <iframe
        ref={frame}
        className="extension-frame"
        title={view.title}
        // Scripts, and nothing else. Without `allow-same-origin` the document
        // is in an origin of its own, which is what makes everything above the
        // only way it can reach the app.
        sandbox="allow-scripts"
        srcDoc={doc}
      />
    </div>
  );
}
