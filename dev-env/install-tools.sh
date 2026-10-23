#!/usr/bin/env bash
# Installs what the browser-tester kit needs beyond Node: a full ffmpeg for
# `brow` (still-frame drop, H.264, burned captions), uv and espeak-ng for Piper
# narration, and pnpm for the macro tooling. See install-tools.md.
set -euo pipefail

have() {
  command -v "$1" >/dev/null 2>&1
}

warn() {
  printf 'install-tools: %s\n' "$*" >&2
}

# Same capability test brow applies: mpdecimate and libx264 are required,
# libass (the subtitles filter) is needed only to burn captions in. Captured
# rather than piped to grep -q: that exits ffmpeg with SIGPIPE, which pipefail
# reports as a failed check.
ffmpeg_ok() {
  local bin="$1" filters encoders
  [[ -x "$bin" ]] || bin="$(command -v "$bin" 2>/dev/null || true)"
  [[ -n "$bin" ]] || return 1
  filters="$("$bin" -hide_banner -filters 2>/dev/null || true)"
  encoders="$("$bin" -hide_banner -encoders 2>/dev/null || true)"
  [[ "$filters" == *" mpdecimate "* && "$filters" == *" subtitles "* && "$encoders" == *" libx264 "* ]]
}

install_node_tooling() {
  if ! have node; then
    warn "node is missing; install Node 22+ first (https://nodejs.org or your package manager)."
    return
  fi
  if ! have pnpm; then
    if have corepack; then
      corepack enable pnpm
    else
      npm install -g pnpm
    fi
  fi
}

# Playwright's own ~/.cache/ms-playwright/ffmpeg-* is not a substitute: it is
# built --disable-everything with libvpx and the webm muxer only. Homebrew's
# stock `ffmpeg` formula has no libass, so macOS gets the keg-only
# `ffmpeg-full`, which brow finds under $(brew --prefix)/opt/ffmpeg-full.
# Amazon Linux 2023 ships no ffmpeg package, so dnf hosts get a static build.
FFMPEG_STATIC_URL="${FFMPEG_STATIC_URL:-}"

install_ffmpeg() {
  if have brew; then
    ffmpeg_ok "$(brew --prefix)/opt/ffmpeg-full/bin/ffmpeg" || brew install ffmpeg-full
    return
  fi
  if ffmpeg_ok ffmpeg; then
    return
  fi
  if have apt-get; then
    sudo apt-get install -y ffmpeg
    return
  fi
  if have dnf; then
    install_static_ffmpeg
    return
  fi
  warn "install an ffmpeg with mpdecimate, libx264 and libass, then point BROW_VIDEO_FFMPEG at it if it is not on PATH."
}

install_static_ffmpeg() {
  local arch url tmpdir extracted
  arch="$(uname -m)"
  url="$FFMPEG_STATIC_URL"
  if [[ -z "$url" ]]; then
    case "$arch" in
      aarch64 | arm64) url='https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz' ;;
      x86_64 | amd64) url='https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz' ;;
      *)
        warn "no static ffmpeg build known for $arch; install ffmpeg (with libx264 and libass) manually."
        return
        ;;
    esac
  fi
  tmpdir="$(mktemp -d)"
  if ! curl -fsSL --max-time 600 -o "$tmpdir/ffmpeg.tar.xz" "$url"; then
    rm -rf "$tmpdir"
    warn "could not download a static ffmpeg from $url; recordings will stay unprocessed webm."
    return
  fi
  tar -xf "$tmpdir/ffmpeg.tar.xz" -C "$tmpdir"
  extracted="$(find "$tmpdir" -maxdepth 2 -type f -name ffmpeg -print -quit)"
  if [[ -z "$extracted" ]]; then
    rm -rf "$tmpdir"
    warn "downloaded archive contained no ffmpeg binary; skipping."
    return
  fi
  mkdir -p "$HOME/.local/bin"
  install -m 0755 "$extracted" "$HOME/.local/bin/ffmpeg"
  # ffprobe measures parts for chapter marks and narration timing; it ships in
  # the same archive.
  if [[ -f "$(dirname "$extracted")/ffprobe" ]]; then
    install -m 0755 "$(dirname "$extracted")/ffprobe" "$HOME/.local/bin/ffprobe"
  fi
  rm -rf "$tmpdir"
}

# Piper runs through `uv run --with piper-tts`, so uv is the only Python-side
# install. Its bundled espeak-ng data is rejected by its own bridge on some
# platforms, so a system espeak-ng is installed alongside.
install_narration_tooling() {
  if ! have uv; then
    if have brew; then
      brew install uv
    else
      curl -LsSf https://astral.sh/uv/install.sh | sh
    fi
  fi

  if have brew; then
    brew list espeak-ng >/dev/null 2>&1 || brew install espeak-ng
  elif have apt-get; then
    sudo apt-get install -y espeak-ng-data
  elif have dnf; then
    sudo dnf install -y espeak-ng || warn "espeak-ng unavailable; set BROW_NARRATION_ESPEAK_DATA if Piper cannot find its data."
  fi

  if ! have claude; then
    warn "claude CLI not found; narration will use the deterministic script instead of a written one."
  fi
}

main() {
  if have apt-get; then
    sudo apt-get update
  fi
  install_node_tooling
  install_ffmpeg
  install_narration_tooling
}

main "$@"
