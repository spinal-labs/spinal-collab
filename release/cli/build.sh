#!/usr/bin/env bash
#
# Build the spinal-collab CLI as ONE cross-platform tarball using pnpm.
#
#   spinal-collab_<VERSION>.tar.gz   (contains dist/ + node_modules + package.json)
#
# It's a Node app (run via `node dist/bin.js`), not a compiled binary — so a
# single tarball works on every platform (no native deps; the Agent SDK's only
# native deps are optional `sharp`, which we exclude). The user needs Node 20+.
#
# The CLI drives the user's own installed Claude Code (resolved at runtime via
# SPINAL_CLAUDE_PATH or `claude` on PATH). The SDK's bundled Claude Code copy is
# pruned below to keep the tarball small (the host must have Claude Code anyway).
#
# Env:
#   VERSION   required, semver (e.g. 0.1.0)
#   OUT_DIR   output dir for the tarball (default: ./dist-cli)
#
# Run from the repo root: `VERSION=0.1.0 bash release/cli/build.sh`
set -euo pipefail

VERSION="${VERSION:?VERSION is required (e.g. VERSION=0.1.0)}"
OUT_DIR="${OUT_DIR:-$(pwd)/dist-cli}"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm is required (https://pnpm.io — try: corepack enable)" >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm build

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# Self-contained app dir: dist/ + a real node_modules (workspace dep inlined),
# prod-only, no optional native deps → portable across OS/arch.
pnpm --filter=@spinal/collab --prod --no-optional deploy --legacy "$stage/app"

# Stamp the resolved version into the PACKAGED manifest so `spinal-collab
# --version` reports the real release. The committed package.json stays put — the
# published VERSION pointer (not git) is the source of truth.
( cd "$stage/app" && pnpm pkg set version="$VERSION" )

# Prune the Agent SDK's BUNDLED Claude Code (cli.js, ~11 MB) and its vendored
# ripgrep binaries for every platform (~35 MB). spinal-collab drives the user's
# OWN installed Claude Code (the host must have it), so this bundled fallback
# never runs — dropping it cuts the install ~74 MB → ~28 MB while keeping the
# SDK's actual code (the load-bearing `query()` loop) intact.
pruned=0
while IFS= read -r sdk; do
  rm -f "$sdk/cli.js"
  rm -rf "$sdk/vendor"
  pruned=1
done < <(find "$stage/app/node_modules" -type d -name 'claude-agent-sdk' -path '*@anthropic-ai*')
[ "$pruned" = 1 ] || { echo "error: claude-agent-sdk not found in deploy output (prune failed)" >&2; exit 1; }

mkdir -p "$OUT_DIR"
tarball="$OUT_DIR/spinal-collab_${VERSION}.tar.gz"
# Tar the CONTENTS (dist/, node_modules/, package.json) at the archive root.
tar -czf "$tarball" -C "$stage/app" dist node_modules package.json

echo "packaged $tarball"
ls -lh "$tarball" | awk '{print "  size:", $5}'
