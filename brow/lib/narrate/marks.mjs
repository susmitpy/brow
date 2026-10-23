/**
 * Recovers where each `browser_video_chapter` card actually lands in a
 * post-processed recording.
 *
 * Why this is needed at all: `video_dedupe` runs mpdecimate plus a setpts clamp,
 * so wall-clock time from the agent transcript does not map linearly onto video
 * time -- browser-tester's own contract says as much ("do not use elapsed video
 * time as evidence of anything"). The only offsets the manifest records are the
 * per-part chapter boundaries, which for a six-part ticket means one anchor per
 * ~38 seconds. Narration written against anchors that coarse drifts away from
 * what is on screen within a few seconds and never recovers.
 *
 * The cards are burned into the pixels, though, so they can be measured
 * directly -- and measured from `keep/`, which means this works on recordings
 * that were made before any of this existed. The titles come from the agent
 * transcript, which has one `browser_video_chapter` call per card in order.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// The card is a dark grey rounded panel over a white scrim, drawn centred at a
// fixed size (560x233 in a 1280x720 recording). Isolating its own luma band and
// asking blackframe what fraction it covers turns "is a card on screen" into one
// number per frame.
//
// Scene detection is the obvious tool here and it does not work: the card fades
// in over ~0.28s, so there is no cut to detect. scdet found 4 cuts on a
// recording with 5 cards, none of them at a card boundary.
//
// Measuring coverage over the WHOLE frame -- which is what an earlier version
// did -- is what made the detector undercount: it matched 5 of 13 parts across
// two real tickets, and never found more cards than were placed, only fewer.
// Two things went wrong at once, and both are properties of the background
// rather than of the card:
//
//   1. Whole-frame coverage measures the page, not the card. In one measured
//      recording the app spends most of the flow behind a dark PDF-preview modal that scores a steady 18-21%
//      by itself -- above the old COVER_MIN of 6 -- so every frame from 4s to
//      the end joined into a single run and four cards were reported as one.
//   2. That same modal peaks at 66% when the PDF page is dark, which blew past
//      the old COVER_MAX of 20 and discarded the joined run outright.
//
// No retune of a whole-frame band can fix that, because the card contributes
// ~15% of the frame and the backgrounds it is drawn over range from 0% to 66%:
// the bands overlap. Cropping to the card's own rectangle first removes the
// background from the measurement entirely, and the numbers separate cleanly.
// Measured over those same 13 parts, coverage inside the crop is:
//
//   card on screen (full opacity)      79-86
//   solid dark region, no card         100   (the PDF viewer's own dark chrome)
//   ordinary page content, no card     0-16
//
// A real card never reaches 100 because its title and description are white
// text, which sits above the band and so is excluded -- roughly 15-20% of
// the crop. That is the discriminator that rejects the PDF viewer, which is
// uniformly dark and therefore scores exactly 100.
//
// The card is translucent, though, so its luma is the page's showing through.
// Over a dark-theme page it lands at 16-22 instead -- below that band entirely,
// so a dark site scored 1-4 here on every card and none were found. Its own
// band sits under the darkest real page background measured (24, a #111-ish
// theme), so the same coverage bounds separate it: 62-75 with a card, 0-39
// without, on one dark-theme ticket. It still misses a card drawn over a
// lighter patch (a diagram, a photo), where the translucency lifts it above
// 23; that part falls back to unanchored, as before. It is a fallback, not a
// second vote: dark text and code blocks on a light page can fill it too, so
// it is only consulted when the light band finds nothing in the part.
const CARD_LUMA_BANDS = [
  [45, 90],
  [0, 23],
];
// The crop, as fractions of frame size so this survives a resolution change.
// The card is 560x233 centred; this is a ~460x187 rectangle wholly inside it,
// inset far enough to clear the rounded corners and the fade's soft edge.
const CROP_W = 0.36;
const CROP_H = 0.26;
const CROP_X = 0.32;
const CROP_Y = 0.36;
// Coverage band, in percent of the crop. COVER_MIN sits well above the 16 that
// busy page content reaches and well below the 79 of the dimmest measured card.
// COVER_MAX is the load-bearing one now: it rejects a crop that is uniformly
// dark, which means a dark panel with no text on it rather than a card.
const COVER_MIN = 55;
const COVER_MAX = 95;
// The card's hold is collapsed by mpdecimate, so its run of frames has interior
// gaps. Join across them rather than reporting one card as several.
const RUN_JOIN_SECONDS = 0.8;

/**
 * Frames where a chapter card is on screen, grouped into runs.
 * Returns [{ startSec, endSec, peak }] in ascending time.
 */
export function detectCards(ffmpeg, file, { tmpDir = os.tmpdir() } = {}) {
  // Bands are tried in order and the first that finds any card wins, so a
  // part that already anchored on the light band never sees the dark one.
  for (const [lo, hi] of CARD_LUMA_BANDS) {
    const samples = measureBand(ffmpeg, file, tmpDir, lo, hi);
    if (!samples) {
      return null;
    }
    const runs = groupRuns(samples);
    if (runs.length > 0) {
      return runs;
    }
  }
  return [];
}

