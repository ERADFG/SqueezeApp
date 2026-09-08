// js/audio-transcribe.js
//
// Client-side speech-to-text for video uploads, using a real open-source
// model (Xenova/whisper-tiny.en, a WebAssembly build of OpenAI's Whisper)
// via @xenova/transformers, entirely in-browser — no server round trip
// for the transcription step itself.
//
// WHY THIS MOVED CLIENT-SIDE: nsfw-service/main.py used to run
// server-side Whisper for this, but it was the single heaviest model
// loaded there for the narrowest payoff (only applies to a video's
// spoken audio track). Moving just the speech-to-text step to the
// browser cuts real server RAM. The transcript this produces is still
// sent to /api/moderate-media, which still runs it through the SAME
// server-side toxicity/category classifiers your text posts go
// through — the actual moderation DECISION never happens client-side.
//
// THE ONE HONEST TRADE-OFF: unlike the video frames (still fetched and
// scanned entirely server-side, untouched by this change), a
// technically adversarial user could open devtools and call
// submitGlobalCompose()-equivalent code with a blank/faked transcript,
// skipping detection of drug/weapon-sale language or harassment
// spoken (not shown) in a video's audio track specifically. This is a
// real, disclosed narrowing of coverage for that one channel — not a
// silent one. Everything else in the moderation pipeline (image NSFW,
// weapon/drug/violence in frames, CSAM hash-matching, text posts) is
// completely unaffected and still server-enforced.
//
// Model download is ~40MB on first use, cached by the browser
// afterward (IndexedDB, via transformers.js's built-in caching) — free,
// no API key, no per-request cost to you.

let _transcriberPromise = null;
function loadTranscriber() {
  if (!_transcriberPromise) {
    _transcriberPromise = import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2')
      .then(({ pipeline }) => pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en'));
  }
  return _transcriberPromise;
}

// Decodes a video File's audio track into the 16kHz mono Float32Array
// Whisper expects, using the Web Audio API (built into every modern
// browser, no extra library needed for this part).
async function decodeAudioFromVideoFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  // OfflineAudioContext lets us decode+resample without actually
  // playing audio out loud — decodeAudioData resamples to whatever
  // sample rate the context is created with.
  const tempCtx = new AudioContextCtor();
  let audioBuffer;
  try {
    audioBuffer = await tempCtx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    // No audio track, or an undecodable one — common for silent/
    // muted video posts, not an error.
    return null;
  } finally {
    tempCtx.close();
  }
  if (!audioBuffer || audioBuffer.length === 0) return null;

  const targetRate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * targetRate), targetRate);
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0); // mono Float32Array at 16kHz
}

// Cap on how much audio we'll transcribe from one video, in seconds —
// keeps a long video from tying up the tab for minutes. Moderation
// only needs to see the content, not process the whole runtime of
// anything absurdly long.
const MAX_AUDIO_SECONDS = 600;

// Public entry point. Returns '' (not an error) for silent/no-audio
// videos or if transcription fails for any reason — this is a
// best-effort enrichment of the moderation check, not something that
// should ever block a post from going through. Call this BEFORE
// checkMediaModeration() for video uploads and pass the result as the
// `transcript` field.
async function transcribeVideoForModeration(file) {
  try {
    const samples = await decodeAudioFromVideoFile(file);
    if (!samples || !samples.length) return '';
    const capped = samples.subarray(0, MAX_AUDIO_SECONDS * 16000);

    const transcriber = await loadTranscriber();
    const result = await transcriber(capped, { chunk_length_s: 30, stride_length_s: 5 });
    return (result?.text || '').trim();
  } catch (e) {
    console.warn('[audio-transcribe] client-side transcription failed, continuing without it', e);
    return '';
  }
}
