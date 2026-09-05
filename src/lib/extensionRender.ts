/**
 * Running the code an extension brought with it.
 *
 * In a worker built from a blob, which is what gives it nothing: no DOM, no
 * `require`, no import, no filesystem, no preload bridge, no reference to the
 * page it will be shown on. It is handed a string and asked for a string, and
 * that string goes into a frame that runs no scripts.
 *
 * Two things are still true and worth stating rather than implying otherwise. A
 * worker can reach the network. And a worker can loop forever — which is why
 * every call has a deadline, after which the worker is destroyed rather than
 * waited on: an extension is allowed to be wrong, not to take the app with it.
 */

/** Long enough for a large file, short enough that a hang is caught. */
const DEADLINE_MS = 4000;

/**
 * The shim wrapped around an extension's code.
 *
 * `render` is called by name, so an extension is a file that defines a function
 * and nothing more — no exports, no registration, no lifecycle to get wrong.
 */
function workerSource(code: string): string {
  return `${code}
;(function () {
  self.onmessage = function (event) {
    var id = event.data && event.data.id;
    try {
      if (typeof render !== 'function') throw new Error('the extension defines no render function');
      var html = render(event.data.input);
      if (typeof html !== 'string') throw new Error('render returned ' + typeof html + ', not a string');
      self.postMessage({ id: id, ok: true, html: html });
    } catch (error) {
      self.postMessage({ id: id, ok: false, error: String((error && error.message) || error) });
    }
  };
})();`;
}

type Live = { worker: Worker; url: string };

/** One worker per extension, kept while it is installed and used. */
const live = new Map<string, Live>();
let nextCall = 0;

function start(kind: string, source: string): Live {
  const url = URL.createObjectURL(new Blob([workerSource(source)], { type: 'text/javascript' }));
  const worker = new Worker(url);
  const entry = { worker, url };
  live.set(kind, entry);
  return entry;
}

/** Throw away the worker for a kind — after a failure, or when it is uninstalled. */
export function dropExtension(kind: string) {
  const entry = live.get(kind);
  if (!entry) return;
  entry.worker.terminate();
  URL.revokeObjectURL(entry.url);
  live.delete(kind);
}

/** Throw away every worker but the ones still wanted. */
export function keepOnlyExtensions(kinds: string[]) {
  const wanted = new Set(kinds);
  for (const kind of [...live.keys()]) if (!wanted.has(kind)) dropExtension(kind);
}

export type RenderInput = { path: string; text: string; dark: boolean };

/**
 * Ask an extension to render a document.
 *
 * Resolves to the HTML, or rejects with what went wrong — which is shown, not
 * swallowed: an extension that throws on a file is a thing its author needs to
 * hear about, and a blank frame tells nobody anything.
 */
export function renderWithExtension(kind: string, source: string, input: RenderInput): Promise<string> {
  const entry = live.get(kind) ?? start(kind, source);
  const id = (nextCall += 1);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      entry.worker.removeEventListener('message', onMessage);
      entry.worker.removeEventListener('error', onError);
      fn();
    };

    const onMessage = (event: MessageEvent) => {
      if (event.data?.id !== id) return;
      finish(() =>
        event.data.ok ? resolve(String(event.data.html)) : reject(new Error(String(event.data.error))),
      );
    };
    const onError = (event: ErrorEvent) => {
      // A worker that fails to even load its own code is not going to recover.
      finish(() => {
        dropExtension(kind);
        reject(new Error(event.message || 'the extension could not be loaded'));
      });
    };

    const timer = window.setTimeout(() => {
      finish(() => {
        dropExtension(kind);
        reject(new Error(`the extension took longer than ${DEADLINE_MS / 1000} seconds and was stopped`));
      });
    }, DEADLINE_MS);

    entry.worker.addEventListener('message', onMessage);
    entry.worker.addEventListener('error', onError);
    entry.worker.postMessage({ id, input });
  });
}