function measureBand(ffmpeg, file, tmpDir, lo, hi) {
  const marksPath = path.join(tmpDir, `brow-cards-${process.pid}-${lo}-${hi}-${path.basename(file)}.txt`);
  fs.rmSync(marksPath, { force: true });
  const filter = [
    `crop=iw*${CROP_W}:ih*${CROP_H}:iw*${CROP_X}:ih*${CROP_Y}`,
    `lutyuv=y='if(between(val,${lo},${hi}),16,235)'`,
    'blackframe=amount=0:threshold=100',
    // metadata=print writes one line per dictionary entry, so it emits nothing
    // unless something upstream actually set frame metadata. blackframe does
    // (lavfi.blackframe.pblack); mpdecimate, for instance, does not.
    `metadata=mode=print:file=${escapeFilterPath(marksPath)}`,
  ].join(',');

  try {
    execFileSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file, '-an', '-vf', filter, '-f', 'null', '-'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    return parseCoverage(fs.readFileSync(marksPath, 'utf8'));
  } catch {
    return null;
  } finally {
    fs.rmSync(marksPath, { force: true });
  }
}

function parseCoverage(text) {
  const samples = [];
  let time = null;
  for (const line of text.split('\n')) {
    const stamp = /pts_time:([0-9.]+)/.exec(line);
    if (stamp) {
      time = Number(stamp[1]);
      continue;
    }
    const black = /lavfi\.blackframe\.pblack=([0-9]+)/.exec(line);
    if (black && time !== null) {
      samples.push({ time, coverage: Number(black[1]) });
    }
  }
  return samples;
}

function groupRuns(samples) {
  const runs = [];
  let current = null;
  for (const { time, coverage } of samples) {
    // Per-frame, not per-run. Rejecting a run by its *peak* -- which is what
    // an earlier version did -- throws away the card as well as the thing
    // that was too dark, and a card drawn while the PDF viewer is open is
    // exactly that case: the modal's own frames score 100 and the card's score
    // ~82, so a peak test discards both. Judging each frame on its own leaves
    // the run bounded by the card and nothing else.
    if (coverage < COVER_MIN || coverage > COVER_MAX) {
      continue;
    }
    if (current && time - current.endSec <= RUN_JOIN_SECONDS) {
      current.endSec = time;
      current.peak = Math.max(current.peak, coverage);
    } else {
      current = { startSec: time, endSec: time, peak: coverage };
      runs.push(current);
    }
  }
  return runs;
}

// ffmpeg parses a filter argument itself, so a path reaches it through two
// layers of syntax: `\` and `:` end the option, `'` ends the quoted expression.
function escapeFilterPath(value) {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * Claude Code's transcript directory for a project:
 * `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<project path with every
 * non-alphanumeric character replaced by '-'>`.
 */
export function defaultTranscriptsDir(projectRoot) {
  if (!projectRoot) {
    return null;
  }
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(home, 'projects', projectRoot.replace(/[^A-Za-z0-9]/g, '-'));
}

/**
 * The `browser_video_chapter` calls the agent made, keyed by the stem of the
 * file it was recording at the time.
 *
 * Only recordings whose `browser_start_video` filename lies inside `ticketDir`
 * count, so another ticket's flow with the same slug cannot lend its titles.
 * Transcripts are read oldest first: a flow that was re-recorded appears more
 * than once, and the last run is the one whose output survived into keep/.
 */
export function readChapterCalls({ transcriptsDir, ticketDir }) {
  const byRecording = new Map();
  if (!transcriptsDir || !fs.existsSync(transcriptsDir)) {
    return byRecording;
  }
  const inTicket = (file) => {
    const relative = path.relative(ticketDir, path.resolve(file));
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  };

  for (const transcript of findTranscripts(transcriptsDir)) {
    let open = null;
    let lines;
    try {
      lines = fs.readFileSync(transcript, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const content = event?.message?.content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const block of content) {
        if (block.type !== 'tool_use') {
          continue;
        }
        const name = String(block.name || '');
        if (name.endsWith('browser_start_video')) {
          const file = String(block.input?.filename || '');
          open = file && inTicket(file) ? { file: path.basename(file), chapters: [] } : null;
        } else if (name.endsWith('browser_stop_video')) {
          if (open?.file) {
            byRecording.set(recordingKey(open.file), open.chapters);
          }
          open = null;
        } else if (name.endsWith('browser_video_chapter') && open) {
          open.chapters.push({
            title: String(block.input?.title || '').trim(),
            description: String(block.input?.description || '').trim(),
          });
        }
      }
    }
  }
  return byRecording;
}

// The agent records .webm; video-note transcodes it to .mp4 in place. Key on the
// stem so the two names meet.
function recordingKey(file) {
  return path.basename(file, path.extname(file));
}

// Every .jsonl under the directory -- session transcripts and their
// subagents/ -- oldest first.
function findTranscripts(root) {
  const found = [];
  const walk = (dir) => {
    for (const name of readDir(dir)) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (name.endsWith('.jsonl')) {
        found.push({ full, mtime: stat.mtimeMs });
      }
    }
  };
  walk(root);
  return found.sort((a, b) => a.mtime - b.mtime).map((entry) => entry.full);
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Pairs detected cards with transcript titles for one part.
 *
 * The count has to match exactly. The detector's thresholds are tied to the
 * card's current styling, so if Playwright MCP restyles it the runs quietly
 * stop matching -- and marks that are silently wrong are worse for narration
 * than no marks at all, because the captions still get placed. A mismatch
 * returns null and the caller falls back to distributing beats across the part.
 */
export function pairMarks({ cards, chapters }) {
  if (!cards || !chapters || cards.length === 0 || cards.length !== chapters.length) {
    return null;
  }
  return cards.map((card, index) => ({
    title: chapters[index].title,
    description: chapters[index].description,
    startMs: Math.round(card.startSec * 1000),
  }));
}
