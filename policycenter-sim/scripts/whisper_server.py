"""Local speech-to-text service for the PolicyCenter Assistant (Whisper, runs on this computer).

Start it in its own PowerShell window, from the PolicyCenter-Sim folder:

    .whisper\\Scripts\\python.exe scripts\\whisper_server.py

It listens on http://127.0.0.1:8178. The app posts a WAV recording to /transcribe and gets back the
text and the language Whisper heard (English, Hindi or Telugu). Nothing leaves this computer.

Settings (environment variables, all optional):
    WHISPER_MODEL   tiny, base, small, medium, large-v3   (default: small, fast; use medium for more accurate Telugu)
    WHISPER_PORT    default 8178
    WHISPER_DEVICE  cpu or cuda                            (default: cpu)

The first start downloads the model once (about 480 MB for small, about 1.5 GB for medium) and then works offline.
"""

import io
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

import time
from urllib.parse import parse_qs

SUPPORTED_LANGUAGES = ("en", "hi", "te")
# Beam size 1 (greedy) decodes about 2-3 times faster than 5 with little loss for short questions.
# Set WHISPER_BEAM=5 for the most careful decoding when speed does not matter.
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM", "1"))
MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
PORT = int(os.environ.get("WHISPER_PORT", "8178"))
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = "float16" if DEVICE == "cuda" else "int8"
MAX_BYTES = 5 * 1024 * 1024  # about 2.5 minutes of 16 kHz mono WAV

print(f"Loading Whisper model '{MODEL_NAME}' on {DEVICE} (first run downloads it)...", flush=True)
# Use every CPU core: halves the time to transcribe a short question on a laptop CPU.
model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE, cpu_threads=os.cpu_count() or 4)
print(f"Speech service ready at http://127.0.0.1:{PORT}", flush=True)


def transcribe(audio_bytes, language=None):
    started = time.perf_counter()
    segments, info = model.transcribe(
        io.BytesIO(audio_bytes),
        beam_size=BEAM_SIZE,
        vad_filter=True,  # skip silence so pauses don't produce junk text
        without_timestamps=True,  # no per-word timing work; the chat only needs the words
        language=language,  # None means detect the language automatically
    )
    text = " ".join(seg.text.strip() for seg in segments).strip()
    language = info.language
    print(f"transcribed {len(audio_bytes) // 1024} KB in {time.perf_counter() - started:.1f}s ({language})", flush=True)
    return {"text": text, "language": language, "probability": round(float(info.language_probability), 3)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "model": MODEL_NAME})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        path, _, query = self.path.partition("?")
        if path != "/transcribe":
            return self._send(404, {"error": "not found"})
        language = (parse_qs(query).get("language") or [None])[0]
        if language not in SUPPORTED_LANGUAGES:
            language = None
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return self._send(400, {"error": "no audio received"})
        if length > MAX_BYTES:
            return self._send(413, {"error": "recording is too long"})
        audio = self.rfile.read(length)
        try:
            return self._send(200, transcribe(audio, language))
        except Exception as exc:  # report the problem instead of crashing the service
            print(f"transcription failed: {exc}", file=sys.stderr, flush=True)
            return self._send(500, {"error": f"transcription failed: {exc}"})

    def log_message(self, fmt, *args):
        return  # keep the console quiet; errors are printed above


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
