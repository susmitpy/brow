/**
 * `brow narrate-video <ticketId>` -- adds a voice-over and captions to the
 * merged validation video.
 *
 * The merged file a reviewer watches is silent, has idle frames stripped, and
 * shows a fast sequence of clicks with nothing explaining what any of it
 * proves. This pass reads what the run already recorded about itself, writes a
 * script against it, speaks it, and re-encodes the video with the narration and
 * captions in place.
 *
 * It rebuilds from the individual parts in keep/ rather than post-processing
 * the merged file, because a segment whose narration outruns its footage has to
 * be freeze-padded, and padding has to happen upstream of the concat.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const lib = process.env.BROW_LIB;
const { selectParts, titleOf, escapeMetadata, durationOf } = await import(
  pathToFileURL(path.join(lib, 'video-parts.mjs')).href
);
const { detectCards, readChapterCalls, defaultTranscriptsDir, pairMarks } = await import(
  pathToFileURL(path.join(lib, 'narrate/marks.mjs')).href
);
const plan = await import(pathToFileURL(path.join(lib, 'narrate/plan.mjs')).href);
const captions = await import(pathToFileURL(path.join(lib, 'narrate/captions.mjs')).href);
const scriptMod = await import(pathToFileURL(path.join(lib, 'narrate/script.mjs')).href);
const contextMod = await import(pathToFileURL(path.join(lib, 'narrate/context.mjs')).href);
const tts = await import(pathToFileURL(path.join(lib, 'narrate/tts.mjs')).href);

const ticketDir = process.env.BROW_VIDEO_DIR;
const ticketId = process.env.BROW_TICKET_ID;
const ffmpeg = process.env.BROW_FFMPEG;
const ffprobe = process.env.BROW_FFPROBE;
const size = process.env.BROW_MERGE_SIZE || '1280x720';
const fps = Number(process.env.BROW_MERGE_FPS || 25);
const captionCapability = process.env.BROW_CAPTION_CAPABILITY || 'softsub';
const projectRoot = process.env.BROW_PROJECT_ROOT;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
// Every value passed as `--context <file>`, in order.
const contextFiles = args.flatMap((arg, index) => (
  arg === '--context' && args[index + 1] ? [path.resolve(args[index + 1])] : []
));
const force = flag('--force');
const scriptOnly = flag('--script-only');
const dryRun = flag('--dry-run');

/**
 * Captions are off by default and the sidecars are written regardless.
 *
 * A caption box sits in the bottom third, which is where the table rows and the
 * filter controls being proven usually are -- so burning it in obscures the
 * evidence the video exists to show. The voice-over carries the explanation
 * without covering anything. `--captions` (or BROW_NARRATION_CAPTIONS=burn)
 * turns burn-in back on; `softsub` muxes a subtitle track players can toggle,
 * which is the compromise when the picture must stay clean but the text has to
 * ship inside the file.
 */
function resolveCaptionMode() {
  if (flag('--no-captions')) {
    return 'off';
  }
  const requested = flag('--captions') ? 'burn' : (env.BROW_NARRATION_CAPTIONS || 'off');
  if (requested === 'off') {
    return 'off';
  }
  if (requested === 'softsub') {
    return 'softsub';
  }
  // Asked to burn, but this ffmpeg has no libass. Degrade to a toggleable
  // track rather than dropping the text on the floor.
  if (captionCapability !== 'ass') {
    warn('this ffmpeg has no subtitles filter (libass), so captions were muxed as a '
      + 'soft subtitle track instead of burned in. Most players hide those unless '
      + 'subtitles are switched on. Install an ffmpeg built --enable-libass '
      + '(macOS: brew install ffmpeg-full) or point BROW_VIDEO_FFMPEG at one.');
    return 'softsub';
  }
  return 'burn';
}

const keepDir = path.join(ticketDir, 'keep');
const manifestPath = path.join(ticketDir, 'manifest.json');
const narrationDir = path.join(ticketDir, '.narration');
const audioDir = path.join(narrationDir, 'audio');
const outputName = `${ticketId}.mp4`;
const output = path.join(keepDir, outputName);

const env = process.env;
const num = (name, fallback) => {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
};
const wordsPerSecond = num('BROW_NARRATION_WORDS_PER_SECOND', plan.DEFAULTS.wordsPerSecond);
const captionMode = resolveCaptionMode();

function die(message) {
  process.stderr.write(`brow: ${message}\n`);
  process.exit(1);
}
function warn(message) {
  process.stderr.write(`warning: ${message}\n`);
}

