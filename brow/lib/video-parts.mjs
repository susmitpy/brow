/**
 * Part selection and chapter naming for the merged ticket video.
 *
 * Extracted from `cmd_merge_videos` so the merge and the narration pass cannot
 * disagree about which recordings make up a ticket's video. They have to agree:
 * narration measures each part to budget its script, and the merge concatenates
 * them. A part in one list and not the other silently desyncs every caption
 * after it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The recordings that make up the merged video, in the order a reviewer should
 * watch them.
 *
 * Noted recordings first, in note order -- the merged file reads as the
 * session's narrative, and alphabetical order is not that. Anything else left
 * in keep/ (the orphan sweep puts unnoted recordings here) follows, because an
 * unexplained recording is still evidence and dropping it silently is how a
 * merged file quietly stops being the whole story.
 */
export function selectParts({ keepDir, manifest, outputName }) {
  const parts = [];
  const seen = new Set();
  const dropped = new Set();

  for (const recording of manifest.recordings) {
    if (recording.kept === false && typeof recording.file === 'string') {
      dropped.add(path.basename(recording.file));
    }
  }

  function addPart(name, entry) {
    // The previous merge's output is in keep/ too; concatenating it into its own
    // successor would double the whole session on every re-run.
    if (name === outputName || seen.has(name) || dropped.has(name)) {
      return;
    }
    // A crashed merge leaves `.<outputName>.partial.mp4` behind in keep/, and the
    // orphan sweep below would otherwise adopt that half-written file as a part
    // -- which is the same doubling bug the outputName guard exists to prevent,
    // reached by a different route. Nothing this pipeline writes as evidence is
    // dot-prefixed, so the whole class is excluded by name shape.
    if (name.startsWith('.')) {
      return;
    }
    const absolute = path.join(keepDir, name);
    if (!fs.existsSync(absolute) || fs.statSync(absolute).size === 0) {
      return;
    }
    seen.add(name);
    parts.push({ name, absolute, entry });
  }

  for (const recording of manifest.recordings) {
    if (recording.kept === false || typeof recording.file !== 'string') {
      continue;
    }
    addPart(path.basename(recording.file), recording);
  }
  for (const name of fs.readdirSync(keepDir).sort()) {
    addPart(name, null);
  }

  return parts;
}

export function titleOf(part) {
  if (!part.entry) {
    return `${path.basename(part.name, path.extname(part.name))} (unnoted)`;
  }
  const label = [part.entry.flow, part.entry.variant].filter(Boolean).join(' - ');
  const verdict = part.entry.verdict ? ` [${part.entry.verdict}]` : '';
  return `${label || path.basename(part.name, path.extname(part.name))}${verdict}`;
}

/**
 * ffmetadata treats these as syntax; an unescaped one truncates the title or
 * the chapter block that follows it.
 */
export function escapeMetadata(value) {
  return value.replace(/([=;#\\\n])/g, '\\$1');
}

/**
 * Container duration in seconds, or null when it cannot be read. Without
 * ffprobe the merge still happens, just unchaptered.
 */
export function durationOf(ffprobe, file) {
  if (!ffprobe) {
    return null;
  }
  try {
    const out = execFileSync(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { encoding: 'utf8' },
    );
    const value = Number.parseFloat(out.trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
