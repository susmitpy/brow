/**
 * Assembles what the narration model is allowed to see.
 *
 * Background comes only from the documents passed as `--context <file>` --
 * typically the requirement and a summary of the change. Nothing is discovered
 * on disk: a prompt built from whatever happened to be lying around would be
 * both unpredictable and a way for unrelated files to leak into a model call.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LIMITS = {
  perFile: 12000,
  total: 30000,
};

function readCapped(file, limit) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
  } catch {
    return '';
  }
}

export function buildContext({ contextFiles = [], segments, wordsPerSecond }) {
  const sections = [];
  for (const file of contextFiles) {
    const text = readCapped(file, LIMITS.perFile);
    if (text) {
      sections.push(`## ${path.basename(file)}\n\n${text}`);
    }
  }

  // Dropped last-first if the whole thing is still too big: pass the document
  // that actually describes the change first.
  let body = sections.join('\n\n');
  while (body.length > LIMITS.total && sections.length > 1) {
    sections.pop();
    body = sections.join('\n\n');
  }

  return { body, segments, wordsPerSecond };
}

/**
 * The segment table the model writes against. Each row is one chapter card the
 * agent placed, with the measured seconds of footage that card covers and the
 * resulting word budget.
 */
export function renderSegmentTable(segments, wordsPerSecond) {
  const rows = segments.map((segment, index) => {
    const seconds = (segment.sourceEndSec - segment.sourceStartSec).toFixed(1);
    return [
      `### Segment ${index}`,
      `- recording: ${segment.partFile}`,
      `- on-screen chapter: ${segment.title}`,
      segment.description ? `- what it proves: ${segment.description}` : null,
      `- seconds of footage: ${seconds}`,
      `- max words: ${segment.maxWords}`,
      segment.verdict ? `- verdict: ${segment.verdict}` : null,
      segment.url ? `- url: ${segment.url}` : null,
      segment.flow ? `- recorded flow claim: ${segment.flow}` : null,
    ].filter(Boolean).join('\n');
  });
  return rows.join('\n\n');
}

export function buildPrompt(context) {
  const { body, segments, wordsPerSecond } = context;
  return `You are writing the voice-over script and captions for a screen recording that
proves a software change works. A reviewer watches this video to understand what
was tested and what the result was.

The recording is already cut into segments. Each segment is one chapter of the
validation, and the video will freeze on its last frame if your narration for it
runs long, so respect the word budgets.

For every segment produce one or more beats. Each beat has:

- "text": what the voice says. Plain English for a project manager or client.
  No requirement IDs, no field names, no API operation names, no UUIDs, no URLs.
  Say what the user sees and why it matters. Full sentences, read aloud at about
  ${wordsPerSecond} words per second.
- "caption": the on-screen caption for the same moment. This is for an engineer
  verifying the evidence, so here you SHOULD keep the exact requirement IDs
  (R8, AC-2), field names (status:ACTIVE) and operation names. At most 70
  characters -- it is clamped past that.

Rules:
- Cover every segment listed below. Use its index as "id".
- Keep each segment's "text" within its max words. Fewer is better than more.
- Describe what is on screen in that segment, not the change in general.
- Do not invent results. If a segment's flow claim says something passed, say it
  passed; never state an outcome the material does not support.
- Two or three short beats read better than one long one, because each beat is a
  separate caption.

Return ONLY a JSON object, in a \`\`\`json fenced block:

{"segments":[{"id":0,"beats":[{"text":"...","caption":"..."}]}]}

# Segments

${renderSegmentTable(segments, wordsPerSecond)}
${body ? `\n# Background\n\n${body}\n` : ''}`;
}
