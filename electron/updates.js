'use strict';

/**
 * Knowing there is a newer version, and being able to take it.
 *
 * The app is distributed as an unsigned DMG and an unsigned AppImage, which
 * rules out the usual machinery: Squirrel.Mac — what `electron-updater` drives
 * on macOS — refuses to apply an update to an application it cannot verify a
 * code signature for, and there is no free path to a Developer ID certificate.
 * So this does the same job the way the release notes already tell people to do
 * it by hand, and the way `scripts/reinstall-locally.sh` already does it from a
 * terminal: read the published releases, fetch the right file, check it against
 * the hash GitHub itself recorded, and swap the application bundle.
 *
 * Three things this is careful about, because each of them is a way to lose
 * somebody's work or their app:
 *
 *   - **Nothing is installed without being verified first.** The hash comes
 *     from the API response, not from the download, so a file that arrives
 *     wrong is deleted rather than opened.
 *   - **The swap happens after this process is gone.** An application cannot
 *     replace its own bundle while it is running, so the last thing the app
 *     does is hand a small script to the system and quit. If the quit is
 *     cancelled — and it is, whenever sessions are live and somebody says keep
 *     them — the app leaves a marker saying so, and the script reads it and
 *     goes. Waiting for the timeout instead would not be enough: a quit refused
 *     at four o'clock and a quit for unrelated reasons four minutes later look
 *     identical from out there, and the second one would install an update that
 *     had already been declined.
 *   - **The old build is never deleted before the new one is in place.** The
 *     copy goes in beside it and is moved over it, so a failure halfway leaves
 *     a working app rather than none.
 *
 * The check itself is a plain GET against the public releases API. No token, no
 * account, and nothing sent: it is the same request a browser makes opening the
 * releases page.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

// ---------------------------------------------------------------- versions

/**
 * A version as semver means it: numbers, then the prerelease tail.
 *
 * `null` for anything that is not one. A release whose tag nobody can read is
 * not a release this offers — inventing an ordering for it would be the one
 * mistake that offers somebody a downgrade.
 */
function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

/** Negative when `a` is older, positive when newer, zero when the same. */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;

  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1;
  }

  // A release beats its own prereleases: 0.7.0 is newer than 0.7.0-rc.1.
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;

  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const one = left.pre[i];
    const two = right.pre[i];
    // The shorter run of identifiers is the earlier one: rc < rc.1.
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    if (one === two) continue;
    const oneNum = /^\d+$/.test(one);
    const twoNum = /^\d+$/.test(two);
    // Numeric identifiers sort below alphanumeric ones, and among themselves by
    // value rather than by text, so rc.9 comes before rc.10.
    if (oneNum && twoNum) return Number(one) < Number(two) ? -1 : 1;
    if (oneNum !== twoNum) return oneNum ? -1 : 1;
    return one < two ? -1 : 1;
  }
  return 0;
}

/**
 * The one release worth offering, out of everything published.
 *
 * Drafts are somebody mid-thought and are never offered. Prereleases are opt-in
 * — the tags in this repository's history include a run of `-rc` builds, and an
 * app that offered those to everyone would be offering a downgrade in
 * stability. A version that was skipped stays skipped until something newer
 * than it appears, which is the behaviour that makes "not now" mean something.
 */
function pickRelease(releases, { current, skipped = null, prereleases = false } = {}) {
  const usable = (Array.isArray(releases) ? releases : [])
    .filter((release) => release && !release.draft)
    .filter((release) => prereleases || !release.prerelease)
    .map((release) => ({ release, version: parseVersion(release.tag_name) }))
    .filter((entry) => entry.version)
    .filter((entry) => compareVersions(entry.release.tag_name, current) > 0)
    .sort((a, b) => compareVersions(b.release.tag_name, a.release.tag_name));

  const best = usable[0];
  if (!best) return null;
  // Skipping is about one version, not about updating: something newer than
  // what was waved away is a fresh offer.
  if (skipped && compareVersions(best.release.tag_name, skipped) <= 0) return null;
  return best.release;
}

