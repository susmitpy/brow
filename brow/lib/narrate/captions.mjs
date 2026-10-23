/**
 * Caption sidecars for the narrated video.
 *
 * Both formats are written every time, before anything checks whether this host
 * can actually burn text in. A machine without libass still produces the .ass,
 * so the same ticket can be re-encoded with captions later without re-running
 * the model or the synthesiser.
 */
import fs from 'node:fs';

const LINE_CHARS = 42;
const MAX_LINES = 2;

/**
 * Breaks a caption to fit the bottom third without pushing the picture away.
 * Two lines is the limit: a third starts covering the table rows that are
 * usually the evidence.
 */
export function wrapCaption(text, { lineChars = LINE_CHARS, maxLines = MAX_LINES } = {}) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= lineChars || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) {
    lines.push(current);
  }
  if (lines.length <= maxLines) {
    return lines;
  }
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, Math.max(0, lineChars - 1)).trimEnd()}…`;
  return kept;
}

const pad = (value, width) => String(value).padStart(width, '0');

function srtTime(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(ms % 1000, 3)}`;
}

// ASS centiseconds, and its hours field is a single digit.
function assTime(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(Math.floor((ms % 1000) / 10), 2)}`;
}

export function writeSrt(beats, outPath) {
  const blocks = beats.map((beat, index) => {
    const lines = wrapCaption(beat.caption ?? beat.text);
    return `${index + 1}\n${srtTime(beat.startMs)} --> ${srtTime(beat.endMs)}\n${lines.join('\n')}\n`;
  });
  fs.writeFileSync(outPath, `${blocks.join('\n')}`, 'utf8');
  return outPath;
}

/**
 * BorderStyle 3 with a translucent BackColour draws a filled box rather than an
 * outline, which is the only thing that stays legible over a data table.
 * Alignment 2 plus MarginV lifts it clear of the very bottom edge, where a
 * player's own scrubber sits.
 */
const ASS_HEADER = (width, height) => `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Cap,Arial,34,&H00FFFFFF,&H000000FF,&H00000000,&HA0000000,0,0,0,0,100,100,0,0,3,0,4,2,60,60,48,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

// A literal newline ends a Dialogue line, and a brace opens an override block.
function assText(lines) {
  return lines
    .map((line) => line.replace(/\\/g, '\\\\').replace(/[{}]/g, ''))
    .join('\\N');
}

export function writeAss(beats, outPath, { size = '1280x720' } = {}) {
  const [width, height] = size.split('x');
  const events = beats.map((beat) => {
    const text = assText(wrapCaption(beat.caption ?? beat.text));
    return `Dialogue: 0,${assTime(beat.startMs)},${assTime(beat.endMs)},Cap,,0,0,0,,${text}`;
  });
  fs.writeFileSync(outPath, `${ASS_HEADER(width, height)}${events.join('\n')}\n`, 'utf8');
  return outPath;
}