if (!ffprobe) {
  die('narration needs ffprobe to measure the parts; install a full ffmpeg or point BROW_VIDEO_FFMPEG at one');
}

const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : { ticketId, recordings: [] };
if (!Array.isArray(manifest.recordings)) {
  die(`manifest has no recordings array: ${manifestPath}`);
}

const parts = selectParts({ keepDir, manifest, outputName });
if (parts.length === 0) {
  process.stdout.write(`nothing to narrate for ${ticketId}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------- measurement

for (const part of parts) {
  part.durationSec = durationOf(ffprobe, part.absolute);
  if (!part.durationSec) {
    die(`could not read the duration of ${part.name}; narration cannot budget or pad without it`);
  }
  part.title = titleOf(part);
}

// Where each chapter card actually lands, recovered from the pixels. Without
// this the finest anchor available is the part boundary, which on a real ticket
// is one anchor per half-minute.
const chapterCalls = readChapterCalls({
  transcriptsDir: env.BROW_NARRATION_TRANSCRIPTS || defaultTranscriptsDir(projectRoot),
  ticketDir,
});
let anchoredParts = 0;
for (const part of parts) {
  const stem = path.basename(part.name, path.extname(part.name));
  const cards = detectCards(ffmpeg, part.absolute, { tmpDir: os.tmpdir() });
  const marks = pairMarks({ cards, chapters: chapterCalls.get(stem) });
  if (marks) {
    part.marks = marks;
    anchoredParts += 1;
  } else if (chapterCalls.has(stem)) {
    warn(
      `${part.name}: found ${cards?.length ?? 0} chapter card(s) on screen but the transcript `
      + `records ${chapterCalls.get(stem).length}; narrating this part as one block`,
    );
  }
}

// ------------------------------------------------------------------- segments

const segments = plan.buildSegments(parts);
for (const segment of segments) {
  const entry = parts[segment.partIndex].entry;
  segment.maxWords = plan.budgetWords(segment, wordsPerSecond);
  if (entry) {
    segment.verdict = entry.verdict;
    segment.url = entry.url;
    segment.flow = segment.title ? null : entry.flow;
  }
  if (!segment.title && !segment.silent) {
    segment.title = parts[segment.partIndex].title;
  }
}

// ------------------------------------------------------------------- the script

let generator = { kind: 'deterministic', model: null, promptChars: 0, fallbackReason: null };
let beatsBySegment = null;

const claudeBin = env.BROW_NARRATION_CLAUDE_BIN || 'claude';
if (env.BROW_NARRATION_GENERATOR !== 'deterministic') {
  try {
    const context = contextMod.buildContext({ contextFiles, segments, wordsPerSecond });
    const { parsed, promptChars } = scriptMod.generateWithClaude({
      context,
      bin: claudeBin,
      claudeHome: env.BROW_NARRATION_CLAUDE_HOME,
      model: env.BROW_NARRATION_MODEL || 'sonnet',
      timeoutMs: num('BROW_NARRATION_LLM_TIMEOUT_MS', 180000),
      scratchDir: path.join(narrationDir, 'scratch'),
    });
    const validated = scriptMod.validateScript(parsed, segments);
    if (validated) {
      beatsBySegment = validated;
      generator = {
        kind: 'claude',
        model: env.BROW_NARRATION_MODEL || 'sonnet',
        promptChars,
        fallbackReason: null,
      };
    } else {
      generator.fallbackReason = 'the model response did not cover every segment';
    }
  } catch (error) {
    generator.fallbackReason = String(error.message || error).split('\n')[0];
  }
}

if (!beatsBySegment) {
  if (generator.fallbackReason) {
    warn(`narration script fell back to the manifest: ${generator.fallbackReason}`);
  }
  beatsBySegment = scriptMod.deterministicScript(segments);
}

// Applied whatever wrote the script: the deterministic path can overrun a short
// segment just as easily as a model can.
for (const [index, segment] of segments.entries()) {
  const { beats, overflow } = plan.enforceBudget(beatsBySegment[index], segment.maxWords);
  segment.beats = beats;
  segment.overflow = overflow;
}

fs.mkdirSync(narrationDir, { recursive: true });
const scriptPath = path.join(narrationDir, 'script.json');
fs.writeFileSync(
  scriptPath,
  `${JSON.stringify({ ticketId, generator, segments: segments.map((segment, index) => ({
    id: index,
    file: segment.partFile,
    title: segment.title,
    startSec: segment.sourceStartSec,
    endSec: segment.sourceEndSec,
    maxWords: segment.maxWords,
    beats: segment.beats,
  })) }, null, 2)}\n`,
  'utf8',
);

if (dryRun) {
  process.stdout.write(`${ticketId}: ${parts.length} part(s), ${segments.length} segment(s), `
    + `${anchoredParts} anchored to chapter cards\n`);
  for (const [index, segment] of segments.entries()) {
    const words = segment.beats.reduce((n, beat) => n + beat.text.trim().split(/\s+/).length, 0);
    process.stdout.write(
      `  ${String(index).padStart(3)} ${segment.partFile.padEnd(46)} `
      + `${(segment.sourceEndSec - segment.sourceStartSec).toFixed(1).padStart(6)}s `
      + `budget=${String(segment.maxWords).padStart(4)} words=${String(words).padStart(4)} `
      + `${segment.title ?? '(lead-in)'}\n`,
    );
  }
  process.exit(0);
}

// ----------------------------------------------------------------------- audio

const engine = tts.resolveEngine(env, { libDir: lib });
const allBeats = [];
for (const [index, segment] of segments.entries()) {
  segment.beats = segment.beats.map((beat, beatIndex) => {
    const withId = {
      ...beat,
      id: engine ? tts.beatId(index, beatIndex, beat.text, engine) : `${index}-${beatIndex}`,
    };
    allBeats.push(withId);
    return withId;
  });
}

captions.writeSrt(
  // Sidecars are written from a provisional timeline when there is no audio, so
  // that --script-only still produces something reviewable.
  allBeats.map((beat, index) => ({ ...beat, startMs: index * 1000, endMs: index * 1000 + 900 })),
  path.join(narrationDir, 'captions.srt'),
);

if (scriptOnly) {
  process.stdout.write(`wrote ${scriptPath} and caption sidecars for ${ticketId}\n`);
  process.exit(0);
}

if (!engine) {
  die('no speech synthesiser available. Piper needs uv on PATH; '
    + 'otherwise set BROW_NARRATION_TTS=command with BROW_NARRATION_TTS_COMMAND. '
    + `The script and captions were written to ${narrationDir}; `
    + `${output} is unchanged.`);
}

let durations;
try {
  durations = tts.synthBeats({ engine, ffmpeg, ffprobe, beats: allBeats, audioDir, force });
} catch (error) {
  die(`speech synthesis failed: ${String(error.message || error).split('\n')[0]}. `
    + `${output} is unchanged.`);
}

// --------------------------------------------------------------------- timeline

const timeline = plan.buildPlan({
  segments,
  beatDurations: durations,
  fps,
  options: {
    leadInSeconds: num('BROW_NARRATION_LEAD_IN_SECONDS', plan.DEFAULTS.leadInSeconds),
    tailSeconds: num('BROW_NARRATION_TAIL_SECONDS', plan.DEFAULTS.tailSeconds),
    maxPadSeconds: num('BROW_NARRATION_MAX_PAD_SECONDS', plan.DEFAULTS.maxPadSeconds),
  },
});

const srtPath = captions.writeSrt(timeline.beats, path.join(narrationDir, 'captions.srt'));
const assPath = captions.writeAss(timeline.beats, path.join(narrationDir, 'captions.ass'), { size });

const narrationWav = plan.buildNarrationTrack({
  ffmpeg,
  plan: timeline,
  audioDir,
  outPath: path.join(narrationDir, 'narration.wav'),
});

// ---------------------------------------------------------------------- encode

const graphPath = path.join(narrationDir, 'filter.txt');
fs.writeFileSync(
  graphPath,
  plan.buildFilterGraph({
    plan: timeline,
    parts,
    size,
    captionsPath: captionMode === 'burn' ? assPath : null,
  }),
  'utf8',
);

const metadataPath = path.join(narrationDir, 'chapters.ffmetadata');
fs.writeFileSync(
  metadataPath,
  `${[';FFMETADATA1', ...timeline.chapters.flatMap((chapter) => [
    '[CHAPTER]', 'TIMEBASE=1/1000', `START=${chapter.startMs}`, `END=${chapter.endMs}`,
    `title=${escapeMetadata(chapter.title)}`,
  ])].join('\n')}\n`,
  'utf8',
);

// Input indices are counted rather than assumed. The silent merge could hardcode
// -map_metadata to parts.length because ffmetadata was always its last input;
// narration adds an audio input and sometimes a subtitle one, and a stale
// constant there silently maps the wrong stream.
const inputs = [];
for (const part of parts) {
  inputs.push(part.absolute);
}
const audioIndex = inputs.push(narrationWav) - 1;
const metadataIndex = inputs.push(metadataPath) - 1;
const subtitleIndex = captionMode === 'softsub' ? inputs.push(srtPath) - 1 : null;

const partial = path.join(keepDir, `.${outputName}.partial.mp4`);
fs.rmSync(partial, { force: true });
const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
for (const input of inputs) {
  ffmpegArgs.push('-i', input);
}
// The graph goes in on argv, not via -filter_complex_script: that option was
// removed in ffmpeg 8, and execFileSync passes argv straight to execve with no
// shell in between, so there is no quoting layer to escape for. It is still
// written to graphPath, which is the only readable form when a filter graph
// this size goes wrong.
ffmpegArgs.push(
  '-filter_complex', fs.readFileSync(graphPath, 'utf8').trim(),
  '-map', '[vout]', '-map', `${audioIndex}:a`,
);
if (subtitleIndex !== null) {
  ffmpegArgs.push('-map', `${subtitleIndex}:s`, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng');
}
ffmpegArgs.push(
  '-map_metadata', String(metadataIndex),
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-ar', '48000',
  '-movflags', '+faststart', partial,
);

try {
  execFileSync(ffmpeg, ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
} catch (error) {
  fs.rmSync(partial, { force: true });
  die(`ffmpeg could not build the narrated video: ${String(error.stderr || error.message).trim()}. `
    + `${output} is unchanged.`);
}
if (!fs.existsSync(partial) || fs.statSync(partial).size === 0) {
  fs.rmSync(partial, { force: true });
  die(`ffmpeg reported success but wrote nothing. ${output} is unchanged.`);
}

// Only now is the silent merge replaced. Everything above can fail without
// costing the ticket its evidence video, and the per-flow parts it was built
// from are still in keep/ either way.
fs.renameSync(partial, output);

const actualMs = Math.round((durationOf(ffprobe, output) ?? 0) * 1000);
const driftMs = actualMs - timeline.durationMs;
if (Math.abs(driftMs) > 500) {
  warn(`narrated video is ${driftMs}ms off the planned timeline; captions may drift`);
}

// ------------------------------------------------------------------- manifest

const rel = (file) => path.relative(ticketDir, file);
manifest.merged = {
  ...(manifest.merged ?? {}),
  file: rel(output),
  parts: parts.map((part) => part.name),
  // The narrated file is what lives at merged.file now, and padding moved every
  // boundary after the first pad, so the old chapter table would point at the
  // wrong moments.
  chapters: timeline.chapters,
  narrated: true,
  mergedAt: manifest.merged?.mergedAt ?? new Date().toISOString(),
};
manifest.narration = {
  script: rel(scriptPath),
  audio: rel(narrationWav),
  captions: { mode: captionMode, srt: rel(srtPath), ass: rel(assPath) },
  generator,
  tts: { engine: engine.name, voice: engine.voice, sampleRate: tts.SAMPLE_RATE, wordsPerSecond },
  anchoredParts,
  totalParts: parts.length,
  segments: timeline.segments.map((segment) => ({
    file: segment.partFile,
    title: segment.title,
    videoMs: Math.round(segment.videoSec * 1000),
    padMs: Math.round(segment.padSec * 1000),
    outStartMs: segment.outStartMs,
    outEndMs: segment.outEndMs,
    overflow: segment.overflow,
  })),
  beats: timeline.beats.map((beat) => ({
    text: beat.text,
    caption: beat.caption,
    startMs: beat.startMs,
    endMs: beat.endMs,
  })),
  durationMs: timeline.durationMs,
  driftMs,
  scriptHash: crypto.createHash('sha1')
    .update(timeline.beats.map((beat) => beat.text).join('\n'))
    .digest('hex'),
  narratedAt: new Date().toISOString(),
};

const tmp = `${manifestPath}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
fs.renameSync(tmp, manifestPath);

const padded = timeline.segments.filter((segment) => segment.padSec > 0).length;
process.stdout.write(
  `narrated ${ticketId}: ${timeline.beats.length} beat(s) over ${segments.length} segment(s) `
  + `(${anchoredParts}/${parts.length} part(s) anchored to chapter cards), `
  + `${padded} padded, captions ${captionMode}, ${(timeline.durationMs / 1000).toFixed(1)}s -> ${output}\n`,
);
