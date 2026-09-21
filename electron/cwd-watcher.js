'use strict';
const { execFile } = require('node:child_process');

const LSOF = '/usr/sbin/lsof';
const PGREP = '/usr/bin/pgrep';
const PS = '/bin/ps';

/**
 * How often to ask, when something is actually happening.
 *
 * Every tick spawns processes — `lsof` over the session pids, `pgrep` for
 * their children, and a `ps` over those. At 2.5s that is over fifty process
 * spawns a minute, for ever, whether or not anything has moved.
 */
const INTERVAL = 2500;

/**
 * How often to ask when nothing has changed for a while.
 *
 * A session that has not moved in a minute is a session nobody is typing in, and
 * the answer to "where is it" is the same answer as last time. The moment
 * anything does change the poll snaps back to `INTERVAL`, so the case that needs
 * to feel immediate still does — this only stops the app asking a question it
 * already knows the answer to, hundreds of times an hour.
 */
const IDLE_INTERVAL = 10000;

/** Quiet for this long, and the poll slows down. */
const QUIET_BEFORE_IDLE = 60000;

/**
 * Reports each session's *live* working directory and what is running in it.
 *
 * The folder a session starts in is only its starting point — the shell is real, so
 * the user can `cd` anywhere and launch Claude there. Rather than trusting the spawn
 * argument forever, this asks the OS where each shell actually is. One `lsof` call
 * covers every session at once (~60ms), so the poll stays cheap as sessions pile up.
 *
 * The same tick also notes whether the shell has a child — a session whose Claude
 * has exited looks identical to a running one from the outside, and that is the
 * difference between "already open" and "needs starting".
 */
class CwdWatcher {
  /**
   * @param {() => Array<{id: string, pid: number}>} listSessions
   * @param {(changes: Array<{id: string, cwd: string}>) => void} onChange
   */
  constructor(listSessions, onChange) {
    this.listSessions = listSessions;
    this.onChange = onChange;
    this.known = new Map();
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.everyMs = INTERVAL;
    this.lastChange = Date.now();
    this.supported = process.platform === 'darwin' || process.platform === 'linux';
  }

  start() {
    if (this.timer || !this.supported) return;
    // A watcher that starts after a long stop must start responsive, not carry
    // in the quiet it was stopped during.
    this.stopped = false;
    this.lastChange = Date.now();
    // `everyMs` is INTERVAL here — `stop()` puts it back — unless a test has
    // set it smaller to watch ticks happen in less than a lifetime.
    this.#schedule(this.everyMs);
  }

  /**
   * Re-arm at a given rate, replacing whatever was pending.
   *
   * One timeout at a time, set again when a tick has *finished*, rather than an
   * interval. An interval measures from start to start, so a tick that takes
   * longer than the interval is followed by the next one immediately: on a
   * machine with a few thousand processes the old `ps` took longer than the
   * interval every time, and the watcher ran without a pause for as long as
   * the app was open. Measured from the end, the gap is the gap whatever a
   * tick costs.
   */
  #schedule(everyMs) {
    if (this.timer) clearTimeout(this.timer);
    this.everyMs = everyMs;
    this.timer = setTimeout(() => this.#tick(), everyMs);
    this.timer.unref?.();
  }

