/**
 * Speech synthesis for the narration track.
 *
 * Every beat is synthesised to its own file and measured. That is not an
 * accident of implementation: it is what makes the captions correct. Because a
 * beat's audio length is known before anything is encoded, the caption timings
 * fall straight out of the plan, with no forced-alignment step and no speech
 * recognition pass to disagree with.
 *
 * Piper is the default engine: offline, no API key, nothing about a recording
 * or a ticket leaves the machine -- which matters here, because these videos
 * capture the login screen and browser-tester's contract forbids sending them
 * anywhere external. It synthesises at roughly a fiftieth of real time.
 *
 * It is run through `uv run --with`, not installed into any of this repo's
 * virtualenvs, so a teammate who never narrates a video pays nothing for it and
 * nobody's existing environment changes. uv caches the wheels globally, so the
 * cost lands once, on the first narration, on the machine that asks for it.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const SAMPLE_RATE = 24000;
export const DEFAULT_VOICE = 'en_US-lessac-medium';
const PIPER_SPEC = 'piper-tts==1.4.2';

export function resolveEngine(env = process.env, { libDir } = {}) {
  const requested = env.BROW_NARRATION_TTS;
  if (requested === 'none') {
    return null;
  }
  if (requested === 'command') {
    return commandEngine(env);
  }
  if (requested === 'piper' || !requested) {
    const engine = piperEngine(env, libDir);
    if (engine) {
      return engine;
    }
    return requested === 'piper' ? null : commandEngine(env);
  }
  return null;
}

// Deliberately not `command -v` through a shell: passing an argument to a
// shelled-out child is exactly the pattern Node deprecated in DEP0190, and the
// binary name here comes from the environment.
function which(bin) {
  if (bin.includes(path.sep)) {
    return fs.existsSync(bin) ? bin : '';
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return '';
}

function voicesDir(env) {
  return env.BROW_NARRATION_VOICE_DIR
    || path.join(os.homedir(), '.cache', 'brow-narration', 'voices');
}

function piperEngine(env, libDir) {
  const uv = env.BROW_NARRATION_UV_BIN || which('uv');
  if (!uv) {
    return null;
  }
  const script = path.join(libDir, 'narrate', 'piper_tts.py');
  if (!fs.existsSync(script)) {
    return null;
  }
  const voice = env.BROW_NARRATION_VOICE || DEFAULT_VOICE;
  const dir = voicesDir(env);
  const model = env.BROW_NARRATION_VOICE_MODEL || path.join(dir, `${voice}.onnx`);

  return {
    name: 'piper',
    voice,
    extension: 'wav',
    batch: true,
    /**
     * Fetches the voice on first use. The models are 60MB-odd and version
     * independently of this repo, so they are cached outside it rather than
     * vendored.
     */
    prepare() {
      if (fs.existsSync(model)) {
        return;
      }
      if (env.BROW_NARRATION_VOICE_MODEL) {
        throw new Error(`BROW_NARRATION_VOICE_MODEL points at a file that does not exist: ${model}`);
      }
      fs.mkdirSync(dir, { recursive: true });
      process.stderr.write(`downloading piper voice ${voice} into ${dir}\n`);
      execFileSync(
        uv,
        ['run', '--quiet', '--with', PIPER_SPEC, 'python', '-m', 'piper.download_voices',
          '--download-dir', dir, voice],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      if (!fs.existsSync(model)) {
        throw new Error(`piper did not produce ${model}`);
      }
    },
    synthAll(beats) {
      const job = JSON.stringify({
        voiceModel: model,
        espeakData: env.BROW_NARRATION_ESPEAK_DATA || null,
        beats,
      });
      let stdout;
      try {
        stdout = execFileSync(
          uv,
          ['run', '--quiet', '--with', PIPER_SPEC, 'python', script],
          { input: job, encoding: 'utf8', maxBuffer: 8 << 20, stdio: ['pipe', 'pipe', 'pipe'] },
        );
      } catch (error) {
        // piper's espeak bridge kills the interpreter instead of raising, so a
        // failure can arrive as a dead process with its reason on stdout.
        const reported = parseResult(String(error.stdout || ''));
        throw new Error(reported?.error || String(error.stderr || error.message).trim());
      }
      const result = parseResult(stdout);
      if (!result?.ok) {
        throw new Error(result?.error || 'piper returned no result');
      }
    },
  };
}

