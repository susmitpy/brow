# Browser testing kit

Playwright MCP browser validation for Claude Code: an agent brief, two skills, and a CLI that turns
the recordings into one narrated evidence video.

Demo Video: https://youtu.be/-8JNMW7W0Es

| Path                                         | What it is                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `AGENTS.md` (imported by `CLAUDE.md`)        | The browser-tester brief: validation rules, macro discipline, video evidence |
| `.claude/skills/browser-tester/`             | Playwright MCP workflow and final-evidence checklist                         |
| `.claude/skills/browser-macros/`             | Registry of replayable, parameterized browser workflows (macros)             |
| `.claude/scripts/`                           | Macro CLI, compiler and catalog generator (`pnpm macro`, `pnpm skills:refresh`) |
| `brow/`                                      | `brow` CLI: record, drop still frames, merge, narrate                         |
| `dev-env/`                                   | Host toolchain installer (ffmpeg, uv, espeak-ng, pnpm) and its rationale      |
| `.mcp.json`                                  | Playwright MCP with `--caps=devtools` (enables the video tools)               |
| `playwright-mcp.config.json`                 | Chrome launch args that stop macOS throttling an occluded window (screenshots, video) |

## Setup

```bash
dev-env/install-tools.sh      # ffmpeg-full/ffmpeg, uv, espeak-ng, pnpm
pnpm install                  # also generates .claude/skills/browser-macros/SKILL.md
export PATH="$PWD/brow:$PATH" # or: ln -s "$PWD/brow/brow" ~/.local/bin/brow
```

Requirements:

- Node 22+, pnpm.
- Playwright MCP with `--caps=devtools` (see `.mcp.json`): the video tools (`browser_start_video`,
  `browser_video_chapter`, `browser_video_show_actions`, `browser_stop_video`) are opt-in behind it.
- A full `ffmpeg`/`ffprobe` with `mpdecimate` and `libx264`; `libass` to burn captions. On macOS
  that is `brew install ffmpeg-full` (stock `ffmpeg` lacks libass), which `brow` finds without it
  being on PATH. Playwright's bundled ffmpeg is not enough. `BROW_VIDEO_FFMPEG` points at another
  build. Details per OS in `dev-env/install-tools.md`.
- Narration: `uv` (runs Piper TTS offline; `brew install espeak-ng` on macOS) and the `claude` CLI to
  write the script. Without `claude` a deterministic script is built from the chapter cards.

## Video pipeline

```bash
brow video-dir TICKET-1                       # prints brow/videos/TICKET-1/raw
# browser_start_video -> browser_video_show_actions -> browser_video_chapter ... -> browser_stop_video
brow video-note TICKET-1 --file <raw>/login.webm --flow "Login as admin" --verdict pass
brow prune-videos TICKET-1                    # retention -> merge-videos -> narrate-video
```

- **Record**: one `.webm` per flow; `browser_video_show_actions` overlays the cursor and action
  callouts, `browser_video_chapter` places title cards.
- **Process**: `video-note` drops still frames (`mpdecimate` with a hold budget) and transcodes to
  H.264 mp4.
- **Merge**: `prune-videos` keeps passes and un-rerun failures, then concatenates survivors into
  `brow/videos/<id>/keep/<id>.mp4` with one chapter per flow.
- **Audio**: `narrate-video` finds each chapter card on screen, writes a voice-over against it,
  synthesises it with Piper, freeze-pads where speech outruns footage, and writes `.srt`/`.ass`
  captions (burned in only with `--captions`). `--context <file>` gives the script writer background.

Where the output lands, per ticket id:

| Path                                            | What                                              |
| ----------------------------------------------- | ------------------------------------------------- |
| `brow/videos/<id>/keep/<id>.mp4`               | The merged, narrated video reviewers watch        |
| `brow/videos/<id>/.narration/captions.srt`     | Caption sidecars (`.srt` and `.ass`)              |
| `brow/videos/<id>/keep/*.mp4`                  | Surviving per-flow recordings                     |
| `brow/videos/<id>/manifest.json`               | One entry per noted run: flow, variant, verdict   |
| `brow/videos/<id>/.narration/script.json`      | The voice-over script and which generator made it |

If `script.json` shows `"generator": {"kind": "deterministic", ...}`, the `claude` call failed and
the voice-over only reads the chapter titles aloud. `fallbackReason` gives the CLI's own error (it
is retried once). Re-run `brow narrate-video <id> --force`, with a higher
`BROW_NARRATION_LLM_TIMEOUT_MS` (default 180000) if the reason is a timeout.

`brow help` lists every command; the knobs are the `BROW_*` variables documented at the top of
`brow/brow`. Recordings capture the login screen: `brow/videos/` is git-ignored and must never be shared
externally.
