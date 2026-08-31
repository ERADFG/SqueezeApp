# nsfw-service/main.py
#
# Self-hosted content moderation service: NSFW image/video classification,
# text toxicity classification, zero-shot category detection for
# drugs/weapons/illegal-goods in both images and text, AND (new) audio
# transcription for video — all open-source models running on your own
# server. Free forever, no external API key, no third-party account.
# (Google's Perspective API — the previous toxicity option — is shutting
# down entirely on Dec 31, 2026 with no migration path, so this avoids
# that dependency altogether.)
#
# Models:
#   - Falconsai/nsfw_image_detection    (NSFW images/video frames)
#   - unitary/toxic-bert                (text toxicity)
#   - openai/clip-vit-base-patch32      (zero-shot image categories —
#                                         weapons/drugs/illegal goods)
#   - facebook/bart-large-mnli          (zero-shot text categories — same,
#                                         for coded/slang phrasing keyword
#                                         lists miss, e.g. "plug for that
#                                         gas, dm 4 menu" — plus sexual
#                                         solicitation/explicit text)
#   - openai/whisper-base                (speech-to-text for video's audio
#                                         track — the transcript then runs
#                                         through the SAME toxicity + text-
#                                         category classifiers above (drug/
#                                         weapon sale, sexual solicitation),
#                                         so someone can't say in the audio
#                                         what would get their post text
#                                         blocked)
#
# What this deliberately does NOT do: detect CSAM. That requires
# hash-matching against a database of known material via a legally
# vetted provider (Thorn Safer / Google CSAI Match / Microsoft
# PhotoDNA) — see CSAM_SETUP.md. Building or training a classifier for
# that here would require possessing the material to train on, which
# is illegal outside a handful of authorized organizations. Don't add
# that here; wire the provider call into api/moderate-media.js instead.
#
# Run locally:
#   pip install -r requirements.txt
#   uvicorn main:app --host 0.0.0.0 --port 8000
#
# Deploy for free/cheap: Fly.io, Railway, or a $5/mo VPS. The category
# and whisper models are heavier than the original two — give the box
# at least 2GB RAM (3GB+ if audio moderation sees real traffic), and
# expect slower cold starts.

import os
import tempfile
import subprocess
import numpy as np
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel
from transformers import pipeline
import requests

app = FastAPI()

SHARED_SECRET = os.environ.get("NSFW_SERVICE_TOKEN", "changeme")

# Cap on how much audio we'll ever transcribe from one video, in seconds.
# Protects the box from a 3-hour upload tying up a worker — moderation
# only needs to see the content, not process the whole runtime of
# anything absurdly long. Tune via env var if your community posts
# longer videos.
MAX_AUDIO_SECONDS = int(os.environ.get("MAX_AUDIO_SECONDS", "600"))
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "openai/whisper-base")

# Loaded once at startup, reused for every request.
nsfw_classifier = pipeline("image-classification", model="Falconsai/nsfw_image_detection")
toxicity_classifier = pipeline("text-classification", model="unitary/toxic-bert", top_k=None)
image_category_classifier = pipeline("zero-shot-image-classification", model="openai/clip-vit-base-patch32")
text_category_classifier = pipeline("zero-shot-classification", model="facebook/bart-large-mnli")
# chunk_length_s/stride_length_s enable long-form transcription (the
# model's own window is ~30s) — without this, anything past the first
# 30 seconds of audio would just be silently dropped.
speech_transcriber = pipeline(
    "automatic-speech-recognition",
    model=WHISPER_MODEL,
    chunk_length_s=30,
    stride_length_s=5,
)

# Candidate labels for the "illegal/dangerous goods" sweep. Tune these
# to your community — narrower labels give sharper scores than broad
# ones. Kept deliberately separate from NSFW/toxicity so each category
# gets its own threshold and doesn't drown out the others.
IMAGE_CATEGORY_LABELS = [
    "firearm or weapon",
    "illegal drugs or drug paraphernalia",
    "a normal, unremarkable photo",
]
TEXT_CATEGORY_LABELS = [
    "selling illegal drugs",
    "selling or trading weapons",
    "sexual solicitation or explicit sexual content",
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


class AudioModerateRequest(BaseModel):
    url: str


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


def extract_audio_waveform(video_path: str) -> np.ndarray | None:
    """Extracts the audio track as 16kHz mono float32 PCM via ffmpeg,
    piped straight to memory (no intermediate wav file needed). Returns
    None if the video has no audio track at all, which is common and
    not an error — ffmpeg exits non-zero for "no audio stream", so we
    check for that specifically rather than raising.
    """
    cmd = [
        "ffmpeg", "-i", video_path,
        "-t", str(MAX_AUDIO_SECONDS),
        "-vn",                 # drop video stream, audio only
        "-ac", "1",            # mono
        "-ar", "16000",        # 16kHz — what whisper expects
        "-f", "f32le",         # raw float32 PCM, no container
        "-hide_banner", "-loglevel", "error",
        "pipe:1",
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0 or not result.stdout:
        return None
    return np.frombuffer(result.stdout, dtype=np.float32)


def transcribe_and_moderate(video_path: str) -> dict:
    """Extracts audio, transcribes it with whisper, then runs the same
    toxicity + drug/weapon-sale classifiers that already run on post
    text against the transcript. Returns a result even when there's no
    audio track (empty transcript, zero scores) rather than erroring,
    since plenty of legitimate video posts are silent or music-only."""
    waveform = extract_audio_waveform(video_path)
    if waveform is None or waveform.size == 0:
        return {"transcript": "", "toxicity_probability": 0.0, "categories": []}

    asr_result = speech_transcriber({"array": waveform, "sampling_rate": 16000})
    transcript = (asr_result.get("text") or "").strip()

    return {
        "transcript": transcript,
        "toxicity_probability": text_toxicity(transcript),
        "categories": text_categories_for(transcript),
    }


@app.post("/audio-moderate")
def audio_moderate(req: AudioModerateRequest, authorization: str = Header(None)):
    """Transcribes a video's audio track and runs it through the same
    toxicity + drug/weapon-sale-language checks /toxicity and
    /text-categories run on post text. Call this alongside /classify
    and /categories for video uploads — see api/moderate-media.js."""
    if authorization != f"Bearer {SHARED_SECRET}":
        raise HTTPException(status_code=401, detail="unauthorized")

    with tempfile.TemporaryDirectory() as tmp:
        local_path = os.path.join(tmp, "input")
        resp = requests.get(req.url, timeout=30)
        resp.raise_for_status()
        with open(local_path, "wb") as f:
            f.write(resp.content)

        return transcribe_and_moderate(local_path)


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
    /toxicity endpoint and the audio-transcript pipeline below, so
    someone can't say in a video's audio what would get their post
    text blocked."""
    if not text.strip():
        return 0.0
    results = toxicity_classifier(text[:512])  # model's max useful input length
    # unitary/toxic-bert returns multiple labels (toxic, severe_toxic, obscene,
    # threat, insult, identity_hate) each with their own score — take the max,
    # same "worst attribute wins" approach Perspective used.
    scores = [r["score"] for r in results[0] if r["label"] != "non_toxic"] if results else [0.0]
    return round(float(max(scores)), 4)


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

