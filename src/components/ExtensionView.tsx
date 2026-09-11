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
  shortContext,
  springShellSetup,
  jdbCommand,
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
  } else if ((view.needs === 'repository' || view.needs === 'folder') && !root) {
    return (
      <div className="extension-view is-empty">
        <p>
          <strong>{view.title}</strong> needs a {view.needs === 'folder' ? 'folder' : 'repository'}. Open a
          folder in a Files tab and start it from there.
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

/**
 * Where each panel was, kept outside the component that keeps being rebuilt.
 *
 * The frame is destroyed and made again whenever the pane it lives in changes
 * shape: a terminal opening underneath it, that terminal closing, the theme
 * changing. React is right to do that — it is a different position in a
 * different tree — but a new frame is a new document, and a new document starts
 * wherever the panel starts. So asking Claude about a pod threw away the table
 * the pod was found in, and closing the session threw it away again.
 *
 * A panel says where it is; this holds it for the next frame with the same id.
 * Module scope on purpose: it has to outlive the component, and it is a handful
 * of small objects that go when the window does. The app never reads what is in
 * one — it hands it straight back to the panel that wrote it.
 */
const whereEachPanelWas = new Map<string, unknown>();

/**
 * The Claude session a cluster panel talks to, one per panel.
 *
 * Ask Claude used to open a tab per question, which is the wrong shape for the
 * way anybody actually debugs a cluster: you look at a pod, then at the service
 * in front of it, then at the deployment behind it, and by the fourth question
 * you have four sessions that each know one thing and a conversation you cannot
 * have. One session per cluster tab knows all four, and can be asked what they
 * have in common.
 *
 * Kept here, beside the panel's place, and for the same reason: it has to
 * survive the frame being rebuilt. Whether it is still alive is asked of the
 * store rather than assumed — the person may have closed it, and a session id
 * that no longer exists is not a session to hand a briefing to.
 */
const claudeForPanel = new Map<string, string>();
/** Panels that have already been given one, so a rebuilt frame does not open a second. */
const alreadyOffered = new Set<string>();

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
   * A notice floats over the panel and does not push it.
   *
   * It used to be a row above the frame, so "Copied labels." moved every row of
   * a table thirty pixels down and left it there until somebody dismissed it —
   * a confirmation that costs a click and loses your place is worse than no
   * confirmation. Good news goes on its own after a few seconds; bad news stays,
   * because an error you did not read is an error that did not happen as far as
   * you know.
   */
  useEffect(() => {
    if (!notice || notice.bad) return;
    const going = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(going);
  }, [notice]);
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
          // Where it was before the last time this frame was thrown away.
          resume: whereEachPanelWas.get(panelId) ?? null,
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
        } else if (message.name === 'remember') {
          // Opaque: whatever the panel says it needs to come back, handed back
          // to that same panel and read by nothing else.
          whereEachPanelWas.set(panelId, message.payload ?? null);
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
        if (channel === 'spring') {
          // The folder is this frame's, whatever the panel wrote: it is what
          // the other side scopes every answer to.
          if (!root) return reply(false, null, 'this panel has no folder');
          return reply(true, await window.api.spring.call(name.slice(7), { ...args, root }), undefined);
        }
        if (channel === 'kube-stream') {
          return reply(true, await stream(name.slice(5), args), undefined);
        }
        if (name.startsWith('spring.')) return reply(true, await springAction(name.slice(7), args), undefined);
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
    /**
     * The same two doors, for a Spring Boot application.
     *
     * `shell` opens a terminal standing in the application's folder with its
     * JDK first on the PATH; `ask` hands a Claude session the app's own account
     * of a run — how it was started, where it stands, and the part of the
     * console that says why. The panel names the application or the run. It
     * does not write the command, and it does not write the briefing.
     */
    async function springAction(verb: string, args: Record<string, unknown>) {
      const store = useStore.getState();
      const inside = (dir: string) => Boolean(root) && (dir === root || dir.startsWith(`${root}/`));
      /*
       * A JDK the machine actually has. The panel names one; the list it is
       * checked against is the app's own, because what goes here ends up first
       * on the PATH of a real shell.
       */
      const knownJdk = async (home: unknown): Promise<string | undefined> => {
        if (!home) return undefined;
        const listed = await window.api.spring.call('jdks');
        const jdks = (listed.jdks as Array<{ home: string }> | undefined) ?? [];
        return jdks.some((jdk) => jdk.home === String(home)) ? String(home) : undefined;
      };
      if (verb === 'shell') {
        const dir = String(args.dir ?? '');
        if (!inside(dir)) return { ok: false, error: 'that folder is not under this panel’s root' };
        const line = springShellSetup({ dir, javaHome: await knownJdk(args.javaHome) });
        const title = `sh ${String(args.name ?? dir.split('/').pop() ?? '')}`.slice(0, 28);
        const sessionId = await store.openShellNear(panelId, title, line, below(panelId));
        if (!sessionId) return { ok: false, error: 'the app could not open a terminal' };
        return { ok: true, sessionId, command: line };
      }
      if (verb === 'debugger') {
        const dir = String(args.dir ?? '');
        if (!inside(dir)) return { ok: false, error: 'that folder is not under this panel’s root' };
        const line = jdbCommand({ dir, port: Number(args.port), javaHome: await knownJdk(args.javaHome) });
        const title = `jdb ${String(args.name ?? '')}`.slice(0, 28);
        const sessionId = await store.openShellNear(panelId, title, line, below(panelId));
        if (!sessionId) return { ok: false, error: 'the app could not open a terminal' };
        return { ok: true, sessionId, command: line };
      }
      // The briefing is the app's words about the run; the panel names the run and nothing else.
      const brief = await window.api.spring.call('brief', { id: String(args.id ?? ''), root });
      if (!brief.ok) return brief;
      const sessionId = await claudeFor(panelId);
      if (!sessionId) return { ok: false, error: 'the app could not open a session' };
      store.focusSession(sessionId);
      const handed = await window.api.analysis.handOver(sessionId, String(brief.text ?? ''));
      return { ok: true, sessionId, delivered: handed.delivered ?? false };
    }

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
      /*
       * The session this panel already has, if it still has one. A briefing goes
       * into the conversation that already holds the other three objects rather
       * than starting a fourth that knows one thing.
       */
      const sessionId = await claudeFor(panelId);
      if (!sessionId) return { ok: false, error: 'the app could not open a session' };
      store.focusSession(sessionId);
      // It rides the same queue as a handover, so it lands the moment Claude is
      // up and waiting rather than into a terminal that is still starting.
      const handed = await window.api.analysis.handOver(sessionId, String(brief.text ?? ''));
      return { ok: true, sessionId, delivered: handed.delivered ?? false };
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [panelId, root, view.title, revealFile]);

  /**
   * The Claude session for this panel: the one it has, or a new one.
   *
   * Asked of the store every time rather than trusted, because the person can
   * close it — and then the next question opens another, which is the right
   * answer to having closed one.
   */
  async function claudeFor(id: string): Promise<string | null> {
    const store = useStore.getState();
    const held = claudeForPanel.get(id);
    if (held && store.sessions[held]) return held;

    const sessionId = await store.newSession({
      kind: 'claude',
      // Named after the cluster, not after the panel: "ask Kubernetes" says
      // nothing on a machine with four clusters in kubeconfig.
      title: `ask ${
        view.needs === 'kubernetes' ? shortContext(String(root ?? '')) || 'cluster' : String(root ?? '').split('/').pop() || 'folder'
      }`.slice(0, 28),
      /*
       * An account that is actually signed in.
       *
       * The default one usually is, and when it is not, a session opens onto a
       * sign-in prompt and the brief sits in a queue behind it — which looks
       * like the button not working. Any signed-in account can answer a
       * question about a cluster.
       */
      profileId: signedInProfile(),
      ...below(id),
    });
    if (!sessionId) return null;
    claudeForPanel.set(id, sessionId);
    return sessionId;
  }

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

  /*
   * What a Spring Boot application printed, and where each run stands.
   *
   * Every frame is told, because the runs are the app's rather than any
   * panel's: the panel that started one may have been closed and another
   * opened on the same folder. A panel keeps the runs it knows and ignores
   * the rest; a panel that is not about Spring has no listener for the type.
   */
  useEffect(() => {
    // Only a panel that asked. A build prints a line per write, and every
    // frame in every window hearing each one is the wrong shape for a channel.
    if (!view.listens?.includes('spring') || !root) return;
    const stopOutput = window.api.spring.onOutput((payload) => tell('spring', { kind: 'output', ...payload }));
    const stopState = window.api.spring.onState((run) => {
      // Its own folder's runs; another folder's are another panel's news.
      if (run.root !== root && !(typeof run.dir === 'string' && (run.dir === root || run.dir.startsWith(`${root}/`)))) return;
      tell('spring', { kind: 'state', run });
    });
    return () => {
      stopOutput();
      stopState();
    };
  }, [view.listens, root]);

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
  /*
   * A cluster tab arrives with a Claude session already open under it.
   *
   * Not because a session is needed to look at a cluster — it is not — but
   * because of when you find out you want one. You want it at the moment
   * something is wrong, and at that moment the last thing worth doing is
   * waiting for a CLI to start and an account to be checked. So it is there,
   * pointed at nothing, costing a process and no tokens: this hands it no
   * briefing and asks it nothing. It learns about an object when you ask about
   * one, and not before.
   *
   * Once per panel per window. Closing it is an answer, and the next question
   * is what opens another.
   */
  useEffect(() => {
    if (view.needs !== 'kubernetes' || !showing) return;
    if (alreadyOffered.has(panelId)) return;
    alreadyOffered.add(panelId);
    void claudeFor(panelId);
    // `claudeFor` reads the store when it runs; it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId, view.needs, showing]);

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
        <div className={`git-notice is-floating ${notice.bad ? 'is-bad' : 'is-ok'}`}>
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
