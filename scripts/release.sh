#!/usr/bin/env bash
#
# release.sh — Bump extension version, commit, tag, and push.
#
# Usage:
#   bash scripts/release.sh <extension-path> <bump>
#
# Arguments:
#   extension-path   Relative path from repo root (e.g. "example-provider"
#                    or "tools/example-plugin")
#   bump             One of: major, minor, patch, or a specific version (e.g. 1.2.3)
#
# Examples:
#   bash scripts/release.sh example-provider patch
#   bash scripts/release.sh tools/example-plugin 2.0.0
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Args ─────────────────────────────────────────────────────────────────────

if [ $# -lt 2 ]; then
  echo "Usage: $0 <extension-path> <bump>"
  echo "  extension-path: directory relative to repo root (e.g. example-provider or tools/example-plugin)"
  echo "  bump: major | minor | patch | <x.y.z>"
  exit 1
fi

EXT_PATH="$1"
BUMP="$2"
EXT_DIR="$REPO_ROOT/$EXT_PATH"
EXT_PKG="$EXT_DIR/package.json"
ROOT_PKG="$REPO_ROOT/package.json"

# ── Preflight ────────────────────────────────────────────────────────────────

if [ ! -f "$EXT_PKG" ]; then
  echo "✗ Extension package.json not found: $EXT_PKG"
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "✗ node is required but not installed."
  exit 1
fi

cd "$REPO_ROOT"

# Ensure we're on main
CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "✗ Must be on 'main' branch (currently on '$CURRENT_BRANCH')"
  exit 1
fi

# Ensure working tree is clean for this extension
if ! git diff --quiet -- "$EXT_DIR"; then
  echo "✗ Uncommitted changes in $EXT_DIR — commit or stash first."
  exit 1
fi

# ── Read current version ─────────────────────────────────────────────────────

OLD_VERSION="$(node -p "require('$EXT_PKG').version")"
echo "  Extension: $EXT_PATH"
echo "  Current:   v$OLD_VERSION"

# ── Bump version ─────────────────────────────────────────────────────────────
#
# `bump-version.js` owns what a bump means for this repo: the extension package
# always, the repo-root package (and its lockfile) when it is the same package.
# Keeping it in one place is what stops the root metadata from drifting behind
# the tag again.

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION="$BUMP"
else
  case "$BUMP" in
    major|minor|patch)
      NEW_VERSION="$(node -e "
        const v = '$OLD_VERSION'.split('.').map(Number);
        const bump = '$BUMP';
        if (bump === 'major') { v[0]++; v[1] = 0; v[2] = 0; }
        if (bump === 'minor') { v[1]++; v[2] = 0; }
        if (bump === 'patch') { v[2]++; }
        process.stdout.write(v.join('.'));
      ")"
      ;;
    *)
      echo "✗ Invalid bump value: $BUMP (use major, minor, patch, or x.y.z)"
      exit 1
      ;;
  esac
fi

# Captured into a variable (not a process substitution) so a failing helper
# aborts the release instead of silently skipping the bump.
BUMPED_OUTPUT="$(node "$REPO_ROOT/scripts/bump-version.js" "$EXT_PATH" "$NEW_VERSION")"

BUMPED_FILES=()
while IFS= read -r bumped; do
  if [ -n "$bumped" ]; then
    BUMPED_FILES+=("$bumped")
    echo "  Bumped:    ${bumped#$REPO_ROOT/}"
  fi
done <<< "$BUMPED_OUTPUT"

echo "  New:       v$NEW_VERSION"

# ── Regenerate docs ──────────────────────────────────────────────────────────

echo ""
echo "→ Regenerating README.md..."
npm run --silent update-docs

# ── Commit ───────────────────────────────────────────────────────────────────

# Tag by extension path, matching the tags already in the repo
# (`tools/pi-search@0.5.0`). `basename` produced `pi-search@...`, which made
# two naming schemes coexist and broke `git tag -l 'tools/*'` style lookups.
EXT_NAME="${EXT_PATH%/}"
TAG="${EXT_NAME}@${NEW_VERSION}"

echo ""
echo "→ Committing..."
git add "$EXT_DIR" "$REPO_ROOT/README.md"
if [ ${#BUMPED_FILES[@]} -gt 0 ]; then
  git add "${BUMPED_FILES[@]}"
fi
git commit -m "release: ${TAG}"

# ── Tag ──────────────────────────────────────────────────────────────────────

echo "→ Creating tag: $TAG"
git tag "$TAG"

# ── Push ─────────────────────────────────────────────────────────────────────

echo "→ Pushing to origin..."
git push origin main
git push origin --tags

echo ""
echo "✓ Released $TAG"
echo "  Commit: $(git rev-parse --short HEAD)"
echo "  Tag:    $TAG"
echo ""
echo "  Install: pi install $(node -p "require('$ROOT_PKG').installUrl || require('$ROOT_PKG').repository")"
