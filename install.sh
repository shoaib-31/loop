#!/bin/sh
# Loop installer — `curl -fsSL <url>/install.sh | sh`
#
# Installs one self-contained executable:
#
#   ~/.local/share/loop/versions/<version>/loop    the actual binary
#   ~/.local/bin/loop -> ../share/loop/versions/<version>/loop
#
# The versioned directory plus a symlink is what makes `loop update` possible and
# reversible: an update drops a new version alongside and re-points one symlink, so a
# rollback is the same operation backwards and a half-finished download never replaces a
# working install.
#
# POSIX sh on purpose — this runs before anything of ours exists, so it may not assume
# bash, node, or npm. It DOES assume Claude Code is installed: that install holds the
# login the agent runs on, and the binary deliberately doesn't carry its own copy.

set -eu

REPO="${LOOP_REPO:-shoaib-31/loop}"
VERSION="${LOOP_VERSION:-latest}"
PREFIX="${LOOP_PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
SHARE_DIR="$PREFIX/share/loop"

say() { printf '  %s\n' "$*"; }
die() { printf '\n  error: %s\n\n' "$*" >&2; exit 1; }

# ---- what are we running on? ------------------------------------------------
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os_tag=darwin ;;
  Linux)  os_tag=linux ;;
  *) die "unsupported OS: $os (macOS and Linux only)" ;;
esac
case "$arch" in
  arm64|aarch64) arch_tag=arm64 ;;
  x86_64|amd64)  arch_tag=x64 ;;
  *) die "unsupported architecture: $arch" ;;
esac
asset="loop-${os_tag}-${arch_tag}"

printf '\n  loop — installing %s for %s-%s\n\n' "$VERSION" "$os_tag" "$arch_tag"

# ---- prerequisites ----------------------------------------------------------
# Claude Code is REQUIRED, not bundled. The binary points the agent SDK at whatever
# `claude` is on PATH, because that install is where the login lives — which is also why
# running agents costs no API key. Bundling a second copy would mean a ~350MB download
# and a login that isn't the user's.
if ! command -v claude >/dev/null 2>&1; then
  say "WARNING: no \`claude\` on PATH."
  say "         loop runs agents through your Claude Code install, so install it and"
  say "         log in before starting a session:  https://claude.com/claude-code"
  say ""
fi
if ! command -v tailscale >/dev/null 2>&1; then
  say "note: no \`tailscale\`. loop works locally without it, but your PHONE can't reach"
  say "      the daemon and web push needs HTTPS — a LAN address can never notify."
  say ""
fi

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else die "need curl or wget"; fi
}

# ---- resolve the version ----------------------------------------------------
# LOOP_ASSET_URL bypasses GitHub entirely: it is how this script gets TESTED before any
# release exists (point it at a local file:// build), and it doubles as the self-hosting
# hatch for anyone mirroring the binary.
if [ -n "${LOOP_ASSET_URL:-}" ]; then
  url="$LOOP_ASSET_URL"
  tag="${LOOP_VERSION:-local}"
elif [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
  # Resolve the tag so the install lands in a NAMED directory rather than one called
  # "latest" — otherwise `loop update` can't tell versions apart and rollback is
  # impossible.
  tag=$(fetch "https://api.github.com/repos/$REPO/releases/latest" /dev/stdout 2>/dev/null \
        | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1) || tag=""
  [ -n "$tag" ] || tag="latest"
else
  tag="$VERSION"
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
fi

dest_dir="$SHARE_DIR/versions/$tag"
dest="$dest_dir/loop"

# ---- download to a temp file, then move -------------------------------------
# Never write directly to `dest`: an interrupted download would leave a truncated binary
# where a working one used to be, and the symlink would still point at it.
tmp=$(mktemp "${TMPDIR:-/tmp}/loop-download.XXXXXX")
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT INT TERM

say "downloading $asset ($tag)…"
fetch "$url" "$tmp" || die "download failed: $url
  If this release doesn't exist yet, build from source instead:
    git clone https://github.com/$REPO && cd loop && npm install && bun apps/cli/build.mjs"

# A GitHub 404 page is HTML and would install as a 9KB "binary" that fails cryptically.
if [ "$(head -c 2 "$tmp")" = "<!" ] || [ "$(wc -c < "$tmp")" -lt 1000000 ]; then
  die "downloaded file is not a binary (got $(wc -c < "$tmp") bytes) — is $tag published for $asset?"
fi

mkdir -p "$dest_dir" "$BIN_DIR"
mv "$tmp" "$dest"
chmod 755 "$dest"
trap - EXIT INT TERM

# macOS quarantines downloads; without this the first run is a Gatekeeper dialog.
if [ "$os_tag" = darwin ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
fi

# ---- point the symlink ------------------------------------------------------
ln -sfn "$dest" "$BIN_DIR/loop"
say "installed $dest"
say "linked    $BIN_DIR/loop"

# ---- verify, then tell the truth about PATH ---------------------------------
if ! "$dest" --help >/dev/null 2>&1; then
  die "the installed binary would not run. Report this with: uname -a"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) on_path=yes ;;
  *) on_path=no ;;
esac

printf '\n'
if [ "$on_path" = yes ]; then
  say "done. Run:  loop"
else
  say "done — but $BIN_DIR is NOT on your PATH."
  say "Add this to your shell profile (~/.zshrc or ~/.bashrc):"
  printf '\n    export PATH="%s:$PATH"\n\n' "$BIN_DIR"
  say "or run it directly for now:  $BIN_DIR/loop"
fi
printf '\n'
say "Start it somewhere safe — the daemon auto-allows every tool in its launch directory:"
say "  mkdir -p ~/loop-work && cd ~/loop-work && loop"
printf '\n'
