# nsfw-service/main.py
#
# Self-hosted content moderation service: NSFW image/video classification
# AND text toxicity classification, both open-source models running on
# your own server. Free forever, no external API key, no third-party
# account. (Google's Perspective API — the previous toxicity option —
# is shutting down entirely on Dec 31, 2026 with no migration path, so
# this avoids that dependency altogether.)
#
# Models:
#   - Falconsai/nsfw_image_detection  (NSFW images/video frames)
#   - unitary/toxic-bert              (text toxicity, open-source, HuggingFace)
#
# Run locally:
#   pip install -r requirements.txt
#   uvicorn main:app --host 0.0.0.0 --port 8000
#
# Deploy for free/cheap: Fly.io, Railway, or a $5/mo VPS.

import os
import tempfile
import subprocess
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel
from transformers import pipeline
import requests

app = FastAPI()

SHARED_SECRET = os.environ.get("NSFW_SERVICE_TOKEN", "changeme")

# Loaded once at startup, reused for every request.
nsfw_classifier = pipeline("image-classification", model="Falconsai/nsfw_image_detection")
toxicity_classifier = pipeline("text-classification", model="unitary/toxic-bert", top_k=None)


class ClassifyRequest(BaseModel):
    url: str
    type: str  # "image" or "video"


class ToxicityRequest(BaseModel):
    text: str


def classify_image_bytes(path: str) -> float:
    """Returns probability the image is NSFW (0.0 - 1.0)."""
    results = nsfw_classifier(path)
    nsfw_scores = [r["score"] for r in results if r["label"].lower() == "nsfw"]
    return max(nsfw_scores) if nsfw_scores else 0.0


def sample_video_frames(video_path: str, out_dir: str, every_n_seconds: int = 3) -> list[str]:
    """Extract one frame every N seconds using ffmpeg. Requires ffmpeg installed."""
    pattern = os.path.join(out_dir, "frame_%04d.jpg")
    subprocess.run(
        ["ffmpeg", "-i", video_path, "-vf", f"fps=1/{every_n_seconds}", pattern, "-hide_banner", "-loglevel", "error"],
        check=True,
    )
    return sorted(
        os.path.join(out_dir, f) for f in os.listdir(out_dir) if f.startswith("frame_")
    )


@app.post("/classify")
def classify(req: ClassifyRequest, authorization: str = Header(None)):
    if authorization != f"Bearer {SHARED_SECRET}":
        raise HTTPException(status_code=401, detail="unauthorized")

    with tempfile.TemporaryDirectory() as tmp:
        local_path = os.path.join(tmp, "input")
        resp = requests.get(req.url, timeout=30)
        resp.raise_for_status()
        with open(local_path, "wb") as f:
            f.write(resp.content)

        if req.type == "image":
            score = classify_image_bytes(local_path)
        elif req.type == "video":
            frames = sample_video_frames(local_path, tmp)
            if not frames:
                return {"nsfw_probability": 0.0, "note": "no frames extracted"}
            score = max(classify_image_bytes(f) for f in frames)
        else:
            raise HTTPException(status_code=400, detail="type must be 'image' or 'video'")

    return {"nsfw_probability": round(float(score), 4)}


@app.post("/toxicity")
def toxicity(req: ToxicityRequest, authorization: str = Header(None)):
    if authorization != f"Bearer {SHARED_SECRET}":
        raise HTTPException(status_code=401, detail="unauthorized")
    if not req.text.strip():
        return {"toxicity_probability": 0.0}

    results = toxicity_classifier(req.text[:512])  # model's max useful input length
    # unitary/toxic-bert returns multiple labels (toxic, severe_toxic, obscene,
    # threat, insult, identity_hate) each with their own score — take the max,
    # same "worst attribute wins" approach Perspective used.
    scores = [r["score"] for r in results[0] if r["label"] != "non_toxic"] if results else [0.0]
    return {"toxicity_probability": round(float(max(scores)), 4)}


@app.get("/health")
def health():
    return {"status": "ok"}

