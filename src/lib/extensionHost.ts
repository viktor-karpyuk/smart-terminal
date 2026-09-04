/**
 * Hosting a whole view that came with an extension.
 *
 * A preview was easy to make safe: text in, HTML out, run in a worker with no
 * DOM and shown in a frame that runs no scripts. A panel cannot work that way,
 * because a panel is worked in — it has to answer a click, ask a question and
 * draw the answer. So it gets scripts, and the question becomes where.
 *
 * In a frame with `sandbox="allow-scripts"` and deliberately *not*
 * `allow-same-origin`. That combination puts the document in an opaque origin
 * of its own: it cannot touch this page, cannot read a cookie or a stored value
 * belonging to the app, has no `window.api`, no `require`, no filesystem, and
 * no way to navigate anything but itself. Everything it wants from the app it
 * has to ask for by message, and every message lands on the table below, which
 * is a fixed list of names rather than anything derived from what was asked.
 *
 * Two things remain true and are said rather than implied. Such a frame can
 * still reach the network — the renderer has no CSP yet, which is the next
 * thing worth closing. And a panel can be wrong: it can throw, hang or draw
 * nonsense. It cannot take the app with it, which is the line that matters.
 */

/** Reading the repository. Free: none of it changes anything. */
const READ_VERBS = [
  'root',
  'status',
  'graph',
  'refs',
  'compare',
  'commitFiles',
  'head',
  'diff',
] as const;

/**
 * Changing the repository.
 *
 * Allowed, because a graph you cannot check out a branch from is a picture, not
 * a tool — and an extension was installed on purpose, from the repository, by
 * somebody who wanted what it does. What it is not allowed to do is anything
 * that is not on this list.
 */
const WRITE_VERBS = [
  'stage',
  'unstage',
  'commit',
  'push',
  'pull',
  'fetch',
  'checkout',
  'createBranch',
  'renameBranch',
  'trackRemote',
  'deleteBranch',
  'merge',
  'rebase',
  'abortMerge',
  'revert',
  'stash',
  'stashPop',
] as const;

const ALLOWED = new Set<string>([...READ_VERBS, ...WRITE_VERBS]);

export function allowed(name: string): boolean {
  return ALLOWED.has(name);
}

/**
 * The calls the app stops to ask about first.
 *
 * Not because the extension is suspect — it is the same list a person should be
 * asked about anyway. These are the two that can destroy work that exists
 * nowhere else: a force push over somebody's commits, and deleting a branch git
 * itself would have refused to delete.
 */
export function needsConsent(name: string, args: Record<string, unknown>): string | null {
  if (name === 'push' && args?.force) {
    return 'Force-push, overwriting what is on the remote?';
  }
  if (name === 'deleteBranch' && args?.force) {
    return `Delete the branch "${String(args.name ?? '')}" even though it is not merged?`;
  }
  return null;
}

/**
 * The bridge given to the panel, as source.
 *
 * Deliberately tiny, and deliberately the only way out: a panel that wants
 * anything says so through `host`, and what comes back is whatever the app
 * decided to answer.
 *
 * `postMessage` targets `'*'` because a sandboxed frame has no origin to name;
 * the host tells frames apart by comparing `event.source`, which is identity
 * rather than a string anyone could claim.
 */
const SHIM = `(function () {
  var pending = {};
  var listeners = {};
  var next = 0;
  function post(message) { parent.postMessage(message, '*'); }

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'reply') {
      var waiting = pending[message.id];
      if (!waiting) return;
      delete pending[message.id];
      if (message.ok) waiting.resolve(message.data);
      else waiting.reject(new Error(message.error || 'the app would not do that'));
      return;
    }
    var fns = listeners[message.type] || [];
    for (var i = 0; i < fns.length; i += 1) {
      try { fns[i](message.payload); } catch (error) { /* one listener's problem */ }
    }
  });

  window.host = {
    /** Ask the app to run one of the things it allows. Resolves with its answer. */
    call: function (name, args) {
      var id = ++next;
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject };
        post({ type: 'call', id: id, name: name, args: args || {} });
      });
    },
    /** Listen for something the app pushes: 'context', 'changed', 'theme'. */
    on: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    /** Tell the app something: 'openFile', 'notify', 'title'. */
    emit: function (name, payload) { post({ type: 'event', name: name, payload: payload }); },
    /** Say the panel is up, and get the context back. */
    ready: function () { post({ type: 'ready' }); }
  };
})();`;

/** The theme values a panel is given, so it looks like part of the app. */
export type PanelTheme = { dark: boolean; tokens: Record<string, string> };

/**
 * The tokens handed across.
 *
 * Named rather than "whatever the app happens to define": a panel written
 * against a list can be relied on to keep working, and the app can change the
 * rest of its stylesheet without silently changing what extensions look like.
 */
export const THEME_TOKENS = [
  'bg',
  'bg-panel',
  'bg-elevated',
  'bg-input',
  'border',
  'border-strong',
  'text',
  'text-dim',
  'text-faint',
  'accent',
  'accent-soft',
  'danger',
  'ok',
  'git-new',
  'radius',
];

/** Read the app's own theme, to hand to a panel. */
export function readTheme(): PanelTheme {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const token of THEME_TOKENS) tokens[token] = style.getPropertyValue(`--${token}`).trim();
  return { dark: document.documentElement.dataset.theme !== 'light', tokens };
}

function cssVariables(theme: PanelTheme): string {
  return THEME_TOKENS.map((token) => `--${token}: ${theme.tokens[token] || 'inherit'};`).join('\n    ');
}

/**
 * Build the document a panel runs as.
 *
 * The extension supplies the body; the app supplies the head. That is not
 * tidiness — it is what stops a panel from declaring its own `<base>`, its own
 * charset, or a `<meta>` that changes how the frame behaves, and it is what
 * guarantees the bridge is in place before any of the extension's own script
 * runs.
 */
export function panelDocument(body: string, theme: PanelTheme): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  :root {
    ${cssVariables(theme)}
    color-scheme: ${theme.dark ? 'dark' : 'light'};
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: var(--border-strong); border: 3px solid transparent; background-clip: content-box; border-radius: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
</style>
<script>${SHIM}</script>
</head>
<body>
${body}
</body>
</html>`;
}
