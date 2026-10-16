#!/usr/bin/env bash
#
# Package the Windows build, from a Mac.
#
# Windows installers are written by tools that want wine on a Mac (the .exe's icon and version
# metadata), so the build runs in a Linux container that has it. `node-pty` ships Windows binaries,
# so nothing is compiled: install scripts (the Linux rebuild of node-pty) and the rebuild are off and the prebuilt ones are packed.
#
# Two things this is careful about.
#
# It never builds in the working tree. `npm ci` inside the container would
# replace `node_modules` with Linux binaries, and the next `npm run dev` on the
# Mac would fail to load node-pty. So
# the source is copied to a staging directory and the container is given that,
# with its own `node_modules` in a named volume that survives between builds.
#
# And it does not stamp. The build number is decided once, by `npm run dist`,
# so the DMG, the AppImage and the installer of a release are the same build rather than two
# builds a minute apart.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stage="$root/release/.windows-stage"
image="electronuserland/builder:wine"

if ! docker info >/dev/null 2>&1; then
  echo "[windows] Docker is not running — start Docker Desktop and try again." >&2
  exit 1
fi

if [ ! -f "$root/dist/index.html" ]; then
  echo "[windows] dist/ is not built — run 'npm run build' first (npm run dist does)." >&2
  exit 1
fi

echo "[windows] staging the source in release/.windows-stage"
mkdir -p "$stage"
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules' \
  --exclude 'release/' \
  --exclude '.test-build/' \
  "$root/" "$stage/"

# The image is x86_64; on Apple silicon it runs emulated, which is slower but is
# also the architecture almost every Linux desktop actually is.
echo "[windows] building in $image (linux/amd64)"
docker run --rm --platform linux/amd64 \
  -v "$stage:/project" \
  -v smart-terminal-windows-modules:/project/node_modules \
  -v smart-terminal-windows-cache:/root/.cache \
  -e npm_config_update_notifier=false \
  "$image" \
  bash -lc 'cd /project && npm ci --ignore-scripts --no-audit --no-fund && npx electron-builder --win --config electron-builder.config.js -c.npmRebuild=false'

echo "[windows] collecting the packages"
mkdir -p "$root/release"
found=0
for file in "$stage"/release/*-portable.exe; do
  [ -e "$file" ] || continue
  cp -f "$file" "$root/release/"
  echo "[windows] $(basename "$file")"
  found=1
done
[ "$found" = 1 ] || { echo "[windows] the container produced no packages" >&2; exit 1; }
