import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { leafOfTab, parentOf } from '../state/layout';
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
export function ExtensionView({ panelId, showing = true }: { panelId: string; showing?: boolean }) {
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
  return (
    <Frame key={`${view.from}:${view.id}:${theme}`} panelId={panelId} view={view} root={root} showing={showing} />
  );
}

function Frame({
  panelId,
  view,
  root,
  showing,
}: {
  panelId: string;
  view: ExtensionPanelView;
  root: string | null;
  showing: boolean;
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
   * The document is staged before the frame exists, and the frame is given a
   * URL rather than the document itself.
   *
   * `srcDoc` inherits the app's Content-Security-Policy, and the packaged app
   * has a strict one — so every panel's script was blocked and every panel drew
   * its static HTML and nothing else. Development has no CSP, which is exactly
   * why this survived so long unnoticed. Served over its own scheme a panel is
   * its own document with its own policy, and the sandbox that isolates it is
   * unchanged.
   */
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.api.extensions.stagePanel(panelId, doc).then((staged) => {
      if (alive) setSource(staged.url ?? null);
    });
    return () => {
      alive = false;
      void window.api.extensions.stagePanel(panelId, null);
    };
  }, [panelId, doc]);
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
        // `root` is what the panel was opened *on*, and what that is depends on
        // what the panel needs: a repository, or a cluster. Both are named, so
        // a panel never has to guess which one it is being handed.
        tell('context', {
          root: view.needs === 'kubernetes' ? null : root,
          context: view.needs === 'kubernetes' ? root : null,
          panelId,
          title: view.title,
          /*
           * Whether it is in front, in the answer to `ready` rather than only
           * as its own message. A panel mounted behind another tab is told it
           * is hidden before it has a listener to hear that with, and a panel
           * that missed the message would go on believing it was being looked
           * at — and go on asking a cluster about it.
           */
          showing: showingRef.current,
        });
        return;
      }

      if (message.type === 'event') {
        if (message.name === 'openFile' && typeof message.payload?.path === 'string' && root) {
          // The panel says which file; the app says where it opens. A panel that
          // could choose the tab could also take over the one you were reading.
          revealFile(root, message.payload.path);
        } else if (message.name === 'notify' && typeof message.payload?.text === 'string') {
          setNotice({ text: message.payload.text, bad: message.payload.kind === 'bad' });
        } else if (message.name === 'save' && typeof message.payload?.text === 'string') {
          // The dialog is the consent: a panel says what and suggests a name,
          // and a person says where — or does not.
          void window.api.system
            .saveText(String(message.payload.name ?? 'output.txt'), message.payload.text)
            .then((done) => {
              if (done.ok) setNotice({ text: `Saved to ${done.path}`, bad: false });
              else if (done.error) setNotice({ text: done.error, bad: true });
            });
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
        if (channel === 'helm') {
          return reply(true, await window.api.helm.call(name.slice(5), args), undefined);
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
      if (verb === 'stopFollow' || verb === 'stopForward' || verb === 'stopWatch') {
        const id = String(args.id ?? '');
        if (!streams.current.has(id)) return { ok: false, error: 'that is not a stream this panel started' };
        streams.current.delete(id);
        return window.api.kube.stopStream(id);
      }
      const id = crypto.randomUUID();
      streams.current.add(id);
      const op =
        verb === 'forward' ? 'portForward' : verb === 'watch' ? 'watch' : verb === 'drain' ? 'drain' : 'logs';
      const started = await window.api.kube.stream(id, op, args);
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
        const title =
          verb === 'shell' ? `sh ${String(args.pod ?? '')}`.slice(0, 28) : `k ${where.namespace ?? 'cluster'}`;
        const sessionId = await store.openShellNear(panelId, title, line, below(panelId));
        if (!sessionId) return { ok: false, error: 'the app could not open a terminal' };
        return { ok: true, sessionId, command: line };
      }

      // Ask Claude. The evidence is gathered by the app, in the app's words.
      const brief = await window.api.kube.call('brief', {
        ...where,
        kind: String(args.kind ?? ''),
        name: String(args.name ?? ''),
        container: args.container ? String(args.container) : undefined,
        question: args.question ? String(args.question) : undefined,
        // Whether the person is looking at the log of the run that died. It is
        // usually the one with the answer in it.
        previous: Boolean(args.previous),
      });
      if (!brief.ok) return brief;
      const sessionId = await store.newSession({
        kind: 'claude',
        title: `why ${String(args.name ?? '')}`.slice(0, 28),
        /*
         * An account that is actually signed in.
         *
         * The default one usually is, and when it is not, a session opens onto
         * a sign-in prompt and the brief sits in a queue behind it — which
         * looks like the button not working. Any signed-in account can answer a
         * question about a cluster.
         */
        profileId: signedInProfile(),
        ...below(panelId),
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
   * An account that can actually answer: the usual one if it is signed in,
   * otherwise whichever is.
   */
  function signedInProfile(): string | undefined {
    const { profiles, settings, authByProfile } = useStore.getState();
    const usual = profiles.find((profile) => profile.id === settings.defaultProfileId) ?? profiles[0];
    if (usual && authByProfile[usual.id]?.loggedIn !== false) return usual.id;
    return profiles.find((profile) => authByProfile[profile.id]?.loggedIn)?.id ?? usual?.id;
  }

  /**
   * Below the panel, in a strip that is reused.
   *
   * A terminal cannot live *inside* the panel: the frame has no pty and no way
   * to reach one, and a shell drawn in HTML is a toy. What it can have is a real
   * one directly underneath — a pane split off the panel's own, which is the
   * bottom of the Kubernetes area in every sense that matters, and is a real
   * terminal with a real TTY.
   *
   * Read out of the layout rather than remembered. A remembered pane id is a
   * thing that can go stale — the pane is closed, or the window is restored, or
   * the panel is dragged somewhere else — and a stale one sends a terminal into
   * a pane that no longer exists, which is how one ends up running with nowhere
   * to be seen. The pane directly below is a fact about the layout, and asking
   * the layout cannot be out of date.
   */
  function below(id: string) {
    const { layout } = useStore.getState();
    const mine = leafOfTab(layout, id);
    if (!mine) return {};

    const parent = parentOf(layout, mine.id);
    if (parent?.direction === 'column') {
      const at = parent.children.findIndex((child) => child.id === mine.id);
      const under = parent.children[at + 1];
      // Only a plain pane: a split below is somebody else's arrangement.
      if (under && under.type === 'leaf') return { leafId: under.id, side: 'center' as const };
    }
    return { leafId: mine.id, side: 'bottom' as const };
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
    // Only for a panel whose subject is a folder. A cluster's `root` is a
    // context name, and watching the filesystem for one would be listening for
    // a folder that does not exist.
    if (!root || view.needs === 'kubernetes') return;
    const stop = window.api.files.onTreeChanged((change) => {
      if (change.root === root) tell('changed', { kind: change.kind });
    });
    return stop;
  }, [root, view.needs]);

  /*
   * Told, rather than left to work it out. A frame cannot see that the tab in
   * front of it changed — `document.hidden` is about the window — so a panel
   * that was not told would keep polling a cluster nobody is looking at.
   */
  const showingRef = useRef(showing);
  useEffect(() => {
    showingRef.current = showing;
    tell('showing', { showing });
  }, [showing]);

  return (
    <div className="extension-view" hidden={!showing}>
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
      {source && (
        <iframe
          ref={frame}
          className="extension-frame"
          title={view.title}
          // Scripts, and nothing else. Without `allow-same-origin` the document
          // is in an origin of its own, which is what makes everything above the
          // only way it can reach the app.
          sandbox="allow-scripts"
          src={source}
        />
      )}
    </div>
  );
}
