/**
 * Runs an expression inside a running dev instance's renderer and prints the result.
 *
 *   node --experimental-websocket scripts/eval-renderer.mjs "<expression>"
 *   node --experimental-websocket scripts/eval-renderer.mjs "" path/to/script.js
 *
 * Terminals draw to a canvas and the app's state lives in a zustand store, so
 * neither is visible from the DOM or from the outside. This is how a change gets
 * checked against the running app instead of against a guess about it.
 *
 * Needs the dev instance started with --remote-debugging-port=9333. A second
 * instance on another port is reachable with EVAL_PORT=9334, which is how two
 * builds get compared side by side.
 */
const port = process.env.EVAL_PORT || '9333';
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
  console.error(`No renderer on port ${port} — is the dev instance running?`);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};
await new Promise((resolve) => (ws.onopen = resolve));

const fs = await import('node:fs');
const expression = process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8') : process.argv[2];
const out = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});

if (out.result.exceptionDetails) {
  console.error(JSON.stringify(out.result.exceptionDetails, null, 2));
  process.exitCode = 1;
} else {
  const value = out.result.result.value;
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
ws.close();
