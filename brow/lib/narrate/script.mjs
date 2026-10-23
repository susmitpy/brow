/**
 * Produces the narration script: what is said, and what is captioned, for every
 * segment of the video.
 *
 * There are two producers. `generateWithClaude` writes it properly; the
 * deterministic fallback derives something serviceable from the manifest alone.
 * The fallback is not a nicety -- it is what runs on a host with no `claude` on
 * PATH, and narration must never be the reason a ticket has no video.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPrompt } from './context.mjs';

const MAX_TEXT_CHARS = 400;
const MAX_CAPTION_CHARS = 72;

/**
 * Calls the `claude` CLI as a subprocess, using whatever login it already has
 * (or the CLAUDE_CONFIG_DIR in BROW_NARRATION_CLAUDE_HOME). There is no
 * ANTHROPIC_API_KEY anywhere in this project and this deliberately does not
 * introduce one.
 *
 * The prompt embeds agent-authored prose (flow claims, context documents), which
 * is untrusted input. It goes in on stdin, the tool set is empty and the working
 * directory is a scratch dir, so the worst a prompt injection achieves is a bad
 * narration script rather than an action taken against the project.
 */
export function generateWithClaude({ context, bin, claudeHome, model, timeoutMs, scratchDir }) {
  const prompt = buildPrompt(context);
  const env = { ...process.env };
  if (claudeHome) {
    env.CLAUDE_CONFIG_DIR = claudeHome;
  }
  fs.mkdirSync(scratchDir, { recursive: true });

  const run = () =>
    execFileSync(
      bin,
      ['-p', '--output-format', 'json', '--max-turns', '1', '--allowed-tools', '', '--model', model],
      {
        input: prompt,
        cwd: scratchDir,
        env,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 8 << 20,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

  // One retry for a non-zero exit: observed failing once and then succeeding
  // on an identical re-run. A timeout is not retried -- that would double an
  // already long wait -- and either way the thrown message carries the CLI's
  // own reason, since execFileSync's first line is only the command.
  let stdout;
  try {
    stdout = run();
  } catch (first) {
    if (first.code === 'ETIMEDOUT' || first.signal === 'SIGKILL') {
      throw new Error(`claude timed out after ${timeoutMs} ms (BROW_NARRATION_LLM_TIMEOUT_MS)`);
    }
    try {
      stdout = run();
    } catch (second) {
      throw new Error(`claude failed twice: ${describeFailure(second)}`);
    }
  }

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error('claude did not return JSON');
  }
  const result = typeof envelope?.result === 'string' ? envelope.result : stdout;
  const parsed = extractJson(result);
  if (!parsed) {
    throw new Error('no JSON object found in the model response');
  }
  return { parsed, promptChars: prompt.length };
}

/**
 * One line saying why the CLI failed. With --output-format json it reports
 * errors (max turns, API errors) as an envelope on stdout; otherwise the last
 * stderr line is the useful one.
 */
function describeFailure(error) {
  try {
    const envelope = JSON.parse(error.stdout || '');
    const detail = envelope?.subtype || envelope?.result;
    if (detail) {
      return `exit ${error.status}: ${String(detail).split('\n')[0].slice(0, 200)}`;
    }
  } catch {
    // not JSON; fall through to stderr
  }
  const stderr = String(error.stderr || '').trim().split('\n').pop();
  return `exit ${error.status}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`;
}

/**
 * Pulls the object out of a reply that may be fenced, prefixed with prose, or
 * both. Scans for a balanced object rather than regexing, because the captions
 * legitimately contain braces-free but quote-heavy text and a greedy match
 * would run past the end.
 */
export function extractJson(text) {
  const fenced = /```json\s*([\s\S]*?)```/.exec(text);
  const candidates = [];
  if (fenced) {
    candidates.push(fenced[1]);
  }
  const start = text.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = !inString;
      } else if (!inString && ch === '{') {
        depth += 1;
      } else if (!inString && ch === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return null;
}

/**
 * Accepts the model's script only if it covers exactly the segments that were
 * asked about, with usable strings.
 *
 * There is no partial acceptance. A script missing one segment shifts every
 * beat after it onto the wrong footage, and a caption on the wrong footage
 * actively misrepresents what the evidence shows -- worse than the plainer
 * deterministic script.
 */
export function validateScript(parsed, segments) {
  if (!parsed || !Array.isArray(parsed.segments)) {
    return null;
  }
  const byId = new Map();
  for (const entry of parsed.segments) {
    const id = Number(entry?.id);
    if (!Number.isInteger(id) || !Array.isArray(entry.beats)) {
      return null;
    }
    byId.set(id, entry.beats);
  }

  const out = [];
  for (const [index, segment] of segments.entries()) {
    if (segment.silent) {
      out.push([]);
      continue;
    }
    const beats = byId.get(index);
    if (!Array.isArray(beats) || beats.length === 0) {
      return null;
    }
    const cleaned = [];
    for (const beat of beats) {
      const text = typeof beat?.text === 'string' ? beat.text.trim() : '';
      if (!text || text.length > MAX_TEXT_CHARS) {
        return null;
      }
      const rawCaption = typeof beat?.caption === 'string' ? beat.caption.trim() : '';
      cleaned.push({
        text,
        caption: clampCaption(rawCaption || text),
      });
    }
    out.push(cleaned);
  }
  return out;
}

/**
 * Captions are clamped at a word boundary, never mid-word. wrapCaption lays out
 * two lines of about 42 characters, so anything past this cannot be shown --
 * but a caption cut to "...null-lateral filter act" reads as a rendering bug,
 * where an ellipsis reads as a deliberate abbreviation.
 */
export function clampCaption(text, limit = MAX_CAPTION_CHARS) {
  const trimmed = String(text).trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  const clipped = trimmed.slice(0, limit - 1);
  const boundary = clipped.lastIndexOf(' ');
  return `${(boundary > limit * 0.6 ? clipped.slice(0, boundary) : clipped).trimEnd()}\u2026`;
}

const firstSentences = (text, maxWords) => {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  if (words.length <= maxWords) {
    return words.join(' ');
  }
  const clipped = words.slice(0, maxWords).join(' ');
  const cut = clipped.lastIndexOf('. ');
  return cut > 20 ? clipped.slice(0, cut + 1) : `${clipped}...`;
};

/**
 * The no-model script. Every fact in it comes from the manifest entry or the
 * chapter card, so it states nothing the recording does not already claim.
 */
export function deterministicScript(segments) {
  return segments.map((segment) => {
    if (segment.silent) {
      return [];
    }
    const beats = [];
    const budget = segment.maxWords ?? 40;

    if (segment.title) {
      beats.push({
        text: `${segment.title.replace(/\s*[-—]\s*/g, ': ')}.`,
        caption: clampCaption(segment.title),
      });
    }
    if (segment.description) {
      beats.push({
        text: firstSentences(segment.description, budget),
        caption: clampCaption(segment.description),
      });
    } else if (segment.flow) {
      beats.push({
        text: firstSentences(segment.flow, budget),
        caption: clampCaption(segment.flow),
      });
    }
    if (segment.verdict) {
      const outcome = segment.verdict === 'pass' ? 'passed' : 'failed';
      beats.push({
        text: `This check ${outcome}.`,
        caption: clampCaption(`[${segment.verdict}]`),
      });
    }
    if (beats.length === 0) {
      beats.push({
        text: `Unlabelled recording: ${path.basename(segment.partFile, path.extname(segment.partFile))}.`,
        caption: clampCaption(segment.partFile),
      });
    }
    return beats;
  });
}
