'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const kube = require('./kube');
const { resolvedPath } = require('./cli-env');
const { PfStore, cleanForward, signature } = require('./pf-store');

/**
 * The Port Forward extension, on the app's side of the door.
 *
 * The Kubernetes panel can already forward a port, and that forward is the
 * panel's: it is started from the object on screen and it goes when the panel
 * does. This is the other half — the forwards somebody needs every morning.
 * They are defined once, kept in groups, switched on and off from one list,
 * and they are the app's rather than any panel's: closing the tab leaves them
 * running, and quitting the app stops them all.
 *
 * It is the K8S Port Forward desktop app, brought in here: saved forwards,
 * several ports of one target on one connection, groups, profiles, starting
 * again when a connection drops, saying so when a cloud sign-in has run out
 * rather than retrying into it, and a list of who is listening on what. One
 * engine instead of two — `kubectl port-forward`, the same one the person
 * would type — so what works in their terminal works here and fails the same.
 *
 * A panel names a forward by id. The kubectl line is assembled here from named
 * parts, and nothing a panel wrote is ever a command.
 */

const LOG_KEPT = 200;
const ATTEMPTS = 6;
/** How long one kubectl is given to say it is listening before it is taken for stuck. */
const START_TIMEOUT = 45_000;
/** Up for less than this and then gone is not "it worked": the run of failures goes on counting. */
const SETTLED = 30_000;
/** With no way to the cluster at all, how often it is tried again — for as long as it takes. */
const OFFLINE_EVERY = 60_000;
/** Connections that got through after one that was refused, before the warning about it is taken down. */
const WARNING_CLEARS_AFTER = 3;
/** A connection through the forward, as kubectl reports it. Counted rather than kept: a database client makes hundreds. */
const HANDLING = /^Handling connection for \d+/;

/**
 * Whether what kubectl said means "sign in again".
 *
 * An EKS, GKE or AKS context runs an auth plugin, and when the session behind
 * it has expired the plugin fails — every time, until somebody signs in.
 * Retrying into that six times is noise; saying it once is the answer.
 */
function authTrouble(text) {
  return /Unauthorized|must be logged in|token (?:is|has) expired|ExpiredToken|sso session|sso login|Unable to locate credentials|getting credentials|executable \S+ failed|gcloud auth|az login|credentials? (?:have |has )?expired|InvalidClientTokenId|refresh token/i.test(String(text || ''));
}

/**
 * Whether what kubectl said is the network rather than the cluster's answer.
 *
 * Asked before "is the pod gone", because the two are spelled alike: a VPN
 * that blinked says `no such host`, and a pod that was replaced says `not
 * found`. One of those is what starting again is for.
 */
function networkTrouble(text) {
  return /no such host|dial tcp|i\/o timeout|Unable to connect to the server|network is unreachable|TLS handshake|connection reset|EOF\b|context deadline exceeded/i.test(String(text || ''));
}

/** What to do about it, from which cloud's plugin the cluster is reached through. */
function signInHint(context, said) {
  const text = `${context} ${said}`;
  if (/arn:aws|eks|aws/i.test(text)) return 'Sign in again — `aws sso login` in a terminal — and start it.';
  if (/gke_|gcloud/i.test(text)) return 'Sign in again — `gcloud auth login` in a terminal — and start it.';
  if (/aks|azure|kubelogin|az login/i.test(text)) return 'Sign in again — `az login` in a terminal — and start it.';
  return 'Sign in to the cluster again, and start it.';
}

/** The arguments for one saved forward. `locals` are the ports it had last time, so it comes back where it was. */
function tunnelArgs(forward, locals = []) {
  const clean = cleanForward(forward);
  return [
    ...kube.scope({ context: clean.context, namespace: clean.namespace, forever: true }),
    'port-forward',
    '--address',
    clean.address,
    `${clean.kind}/${clean.target}`,
    ...clean.ports.map((one, index) => `${locals[index] || one.local}:${one.remote}`),
  ];
}

/** Every `Forwarding from <address>:<port>` in a piece of output: the local ports kubectl really opened. */
function listeningPorts(text) {
  return [...String(text || '').matchAll(/Forwarding from (?:\[[^\]]*\]|[^\s:]+):(\d+)\s*->/g)].map((match) => Number(match[1]));
}

/**
 * The forwards that are running, or were.
 *
 * One kubectl per forward, however many ports it carries. A record is kept for
 * each one that was ever started, so a forward that failed still says why and
 * still has its log after the process is gone.
 */
class Tunnels {
  #live = new Map();

  constructor({ spawnProcess = spawn, env = null, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, onChange = () => {} } = {}) {
    this.spawnProcess = spawnProcess;
    this.env = env ?? (async () => ({ ...process.env, PATH: await resolvedPath() }));
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.onChange = onChange;
  }

