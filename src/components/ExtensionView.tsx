import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { allLeaves, leafOfTab } from '../state/layout';
import type { ExtensionPanelView } from '../global';
import {
  execCommand,
  needsConsent,
  panelDocument,
  readTheme,
  route,
  terminalSetup,
} from '../lib/extensionHost';

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
  if (view.needs === 'kubernetes') {
    // Nothing to check: a cluster is not a folder, and this panel is as valid
    // opened from nowhere as from anywhere.
  } else if (view.needs === 'repository' && !root) {
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
  /*
   * The question asked before something is taken away, and the answer that is
   * waiting on it. Drawn by the app rather than by `window.confirm`, and not
   * only for the look of it: a native dialog is auto-accepted when anything is
   * driving the app — a debugger, a test harness — which for "delete this in
   * production?" is the one behaviour that must never happen quietly.
   */
  const [asking, setAsking] = useState<{ question: string; answer: (yes: boolean) => void } | null>(null);
  const doc = useMemo(() => panelDocument(view.source ?? '', readTheme()), [view.source]);
  /*
   * The long-running things this panel started — a followed log, a held-open
   * port. Kept per frame rather than globally, which is what stops one panel
   * from stopping another's: an id it never received is an id it cannot name.
   */
  const streams = useRef(new Set<string>());

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
        } else if (message.name === 'copy' && typeof message.payload?.text === 'string') {
          // A frame in an origin of its own has no clipboard to write to, so it
          // asks. Text only: what goes on the clipboard is a string the person
          // will paste somewhere, not a payload of the panel's choosing.
          void navigator.clipboard.writeText(message.payload.text);
        }
        return;
      }

      if (message.type !== 'call') return;
      const reply = (ok: boolean, data: unknown, error?: string) =>
        frame.current?.contentWindow?.postMessage({ type: 'reply', id: message.id, ok, data, error }, '*');

      const name = String(message.name ?? '');
      const channel = route(name);
      if (!channel) {
        // Named, rather than a generic refusal: an extension asking for
        // something that does not exist is a bug its author has to be able to
        // see, and "no" with no noun in it tells nobody anything.
        reply(false, null, `"${name}" is not something an extension may ask the app to do`);
        return;
      }

      const args = (message.args ?? {}) as Record<string, unknown>;
      const question = needsConsent(name, args);
      if (question) {
        const yes = await new Promise<boolean>((answer) => setAsking({ question, answer }));
        setAsking(null);
        if (!yes) {
          reply(false, null, 'the person said no');
          return;
        }
      }

      try {
        if (channel === 'git') {
          if (!root) return reply(false, null, 'this panel has no repository');
          return reply(true, await window.api.git.call(name, root, args), undefined);
        }
        if (channel === 'kube') {
          return reply(true, await window.api.kube.call(name.slice(5), args), undefined);
        }
        if (channel === 'kube-stream') {
          return reply(true, await stream(name.slice(5), args), undefined);
        }
        return reply(true, await appAction(name.slice(5), args), undefined);
      } catch (error) {
        reply(false, null, String((error as Error)?.message ?? error));
      }
    };

    /**
     * Starting and stopping the things that keep talking.
     *
     * An id is handed out rather than taken: the panel gets back a name for the
     * stream it just started and can stop that one. It cannot stop a stream it
     * was never given, and closing the tab stops all of them whether it asks or
     * not.
     */
    async function stream(verb: string, args: Record<string, unknown>) {
      if (verb === 'stopFollow' || verb === 'stopForward') {
        const id = String(args.id ?? '');
        if (!streams.current.has(id)) return { ok: false, error: 'that is not a stream this panel started' };
        streams.current.delete(id);
        return window.api.kube.stopStream(id);
      }
      const id = crypto.randomUUID();
      streams.current.add(id);
      const started = await window.api.kube.stream(id, verb === 'forward' ? 'portForward' : 'logs', args);
      if (!started.ok) streams.current.delete(id);
      return { ...started, id };
    }

    /**
     * The two that open something in the app instead of answering a question.
     *
     * Both build what they run from named parts. The panel says which pod, and
     * which cluster it is looking at; it never says what to type or what to
     * ask, because a tab it could dictate the contents of would be a tab it
     * controls rather than one it opened.
     */
    async function appAction(verb: string, args: Record<string, unknown>) {
      const where = {
        context: args.context ? String(args.context) : undefined,
        namespace: args.namespace ? String(args.namespace) : undefined,
      };
      const store = useStore.getState();

      if (verb === 'shell' || verb === 'terminal') {
        const line =
          verb === 'shell'
            ? execCommand({
                ...where,
                pod: String(args.pod ?? ''),
                container: args.container ? String(args.container) : undefined,
              })
            : terminalSetup(where);
        const sessionId = await store.newSession({
          kind: 'shell',
          title: verb === 'shell' ? `sh ${String(args.pod ?? '')}`.slice(0, 28) : `k ${where.namespace ?? 'cluster'}`,
          ...beside(panelId),
        });
        if (!sessionId) return { ok: false, error: 'the app could not open a terminal' };
        /*
         * After the shell has drawn its prompt, which is the same wait a
         * restored session's command uses and is not arbitrary: a line typed
         * into a zsh that is still sourcing its profile comes back mangled,
         * half of it echoed and the rest run against a shell that had not
         * finished defining `compdef` yet. Two and a half seconds is what that
         * costs to avoid.
         */
        window.setTimeout(() => useStore.getState().runCommandIn(sessionId, line), 2500);
        return { ok: true, sessionId, command: line };
      }

      // Ask Claude. The evidence is gathered by the app, in the app's words.
      const brief = await window.api.kube.call('brief', {
        ...where,
        kind: String(args.kind ?? ''),
        name: String(args.name ?? ''),
        container: args.container ? String(args.container) : undefined,
        question: args.question ? String(args.question) : undefined,
      });
      if (!brief.ok) return brief;
      const sessionId = await store.newSession({
        kind: 'claude',
        title: `why ${String(args.name ?? '')}`.slice(0, 28),
        ...beside(panelId),
      });
      if (!sessionId) return { ok: false, error: 'the app could not open a session' };
      // It rides the same queue as a handover, so it lands the moment Claude is
      // up and waiting rather than into a terminal that is still starting.
      const handed = await window.api.analysis.handOver(sessionId, String(brief.text ?? ''));
      return { ok: true, sessionId, delivered: handed.delivered ?? false };
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [panelId, root, view.title, revealFile]);

  /**
   * Where a tab this panel opens should go: anywhere but on top of the panel.
   *
   * A dashboard you clicked *from* disappearing the moment you click is the
   * oldest bad habit in this kind of tool — the terminal you asked for arrives
   * and the thing you were reading is gone. So it goes into another pane if
   * there is one, and splits below if there is not. The panel stays where it
   * was, still following its log, still showing the row you were on.
   */
  function beside(id: string) {
    const { layout } = useStore.getState();
    const mine = leafOfTab(layout, id);
    if (!mine) return {};
    const elsewhere = allLeaves(layout).find((leaf) => leaf.id !== mine.id);
    return elsewhere
      ? { leafId: elsewhere.id, side: 'center' as const }
      : { leafId: mine.id, side: 'bottom' as const };
  }

  /*
   * A followed log, arriving. Only this panel's own streams are passed on: the
   * channel is shared by every panel in the window, and a log meant for one of
   * them is not news to the others.
   */
  useEffect(() => {
    const held = streams.current;
    const stop = window.api.kube.onStream((payload) => {
      if (!held.has(payload.id)) return;
      if (payload.done) held.delete(payload.id);
      tell('stream', payload);
    });
    return () => {
      stop();
      // The tab is going away, and so is anything it started. A port-forward
      // nobody stops is a port left open by a panel that no longer exists.
      for (const id of held) window.api.kube.stopStream(id);
      held.clear();
    };
  }, []);

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
      {asking && (
        <div className="modal-backdrop" onMouseDown={() => asking.answer(false)}>
          <div className="confirm" onMouseDown={(event) => event.stopPropagation()}>
            <h3>{view.title}</h3>
            {asking.question.split('\n\n').map((line, at) =>
              at === 0 ? <p key={at} style={{ color: 'var(--text)' }}>{line}</p> : <p key={at}>{line}</p>,
            )}
            <div className="confirm-actions">
              <button className="ghost-btn" onClick={() => asking.answer(false)} autoFocus>
                Cancel
              </button>
              <button className="danger-btn" onClick={() => asking.answer(true)}>
                Do it
              </button>
            </div>
          </div>
        </div>
      )}
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
