#!/bin/sh
#
# spinal-collab installer.  Usage:
#
#   curl -fsSL https://raw.githubusercontent.com/spinal-labs/spinal-collab/main/release/cli/install.sh | sh
#
# Installs the spinal-collab CLI (a Node app) and a small launcher on your PATH.
# Requires Node 20+ (https://nodejs.org). It drives your OWN installed Claude
# Code — install that separately (https://claude.com/claude-code) and be logged
# in before running `share`.
#
# Artifacts are GitHub Release assets — no other infra. Env overrides:
#   SPINAL_COLLAB_REPO      GitHub <owner>/<repo>   (default: spinal-labs/spinal-collab)
#   SPINAL_COLLAB_VERSION   pin a version (default: latest release)
#   PREFIX                  bin dir   (default: /usr/local/bin, else ~/.local/bin)
#   SPINAL_COLLAB_LIBDIR    app dir   (default: <prefix>/../lib/spinal-collab)
set -eu

REPO="${SPINAL_COLLAB_REPO:-spinal-labs/spinal-collab}"
API="https://api.github.com/repos/${REPO}"
DL="https://github.com/${REPO}/releases/download"

err() { printf 'spinal-collab install: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || err "Node.js 20+ is required and was not found on PATH (https://nodejs.org)"
node_major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
[ "$node_major" -ge 20 ] 2>/dev/null || err "Node.js 20+ required (found $(node -v 2>/dev/null))"

# --- resolve version (latest release tag, unless pinned) ---
version="${SPINAL_COLLAB_VERSION:-}"
if [ -z "$version" ]; then
  version="$(curl -fsSL "${API}/releases/latest" 2>/dev/null \
    | grep '"tag_name"' | head -1 \
    | sed -E 's/.*"spinal-collab-v?([^"]+)".*/\1/')"
  [ -n "$version" ] || err "could not resolve the latest release from ${API} (set SPINAL_COLLAB_VERSION to pin one)"
fi

tarball="spinal-collab_${version}.tar.gz"
base="${DL}/spinal-collab-v${version}"

# --- choose writable bin + lib dirs ---
bindir="${PREFIX:-/usr/local/bin}"
if [ ! -d "$bindir" ] || [ ! -w "$bindir" ]; then
  if [ -w "/usr/local/bin" ]; then bindir="/usr/local/bin"; else bindir="$HOME/.local/bin"; fi
fi
mkdir -p "$bindir"
libdir="${SPINAL_COLLAB_LIBDIR:-$(dirname "$bindir")/lib/spinal-collab}"
mkdir -p "$libdir"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

printf 'Downloading %s …\n' "$tarball"
curl -fsSL "${base}/${tarball}" -o "$tmp/$tarball" || err "download failed: ${base}/${tarball}"

# --- mandatory checksum verification ---
# A curl|sh installer of a remote-control tool MUST verify integrity. No fallback:
# if the sums file is missing, lacks this tarball, or no hasher is present, abort.
curl -fsSL "${base}/SHA256SUMS" -o "$tmp/SHA256SUMS" \
  || err "could not fetch SHA256SUMS for $version (refusing to install unverified)"
expected="$(grep " $tarball\$" "$tmp/SHA256SUMS" | awk '{print $1}')"
[ -n "$expected" ] || err "no checksum entry for $tarball in SHA256SUMS"
if command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$tmp/$tarball" | awk '{print $1}')";
elif command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$tarball" | awk '{print $1}')";
else err "need 'shasum' or 'sha256sum' to verify the download"; fi
[ "$expected" = "$actual" ] || err "checksum mismatch for $tarball (expected $expected, got $actual)"

# --- reject unsafe archive entries before extracting ---
# Absolute paths or '..' components could write outside $libdir.
if tar -tzf "$tmp/$tarball" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  err "refusing to extract: archive has absolute or path-traversal entries"
fi

# --- install app dir + launcher ---
rm -rf "$libdir"/*
tar -xzf "$tmp/$tarball" -C "$libdir"
launcher="$bindir/spinal-collab"
cat > "$launcher" <<EOF
#!/bin/sh
exec node "$libdir/dist/bin.js" "\$@"
EOF
chmod +x "$launcher"

printf '\nInstalled spinal-collab %s → %s\n' "$version" "$launcher"
case ":$PATH:" in
  *":$bindir:"*) ;;
  *) printf 'Note: %s is not on your PATH. Add it:\n  export PATH="%s:$PATH"\n' "$bindir" "$bindir" ;;
esac
printf 'Next: be logged into Claude Code, then run `spinal-collab share`.\n'
