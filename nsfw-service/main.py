# nsfw-service/main.py
#
# Self-hosted content moderation service: NSFW image/video classification,
# text toxicity classification, and zero-shot category detection for
# drugs/weapons/violence/self-harm/illegal-goods in both images and text —
# open-source models running on your own server. Free forever, no external
# API key, no third-party account. (Google's Perspective API — the
# previous toxicity option — is shutting down entirely on Dec 31, 2026
# with no migration path, so this avoids that dependency altogether.)
#
# Models (all distilled/smaller variants chosen specifically to keep RAM
# down without dropping a category — see the memory-budget note below):
#   - Falconsai/nsfw_image_detection    (NSFW images/video frames)
#   - martin-ha/toxic-comment-model     (text toxicity — DistilBERT, ~4x
#                                         smaller than the original
#                                         toxic-bert at ~97% of its
#                                         accuracy on standard benchmarks)
#   - openai/clip-vit-base-patch32      (zero-shot image categories —
#                                         weapons/drugs/violence)
#   - valhalla/distilbart-mnli-12-3     (zero-shot text categories — same,
#                                         for coded/slang phrasing keyword
#                                         lists miss, drug/weapon sale,
#                                         self-harm, sexual solicitation,
#                                         spam. Distilled MNLI model —
#                                         much smaller than bart-large-mnli,
#                                         same zero-shot approach)
#
# What this deliberately does NOT do: detect CSAM. That requires
# hash-matching against a database of known material via a legally
# vetted provider (Thorn Safer / Google CSAI Match / Microsoft
# PhotoDNA) — see CSAM_SETUP.md. Building or training a classifier for
# that here would require possessing the material to train on, which
# is illegal outside a handful of authorized organizations. Don't add
# that here; wire the provider call into api/moderate-media.js instead.
#
# What this ALSO deliberately does not do (as of this revision): video
# audio transcription. That used to run here via Whisper, but Whisper
# was the single heaviest model for the narrowest payoff (only applies
# to a video's spoken audio track). It's moved to the browser instead —
# see js/audio-transcribe.js, which runs a real open-source Whisper-tiny
# model client-side via @xenova/transformers (WebAssembly, ~40MB,
# cached after first load). The resulting transcript is still sent here
# and classified by the SAME toxicity/category models below, so a video
# someone narrates a drug sale over still gets caught — the only actual
# security trade-off is that a technically adversarial user could send a
# blank/faked transcript from devtools and dodge THAT specific channel.
# The video's actual frames are still scanned server-side either way,
# completely unaffected by this change.
#
# Memory budget (why these specific models, at bf16):
#   Falconsai NSFW  ~170MB   CLIP           ~300MB
#   toxic-comment   ~130MB   distilbart-mnli ~280MB
#   + FastAPI/PyTorch runtime baseline: ~150-300MB
#   Total: roughly 900MB-1.1GB. That's a real, substantial cut from the
#   ~3GB+ the original fp32 five-model setup needed — but it does NOT
#   fit a true 512MB free tier. Nothing left to cut gets you there
#   without dropping NSFW, weapon/drug/violence, or self-harm detection
#   outright, which is the one thing this revision was built to avoid.
#   Budget for Railway Hobby (~$5/mo) or a Render paid tier.
#
# Run locally:
#   pip install -r requirements.txt
#   uvicorn main:app --host 0.0.0.0 --port 8000
#
# Deploy: Railway or Fly.io (~$5/mo minimum as of 2026 — neither has a
# real free tier anymore). Give the box at least 1.5GB RAM for headroom
# beyond the ~1GB steady-state above (model loading briefly spikes
# higher than steady-state, and video frame sampling needs scratch
# space too).

import os
import tempfile
import subprocess
import torch
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel
from transformers import pipeline
import requests

app = FastAPI()

SHARED_SECRET = os.environ.get("NSFW_SERVICE_TOKEN", "changeme")

# bfloat16 over float16: float16 has spotty/slow support in many CPU
# kernels (it's really designed for GPU), while bfloat16 runs natively
# and reasonably fast on modern CPUs and still halves memory vs fp32.
MODEL_DTYPE = torch.bfloat16

# Loaded once at startup, reused for every request.
nsfw_classifier = pipeline("image-classification", model="Falconsai/nsfw_image_detection", torch_dtype=MODEL_DTYPE)
toxicity_classifier = pipeline("text-classification", model="martin-ha/toxic-comment-model", top_k=None, torch_dtype=MODEL_DTYPE)
image_category_classifier = pipeline("zero-shot-image-classification", model="openai/clip-vit-base-patch32", torch_dtype=MODEL_DTYPE)
text_category_classifier = pipeline("zero-shot-classification", model="valhalla/distilbart-mnli-12-3", torch_dtype=MODEL_DTYPE)

# Candidate labels for the "illegal/dangerous goods" sweep. Tune these
# to your community — narrower labels give sharper scores than broad
# ones. Kept deliberately separate from NSFW/toxicity so each category
# gets its own threshold and doesn't drown out the others.
IMAGE_CATEGORY_LABELS = [
    "firearm or weapon",
    "illegal drugs or drug paraphernalia",
    "graphic violence, gore, or a depiction of serious injury",
    "a normal, unremarkable photo",
]
TEXT_CATEGORY_LABELS = [
    "selling illegal drugs",
    "selling or trading weapons",
    "sexual solicitation or explicit sexual content",
    "graphic violence or threats of violence against a person",
    "self-harm, suicide, or suicidal ideation",
    "spam, scam, or phishing content",
    "ordinary conversation",
]
# Labels ending in "a normal photo" / "ordinary conversation" are the
# deliberate null class — a zero-shot classifier forced to choose only
# among bad categories will always pick one, even for a photo of a
# sandwich. Including a neutral option lets low-confidence content
# actually score low instead of being forced into a false category.