/** What this machine would install, which is not always what it can download. */
function installKind({ platform = process.platform, appImage = false } = {}) {
  if (platform === 'darwin') return 'dmg';
  if (platform === 'linux') return appImage ? 'appimage' : 'deb';
  return null;
}

/** Architecture words a file name might carry, by the arch node reports. */
const ARCH_WORDS = {
  arm64: ['arm64', 'aarch64'],
  x64: ['x64', 'x86_64', 'amd64', 'intel'],
};

/**
 * The file to fetch for this machine.
 *
 * Names are matched rather than constructed. electron-builder writes the
 * product name into them and GitHub replaces the spaces with dots on upload, so
 * the asset for 0.6.4 is `Smart.Terminal-0.6.4-arm64.dmg` — a name no code
 * here should be in the business of predicting. What matters is the extension
 * and the architecture, and when a release carries only one file of a kind,
 * that is the one, named however it was named.
 */
function pickAsset(assets, { platform = process.platform, arch = process.arch, appImage = false } = {}) {
  const kind = installKind({ platform, appImage });
  if (!kind) return null;
  const suffix = { dmg: '.dmg', appimage: '.appimage', deb: '.deb' }[kind];

  const candidates = (Array.isArray(assets) ? assets : []).filter(
    (asset) => asset?.name && asset.name.toLowerCase().endsWith(suffix),
  );
  if (candidates.length <= 1) return candidates[0] ?? null;

  const words = ARCH_WORDS[arch] ?? [arch];
  const matching = candidates.filter((asset) =>
    words.some((word) => asset.name.toLowerCase().includes(word)),
  );
  if (matching.length) return matching[0];

  // Several files of the right kind and none of them says which machine it is
  // for. Guessing would install an Intel build on an Apple-silicon Mac, so this
  // says it has nothing rather than picking one.
  const otherArch = Object.entries(ARCH_WORDS)
    .filter(([name]) => name !== arch)
    .flatMap(([, list]) => list);
  const unlabelled = candidates.filter(
    (asset) => !otherArch.some((word) => asset.name.toLowerCase().includes(word)),
  );
  return unlabelled.length === 1 ? unlabelled[0] : null;
}

