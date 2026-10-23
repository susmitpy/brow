"""Batch speech synthesis for `brow narrate-video`, using Piper.

Reads one JSON job on stdin and writes one wav per beat:

    {"voiceModel": "/path/en_US-lessac-medium.onnx",
     "espeakData": "/opt/homebrew/share/espeak-ng-data",   # optional
     "beats": [{"id": "000-00-abc", "out": "/path/000-00-abc.wav", "text": "..."}]}

One process for the whole ticket because loading the ONNX voice costs about half
a second and synthesising a sentence costs about a fiftieth of that; a process
per beat would spend all its time on model loads.

espeak-ng data, and why this is not the obvious path: piper's wheels bundle an
espeak-ng-data directory that its own compiled espeakbridge rejects as the wrong
version. When that happens the bridge silently falls back to the data path baked
in at build time -- on macOS arm64 that is the CI machine's
/Users/runner/work/piper1-gpl/... -- reports "No such file or directory", and
exits the process rather than raising, so Python never gets to see the error.
A system espeak-ng install has data the bridge does accept, so that is what is
looked for first. Every candidate is verified by actually initialising the
bridge in a subprocess, because a failure cannot be caught in-process.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import wave
from pathlib import Path

ESPEAK_CANDIDATES = (
    "/opt/homebrew/share/espeak-ng-data",
    "/usr/local/share/espeak-ng-data",
    "/usr/share/espeak-ng-data",
    "/usr/lib/x86_64-linux-gnu/espeak-ng-data",
)


def fail(message: str) -> None:
    json.dump({"ok": False, "error": message}, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    raise SystemExit(1)


def espeak_probe_source() -> str:
    return (
        "import sys\n"
        "from piper import espeakbridge\n"
        "espeakbridge.initialize(sys.argv[1])\n"
        "espeakbridge.set_voice('en-us')\n"
        "assert espeakbridge.get_phonemes('test')\n"
        "print('OK')\n"
    )


def usable_espeak_data(explicit: str | None) -> str:
    """First espeak-ng data directory the bridge actually accepts.

    Probed out-of-process: a bad directory terminates the interpreter, so an
    in-process try/except would take this script down with it.
    """
    candidates = []
    if explicit:
        candidates.append(explicit)
    candidates.extend(ESPEAK_CANDIDATES)
    try:
        import piper

        candidates.append(str(Path(piper.__file__).parent / "espeak-ng-data"))
    except Exception:  # noqa: BLE001 - reported below as "no usable data"
        pass

    for candidate in candidates:
        if not Path(candidate).is_dir():
            continue
        probe = subprocess.run(
            [sys.executable, "-c", espeak_probe_source(), candidate],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if probe.returncode == 0 and "OK" in probe.stdout:
            return candidate
    fail(
        "no usable espeak-ng data found. Install espeak-ng (macOS: brew install espeak-ng, "
        "Debian/Ubuntu: apt-get install espeak-ng-data) or set BROW_NARRATION_ESPEAK_DATA "
        f"to a directory containing phontab. Tried: {', '.join(candidates)}"
    )
    raise AssertionError("unreachable")


def main() -> None:
    try:
        job = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        fail(f"could not parse the job on stdin: {error}")

    model = job.get("voiceModel")
    beats = job.get("beats") or []
    if not model or not Path(model).is_file():
        fail(f"voice model not found: {model}")
    if not beats:
        fail("no beats to synthesise")

    espeak = usable_espeak_data(job.get("espeakData") or os.environ.get("BROW_NARRATION_ESPEAK_DATA"))

    try:
        from piper.voice import PiperVoice
    except ImportError as error:
        fail(f"piper is not importable: {error}")

    config = f"{model}.json"
    kwargs = {"espeak_data_dir": espeak}
    if Path(config).is_file():
        kwargs["config_path"] = config

    try:
        voice = PiperVoice.load(model, **kwargs)
    except Exception as error:  # noqa: BLE001 - surfaced as JSON for the caller
        fail(f"could not load {model}: {error}")

    written = []
    for beat in beats:
        out = beat["out"]
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        with wave.open(out, "wb") as handle:
            voice.synthesize_wav(beat["text"], handle)
        written.append(beat["id"])

    json.dump({"ok": True, "espeakData": espeak, "written": written}, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