function parseResult(text) {
  for (const line of String(text).trim().split('\n').reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // not the result line
    }
  }
  return null;
}

/**
 * Escape hatch for any other synthesiser. BROW_NARRATION_TTS_COMMAND is a
 * command line in which {out} is replaced by the output path; the text arrives
 * on stdin.
 *
 *   BROW_NARRATION_TTS=command
 *   BROW_NARRATION_TTS_COMMAND='espeak-ng -w {out}'
 */
function commandEngine(env) {
  const template = env.BROW_NARRATION_TTS_COMMAND;
  if (!template) {
    return null;
  }
  return {
    name: 'command',
    voice: env.BROW_NARRATION_VOICE || template,
    extension: 'wav',
    batch: false,
    prepare() {},
    synth(text, outPath) {
      const parts = template.split(/\s+/).map((part) => part.replace('{out}', outPath));
      execFileSync(parts[0], parts.slice(1), { input: text, stdio: ['pipe', 'ignore', 'pipe'] });
    },
  };
}

export function beatId(segmentIndex, beatIndex, text, engine) {
  const hash = crypto
    .createHash('sha1')
    .update(`${text} ${engine.name} ${engine.voice}`)
    .digest('hex')
    .slice(0, 10);
  return `${String(segmentIndex).padStart(3, '0')}-${String(beatIndex).padStart(2, '0')}-${hash}`;
}

/**
 * Synthesises every beat and returns its exact duration in seconds.
 *
 * Normalisation is not optional and is identical for every beat: the narration
 * track is later assembled with the concat demuxer and a stream copy, which
 * requires every input to agree on codec, sample rate and channel count. Piper
 * voices differ here between quality levels -- "low" is 16kHz where "medium" is
 * 22.05kHz -- so without this a change of voice would silently corrupt the
 * track. Leading silence is stripped because a variable lead-in would shift
 * every caption off the word it belongs to; the quarter second on the end is
 * the pause between sentences.
 *
 * The hash in the beat id is the cache key, so re-running after editing one
 * line of the script re-synthesises that line and reuses the rest.
 */
export function synthBeats({ engine, ffmpeg, ffprobe, beats, audioDir, force = false }) {
  fs.mkdirSync(audioDir, { recursive: true });

  const pending = beats.filter((beat) => {
    const wav = path.join(audioDir, `${beat.id}.wav`);
    return force || !fs.existsSync(wav) || fs.statSync(wav).size === 0;
  });

  if (pending.length > 0) {
    engine.prepare();
    const raw = (beat) => path.join(audioDir, `.${beat.id}.raw.${engine.extension}`);
    for (const beat of pending) {
      fs.rmSync(raw(beat), { force: true });
    }

    if (engine.batch) {
      engine.synthAll(pending.map((beat) => ({ id: beat.id, text: beat.text, out: raw(beat) })));
    } else {
      for (const beat of pending) {
        engine.synth(beat.text, raw(beat));
      }
    }

    for (const beat of pending) {
      if (!fs.existsSync(raw(beat)) || fs.statSync(raw(beat)).size === 0) {
        throw new Error(`${engine.name} produced no audio for beat ${beat.id}`);
      }
      execFileSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', raw(beat),
        '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le',
        '-af', 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,apad=pad_dur=0.25',
        path.join(audioDir, `${beat.id}.wav`),
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      fs.rmSync(raw(beat), { force: true });
    }
  }

  const durations = new Map();
  for (const beat of beats) {
    durations.set(beat.id, probeDuration(ffprobe, path.join(audioDir, `${beat.id}.wav`)));
  }
  return durations;
}

function probeDuration(ffprobe, file) {
  const out = execFileSync(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' },
  );
  const value = Number.parseFloat(out.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`could not measure ${file}`);
  }
  return value;
}