  #tick() {
    this.timer = null;
    this.poll().finally(() => {
      // Stopped, or re-armed by the tick itself, while this one was running.
      if (this.stopped || this.timer) return;
      this.#schedule(this.everyMs);
    });
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopped = true;
    this.everyMs = INTERVAL;
    this.known.clear();
  }

  forget(id) {
    this.known.delete(id);
  }

  /**
   * Somebody is doing something; ask at full rate again.
   *
   * A keystroke is the one signal that beats any polling interval: `cd` has been
   * typed before the next tick either way, and this is what keeps the backoff
   * from ever being something you can feel.
   */
  wake() {
    this.lastChange = Date.now();
    if (this.stopped || this.everyMs === INTERVAL) return;
    // Mid-tick there is no timer to replace; the tick re-arms at `everyMs`
    // when it finishes, so the rate is enough. Between ticks, re-arm now.
    if (this.timer) this.#schedule(INTERVAL);
    else this.everyMs = INTERVAL;
  }

  /** @returns {Promise<void>} settled when the tick has said what it has to say */
  poll() {
    if (this.running) return Promise.resolve();
    const sessions = this.listSessions().filter((s) => s.pid);
    if (!sessions.length) return Promise.resolve();

    this.running = true;
    const pids = sessions.map((s) => s.pid).join(',');

    return Promise.all([run(LSOF, ['-a', '-p', pids, '-d', 'cwd', '-Fpn']), childrenOf(pids)])
      .then(([lsofOut, children]) => {
        const byPid = parseLsof(lsofOut);

        const changes = [];
        for (const session of sessions) {
          const cwd = byPid.get(session.pid);
          const child = children.get(session.pid) ?? null;
          const foreground = child?.name ?? null;
          const command = child?.command ?? null;
          const previous = this.known.get(session.id);
          if (previous && previous.cwd === cwd && previous.foreground === foreground && previous.command === command) {
            continue;
          }
          this.known.set(session.id, { cwd: cwd ?? previous?.cwd, foreground, command });
          changes.push({
            id: session.id,
            cwd: cwd ?? previous?.cwd,
            foreground,
            command,
            kind: session.kind ?? null,
            ageMs: session.bornAt ? Date.now() - session.bornAt : null,
          });
        }
        if (changes.length) {
          this.lastChange = Date.now();
          this.everyMs = INTERVAL;
          /*
           * Whatever the consumer does with a change is the consumer's problem,
           * and it must not be reported as this tick having failed. The catch
           * below is for the sampling — a `ps` that timed out is a tick that
           * says nothing and is retried a second later. A consumer that throws
           * is a different animal: the changes have already been recorded as
           * reported, so they will never be offered again, and swallowing that
           * is how the app spent five days with a stale idea of what every
           * session was running.
           */
          try {
            this.onChange(changes);
          } catch (error) {
            console.error('[cwd-watcher] the consumer threw on a change:', error);
          }
        } else if (this.everyMs === INTERVAL && Date.now() - this.lastChange > QUIET_BEFORE_IDLE) {
          this.everyMs = IDLE_INTERVAL;
        }
      })
      .catch(() => {
        /* a transient failure just means this tick reports nothing */
      })
      .finally(() => {
        this.running = false;
      });
  }
}

/**
 * `pgrep` and `ps` answer "nothing matched" with this status and no output. That
 * is an answer — a shell with nothing running — not a failure, and a tick that
 * treated it as one would drop every `cd` it had just seen alongside it.
 */
const NOTHING_MATCHED = 1;

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout && error.code !== NOTHING_MATCHED) reject(error);
      else resolve(stdout || '');
    });
  });
}

/**
 * What each session's shell is running, asked about those shells and nothing else.
 *
 * This used to be `ps -axo ppid=,args=`: every process on the machine, eight
 * hundred lines a tick, printed and parsed to find the handful whose parent is
 * one of ours. `pgrep -P` names the children of the session pids and nothing
 * else, `ps -p` describes just those, and when no shell is running anything
 * there is nothing to describe and `ps` is not spawned at all.
 *
 * @param {string} pids comma-separated shell pids
 * @returns {Promise<Map<number, {name: string, command: string}>>} by parent pid
 */
async function childrenOf(pids) {
  const children = (await run(PGREP, ['-P', pids])).split('\n').filter((line) => /^\d+$/.test(line));
  if (!children.length) return new Map();
  return parseChildren(await run(PS, ['-o', 'ppid=,args=', '-p', children.join(',')]));
}

/**
 * The command a shell is currently running, if any. Only the last child is kept:
 * a shell running one program at a time is the case that matters.
 *
 * Both halves are reported. `name` is the short one everything already shows —
 * `node`, `claude`, `vim`. `command` is the whole line, which is the only thing
 * that can be run again: "node" is not a thing anyone can restart, and
 * `npm run local` is.
 */