/** `owner/repo` out of whatever form the repository field is written in. */
function repoSlug(url) {
  if (typeof url !== 'string') return null;
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** What the panel shows about a release, out of what the API returns. */
function describeRelease(release, asset) {
  return {
    version: String(release.tag_name || '').replace(/^v/, ''),
    tag: release.tag_name,
    name: release.name || release.tag_name,
    notes: typeof release.body === 'string' ? release.body : '',
    url: release.html_url,
    publishedAt: release.published_at ?? null,
    prerelease: Boolean(release.prerelease),
    asset: asset
      ? {
          name: asset.name,
          size: Number(asset.size) || 0,
          url: asset.browser_download_url,
          // GitHub records this itself, so it is a check on the download rather
          // than a restatement of it. Older releases predate the field.
          digest: typeof asset.digest === 'string' ? asset.digest : null,
        }
      : null,
  };
}

// ---------------------------------------------------------------- the shell scripts

/** A value safe to drop into a single-quoted shell word. */
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * The part every install script starts with: wait for the app to be gone.
 *
 * Two ways this ends without installing anything, and both matter.
 *
 * **The app was told to stop.** Somebody with live sessions who answers "keep
 * working" has said no to the update as well, and the app drops a file to say
 * so. Waiting on the process id alone is not enough to notice that: a quit that
 * was refused at four o'clock and a quit for entirely unrelated reasons at four
 * minutes past look identical from out here, and the second one would install
 * an update that had already been declined. So the marker is checked every
 * second of the wait, and once more at the end of it.
 *
 * **Nobody quit at all.** Five minutes, because a quit with live sessions puts
 * up a confirmation and somebody may be reading it. Past that the honest
 * conclusion is that it is not happening, and the script leaves without having
 * touched anything.
 */
function waitForExit(pid, cancel) {
  return `
CANCEL=${shellQuote(cancel)}
called_off() { [ -f "$CANCEL" ]; }

say "waiting for the app (pid ${pid}) to quit"
waited=0
while kill -0 ${pid} 2>/dev/null; do
  if called_off; then
    fail "stopped: the update was called off — nothing was touched"
  fi
  waited=$((waited+1))
  if [ "$waited" -gt 300 ]; then
    fail "stopped: the app is still running after five minutes — the quit was probably cancelled, and nothing was touched"
  fi
  sleep 1
done
# Checked again on the way out: the app can be told to stop and then quit for
# its own reasons a moment later, and the marker is the thing that outlives it.
if called_off; then
  fail "stopped: the update was called off — nothing was touched"
fi
say "it quit"
sleep 1
`;
}

/** The preamble both scripts share: where to talk, and how to give up. */
function scriptHead(log) {
  return `#!/bin/sh
# Written by Smart Terminal to install an update. Safe to delete.
set -u
LOG=${shellQuote(log)}
say() { printf '%s %s\\n' "$(date '+%H:%M:%S')" "$*" >> "$LOG"; }
fail() { say "$1"; cleanup; exit 1; }
cleanup() { :; }
`;
}

/**
 * macOS: mount the disk image, copy the app out of it, move it into place.
 *
 * The order is the point. The copy lands beside the installed app under a
 * hidden name and is moved over it in one step, so the window in which there is
 * no application at all is a rename rather than a download.
 */
function macScript({ dmg, dest, pid, log, cancel }) {
  return `${scriptHead(log)}
DMG=${shellQuote(dmg)}
DEST=${shellQuote(dest)}
MOUNT="$(mktemp -d /tmp/smart-terminal-update.XXXXXX)"
STAGE="$(dirname "$DEST")/.$(basename "$DEST").installing"

cleanup() {
  hdiutil detach "$MOUNT" -quiet 2>/dev/null
  rmdir "$MOUNT" 2>/dev/null
  :
}
${waitForExit(pid, cancel)}
say "opening the installer"
hdiutil attach "$DMG" -nobrowse -readonly -noverify -mountpoint "$MOUNT" -quiet ||
  fail "stopped: could not open the downloaded installer — nothing was touched"

APP="$MOUNT/$(basename "$DEST")"
[ -d "$APP" ] || fail "stopped: the installer does not contain $(basename "$DEST") — nothing was touched"

rm -rf "$STAGE"
say "copying the new build in beside the old one"
cp -R "$APP" "$STAGE" || { rm -rf "$STAGE"; fail "stopped: could not copy the new build — the installed one is untouched"; }
cleanup

# From here the old app goes. Both steps are reported on failure with where the
# new build is, because at that point it is the only copy that is any use.
rm -rf "$DEST" || fail "stopped: could not remove the installed app — the new build is waiting at $STAGE"
mv "$STAGE" "$DEST" || fail "stopped at the last step — the new build is at $STAGE, move it into place by hand"

xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
say "installed"
open -a "$DEST" || fail "installed, but could not relaunch it — open it from Applications"
say "relaunched"
`;
}

/**
 * Linux: an AppImage is one file, so the install is one move.
 *
 * It still has to happen after the app is gone — a running AppImage is a
 * mounted filesystem, and replacing the file underneath it is how you get a
 * half-read binary.
 */
function appImageScript({ file, dest, pid, log, cancel }) {
  return `${scriptHead(log)}
NEW=${shellQuote(file)}
DEST=${shellQuote(dest)}
${waitForExit(pid, cancel)}
say "putting the new build in place"
cp "$NEW" "$DEST.new" || fail "stopped: could not write beside $DEST — the installed one is untouched"
chmod +x "$DEST.new" || { rm -f "$DEST.new"; fail "stopped: could not make the new build runnable — the installed one is untouched"; }
mv "$DEST.new" "$DEST" || { rm -f "$DEST.new"; fail "stopped: could not move the new build into place — the installed one is untouched"; }
say "installed"
(setsid "$DEST" >/dev/null 2>&1 &) || fail "installed, but could not relaunch it"
say "relaunched"
`;
}

// ---------------------------------------------------------------- the checker

/** Long enough that nobody meets it twice in a session; short enough to matter. */
const CHECK_EVERY = 6 * 60 * 60 * 1000;
/** Let the window finish opening and the sessions finish restoring first. */
const FIRST_CHECK_AFTER = 30 * 1000;
/** Below this the progress bar is noise; above it, the app looks stuck. */
const PROGRESS_EVERY = 200;

/**
 * What the app knows about its own version and the ones it could have.
 *
 * One instance, owned by the main process, broadcasting its whole state on
 * every change. The renderer never asks a question it has to assemble an answer
 * from — a panel that has to decide whether "downloading" and "ready" can both
 * be true is a panel with a bug in it.
 */
class Updates extends EventEmitter {
  /**
   * @param {object} options
   * @param {{version: string, build: number|null}} options.current what is running
   * @param {string} options.slug `owner/repo` on GitHub
   * @param {string} options.dir where downloads are kept
   * @param {import('electron')} options.electron
   * @param {object} [options.settings] a JsonStore-shaped thing: get()/set()
   */
  constructor({ current, slug, dir, electron, settings }) {
    super();
    this.current = current;
    this.slug = slug;
    this.dir = dir;
    this.electron = electron;
    this.settings = settings;
    this.first = null;
    this.timer = null;
    this.aborter = null;
    /** The install script, while one is waiting for this process to end. */
    this.installer = null;
    /** The last file whose hash was checked, and what it looked like then. */
    this.verified = null;

    const stored = settings?.get?.() ?? {};
    this.state = {
      phase: 'idle',
      current,
      release: null,
      progress: null,
      file: null,
      error: null,
      checkedAt: stored.checkedAt ?? null,
      skipped: stored.skipped ?? null,
      auto: stored.auto !== false,
      prereleases: Boolean(stored.prereleases),
      install: this.#howItWouldInstall(),
    };

    const failed = this.#unfinishedInstall();
    if (failed) this.state = { ...this.state, phase: 'error', error: failed };
  }

  /**
   * An install that was asked for and did not happen.
   *
   * The worst version of this feature failing is the silent one: the app quits,
   * comes back as the version it already was, and says nothing — so the person
   * tries again, and it says nothing again. The script leaves a log behind, and
   * the log names the version it was going in for. If that is not the version
   * now running, it did not go in, and the last line says why.
   *
   * Read once, and the log is renamed so the same failure is not reported for
   * ever. The previous one is kept, because two attempts in a row are the case
   * somebody would want to send in.
   */
  #unfinishedInstall() {
    const log = path.join(this.dir, 'install.log');
    let text;
    try {
      text = fs.readFileSync(log, 'utf8');
    } catch {
      return null;
    }
    try {
      fs.renameSync(log, `${log}.last`);
    } catch {
      /* Reporting it matters more than tidying up after it. */
    }

    const wanted = /installing (\S+)/.exec(text)?.[1];
    // It worked: this *is* that version, and the log is just what it left behind.
    if (!wanted || wanted === this.current.version) return null;

    const said = text
      .split('\n')
      .map((line) => line.replace(/^\d\d:\d\d:\d\d /, '').trim())
      .filter(Boolean)
      .pop();
    return `The update to ${wanted} did not go in${said ? ` — ${said}` : ''}.`;
  }

  /** Everything the renderer draws from, as one object. */
  snapshot() {
    return { ...this.state };
  }

  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.snapshot());
  }

  #remember(patch) {
    if (!this.settings) return;
    this.settings.set({ ...this.settings.get(), ...patch });
  }

  /**
   * Whether this copy can replace itself, and in plain words why not.
   *
   * Four different "no"s, and they are not interchangeable: a development run
   * has no bundle to swap, a `.deb` belongs to the package manager, a
   * read-only Applications folder is somebody else's machine policy, and an
   * unknown platform is simply unhandled. Each one wants a different sentence
   * on screen, so each one keeps its own.
   */
  #howItWouldInstall() {
    const { app } = this.electron;
    const appImage = Boolean(process.env.APPIMAGE);
    const kind = installKind({ appImage });

    if (!app.isPackaged) {
      return { can: false, kind, why: 'This is a development run — there is no installed app to replace.' };
    }
    if (kind === 'deb') {
      return {
        can: false,
        kind,
        why: 'Installed from a .deb, so the package manager owns it. The download is offered instead.',
      };
    }
    if (!kind) {
      return { can: false, kind, why: `Updating is not implemented for ${process.platform}.` };
    }

    const target = this.#installedPath();
    if (!target) {
      return { can: false, kind, why: 'Could not work out where this app is installed.' };
    }
    try {
      // The move happens in the *containing* folder, so that is what has to be
      // writable — /Applications usually is, a managed Mac's may not be.
      fs.accessSync(path.dirname(target), fs.constants.W_OK);
    } catch {
      return { can: false, kind, why: `${path.dirname(target)} is not writable, so the app cannot replace itself there.` };
    }
    return { can: true, kind, why: null, target };
  }

  /** The thing that gets replaced: the .app bundle, or the AppImage file. */
  #installedPath() {
    if (process.platform === 'darwin') {
      const exe = this.electron.app.getPath('exe');
      const at = exe.indexOf('.app/Contents/MacOS/');
      return at > 0 ? exe.slice(0, at + 4) : null;
    }
    return process.env.APPIMAGE || null;
  }

  // -------------------------------------------------------------- checking

  /**
   * Start checking on a schedule, if the setting allows it.
   *
   * Deliberately not at the first tick of the app's life: launch is already the
   * busiest moment it has, and an update found thirty seconds later is found
   * just as usefully.
   */
  start() {
    this.stop();
    if (!this.state.auto) return;
    this.first = setTimeout(() => {
      this.first = null;
      this.check().catch(() => {});
      this.timer = setInterval(() => this.check().catch(() => {}), CHECK_EVERY);
      this.timer.unref?.();
    }, FIRST_CHECK_AFTER);
    // Neither timer is a reason for the process to stay alive.
    this.first.unref?.();
  }

  stop() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  /**
   * Ask what has been published.
   *
   * A failure here is reported and then forgotten: being offline is the normal
   * state of a laptop, not a fault, and an app that kept an error on screen
   * about it would be wrong more often than right. `force` is the button, and
   * it ignores both the interval and a skipped version.
   */
  async check({ force = false } = {}) {
    if (this.state.phase === 'checking' || this.state.phase === 'downloading' || this.state.phase === 'installing') {
      return this.snapshot();
    }
    if (!force && this.state.checkedAt && Date.now() - this.state.checkedAt < CHECK_EVERY / 2) {
      return this.snapshot();
    }
    if (!this.slug) {
      this.#set({ phase: 'error', error: 'No repository to check — the app was built without one.' });
      return this.snapshot();
    }

    this.#set({ phase: 'checking', error: null });
    try {
      const releases = await this.#api(`https://api.github.com/repos/${this.slug}/releases?per_page=20`);
      const release = pickRelease(releases, {
        current: this.current.version,
        skipped: force ? null : this.state.skipped,
        prereleases: this.state.prereleases,
      });
      const checkedAt = Date.now();
      this.#remember({ checkedAt });
      /*
       * Asking on purpose clears a skip.
       *
       * A forced check ignores it already, so leaving it stored would put the
       * panel in the one state it must never be in: offering a version and, two
       * lines below, saying it is being skipped. Pressing the button is somebody
       * changing their mind, and the record should say so.
       */
      if (force && release && this.state.skipped) {
        this.#remember({ skipped: null });
        this.state = { ...this.state, skipped: null };
      }

      if (!release) {
        this.#set({ phase: 'idle', release: null, checkedAt, progress: null, file: null });
        return this.snapshot();
      }

      const asset = pickAsset(release.assets, { appImage: Boolean(process.env.APPIMAGE) });
      const described = describeRelease(release, asset);
      // A file already fetched and still good is an update that is ready, not
      // one to download again — closing the panel must not cost 128 MB.
      const ready = asset ? await this.#alreadyHave(described) : null;
      this.#set({
        phase: ready ? 'ready' : 'available',
        release: described,
        file: ready,
        progress: null,
        checkedAt,
        install: this.#howItWouldInstall(),
      });
      return this.snapshot();
    } catch (error) {
      this.#set({ phase: 'error', error: describeError(error) });
      return this.snapshot();
    }
  }

  async #api(url) {
    const response = await this.electron.net.fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `SmartTerminal/${this.current.version}`,
      },
    });
    if (response.status === 404) throw new Error(`No releases published for ${this.slug} yet.`);
    if (response.status === 403 || response.status === 429) {
      throw new Error('GitHub is rate-limiting this machine — try again in a few minutes.');
    }
    if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
    return response.json();
  }

  // -------------------------------------------------------------- downloading

  /** The name the downloaded file keeps, tied to the version it belongs to. */
  #downloadPath(release) {
    return path.join(this.dir, `${release.version}-${release.asset.name}`);
  }

  /**
   * A previous download of this exact file, if it survived and still checks out.
   *
   * Hashed once per run rather than once per check. `check()` runs every six
   * hours and again whenever the panel is opened, and re-reading 128 MB through
   * SHA-256 each time is real disk and real CPU for a file that only changes
   * when this code writes it. So the reading is remembered with the size and
   * modification time it was taken at, and anything that disagrees with those —
   * including a launch, which starts with no memory at all — is read again.
   */
  async #alreadyHave(release) {
    const file = this.#downloadPath(release);
    try {
      const stat = await fsp.stat(file);
      if (release.asset.size && stat.size !== release.asset.size) return null;
      if (release.asset.digest && !this.#remembersVerifying(file, stat, release.asset.digest)) {
        const seen = await hashFile(file);
        if (`sha256:${seen}` !== release.asset.digest) {
          this.verified = null;
          return null;
        }
        this.#rememberVerifying(file, stat, release.asset.digest);
      }
      return file;
    } catch {
      return null;
    }
  }

  #remembersVerifying(file, stat, digest) {
    const known = this.verified;
    return Boolean(
      known &&
        known.file === file &&
        known.size === stat.size &&
        known.mtimeMs === stat.mtimeMs &&
        known.digest === digest,
    );
  }

  #rememberVerifying(file, stat, digest) {
    this.verified = { file, size: stat.size, mtimeMs: stat.mtimeMs, digest };
  }

  /**
   * Fetch the file, checking it as it arrives.
   *
   * The hash is computed while streaming rather than by reading the file again
   * afterwards, so a 128 MB download is read once. A file that does not match
   * is deleted on the spot: leaving it would mean the next check finds it,
   * trusts its size, and offers to install something corrupt.
   */
  async download() {
    const release = this.state.release;
    if (!release?.asset) {
      this.#set({ phase: 'error', error: 'This release has no file for this machine.' });
      return this.snapshot();
    }
    if (this.state.phase === 'downloading') return this.snapshot();

    const existing = await this.#alreadyHave(release);
    if (existing) {
      this.#set({ phase: 'ready', file: existing, progress: null, error: null });
      return this.snapshot();
    }

    const target = this.#downloadPath(release);
    const part = `${target}.part`;
    this.aborter = new AbortController();
    this.#set({ phase: 'downloading', error: null, progress: { received: 0, total: release.asset.size } });

    /** Held out here so a failure anywhere below can still close it. */
    let out = null;

    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.rm(part, { force: true });

      const response = await this.electron.net.fetch(release.asset.url, {
        headers: { 'User-Agent': `SmartTerminal/${this.current.version}` },
        signal: this.aborter.signal,
      });
      if (!response.ok) throw new Error(`The download answered ${response.status}.`);

      const total = Number(response.headers.get('content-length')) || release.asset.size;
      const hash = crypto.createHash('sha256');
      out = fs.createWriteStream(part);
      const reader = response.body.getReader();
      let received = 0;
      let announced = 0;

      /*
       * A write stream that fails has to be *listened* to.
       *
       * Nothing here catches an `'error'` on a Writable: it is an event, not a
       * rejected promise, and an `'error'` with no listener is how Node ends a
       * process. That would take the main process down — every window, every
       * session — because a 128 MB download filled a disk. Worse, the wait for
       * `'drain'` below would never return on a stream that has already failed,
       * so the download would hang instead of reporting anything.
       *
       * So the failure is turned into a promise that everything which can block
       * races against. The extra `catch` is only there to keep an unobserved
       * rejection from being reported as one while the download is still going.
       */
      const broke = new Promise((_, reject) => {
        out.once('error', (error) => reject(error));
      });
      broke.catch(() => {});

      for (;;) {
        const { done, value } = await Promise.race([reader.read(), broke]);
        if (done) break;
        hash.update(value);
        received += value.length;
        if (!out.write(Buffer.from(value))) {
          await Promise.race([new Promise((resolve) => out.once('drain', resolve)), broke]);
        }
        if (Date.now() - announced > PROGRESS_EVERY) {
          announced = Date.now();
          this.#set({ progress: { received, total } });
        }
      }
      await Promise.race([
        new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve()))),
        broke,
      ]);
      out = null;

      const digest = `sha256:${hash.digest('hex')}`;
      if (release.asset.digest && digest !== release.asset.digest) {
        await fsp.rm(part, { force: true });
        throw new Error('The download does not match the hash GitHub published for it, so it was discarded.');
      }
      if (release.asset.size && received !== release.asset.size) {
        await fsp.rm(part, { force: true });
        throw new Error('The download ended early, so it was discarded.');
      }

      await fsp.rename(part, target);
      // Just hashed, byte by byte, on the way in — so the next check has no
      // reason to read it all over again.
      if (release.asset.digest) {
        await fsp.stat(target).then(
          (stat) => this.#rememberVerifying(target, stat, release.asset.digest),
          () => {},
        );
      }
      await this.#sweep(target);
      this.#set({ phase: 'ready', file: target, progress: { received, total } });
    } catch (error) {
      // Closed before the part file is removed: a stream still holding it open
      // is a file that comes back.
      out?.destroy();
      await fsp.rm(part, { force: true }).catch(() => {});
      const cancelled = error?.name === 'AbortError';
      this.#set({
        phase: cancelled ? 'available' : 'error',
        progress: null,
        error: cancelled ? null : describeError(error),
      });
    } finally {
      this.aborter = null;
    }
    return this.snapshot();
  }

  /** Stop a download that is running. The file it was writing goes with it. */
  cancel() {
    this.aborter?.abort();
  }

  /** Every other download this left behind. One version's worth is enough to keep. */
  async #sweep(keep) {
    try {
      for (const name of await fsp.readdir(this.dir)) {
        const file = path.join(this.dir, name);
        if (file === keep) continue;
        if (!/\.(dmg|appimage|deb|part)$/i.test(name)) continue;
        await fsp.rm(file, { force: true }).catch(() => {});
      }
    } catch {
      /* Nothing to sweep is the usual case. */
    }
  }

  // -------------------------------------------------------------- installing

  /**
   * Hand the swap to a script and get out of its way.
   *
   * The script is written fresh each time with the paths already in it, so
   * nothing it does depends on an environment this process will not be around
   * to provide. It is detached on purpose: it has to outlive the app whose
   * bundle it is replacing.
   */
  async install() {
    const how = this.#howItWouldInstall();
    if (!how.can) {
      // A `.deb` is not a failure, it is a different ending: the file is
      // downloaded and correct, and the package manager takes it from here.
      if (how.kind === 'deb' && this.state.file) {
        this.electron.shell.showItemInFolder(this.state.file);
        this.#set({ phase: 'handed-off', error: null });
        return this.snapshot();
      }
      this.#set({ phase: 'error', error: how.why });
      return this.snapshot();
    }
    if (this.state.phase !== 'ready' || !this.state.file) {
      this.#set({ phase: 'error', error: 'Nothing is downloaded to install yet.' });
      return this.snapshot();
    }

    const log = path.join(this.dir, 'install.log');
    const script = path.join(this.dir, 'install.sh');
    const cancel = this.#cancelMarker();
    const body =
      how.kind === 'dmg'
        ? macScript({ dmg: this.state.file, dest: how.target, pid: process.pid, log, cancel })
        : appImageScript({ file: this.state.file, dest: how.target, pid: process.pid, log, cancel });

    try {
      await fsp.mkdir(this.dir, { recursive: true });
      // A marker left over from a previous attempt that was called off would
      // stop this one before it began.
      await fsp.rm(cancel, { force: true });
      await fsp.writeFile(script, body, { mode: 0o700 });
      await fsp.writeFile(log, `${new Date().toISOString()} installing ${this.state.release?.version}\n`);
      this.installer = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' });
      this.installer.unref();
    } catch (error) {
      this.#set({ phase: 'error', error: describeError(error) });
      return this.snapshot();
    }

    this.#set({ phase: 'installing', error: null });
    // The script is already waiting on this process id, so the quit is what
    // starts the install — and a quit the user cancels stops it just as surely.
    this.emit('quit-for-install');
    return this.snapshot();
  }

  /** Where the script looks to find out that it is not wanted after all. */
  #cancelMarker() {
    return path.join(this.dir, 'install.cancelled');
  }

  /**
   * The quit the install asked for did not happen.
   *
   * Which is a perfectly good answer — somebody looked at twenty-eight live
   * sessions and decided not now. The downloaded file is still good and still
   * there, so this goes back to being an update waiting to be installed rather
   * than an error.
   *
   * The script outside has to be *told*, though, and this is the part that is
   * easy to get wrong. Left to itself it only knows how to wait for this
   * process to end — and a quit refused at four o'clock and a quit for entirely
   * unrelated reasons four minutes later look the same from out there. Somebody
   * who declined an update, finished what they were doing and then quit would
   * come back to an application replaced against their answer.
   *
   * So two things happen, in the order that matters. The marker is written
   * first and synchronously: it is the one that survives this process being
   * killed, crashing, or quitting a second later. Then the script is asked to
   * go, which is the tidy ending rather than the safe one.
   */
  quitCancelled() {
    if (this.state.phase !== 'installing') return this.snapshot();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.#cancelMarker(), `${new Date().toISOString()}\n`);
    } catch {
      /* The five-minute timeout is what is left, and it is still a refusal. */
    }
    if (this.installer?.pid) {
      try {
        // Detached, so it leads its own process group; the negative pid takes
        // the `sleep` it is sitting in along with the shell.
        process.kill(-this.installer.pid, 'SIGTERM');
      } catch {
        /* Already gone, or never ours to signal. The marker still stands. */
      }
      this.installer = null;
    }
    this.#set({ phase: this.state.file ? 'ready' : 'available', error: null });
    return this.snapshot();
  }

  /** Where the script wrote down what it did, for when it did not work. */
  logPath() {
    return path.join(this.dir, 'install.log');
  }

  // -------------------------------------------------------------- settings

  /** Not this one. Until something newer turns up, at which point ask again. */
  skip() {
    const skipped = this.state.release?.version ?? null;
    if (!skipped) return this.snapshot();
    this.#remember({ skipped });
    this.#set({ skipped, phase: 'idle', release: null, progress: null, file: null });
    return this.snapshot();
  }

  configure({ auto, prereleases } = {}) {
    const patch = {};
    if (auto !== undefined) patch.auto = Boolean(auto);
    if (prereleases !== undefined) patch.prereleases = Boolean(prereleases);
    if (!Object.keys(patch).length) return this.snapshot();
    this.#remember(patch);
    this.#set(patch);
    if (patch.auto !== undefined) {
      if (patch.auto) this.start();
      else this.stop();
    }
    return this.snapshot();
  }
}

/** An error with somewhere to go: a sentence, not a stack. */
function describeError(error) {
  const message = error?.message ? String(error.message) : String(error);
  // Every offline failure arrives as one of these, and none of them reads like
  // anything to a person looking at a panel.
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK/i.test(message)) {
    return 'Could not reach GitHub — check the connection and try again.';
  }
  if (/ENOSPC/.test(message)) return 'There is not enough room on the disk for the download.';
  return message;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = {
  Updates,
  // Exported for the tests, which are about the decisions rather than the I/O.
  parseVersion,
  compareVersions,
  pickRelease,
  pickAsset,
  installKind,
  repoSlug,
  describeRelease,
  shellQuote,
  macScript,
  appImageScript,
};
