# Install Tools

What the browser-tester kit needs on the host. `install-tools.sh` installs everything below that
is missing (Homebrew, apt or dnf).

## Node And JS Tooling

- `node` 22+ — runs `brow`'s helpers, the macro CLI and Playwright MCP.
- `pnpm` 9+ — `pnpm install` pulls `tsx`/`prettier` and generates the macro catalog.

## Browser

- Playwright MCP, configured in `.mcp.json` with `--caps=devtools`. The video tools
  (`browser_start_video`, `browser_video_chapter`, `browser_video_show_actions`,
  `browser_stop_video`) are opt-in behind that capability. It drives an installed Google Chrome by
  default; on a host without one, `npx playwright install chrome`.

## Media Tooling

Used by `brow video-note`, `merge-videos` and `narrate-video` to drop still frames, transcode to
H.264, measure parts and burn captions. `brow` requires `mpdecimate` and `libx264`; burning captions
also needs `libass` (the `subtitles` filter), without which captions ship as a soft subtitle track.

Playwright's own `~/.cache/ms-playwright/ffmpeg-*` is not a substitute: it is compiled
`--disable-everything` with libvpx and the webm muxer only.

- macOS: `ffmpeg-full` (stock `ffmpeg` has no libass). It is keg-only; `brow` finds it under
  `$(brew --prefix)/opt/ffmpeg-full/bin` without it being on PATH.
- Debian/Ubuntu: distro `ffmpeg`.
- Amazon Linux 2023: no ffmpeg package, so the johnvansickle static build goes to `~/.local/bin`
  (`FFMPEG_STATIC_URL` overrides the download).
- Anything else: set `BROW_VIDEO_FFMPEG` to a suitable build; `ffprobe` is taken from beside it.

## Narration

- `uv` — runs Piper TTS (`piper-tts`) on demand; nothing is installed into a project virtualenv.
  The voice (~60 MB) is cached in `~/.cache/brow-narration/voices` on first use.
- `espeak-ng` — phoneme data for Piper. Piper's bundled data is rejected by its own bridge on some
  platforms; `BROW_NARRATION_ESPEAK_DATA` overrides the directory.
- `claude` CLI (optional) — writes the narration script. Without it `brow` falls back to a
  deterministic script built from the chapter cards.
