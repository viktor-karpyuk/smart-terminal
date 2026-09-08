#!/usr/bin/env bash
#
# Package the Linux build, from a Mac.
#
# `node-pty` is a native module: it is compiled, and a Mac compiles Mach-O. So
# there is no flag that makes `electron-builder --linux` produce something a
# Linux machine can run — the build has to happen on Linux, and a container is
# the shortest way to have one without leaving the laptop.
#
# Two things this is careful about.
#
# It never builds in the working tree. `npm ci` inside the container would
# replace `node_modules` with Linux binaries, and the next `npm run dev` on the
# Mac would fail to load node-pty with an error that says nothing about why. So
# the source is copied to a staging directory and the container is given that,
# with its own `node_modules` in a named volume that survives between builds.
#
# And it does not stamp. The build number is decided once, by `npm run dist`,
# so the DMG and the AppImage of a release are the same build rather than two
# builds a minute apart.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stage="$root/release/.linux-stage"
image="electronuserland/builder:latest"

if ! docker info >/dev/null 2>&1; then
  echo "[linux] Docker is not running — start Docker Desktop and try again." >&2
  exit 1
fi

if [ ! -f "$root/dist/index.html" ]; then
  echo "[linux] dist/ is not built — run 'npm run build' first (npm run dist does)." >&2
  exit 1
fi

echo "[linux] staging the source in release/.linux-stage"
mkdir -p "$stage"
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'release/' \
  --exclude '.test-build/' \
  "$root/" "$stage/"

# The image is x86_64; on Apple silicon it runs emulated, which is slower but is
# also the architecture almost every Linux desktop actually is.
echo "[linux] building in $image (linux/amd64)"
docker run --rm --platform linux/amd64 \
  -v "$stage:/project" \
  -v smart-terminal-linux-modules:/project/node_modules \
  -v smart-terminal-linux-cache:/root/.cache \
  -e npm_config_update_notifier=false \
  "$image" \
  bash -lc 'cd /project && npm ci --no-audit --no-fund && npx electron-builder --linux --config electron-builder.config.js'

echo "[linux] collecting the packages"
mkdir -p "$root/release"
found=0
for file in "$stage"/release/*.AppImage "$stage"/release/*.deb; do
  [ -e "$file" ] || continue
  cp -f "$file" "$root/release/"
  echo "[linux] $(basename "$file")"
  found=1
done
[ "$found" = 1 ] || { echo "[linux] the container produced no packages" >&2; exit 1; }
