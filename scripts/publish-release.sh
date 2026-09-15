#!/bin/zsh
#
# Publish what `npm run dist` just built, so the app can find it.
#
# This is the other half of updating. The app asks GitHub which releases exist
# and downloads the file attached to the newest one — so a version that was
# tagged but never released is a version nobody is ever offered, which is
# exactly what happened to 0.6.5 and 0.6.6.
#
#   npm run dist                      # one stamp, three packages
#   scripts/publish-release.sh        # tag it, upload them, publish
#
# Everything it checks, it checks before it creates anything: a half-published
# release with one file missing is worse than no release, because the app finds
# it, offers it, and then has nothing to download.
#
# Options:
#   --notes FILE   release notes to publish (default: ask $EDITOR, or a stub)
#   --draft        create it as a draft — the app never offers drafts
#   --pre          mark it a pre-release — only people who opted in are offered it
set -eu

HERE="${0:A:h}"
REPO="${HERE:h}"
cd "$REPO"

NOTES=""
EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --notes) NOTES="$2"; shift 2 ;;
    --draft) EXTRA+=(--draft); shift ;;
    --pre) EXTRA+=(--prerelease); shift ;;
    *) print -u2 "unknown option: $1"; exit 2 ;;
  esac
done

command -v gh >/dev/null || { print -u2 "gh is not installed — see https://cli.github.com"; exit 1 }
gh auth status >/dev/null 2>&1 || { print -u2 "gh is not logged in — run: gh auth login"; exit 1 }

VERSION="$(node -p 'require("./package.json").version')"
TAG="v$VERSION"

# The stamp is what the app reports about itself, and it is written by the
# build. If it does not match package.json then what was packaged is not this
# version, and publishing it would put the wrong number on the right files.
STAMPED="$(node -p 'try{require("./electron/build-info.json").version}catch(e){""}')"
if [[ "$STAMPED" != "$VERSION" ]]; then
  print -u2 "the last build was ${STAMPED:-nothing}, not $VERSION — run 'npm run dist' first"
  exit 1
fi

# All three, or none. The app picks the file for the machine it is on, so a
# release with only the DMG leaves every Linux copy with an update it cannot take.
FILES=(
  "release/Smart Terminal-$VERSION-arm64.dmg"
  "release/Smart Terminal-$VERSION.AppImage"
  "release/smart-terminal_${VERSION}_amd64.deb"
)
MISSING=0
for file in "${FILES[@]}"; do
  [[ -f "$file" ]] || { print -u2 "missing: $file"; MISSING=1 }
done
if (( MISSING )); then
  print -u2 "\nnot publishing a partial release. 'npm run dist' builds all three from one stamp."
  exit 1
fi

if gh release view "$TAG" >/dev/null 2>&1; then
  print -u2 "$TAG is already published — bump the version, or delete it with: gh release delete $TAG"
  exit 1
fi

# The tag is made here rather than assumed: cutting it by hand and forgetting
# is the same mistake as building and forgetting to publish.
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  print "tagging $TAG at $(git rev-parse --short HEAD)"
  git tag -a "$TAG" -m "$VERSION"
fi
git push -q origin "$TAG"

if [[ -z "$NOTES" ]]; then
  NOTES="$(mktemp -t smart-terminal-notes).md"
  cat > "$NOTES" <<EOF
## What is new in $VERSION

Write this before publishing — it is what people read inside the app when it
offers them the update, and "no description" is what they will decide from.

**macOS (Apple silicon)** — \`Smart Terminal-$VERSION-arm64.dmg\`. Unsigned:
a first launch from the DMG needs right-click → Open. An update taken from
inside the app clears the flag itself.

**Linux (x64)** — \`Smart Terminal-$VERSION.AppImage\` (\`chmod +x\` it first) or
\`smart-terminal_${VERSION}_amd64.deb\`. Same build number as the DMG.
EOF
  print "notes: $NOTES"
  "${EDITOR:-vi}" "$NOTES"
fi

print "publishing $TAG with $(( ${#FILES[@]} )) files…"
gh release create "$TAG" "${FILES[@]}" --title "$VERSION" --notes-file "$NOTES" "${EXTRA[@]}"

print "\ndone. Running copies will be offered $VERSION within six hours, or at once from"
print "Smart Terminal → Check for Updates…"
