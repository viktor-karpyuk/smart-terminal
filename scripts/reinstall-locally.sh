#!/bin/zsh
#
# Replace the installed app with the build in release/.
#
# Run it detached. The session asking for a reinstall usually lives *inside* the
# app being replaced — Claude sessions run in its panes — so it dies the moment
# the app quits, and anything left to do after that never happens:
#
#   nohup scripts/reinstall-locally.sh >/dev/null 2>&1 &
#
# Progress goes to the log named below, since a detached script has nowhere else
# to say anything.
set -u

HERE="${0:A:h}"
REPO="${HERE:h}"
NEW="$REPO/release/mac-arm64/Smart Terminal.app"
DEST="/Applications/Smart Terminal.app"
LOG="${TMPDIR:-/tmp}/smart-terminal-reinstall.log"

say() { print -r -- "$(date '+%H:%M:%S') $*" >> "$LOG" }

# Everything checkable is checked before anything is quit or deleted. Asking the
# app to quit costs every live conversation in it, so it must not happen only to
# fail on a missing build a moment later.
if [[ ! -d "$NEW" ]]; then
  say "aborted: no build at $NEW — run 'npm run dist' first. Nothing was touched."
  exit 1
fi

# The app's own process, found with ps.
#
# `pgrep` cannot see it on macOS: neither `pgrep -f` with the full path nor
# `pgrep -x "Smart Terminal"` returns it, though both find its Helper processes.
# Asked that way it reports the app gone the instant it is asked, and the swap
# then happens underneath a live app. The Helpers live under Contents/Frameworks,
# so matching the main binary's path does not catch them.
app_pid() {
  ps -axo pid=,command= | awk -v bin="$DEST/Contents/MacOS/Smart Terminal" 'index($0, bin) { print $1; exit }'
}

PID="${1:-$(app_pid)}"

if [[ -n "$PID" ]]; then
  say "asking Smart Terminal (pid $PID) to quit — it puts up a confirmation dialog if sessions are running"
  osascript -e 'tell application "Smart Terminal" to quit' >/dev/null 2>&1 &
  for i in {1..180}; do
    ps -p "$PID" >/dev/null 2>&1 || break
    sleep 1
  done
  if ps -p "$PID" >/dev/null 2>&1; then
    say "aborted: still running after three minutes — the quit was probably cancelled. Nothing was touched."
    exit 1
  fi
  say "it quit"
  sleep 2
else
  say "not running, installing straight away"
fi

# Copy alongside first and swap afterwards. Deleting first leaves a window in
# which a failed copy means no app at all.
STAGE="/Applications/Smart Terminal.installing.app"
rm -rf "$STAGE"
if ! cp -R "$NEW" "$STAGE"; then
  say "aborted: could not copy the new build. The installed one is untouched."
  rm -rf "$STAGE"
  exit 1
fi
if ! rm -rf "$DEST"; then
  say "aborted: could not remove the installed app. The new build is at $STAGE."
  exit 1
fi
if ! mv "$STAGE" "$DEST"; then
  say "failed at the last step — the new build is at $STAGE, move it into place by hand."
  exit 1
fi
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist" 2>/dev/null)"
# From the stamp that was packaged: the number inside the app is in an asar,
# which plain node cannot read without Electron's hook.
BUILD="$(sed -n 's/.*"build": *\([0-9]*\).*/\1/p' "$REPO/electron/build-info.json" 2>/dev/null)"
say "installed ${VERSION:-?} build ${BUILD:-?}"

# `open -a` activates a copy that is already running rather than starting a
# second one. That is only safe here because the app is known to have quit.
open -a "$DEST"
say "relaunched"
