/**
 * Turns a narration script plus measured per-beat audio into an exact timeline:
 * where every segment of video starts, how much freeze-padding it needs to give
 * its narration room, and what millisecond each caption appears at.
 *
 * A "segment" is the span of one chapter card -- the unit the browser-tester
 * already thinks in, and the finest one whose position in the finished video is
 * actually known (see marks.mjs). Padding per segment rather than per part is
 * the whole point: a part is ~38 seconds and holds several acceptance criteria,
 * so padding only at its end would let the voice drift a chapter behind the
 * picture and stay there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const DEFAULTS = {
  wordsPerSecond: 2.6,
  leadInSeconds: 0.6,
  tailSeconds: 0.4,
  maxPadSeconds: 20,
  overflowTolerance: 1.25,
  sampleRate: 24000,
};

/**
 * Splits each part into the segments narration is written against.
 *
 * Every part gets a leading segment covering whatever plays before its first
 * card. It carries no narration -- it is the fade-in, and talking over it would
 * start the voice before the picture has settled -- but it must still exist as
 * a segment or its footage would be trimmed out of the merge entirely.
 */
export function buildSegments(parts) {
  const segments = [];
  for (const [partIndex, part] of parts.entries()) {
    const marks = Array.isArray(part.marks) && part.marks.length > 0 ? part.marks : null;
    if (!marks) {
      // No usable card marks: the part is one segment and its beats are spread
      // across the whole thing. Coarse, but never wrong about where it starts.
      segments.push({
        partIndex,
        partFile: part.name,
        title: part.title ?? part.name,
        description: '',
        sourceStartSec: 0,
        sourceEndSec: part.durationSec,
        anchored: false,
      });
      continue;
    }
    const leadEnd = marks[0].startMs / 1000;
    if (leadEnd > 0) {
      segments.push({
        partIndex,
        partFile: part.name,
        title: null,
        description: '',
        sourceStartSec: 0,
        sourceEndSec: leadEnd,
        anchored: true,
        silent: true,
      });
    }
    for (const [index, mark] of marks.entries()) {
      const next = marks[index + 1];
      segments.push({
        partIndex,
        partFile: part.name,
        title: mark.title,
        description: mark.description,
        sourceStartSec: mark.startMs / 1000,
        sourceEndSec: next ? next.startMs / 1000 : part.durationSec,
        anchored: true,
      });
    }
  }
  return segments;
}

/**
 * Words a segment can carry before its narration outruns its footage.
 *
 * The floor matters more than the rate: dedupe collapses an idle stretch to
 * half a second, so a segment that proves something with one click can be under
 * a second long, and a budget of zero words would leave it unexplained.
 */
export function budgetWords(segment, wordsPerSecond = DEFAULTS.wordsPerSecond) {
  const seconds = Math.max(0, segment.sourceEndSec - segment.sourceStartSec);
  return Math.max(12, Math.floor(seconds * wordsPerSecond * 0.85));
}

const countWords = (text) => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Trims a segment's beats to its word budget.
 *
 * Applied to every script whatever wrote it, because the deterministic fallback
 * can overrun just as easily as a model can. A mild overrun is left alone --
 * the pad absorbs it, and cutting a sentence to save half a second reads worse
 * than a short freeze.
 */
export function enforceBudget(beats, maxWords, tolerance = DEFAULTS.overflowTolerance) {
  const requestedWords = beats.reduce((total, beat) => total + countWords(beat.text), 0);
  if (requestedWords <= maxWords * tolerance) {
    return { beats, overflow: { requestedWords, keptWords: requestedWords, droppedBeats: 0 } };
  }
  const kept = [];
  let words = 0;
  for (const beat of beats) {
    const next = words + countWords(beat.text);
    if (kept.length > 0 && next > maxWords) {
      break;
    }
    kept.push(beat);
    words = next;
  }
  return {
    beats: kept,
    overflow: { requestedWords, keptWords: words, droppedBeats: beats.length - kept.length },
  };
}

/**
 * The finished timeline.
 *
 * Pads are computed in whole frames and the seconds value is derived back from
 * the frame count, never the other way round: ffmpeg pads by cloning frames, so
 * a pad expressed in raw seconds is rounded at encode time and every offset
 * after it inherits the error.
 */