class ClassifyRequest(BaseModel):
    url: str
    type: str  # "image" or "video"


class ToxicityRequest(BaseModel):
    text: str


class CategoryImageRequest(BaseModel):
    url: str
    type: str  # "image" or "video"


class CategoryTextRequest(BaseModel):
    text: str


class TranscriptModerateRequest(BaseModel):
    transcript: str


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


@app.post("/transcript-moderate")
def transcript_moderate(req: TranscriptModerateRequest, authorization: str = Header(None)):
    """Classifies a video's transcript — same toxicity + drug/weapon-sale/
    self-harm/etc category checks /toxicity and /text-categories run on
    post text. The transcript itself is produced client-side now (see
    js/audio-transcribe.js's in-browser Whisper-tiny via
    @xenova/transformers) rather than this server downloading and
    transcribing the video's audio track — that was the single heaviest
    model here for the narrowest payoff. The actual classification of
    whatever transcript text arrives still happens here, server-side,
    same as always."""
    if authorization != f"Bearer {SHARED_SECRET}":
        raise HTTPException(status_code=401, detail="unauthorized")

    transcript = (req.transcript or "").strip()
    return {
        "transcript": transcript,
        "toxicity_probability": text_toxicity(transcript),
        "categories": text_categories_for(transcript),
    }


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


def text_toxicity(text: str) -> float:
    """Returns probability the text is toxic (0.0 - 1.0). Shared by the
    /toxicity endpoint and /transcript-moderate, so someone can't say
    in a video's audio what would get their post text blocked."""
    if not text.strip():
        return 0.0
    results = toxicity_classifier(text[:512])  # model's max useful input length
    # martin-ha/toxic-comment-model (distilled, single toxic/non-toxic
    # label pair) replaces the original 6-label unitary/toxic-bert —
    # smaller model, same "score for toxic" extraction, just less to
    # filter out of the label set.
    labels = results[0] if results else []
    scores = [r["score"] for r in labels if "non" not in r["label"].lower()]
    return round(float(max(scores)), 4) if scores else 0.0


@app.post("/toxicity")
def toxicity(req: ToxicityRequest, authorization: str = Header(None)):
    if authorization != f"Bearer {SHARED_SECRET}":
        raise HTTPException(status_code=401, detail="unauthorized")
    return {"toxicity_probability": text_toxicity(req.text)}


def classify_image_categories(path: str) -> list[dict]:
    """Returns [{label, score}, ...] excluding the neutral label, sorted desc."""
    from PIL import Image
    img = Image.open(path).convert("RGB")
    results = image_category_classifier(img, candidate_labels=IMAGE_CATEGORY_LABELS)
    return [
        {"label": r["label"], "score": round(float(r["score"]), 4)}
        for r in results
        if r["label"] != "a normal, unremarkable photo"
    ]


@app.post("/categories")
def categories(req: CategoryImageRequest, authorization: str = Header(None)):
    """Zero-shot weapon/drug/illegal-goods detection for an image or video.
    Returns the highest-scoring non-neutral label per frame (video: worst
    frame wins, same approach as /classify)."""
    if authorization != f"Bearer {SHARED_SECRET}":
        raise HTTPException(status_code=401, detail="unauthorized")

    with tempfile.TemporaryDirectory() as tmp:
        local_path = os.path.join(tmp, "input")
        resp = requests.get(req.url, timeout=30)
        resp.raise_for_status()
        with open(local_path, "wb") as f:
            f.write(resp.content)

        if req.type == "image":
            scores = classify_image_categories(local_path)
        elif req.type == "video":
            frames = sample_video_frames(local_path, tmp)
            if not frames:
                return {"categories": [], "note": "no frames extracted"}
            all_scores = [classify_image_categories(f) for f in frames]
            # worst-frame-wins per label, mirroring the NSFW video approach
            best = {}
            for frame_scores in all_scores:
                for s in frame_scores:
                    if s["label"] not in best or s["score"] > best[s["label"]]["score"]:
                        best[s["label"]] = s
            scores = sorted(best.values(), key=lambda s: -s["score"])
        else:
            raise HTTPException(status_code=400, detail="type must be 'image' or 'video'")

    return {"categories": scores}


def text_categories_for(text: str) -> list[dict]:
    """Zero-shot category detection for text: drug-sale/weapon-sale
    language and sexual solicitation/explicit sexual content — catches
    coded or slang phrasing a keyword list would miss, by scoring the
    sentence against candidate categories in context rather than
    matching words. Shared by /text-categories and the audio-transcript
    pipeline below."""
    if not text.strip():
        return []
    result = text_category_classifier(text[:512], candidate_labels=TEXT_CATEGORY_LABELS, multi_label=True)
    scores = [
        {"label": label, "score": round(float(score), 4)}
        for label, score in zip(result["labels"], result["scores"])
        if label != "ordinary conversation"
    ]
    return sorted(scores, key=lambda s: -s["score"])


@app.post("/text-categories")
def text_categories(req: CategoryTextRequest, authorization: str = Header(None)):
    if authorization != f"Bearer {SHARED_SECRET}":
        raise HTTPException(status_code=401, detail="unauthorized")
    return {"categories": text_categories_for(req.text)}


@app.get("/health")
def health():
    return {"status": "ok"}

