"""Local speech-to-text service for the PolicyCenter Assistant (Whisper, runs on this computer).

Start it in its own PowerShell window, from the PolicyCenter-Sim folder:

    .whisper\\Scripts\\python.exe scripts\\whisper_server.py

It listens on http://127.0.0.1:8178. The app posts a WAV recording to /transcribe and gets back the
text and the language Whisper heard (English, Hindi or Telugu). Nothing leaves this computer.

Settings (environment variables, all optional):
    WHISPER_MODEL   tiny, base, small, medium, large-v3   (default: medium; best for Telugu on CPU)
    WHISPER_PORT    default 8178
    WHISPER_DEVICE  cpu or cuda                            (default: cpu)

The first start downloads the model once (about 1.5 GB for medium) and then works offline.
"""

import io
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "medium")
PORT = int(os.environ.get("WHISPER_PORT", "8178"))
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = "float16" if DEVICE == "cuda" else "int8"
MAX_BYTES = 5 * 1024 * 1024  # about 2.5 minutes of 16 kHz mono WAV

print(f"Loading Whisper model '{MODEL_NAME}' on {DEVICE} (first run downloads it)...", flush=True)
model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
print(f"Speech service ready at http://127.0.0.1:{PORT}", flush=True)


def transcribe(audio_bytes):
    segments, info = model.transcribe(
        io.BytesIO(audio_bytes),
        beam_size=5,
        vad_filter=True,  # skip silence so pauses don't produce junk text
        language=None,    # detect the language automatically
    )
    text = " ".join(seg.text.strip() for seg in segments).strip()
    language = info.language
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
        if self.path != "/transcribe":
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return self._send(400, {"error": "no audio received"})
        if length > MAX_BYTES:
            return self._send(413, {"error": "recording is too long"})
        audio = self.rfile.read(length)
        try:
            return self._send(200, transcribe(audio))
        except Exception as exc:  # report the problem instead of crashing the service
            print(f"transcription failed: {exc}", file=sys.stderr, flush=True)
            return self._send(500, {"error": f"transcription failed: {exc}"})

    def log_message(self, fmt, *args):
        return  # keep the console quiet; errors are printed above


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