export function buildPlan({ segments, beatDurations, fps, options = {} }) {
  const {
    leadInSeconds = DEFAULTS.leadInSeconds,
    tailSeconds = DEFAULTS.tailSeconds,
    maxPadSeconds = DEFAULTS.maxPadSeconds,
  } = options;

  const planned = [];
  let offsetSec = 0;

  for (const segment of segments) {
    const videoSec = Math.max(0, segment.sourceEndSec - segment.sourceStartSec);
    let beats = (segment.beats ?? []).map((beat, index) => ({
      ...beat,
      durationSec: beatDurations.get(beat.id) ?? 0,
    }));

    let lead = beats.length > 0 ? leadInSeconds : 0;
    let audioSec = lead + beats.reduce((total, beat) => total + beat.durationSec, 0)
      + (beats.length > 0 ? tailSeconds : 0);

    // Dropping trailing beats is the only real guarantee that a segment cannot
    // freeze for a minute; the word budget is a hint the synthesiser is free to
    // miss.
    while (beats.length > 0 && audioSec - videoSec > maxPadSeconds) {
      beats = beats.slice(0, -1);
      lead = beats.length > 0 ? leadInSeconds : 0;
      audioSec = lead + beats.reduce((total, beat) => total + beat.durationSec, 0)
        + (beats.length > 0 ? tailSeconds : 0);
    }

    const padFrames = Math.ceil(Math.max(0, audioSec - videoSec) * fps);
    const padSec = padFrames / fps;
    const outSec = videoSec + padSec;

    let beatCursor = offsetSec + lead;
    const placed = beats.map((beat) => {
      const startMs = Math.round(beatCursor * 1000);
      beatCursor += beat.durationSec;
      return {
        id: beat.id,
        text: beat.text,
        caption: beat.caption,
        startMs,
        endMs: Math.round(beatCursor * 1000),
      };
    });

    planned.push({
      ...segment,
      videoSec,
      padSec,
      padFrames,
      outSec,
      outStartMs: Math.round(offsetSec * 1000),
      outEndMs: Math.round((offsetSec + outSec) * 1000),
      leadSec: lead,
      beats: placed,
    });
    offsetSec += outSec;
  }

  return {
    fps,
    segments: planned,
    beats: planned.flatMap((segment) => segment.beats),
    chapters: planned
      .filter((segment) => segment.title)
      .map((segment) => ({
        file: segment.partFile,
        title: segment.title,
        startMs: segment.outStartMs,
        endMs: segment.outEndMs,
      })),
    durationMs: Math.round(offsetSec * 1000),
  };
}

/**
 * The single narration track, assembled by concatenating generated silence and
 * the per-beat wavs in timeline order.
 *
 * Every beat wav was normalised to one format by tts.mjs, so the concat demuxer
 * can stream-copy: the result is sample-exact and instant. Building the same
 * track with adelay and amix would need one input and one filter chain per beat
 * -- forty-odd on a real ticket -- and would fold floating point rounding into
 * the very offsets the captions are placed at.
 */
export function buildNarrationTrack({ ffmpeg, plan, audioDir, outPath, sampleRate = DEFAULTS.sampleRate }) {
  const entries = [];
  let cursorMs = 0;

  const silence = (durationMs) => {
    const file = path.join(audioDir, `sil-${durationMs}.wav`);
    if (!fs.existsSync(file)) {
      execFileSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=mono`,
        '-t', (durationMs / 1000).toFixed(3), '-c:a', 'pcm_s16le', file,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    }
    return file;
  };

  for (const beat of plan.beats) {
    const gap = beat.startMs - cursorMs;
    if (gap > 0) {
      entries.push(silence(gap));
    }
    entries.push(path.join(audioDir, `${beat.id}.wav`));
    cursorMs = beat.endMs;
  }
  const trailing = plan.durationMs - cursorMs;
  if (trailing > 0) {
    entries.push(silence(trailing));
  }

  const listPath = path.join(audioDir, 'concat.txt');
  fs.writeFileSync(
    listPath,
    `${entries.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n')}\n`,
    'utf8',
  );
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return outPath;
}

/**
 * The filter graph for the narrated encode.
 *
 * Each part is split once per segment it contains, then every segment is
 * trimmed out, normalised to the merge geometry and padded. tpad has to come
 * after fps= so the frames it clones are already at the output rate, and the
 * whole chain has to sit upstream of concat because tpad can only extend the
 * end of a stream -- which is exactly why narration cannot be a second pass
 * over the already-merged file.
 */
export function buildFilterGraph({ plan, parts, size, captionsPath }) {
  const [width, height] = size.split('x');
  const lines = [];

  for (const [partIndex] of parts.entries()) {
    const count = plan.segments.filter((segment) => segment.partIndex === partIndex).length;
    if (count === 1) {
      lines.push(`[${partIndex}:v]null[p${partIndex}s0]`);
    } else {
      const labels = Array.from({ length: count }, (_, i) => `[p${partIndex}s${i}]`).join('');
      lines.push(`[${partIndex}:v]split=${count}${labels}`);
    }
  }

  const counters = new Map();
  const outputs = [];
  for (const [index, segment] of plan.segments.entries()) {
    const seen = counters.get(segment.partIndex) ?? 0;
    counters.set(segment.partIndex, seen + 1);
    const source = `[p${segment.partIndex}s${seen}]`;
    const chain = [
      `trim=start=${segment.sourceStartSec.toFixed(3)}:end=${segment.sourceEndSec.toFixed(3)}`,
      'setpts=PTS-STARTPTS',
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:-1:-1:color=black`,
      'setsar=1',
      `fps=${plan.fps}`,
    ];
    if (segment.padSec > 0) {
      chain.push(`tpad=stop_mode=clone:stop_duration=${segment.padSec.toFixed(3)}`);
    }
    lines.push(`${source}${chain.join(',')}[v${index}]`);
    outputs.push(`[v${index}]`);
  }

  const concat = `${outputs.join('')}concat=n=${outputs.length}:v=1:a=0`;
  lines.push(captionsPath ? `${concat}[vcat]` : `${concat}[vout]`);
  if (captionsPath) {
    lines.push(`[vcat]subtitles=filename='${escapeFilterPath(captionsPath)}'[vout]`);
  }

  return `${lines.join(';\n')}\n`;
}

// The path travels through ffmpeg's own filter-argument parser, where a
// backslash escapes, a colon ends the option and a quote ends the expression.
// The graph reaches ffmpeg on argv via execFileSync, which uses no shell, so
// this is the only quoting layer there is.
function escapeFilterPath(value) {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