  #entry(id) {
    return this.#live.get(String(id)) ?? null;
  }

  /** Where one stands, for a panel. The log is asked for separately. */
  state(id) {
    const entry = this.#entry(id);
    return entry ? this.#shown(entry) : { id: String(id), state: 'stopped', ports: [], error: null, warning: null, reconnects: 0, connections: 0, startedAt: null, upAt: null, endsAt: null };
  }

  #shown(entry) {
    const { record } = entry;
    return { ...record, ports: record.ports.map((one) => ({ ...one })) };
  }

  log(id) {
    return [...(this.#entry(id)?.log ?? [])];
  }

  active(id) {
    const state = this.#entry(id)?.record.state;
    return state === 'starting' || state === 'up' || state === 'reconnecting';
  }

  /** The local ports held by forwards that are on, and by whom — to refuse a clash before kubectl has to. */
  held() {
    const out = new Map();
    for (const entry of this.#live.values()) {
      if (!this.active(entry.record.id)) continue;
      for (const one of entry.record.ports) {
        const port = one.actual ?? one.local;
        if (port) out.set(port, entry.forward.name);
      }
    }
    return out;
  }

  async start(forward) {
    const id = String(forward.id);
    if (this.active(id)) return this.state(id);
    tunnelArgs(forward); // refused here, not in a process that dies a second later
    const previous = this.#entry(id);
    this.#end(previous);
    let clash = null;
    for (const [port, name] of this.held()) {
      if (forward.ports.some((one) => one.local === port)) clash = `Port ${port} on this machine is already used by ${name}. Stop that one, or give this one another port.`;
    }
    const record = {
      id,
      state: 'starting',
      ports: forward.ports.map((one) => ({ local: one.local, remote: one.remote, actual: null })),
      error: null,
      warning: null,
      attempts: 0,
      failures: 0,
      // No way to the cluster at all: waited out rather than given up on.
      offline: false,
      reconnects: 0,
      connections: 0,
      startedAt: new Date(this.now()).toISOString(),
      upAt: null,
      endsAt: null,
    };
    const entry = { forward, record, child: null, timer: null, ttl: null, stopped: false, said: '', log: previous?.log ?? [], pending: { out: '', err: '' } };
    this.#live.set(id, entry);
    // Refused before kubectl has to: said on its own row, where it will be looked for.
    if (clash) {
      this.#give(entry, 'failed', clash);
      return this.#shown(entry);
    }
    if (forward.ttlMinutes > 0) {
      const ms = forward.ttlMinutes * 60_000;
      record.endsAt = new Date(this.now() + ms).toISOString();
      entry.ttl = this.setTimer(() => this.#expire(entry), ms);
      entry.ttl?.unref?.();
    }
    this.#note(entry, `starting ${forward.kind}/${forward.target} in ${forward.namespace}`);
    this.onChange(this.#shown(entry));
    await this.#run(entry);
    return this.#shown(entry);
  }

  async #run(entry) {
    const { record, forward } = entry;
    if (entry.stopped) return;
    record.attempts += 1;
    entry.said = '';
    entry.pending = { out: '', err: '' };
    const heard = new Set();
    // Once it has had a port, it asks for that one again: whatever points at it keeps working.
    const args = tunnelArgs(forward, record.ports.map((one) => one.actual));
    let child;
    try {
      // No stdin: an auth plugin that stops to ask a question would otherwise wait for an answer nobody can type.
      child = this.spawnProcess('kubectl', args, { env: await this.env(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      // Stopped, or replaced by a restart, while this was getting ready: that one's story is not this one's.
      if (entry.stopped) return;
      return this.#give(entry, 'failed', kube.cleanError('', error));
    }
    if (entry.stopped) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      return;
    }
    entry.child = child;
    entry.fatal = null;
    entry.starting = this.setTimer(() => {
      entry.starting = null;
      if (entry.child !== child || record.state === 'up') return;
      entry.said = `${entry.said}kubectl did not say it was listening within ${START_TIMEOUT / 1000} seconds.\n`;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }, START_TIMEOUT);
    entry.starting?.unref?.();
    const line = (text, stream) => {
      if (entry.child !== child || !text.trim()) return;
      if (HANDLING.test(text)) {
        record.connections += 1;
        // Connections are getting through again: the one that found nothing listening is history.
        entry.sinceRefused = (entry.sinceRefused ?? 0) + 1;
        if (record.warning && entry.sinceRefused >= WARNING_CLEARS_AFTER) {
          record.warning = null;
          this.onChange(this.#shown(entry));
        }
        return;
      }
      this.#note(entry, text.trim());
      for (const port of listeningPorts(text)) {
        if (heard.has(port)) continue; // said twice, for IPv4 and IPv6; the second is not news
        heard.add(port);
        const slot = record.ports.find((one) => (one.actual ?? one.local) === port && !one.heard) ?? record.ports.find((one) => !one.local && !one.actual);
        if (slot) {
          slot.actual = port;
          slot.heard = true;
        }
      }
      if (record.state !== 'up' && heard.size >= record.ports.length) {
        if (entry.starting) this.clearTimer(entry.starting);
        entry.starting = null;
        // Coming back is after having been up; a first success after a few tries is just starting.
        if (record.upAt) record.reconnects += 1;
        for (const one of record.ports) delete one.heard;
        record.state = 'up';
        record.error = null;
        record.warning = null;
        record.offline = false;
        // `failures` is left as it is: only having stayed up — see `settled` — starts that count over.
        record.upAt = new Date(this.now()).toISOString();
        return this.onChange(this.#shown(entry));
      }
      if (stream !== 'err') return;
      entry.said = `${entry.said}${text}\n`.slice(-2000);
      // One connection finding nothing listening is news, not an ending.
      if (kube.forwardTrouble(text) === 'refused') {
        entry.sinceRefused = 0;
        if (!record.warning) {
          record.warning = 'A connection found nothing listening inside — is the application up on that port?';
          this.onChange(this.#shown(entry));
        }
      }
    };
    const hear = (chunk, stream) => {
      const { lines, rest } = kube.wholeLines(entry.pending[stream] + String(chunk));
      entry.pending[stream] = rest;
      for (const one of lines) line(one, stream);
    };
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => hear(chunk, 'out'));
    child.stderr?.on('data', (chunk) => hear(chunk, 'err'));
    child.on('error', (error) => {
      entry.said = `${entry.said}${kube.cleanError('', error)}\n`;
      // Not installed is not a connection that dropped: trying again finds the same nothing.
      if (error?.code === 'ENOENT') entry.fatal = 'kubectl is not installed, or not on the PATH this app can see.';
    });
    child.on('close', () => {
      if (entry.child !== child) return;
      if (entry.starting) this.clearTimer(entry.starting);
      entry.starting = null;
      for (const stream of ['out', 'err']) if (entry.pending[stream]) line(entry.pending[stream], stream);
      entry.child = null;
      if (entry.stopped) return;
      this.#afterExit(entry);
    });
  }

  #afterExit(entry) {
    const { record, forward } = entry;
    for (const one of record.ports) delete one.heard;
    const said = entry.said.trim() ? kube.cleanError(entry.said, null).split('\n').filter(Boolean).pop() ?? '' : '';
    const wasUp = record.state === 'up';
    const settled = wasUp && record.upAt && this.now() - Date.parse(record.upAt) >= SETTLED;
    if (entry.fatal) return this.#give(entry, 'failed', entry.fatal);
    if (authTrouble(entry.said)) {
      return this.#give(entry, 'auth', `The sign-in for this cluster has run out. ${signInHint(forward.context, entry.said)}`);
    }
    const network = networkTrouble(entry.said);
    const trouble = kube.forwardTrouble(entry.said);
    if (/permission denied/i.test(entry.said) && /listen|bind/i.test(entry.said)) {
      const low = record.ports.map((one) => one.actual ?? one.local).filter((port) => port && port < 1024).join(', ');
      return this.#give(entry, 'failed', `This computer would not let kubectl open port ${low || 'that'}: ports below 1024 need administrator rights. Give it a local port above 1024 — 8080 for 80, 8443 for 443.`);
    }
    if (trouble === 'taken') {
      const port = record.ports.map((one) => one.actual ?? one.local).filter(Boolean).join(', ');
      return this.#give(entry, 'failed', `Port ${port} on this machine is already in use by something else. Ports shows what holds it.`);
    }
    if (trouble === 'gone' && forward.kind === 'pod' && !network) {
      return this.#give(entry, 'failed', `${forward.target} is gone. A pod that was replaced has a new name — point this at its service or its workload, which follow it.`);
    }
    if (!forward.autoRestart) return this.#give(entry, 'failed', said || 'The connection dropped.');
    // One that comes up and falls over at once, again and again, is failing: only having stayed up starts the count over.
    record.failures = settled ? 1 : record.failures + 1;
    /*
     * Nothing is wrong with the forward when there is no network: the VPN is
     * down, the laptop is on a train. Giving up on it then means somebody
     * switches ten of them back on by hand when the network returns — so it
     * is waited out instead, slowly, and comes back by itself.
     */
    if (record.failures >= ATTEMPTS && !network) {
      return this.#give(entry, 'failed', `Gave up after ${record.failures} attempts${said ? `: ${said}` : ''}.`);
    }
    record.offline = network && record.failures >= ATTEMPTS;
    const wait = record.offline ? OFFLINE_EVERY : kube.forwardBackoff(record.failures);
    record.state = 'reconnecting';
    record.error = record.offline ? 'There is no way to the cluster right now — the network, or a VPN. It is tried again every minute.' : said || 'The connection dropped.';
    this.#note(entry, record.offline ? `no way to the cluster; trying again in ${Math.round(wait / 1000)}s` : `starting again in ${Math.round(wait / 1000)}s (attempt ${record.failures + 1} of ${ATTEMPTS})`);
    this.onChange(this.#shown(entry));
    entry.timer = this.setTimer(() => {
      entry.timer = null;
      void this.#run(entry);
    }, wait);
    entry.timer?.unref?.();
  }

  #note(entry, text) {
    entry.log.push(`${new Date(this.now()).toISOString().slice(11, 19)}  ${String(text).slice(0, 500)}`);
    if (entry.log.length > LOG_KEPT) entry.log.splice(0, entry.log.length - LOG_KEPT);
  }

  /** Over, with a reason. The record stays so the list can say what happened. */
  #give(entry, state, why) {
    this.#end(entry);
    entry.record.state = state;
    entry.record.error = why;
    entry.record.endsAt = null;
    this.#note(entry, why);
    this.onChange(this.#shown(entry));
  }

  #expire(entry) {
    if (entry.ttl) this.clearTimer(entry.ttl);
    entry.ttl = null;
    if (!this.active(entry.record.id)) return;
    const minutes = entry.forward.ttlMinutes;
    this.#give(entry, 'expired', `Stopped after ${minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`}, as it was set to.`);
  }

  #end(entry) {
    if (!entry) return;
    entry.stopped = true;
    if (entry.timer) this.clearTimer(entry.timer);
    if (entry.ttl) this.clearTimer(entry.ttl);
    if (entry.starting) this.clearTimer(entry.starting);
    entry.timer = null;
    entry.ttl = null;
    entry.starting = null;
    const child = entry.child;
    entry.child = null;
    try {
      child?.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }

  stop(id) {
    const entry = this.#entry(id);
    if (!entry) return false;
    const was = this.active(id);
    this.#end(entry);
    entry.record.state = 'stopped';
    entry.record.error = null;
    entry.record.warning = null;
    entry.record.endsAt = null;
    if (was) this.#note(entry, 'stopped');
    this.onChange(this.#shown(entry));
    return was;
  }

  /** The computer woke up, or the network came back: whatever was waiting to try again tries now. */
  wake() {
    for (const entry of [...this.#live.values()]) {
      /*
       * A timer does not run while the computer sleeps, so "stop after two
       * hours" set at six in the evening would still be counting at nine the
       * next morning. The time it was to end at is what is kept, and it is
       * looked at again here.
       */
      if (entry.record.endsAt && this.now() >= Date.parse(entry.record.endsAt) && this.active(entry.record.id)) {
        this.#expire(entry);
        continue;
      }
      if (!entry.timer || entry.stopped) continue;
      this.clearTimer(entry.timer);
      entry.timer = null;
      this.#note(entry, 'trying again now');
      void this.#run(entry);
    }
  }

  /** Stopped and forgotten, log and all: the forward itself was removed. */
  forget(id) {
    this.#end(this.#entry(id));
    this.#live.delete(String(id));
  }

  stopAll() {
    for (const entry of this.#live.values()) this.#end(entry);
    this.#live.clear();
  }

  get running() {
    return [...this.#live.keys()].filter((id) => this.active(id));
  }
}

/** What kubectl was told about a forward. Two definitions with the same answer are the same process. */
function running(forward) {
  return JSON.stringify([signature(forward), forward.address, forward.ttlMinutes, forward.autoRestart]);
}

/** kubeconfig as data. No cluster is contacted. */
async function readKubeconfig() {
  const env = { ...process.env, PATH: await resolvedPath() };
  return new Promise((resolve) => {
    execFile('kubectl', ['config', 'view', '-o', 'json'], { env, timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      try {
        resolve(error ? {} : JSON.parse(stdout));
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * The command that signs in to whatever a context authenticates through.
 *
 * Read from the context's own exec block: `aws` means SSO, and the profile it
 * names — in `--profile` or in `AWS_PROFILE` — is the one to sign in to.
 * Nothing from kubeconfig reaches the line but that one name, and only when
 * it is made of the characters a profile name is made of.
 */
function signIn(config, context) {
  const wanted = context || config?.['current-context'] || '';
  const entry = (config?.contexts ?? []).find((one) => one.name === wanted);
  const user = (config?.users ?? []).find((one) => one.name === entry?.context?.user);
  const exec = user?.user?.exec;
  const command = String(exec?.command ?? '');
  const args = Array.isArray(exec?.args) ? exec.args.map(String) : [];
  const text = `${command} ${args.join(' ')}`;
  if (/aws/i.test(text)) {
    const at = args.indexOf('--profile');
    const fromEnv = (Array.isArray(exec?.env) ? exec.env : []).find((one) => one?.name === 'AWS_PROFILE')?.value;
    const profile = String((at >= 0 ? args[at + 1] : fromEnv) ?? '');
    return { title: 'aws sso login', command: /^[A-Za-z0-9_.@-]+$/.test(profile) ? `aws sso login --profile ${profile}` : 'aws sso login' };
  }
  if (/gcloud|gke/i.test(text)) return { title: 'gcloud auth login', command: 'gcloud auth login' };
  if (/kubelogin|azure|\baz\b/i.test(text)) return { title: 'az login', command: 'az login' };
  if (/doctl/i.test(text)) return { title: 'doctl auth init', command: 'doctl auth init' };
  return null;
}

/** Where the K8S Port Forward desktop app keeps its database, on this system. */
function desktopAppFile(home = os.homedir(), platform = process.platform, env = process.env) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'PortForwardApp', 'data.db');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'PortForwardApp', 'data.db');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'port-forward-app', 'data.db');
}

/**
 * Everything the desktop app has saved, in this extension's shape.
 *
 * Opened read-only and closed again: the file is the other app's, and it may
 * be running. A cluster there is an id; here it is the kubeconfig context that
 * id stood for, which is what kubectl is told.
 */
function readDesktopApp(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (!tables.has('forwards')) throw new Error('That is not a K8S Port Forward database');
    const all = (sql) => db.prepare(sql).all();
    const contexts = new Map(tables.has('clusters') ? all('SELECT id, context_name FROM clusters').map((row) => [row.id, row.context_name]) : []);
    const groups = new Map(tables.has('forward_groups') ? all('SELECT id, name FROM forward_groups').map((row) => [row.id, row.name]) : []);
    const ports = new Map();
    if (tables.has('forward_ports')) {
      for (const row of all('SELECT forward_id, remote_port, local_port FROM forward_ports ORDER BY forward_id, ordinal, id')) {
        if (!ports.has(row.forward_id)) ports.set(row.forward_id, []);
        ports.get(row.forward_id).push({ local: row.local_port, remote: row.remote_port });
      }
    }
    const forwards = all('SELECT * FROM forwards ORDER BY created_at').map((row) => ({
      key: row.id,
      name: row.name,
      context: contexts.get(row.cluster_id) ?? '',
      // A cluster the other app no longer knows: nothing here says where this one led.
      lost: !contexts.has(row.cluster_id),
      namespace: row.namespace,
      kind: String(row.target_kind ?? 'pod').toLowerCase(),
      target: row.target_name,
      // Older rows keep their one port on the forward itself.
      ports: ports.get(row.id) ?? [{ local: row.local_port, remote: row.remote_port }],
      address: row.address || '127.0.0.1',
      autoStart: row.auto_start === 1,
      autoRestart: row.auto_restart !== 0,
      group: groups.get(row.group_id) ?? null,
    }));
    const profiles = tables.has('profiles')
      ? all('SELECT id, name FROM profiles').map((row) => ({
          name: row.name,
          forwards: db.prepare('SELECT forward_id FROM profile_forwards WHERE profile_id = ?').all(row.id).map((one) => one.forward_id),
        }))
      : [];
    return { groups: [...groups.values()], forwards, profiles };
  } finally {
    db.close();
  }
}

/** Who is listening on which TCP port of this machine, from `lsof`. */
function parseLsof(text) {
  const seen = new Map();
  for (const line of String(text || '').split('\n')) {
    const match = /^(\S+)\s+(\d+)\s+.*TCP\s+(\S+):(\d+)\s+\(LISTEN\)/.exec(line);
    if (!match) continue;
    const port = Number(match[4]);
    if (!seen.has(port)) seen.set(port, { port, process: match[1].replace(/\\x20/g, ' '), pid: Number(match[2]), address: match[3] });
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

function scanPorts() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') return resolve({ ok: false, error: 'Listing the ports in use is not available on Windows yet.' });
    execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      // lsof exits 1 when it has nothing to list, which is an answer.
      if (error && !stdout) return resolve(error.code === 1 ? { ok: true, ports: [] } : { ok: false, error: 'lsof could not be run, so the ports in use cannot be listed.' });
      resolve({ ok: true, ports: parseLsof(stdout) });
    });
  });
}

class PfService {
  /**
   * @param {object} deps
   * @param {object} deps.db              the app's database handle
   * @param {Function} [deps.emit]        (event) => void — pushed to every window: a forward changed state, or the lists did
   * @param {Function} [deps.openUrl]     (url) => Promise — the system browser
   * @param {Function} [deps.pickFile]    () => Promise<string|null> — a file the person chose to import
   * @param {string}   [deps.desktopFile] where the K8S Port Forward app keeps its data
   * @param {Function} [deps.scan]        () => Promise<{ok, ports}> — who is listening on this machine
   * @param {object}   [deps.tunnels]     options for the engine; a test's fake kubectl goes in here
   */
  constructor({ db, emit, openUrl, pickFile, desktopFile, scan, tunnels, notify, kubeconfig, later } = {}) {
    /** (fn, ms) => void — how "in a moment" is spelled; a test says it differently. */
    this.later = later ?? ((fn, ms) => setTimeout(fn, ms).unref?.());
    /** Endings waiting to be said together: a VPN that drops takes ten forwards with it, and that is one piece of news. */
    this.news = [];
    this.store = new PfStore(db);
    this.emit = emit ?? (() => {});
    /** (title, body) => void — said by the system when a forward that was up is not any more and nobody stopped it. */
    this.notify = notify ?? (() => {});
    /** () => Promise<object> — kubeconfig as data, to see which cloud's sign-in a cluster asks for. */
    this.kubeconfig = kubeconfig ?? readKubeconfig;
    /** forward id → the state it was last seen in, to tell an ending from more of the same. */
    this.seen = new Map();
    this.openUrl = openUrl ?? (async () => {});
    this.pickFile = pickFile ?? (async () => null);
    this.desktopFile = desktopFile ?? desktopAppFile();
    this.scan = scan ?? scanPorts;
    this.tunnels = new Tunnels({ ...tunnels, onChange: (state) => this.#moved(state) });
    this.verbs = this.#verbs();
  }

  /** The forwards marked to start with the app. One that cannot start says so on its own row. */
  start() {
    for (const forward of this.store.forwards()) {
      if (forward.autoStart) this.tunnels.start(forward).catch(() => {});
    }
  }

  stop() {
    this.tunnels.stopAll();
  }

  /** The computer woke from sleep: the forwards that were waiting out a dead connection try again at once. */
  wake() {
    this.tunnels.wake();
  }

  async call(name, args = {}) {
    // Own keys only: `constructor` and `toString` are on every object and are not verbs.
    const verb = Object.hasOwn(this.verbs, name) ? this.verbs[name] : null;
    if (!verb) return { ok: false, error: `No such Port Forward action: ${String(name).slice(0, 60)}` };
    try {
      const given = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      return (await verb(given)) ?? { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** A forward changed state: every window is told, and an ending nobody asked for is said out loud. */
  #moved(state) {
    const before = this.seen.get(state.id);
    this.seen.set(state.id, state.state);
    this.emit({ type: 'state', state });
    /*
     * One that came up proves the sign-in is good again: whatever else on the
     * same cluster stopped for want of one is started, so signing in once and
     * pressing Try again on one row is all there is to do.
     */
    if (state.state === 'up' && before !== 'up') {
      const context = this.store.forward(state.id)?.context;
      for (const other of this.store.forwards()) {
        if (other.id !== state.id && other.context === context && this.tunnels.state(other.id).state === 'auth') this.tunnels.start(other).catch(() => {});
      }
    }
    const wasGoing = before === 'up' || before === 'reconnecting';
    if (!wasGoing || !['failed', 'auth', 'expired'].includes(state.state)) return;
    this.news.push({ name: this.store.forward(state.id)?.name ?? 'A forward', state: state.state, error: String(state.error ?? '') });
    if (this.news.length === 1) this.later(() => this.#tell(), 1500);
  }

  /** What ended in the last moment, as one notification. */
  #tell() {
    const news = this.news;
    this.news = [];
    if (!news.length) return;
    const [first] = news;
    const one = news.length === 1;
    const kind = news.every((item) => item.state === news[0].state) ? first.state : 'failed';
    const title = one
      ? first.state === 'auth' ? `${first.name} needs a sign-in` : first.state === 'expired' ? `${first.name} stopped` : `${first.name} is down`
      : kind === 'auth' ? `${news.length} forwards need a sign-in` : kind === 'expired' ? `${news.length} forwards stopped` : `${news.length} forwards are down`;
    const body = one ? first.error : `${news.slice(0, 6).map((item) => item.name).join(', ')}${news.length > 6 ? ` and ${news.length - 6} more` : ''}. ${kind === 'auth' ? first.error : ''}`;
    try {
      this.notify(title, body.trim().slice(0, 240));
    } catch { /* a notification that cannot be shown is not a reason to fail */ }
  }

  #forward(id) {
    const forward = this.store.forward(id);
    if (!forward) throw new Error('That forward is not here any more');
    return forward;
  }

  #changed() {
    this.emit({ type: 'changed' });
  }

  async #startMany(forwards) {
    const failed = [];
    for (const forward of forwards) {
      try {
        const run = await this.tunnels.start(forward);
        if (run.state === 'failed') failed.push(`${forward.name}: ${run.error}`);
      } catch (error) {
        failed.push(`${forward.name}: ${String(error?.message ?? error)}`);
      }
    }
    return failed.length ? { ok: true, failed } : { ok: true };
  }

  #overview() {
    return {
      ok: true,
      groups: this.store.groups(),
      forwards: this.store.forwards().map((forward) => ({ ...forward, run: this.tunnels.state(forward.id) })),
      profiles: this.store.profiles(),
      desktopApp: fs.existsSync(this.desktopFile),
    };
  }

  /** Bring in forwards, groups and profiles in the shape `readDesktopApp` and an exported file share. Adds; never changes or removes. */
  #bringIn(data, { keepAutoStart = false } = {}) {
    const have = new Map(this.store.forwards().map((forward) => [signature(forward), forward.id]));
    const ids = new Map();
    let added = 0;
    let skipped = 0;
    let closed = 0;
    let manual = 0;
    const refused = [];
    for (const name of Array.isArray(data.groups) ? data.groups : []) {
      try { this.store.saveGroup({ name }); } catch { /* a group with no name is no group */ }
    }
    for (const one of Array.isArray(data.forwards) ? data.forwards : []) {
      try {
        if (one?.lost) throw new Error('its cluster is no longer known, so there is no saying where it led');
        const clean = cleanForward(one);
        /*
         * Nobody is asked about a file's contents one by one, so nothing in
         * one opens a port to the network or starts by itself: both are
         * things a person says yes to, on the forward, afterwards.
         */
        if (!/^(127\.|localhost$)/.test(clean.address)) {
          clean.address = '127.0.0.1';
          closed += 1;
        }
        if (clean.autoStart && !keepAutoStart) {
          clean.autoStart = false;
          manual += 1;
        }
        const known = have.get(signature(clean));
        if (known) {
          skipped += 1;
          if (one.key != null) ids.set(String(one.key), known);
          continue;
        }
        const group = one.group ? this.store.saveGroup({ name: one.group }) : null;
        const saved = this.store.saveForward({ ...clean, groupId: group?.id ?? null });
        have.set(signature(saved), saved.id);
        if (one.key != null) ids.set(String(one.key), saved.id);
        added += 1;
      } catch (error) {
        refused.push(`${String(one?.name ?? 'a forward').slice(0, 80)}: ${String(error?.message ?? error)}`);
      }
    }
    let profiles = 0;
    for (const profile of Array.isArray(data.profiles) ? data.profiles : []) {
      const members = (Array.isArray(profile?.forwards) ? profile.forwards : []).map((key) => ids.get(String(key))).filter(Boolean);
      if (!members.length || this.store.profiles().some((one) => one.name.toLowerCase() === String(profile.name ?? '').trim().toLowerCase())) continue;
      try {
        this.store.saveProfile({ name: profile.name, forwards: members });
        profiles += 1;
      } catch { /* a profile that cannot be saved is left out */ }
    }
    this.#changed();
    const notes = [];
    if (closed) notes.push(`${closed} listened on the network and now listen${closed === 1 ? 's' : ''} on this computer only. Change it on the forward if that was wanted.`);
    if (manual) notes.push(`${manual} started with the app there; here ${manual === 1 ? 'it is' : 'they are'} started by hand until you say otherwise.`);
    return { ok: true, added, skipped, profiles, refused, notes };
  }

  #verbs() {
    return {
      // ── reading ──
      overview: () => this.#overview(),
      log: ({ id }) => ({ ok: true, lines: this.tunnels.log(id), run: this.tunnels.state(id) }),
      ports: async () => {
        const found = await this.scan();
        if (!found.ok) return found;
        const ours = this.tunnels.held();
        return { ok: true, ports: found.ports.map((one) => ({ ...one, forward: ours.get(one.port) ?? null })) };
      },
      /** Everything saved, as text a person can keep in a file or hand to a colleague. */
      exportText: () => {
        const groups = new Map(this.store.groups().map((group) => [group.id, group.name]));
        const forwards = this.store.forwards();
        return {
          ok: true,
          name: `port-forwards-${new Date().toISOString().slice(0, 10)}.json`,
          text: JSON.stringify({
            version: 1,
            groups: [...groups.values()],
            forwards: forwards.map(({ id, groupId, ...rest }) => ({ key: id, ...rest, group: groups.get(groupId) ?? null })),
            profiles: this.store.profiles().map((profile) => ({ name: profile.name, forwards: profile.forwards })),
          }, null, 2),
        };
      },

      // ── changing what is saved ──
      save: async ({ forward }) => {
        const before = forward?.id ? this.store.forward(forward.id) : null;
        const saved = this.store.saveForward(forward);
        /*
         * What is running was started from the old definition. A new name or a
         * new group changes nothing about it; anything kubectl was told does,
         * and then it is started again as it now reads rather than left
         * pointing somewhere the row no longer says.
         */
        let restarted = false;
        if (before && this.tunnels.active(saved.id) && running(before) !== running(saved)) {
          this.tunnels.stop(saved.id);
          await this.tunnels.start(saved);
          restarted = true;
        }
        this.#changed();
        return { ok: true, forward: saved, restarted };
      },
      /** Several at once — what was ticked in a cluster's list. All of them, or the first one that is wrong says why and none is added. */
      saveMany: ({ forwards }) => {
        const list = Array.isArray(forwards) ? forwards.slice(0, 50) : [];
        if (!list.length) throw new Error('Nothing was chosen');
        for (const one of list) cleanForward(one);
        const saved = list.map((one) => this.store.saveForward({ ...one, id: null }));
        this.#changed();
        return { ok: true, forwards: saved };
      },
      remove: ({ id }) => {
        this.tunnels.forget(id);
        this.store.removeForward(id);
        this.#changed();
      },
      saveGroup: (args) => {
        const group = this.store.saveGroup(args);
        this.#changed();
        return { ok: true, group };
      },
      removeGroup: ({ id }) => {
        this.store.removeGroup(id);
        this.#changed();
      },
      saveProfile: ({ id, name, forwards, running }) => {
        const members = running === true ? this.tunnels.running : forwards;
        if (running === true && !members.length) throw new Error('Nothing is running, so there is nothing to keep as a profile');
        const profile = this.store.saveProfile({ id, name, forwards: members });
        this.#changed();
        return { ok: true, profile };
      },
      removeProfile: ({ id }) => {
        this.store.removeProfile(id);
        this.#changed();
      },
      importDesktopApp: () => {
        if (!fs.existsSync(this.desktopFile)) throw new Error('K8S Port Forward has saved nothing on this computer');
        let theirs;
        try {
          theirs = readDesktopApp(this.desktopFile);
        } catch (error) {
          throw new Error(`What K8S Port Forward saved could not be read: ${String(error?.message ?? error).slice(0, 200)}`);
        }
        // The person's own app on the person's own computer: what started with it there starts with this one here.
        return this.#bringIn(theirs, { keepAutoStart: true });
      },
      importFile: async () => {
        const file = await this.pickFile();
        if (!file) return { ok: false, cancelled: true, error: 'Nothing was chosen' };
        if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('That file is too large to be a list of forwards');
        let data;
        try {
          data = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          throw new Error('That file is not JSON');
        }
        if (!data || typeof data !== 'object' || !Array.isArray(data.forwards)) throw new Error('That file is not a list of forwards exported from here');
        return this.#bringIn(data);
      },

      // ── running ──
      start: async ({ id }) => {
        const run = await this.tunnels.start(this.#forward(id));
        return run.state === 'failed' ? { ok: false, error: run.error, run } : { ok: true, run };
      },
      /** Everything that stopped for want of a sign-in, started again — after somebody signed in. */
      retryWaiting: () => this.#startMany(this.store.forwards().filter((forward) => this.tunnels.state(forward.id).state === 'auth')),
      /**
       * The line that signs in to the cloud a forward's cluster is reached through.
       * Not a panel's verb: the app asks, and opens a terminal with the answer.
       * Fixed words and at most a profile name out of kubeconfig, checked.
       */
      signInCommand: async ({ id }) => {
        const forward = this.#forward(id);
        const found = signIn(await this.kubeconfig(), forward.context);
        if (!found) throw new Error('This cluster does not say how it is signed in to. Sign in the way you usually do, and start the forward again.');
        return { ok: true, ...found };
      },
      stop: ({ id }) => {
        this.tunnels.stop(id);
        return { ok: true, run: this.tunnels.state(id) };
      },
      restart: async ({ id }) => {
        this.tunnels.stop(id);
        return { ok: true, run: await this.tunnels.start(this.#forward(id)) };
      },
      startGroup: ({ id }) => this.#startMany(this.store.forwards().filter((forward) => (forward.groupId ?? null) === (id ?? null))),
      stopGroup: ({ id }) => {
        // Only the ones that are on: one that failed keeps saying why.
        for (const forward of this.store.forwards()) {
          if ((forward.groupId ?? null) === (id ?? null) && this.tunnels.active(forward.id)) this.tunnels.stop(forward.id);
        }
      },
      stopAll: () => {
        for (const id of this.tunnels.running) this.tunnels.stop(id);
      },
      /** A profile, switched to: what is in it is started, and everything else that is running is stopped. */
      applyProfile: async ({ id }) => {
        const profile = this.store.profile(id);
        if (!profile) throw new Error('That profile is not here any more');
        const members = new Set(profile.forwards);
        let stopped = 0;
        for (const running of this.tunnels.running) {
          if (members.has(running)) continue;
          this.tunnels.stop(running);
          stopped += 1;
        }
        const wanted = this.store.forwards().filter((forward) => members.has(forward.id));
        const starting = wanted.filter((forward) => !this.tunnels.active(forward.id)).length;
        return { ...(await this.#startMany(wanted)), started: starting, stopped };
      },
      /** Only ever `http://localhost:<a port this forward holds>`: a panel names a forward, never an address. */
      open: async ({ id, port }) => {
        const run = this.tunnels.state(id);
        if (run.state !== 'up') throw new Error('That forward is not up');
        const wanted = Number(port);
        const slot = run.ports.find((one) => one.actual === wanted) ?? run.ports[0];
        if (!slot?.actual) throw new Error('That forward has no port yet');
        await this.openUrl(`http://localhost:${slot.actual}/`);
      },
    };
  }
}

module.exports = { PfService, Tunnels, signIn, networkTrouble, tunnelArgs, listeningPorts, authTrouble, signInHint, readDesktopApp, desktopAppFile, parseLsof };