function parseChildren(output) {
  const byParent = new Map();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = asTyped(match[2].trim());
    if (!command) continue;
    // The first token is the program; the rest are its arguments.
    const name = command.split(/\s+/)[0].split('/').pop();
    if (name) byParent.set(Number(match[1]), { name, command });
  }
  return byParent;
}

/**
 * The line as a person typed it, for the two build tools that are shells
 * around a JVM.
 *
 * `mvn install` runs as `java -classpath …/plexus-classworlds.jar …
 * org.codehaus.plexus.classworlds.launcher.Launcher install`, and `./gradlew
 * build` as `java … org.gradle.wrapper.GradleWrapperMain build`. The tab
 * would say "java", and the thing offered back after a restart would be a
 * three-hundred-character class path nobody typed. What they typed is the
 * tool and the arguments after the launcher class.
 */
function asTyped(command) {
  const maven = /\bjava\b.*?\borg\.codehaus\.plexus\.classworlds\.launcher\.Launcher\b\s*(.*)$/.exec(command);
  if (maven) return `mvn ${maven[1]}`.trim();
  const gradle = /\bjava\b.*?\borg\.gradle\.wrapper\.GradleWrapperMain\b\s*(.*)$/.exec(command);
  if (gradle) return `./gradlew ${gradle[1]}`.trim();
  const launcher = /\bjava\b.*?\borg\.gradle\.launcher\.GradleMain\b\s*(.*)$/.exec(command);
  if (launcher) return `gradle ${launcher[1]}`.trim();
  return command;
}

/** `lsof -Fpn` emits `p<pid>`, then `fcwd`, then `n<path>` per process. */
function parseLsof(output) {
  const byPid = new Map();
  let pid = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null) byPid.set(pid, line.slice(1));
  }
  return byPid;
}

/**
 * Whether what a session is running is worth offering back after a restart.
 *
 * This was called and never defined. Every tick of the watcher threw a
 * ReferenceError that was swallowed whole — and with it went every change after
 * the first one in that tick, permanently, because the watcher had already
 * recorded them as reported. The app's idea of what each session is running
 * stopped being updated, which is not cosmetic: `claudeIsUp` reads it, so
 * messages between sessions were not delivered, a briefing handed to a session
 * never arrived, and autopilot saw sessions that were not running Claude. All
 * of it silent, because a `catch` in the watcher treats any failure as "this
 * tick reported nothing".
 *
 * What it decides is small. A shell is not a command anybody wants restarted —
 * it is what a terminal *is*. Claude comes back by its own machinery and would
 * otherwise be started twice. Everything else — a dev server, a test run, a
 * tail — is worth offering back.
 */
const NOT_WORTH_REMEMBERING = new Set(['claude', 'zsh', 'bash', 'sh', 'fish', 'login', '-zsh', '-bash']);

/**
 * How long a shell is still starting up.
 *
 * A `.zshrc` runs programs on its way in — `conda shell.zsh hook` is a
 * python process, `brew shellenv`, `nvm`, a prompt theme — and for a tick or
 * two one of them is the shell's child. It looked exactly like something the
 * person ran, was remembered as the session's last command, and on the next
 * restore was typed into the session: into a Claude session, as a message.
 * Nothing anybody typed happens this soon after the shell was born.
 */
const STARTUP_MS = 5000;

function worthRemembering(foreground, command, { kind = null, ageMs = null } = {}) {
  const name = String(foreground ?? '').trim();
  if (!name || !String(command ?? '').trim()) return false;
  // A Claude session comes back by its own machinery; whatever ran under it
  // — a helper Claude spawned, a startup hook — is not a command to offer.
  if (kind === 'claude') return false;
  if (ageMs !== null && ageMs < STARTUP_MS) return false;
  return !NOT_WORTH_REMEMBERING.has(name);
}

module.exports = { CwdWatcher, worthRemembering, asTyped, childrenOf };
