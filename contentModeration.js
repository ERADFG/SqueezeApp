/**
 * contentModeration.js  (v2)
 * -----------------------------------------------------------------------
 * Fully client-side content moderation toolkit — no backend/API required.
 * Covers: NSFW in images/video AND in typed text, OCR'd text-in-images,
 * doxxing/PII, dangerous links, and spam/bot behavior — with a weighted
 * risk-scoring engine instead of simple pass/fail flags.
 *
 * SCOPE NOTE (unchanged from v1): this module does NOT and cannot detect
 * CSAM. That requires accredited hash-matching services (PhotoDNA, Thorn
 * Safer, Google CSAI Match) + mandatory NCMEC reporting. Don't DIY it.
 *
 * Dependencies:
 *   npm install nsfwjs @tensorflow/tfjs tesseract.js
 * -----------------------------------------------------------------------
 */

import * as tf from '@tensorflow/tfjs';
import * as nsfwjs from 'nsfwjs';
import Tesseract from 'tesseract.js';

// ============================================================
// 0. Text normalization — defeats common evasion tricks
// ============================================================
// Catches leetspeak, spacing/punctuation insertion, repeated letters,
// and Unicode look-alikes people use to sneak banned words past naive
// substring checks (e.g. "p0rn", "s.e.x", "druuugs", "ѕex" with Cyrillic s).

const LEET_MAP = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's',
  '7': 't', '@': 'a', '$': 's', '!': 'i', '+': 't',
};

// A handful of common Cyrillic/Greek look-alikes used for evasion.
const HOMOGLYPH_MAP = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', // Cyrillic
  'ѕ': 's', 'і': 'i',
};

export function normalizeText(input) {
  if (!input) return '';
  let text = input.toLowerCase();

  // Replace homoglyphs first
  text = text.replace(/./g, (ch) => HOMOGLYPH_MAP[ch] || ch);
  // Replace leetspeak substitutions
  text = text.replace(/[013457@$!+]/g, (ch) => LEET_MAP[ch] || ch);
  // Collapse separators inserted between letters: "p.o.r.n" / "p o r n" -> "porn"
  text = text.replace(/([a-z])[\s._\-*]+(?=[a-z])/g, '$1');
  // Collapse 3+ repeated letters: "porrrrn" -> "porn"
  text = text.replace(/([a-z])\1{2,}/g, '$1');

  return text;
}

// ============================================================
// 1. Typed-text content classification (NSFW / drugs / illegal)
// ============================================================
// Pure client-side keyword+pattern matching on normalized text. This is
// necessarily a blunter tool than an ML classifier, but it runs instantly,
// needs no model download, and catches evasion attempts via normalization.
//
// IMPORTANT: expand these lists to match your actual policy. Keep them in
// a separate config file in production so non-engineers can maintain them.

export const TEXT_POLICY = {
  sexualExplicit: {
    weight: 3,
    terms: ['porn', 'pornhub', 'xxx video', 'nude pics', 'sex tape', 'onlyfans link'],
  },
  drugs: {
    weight: 2,
    terms: ['heroin', 'fentanyl', 'meth', 'cocaine', 'mdma', 'buy weed', 'xanax bars for sale'],
  },
  illegalTransactions: {
    weight: 3,
    terms: ['stolen credit card', 'ssn for sale', 'fake id', 'counterfeit money', 'hacked account'],
  },
  weapons: {
    weight: 3,
    terms: ['buy gun no background check', 'untraceable firearm', 'homemade explosive'],
  },
};

/**
 * Scans free text (post body, comment, chat message, bio, OCR output)
 * against TEXT_POLICY. Returns per-category hits and a combined score.
 */
export function checkTextContent(rawText, extraPolicy = {}) {
  const normalized = normalizeText(rawText);
  const policy = { ...TEXT_POLICY, ...extraPolicy };
  const hits = {};
  let score = 0;

  for (const [category, { weight, terms }] of Object.entries(policy)) {
    const matched = terms.filter((t) => normalized.includes(normalizeText(t)));
    if (matched.length) {
      hits[category] = matched;
      score += matched.length * weight;
    }
  }

  return {
    safe: score === 0,
    score,
    hits,
  };
}

// ============================================================
// 2. NSFW / explicit image + video detection (in-browser ML)
// ============================================================

let nsfwModel = null;

export async function loadNSFWModel() {
  if (!nsfwModel) {
    nsfwModel = await nsfwjs.load('/nsfw-model/'); // self-host for zero third-party calls
  }
  return nsfwModel;
}

export async function checkImageNSFW(element, opts = {}) {
  const threshold = opts.threshold ?? 0.75;
  const model = await loadNSFWModel();
  const predictions = await model.classify(element);

  const flagged = predictions.filter(
    (p) => ['Porn', 'Hentai', 'Sexy'].includes(p.className) && p.probability >= threshold
  );

  // Confidence-weighted score instead of a flat boolean, so callers can
  // set their own "review vs. auto-block" thresholds.
  const maxRisk = Math.max(0, ...flagged.map((f) => f.probability));

  return {
    safe: flagged.length === 0,
    riskScore: maxRisk, // 0–1
    predictions,
    flaggedClasses: flagged.map((f) => f.className),
  };
}

export function fileToImageElement(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

export async function checkVideoNSFW(videoEl, { sampleEverySeconds = 2, threshold = 0.75 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext('2d');

  const duration = videoEl.duration;
  const results = [];

  for (let t = 0; t < duration; t += sampleEverySeconds) {
    await seekTo(videoEl, t);
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    const result = await checkImageNSFW(canvas, { threshold });
    results.push({ timestamp: t, ...result });
    if (!result.safe) break; // early-exit once flagged
  }

  return {
    safe: results.every((r) => r.safe),
    frames: results,
  };
}

function seekTo(videoEl, time) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      videoEl.removeEventListener('seeked', onSeeked);
      resolve();
    };
    videoEl.addEventListener('seeked', onSeeked);
    videoEl.currentTime = time;
  });
}

// ============================================================
// 3. OCR — text embedded in images/video frames
// ============================================================

export async function checkImageTextContent(imageSource, extraPolicy = {}) {
  const { data } = await Tesseract.recognize(imageSource, 'eng');
  const extractedText = data.text || '';
  const result = checkTextContent(extractedText, extraPolicy);
  return { ...result, extractedText };
}

// ============================================================
// 4. Doxxing / PII detection — smarter, fewer false positives
// ============================================================

/** Luhn checksum — filters out random 13–16 digit numbers that aren't
 * actually valid card numbers, a major source of false positives. */
function passesLuhn(numStr) {
  const digits = numStr.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

const PII_PATTERNS = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  creditCard: /\b(?:\d[ -]*?){13,19}\b/g, // validated further with Luhn below
  streetAddress: /\b\d{1,5}\s+([A-Za-z]+\s){1,3}(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr)\b/gi,
  ipAddress: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
};

export function checkForDoxxing(text) {
  const findings = {};

  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    const matches = text.match(pattern);
    if (!matches) continue;

    if (type === 'creditCard') {
      const valid = matches.filter(passesLuhn);
      if (valid.length) findings.creditCard = valid;
    } else {
      findings[type] = matches;
    }
  }

  return {
    safe: Object.keys(findings).length === 0,
    findings,
  };
}

// ============================================================
// 5. Dangerous / malicious link detection — with typosquat check
// ============================================================

const SUSPICIOUS_TLDS = ['.zip', '.mov', '.xyz', '.top', '.click', '.link', '.gq', '.tk'];
const URL_SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly'];
const KNOWN_BRAND_DOMAINS = ['paypal.com', 'apple.com', 'google.com', 'microsoft.com', 'amazon.com', 'bankofamerica.com'];

/** Simple Levenshtein distance — used to catch typosquatting like
 * "paypa1.com" or "arnazon.com" that are one edit away from a real brand. */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export function checkLinkSafety(url) {
  const reasons = [];
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reasons: ['Malformed URL'], riskScore: 1 };
  }

  const host = parsed.hostname.toLowerCase();

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) reasons.push('Uses raw IP address instead of domain');
  if (host.startsWith('xn--')) reasons.push('Punycode domain (possible homoglyph spoofing)');
  if (SUSPICIOUS_TLDS.some((tld) => host.endsWith(tld))) reasons.push('Suspicious top-level domain');
  if (URL_SHORTENERS.some((s) => host.includes(s))) reasons.push('URL shortener (destination obscured)');
  if (parsed.username || parsed.password) reasons.push('Contains embedded credentials (common phishing trick)');
  if (host.split('.').length > 4) reasons.push('Unusually deep subdomain chain');

  // Typosquat detection: is this host suspiciously close to a known brand
  // domain without actually being it?
  for (const brand of KNOWN_BRAND_DOMAINS) {
    if (host === brand) continue;
    const dist = levenshtein(host, brand);
    if (dist > 0 && dist <= 2) {
      reasons.push(`Possible typosquat of "${brand}"`);
      break;
    }
    // Brand name present as a substring but not the real domain
    const brandName = brand.split('.')[0];
    if (host.includes(brandName) && !host.endsWith(brand)) {
      reasons.push(`Possible impersonation of "${brandName}"`);
      break;
    }
  }

  return {
    safe: reasons.length === 0,
    riskScore: Math.min(1, reasons.length / 3),
    reasons,
    url,
  };
}

export function checkLinksInText(text) {
  const urls = text.match(/https?:\/\/[^\s]+/g) || [];
  return urls.map((u) => checkLinkSafety(u));
}

// ============================================================
// 6. Spam / bot behavior detection — persistent + weighted
// ============================================================
// Adds lightweight cross-session tracking via localStorage (best-effort
// only — clearing storage or private browsing bypasses it, which is a
// known limitation of any purely client-side approach).

function getClientId() {
  const KEY = 'cm_client_id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

export class SpamBotDetector {
  constructor() {
    this.formLoadTime = Date.now();
    this.mouseMovements = 0;
    this.keystrokes = 0;
    this.clientId = typeof window !== 'undefined' ? getClientId() : null;
  }

  attachListeners(root = document) {
    root.addEventListener('mousemove', () => this.mouseMovements++);
    root.addEventListener('keydown', () => this.keystrokes++);
  }

  _getHistory() {
    try {
      return JSON.parse(localStorage.getItem(`cm_history_${this.clientId}`) || '[]');
    } catch {
      return [];
    }
  }

  _saveHistory(history) {
    localStorage.setItem(`cm_history_${this.clientId}`, JSON.stringify(history));
  }

  /**
   * @param {{ honeypotValue?: string, text?: string }} input
   * Returns a weighted score (0+) instead of a flat boolean, plus a
   * suggested action so you can tune sensitivity per use case.
   */
  evaluate({ honeypotValue, text }) {
    const signals = [];
    let score = 0;
    const timeToSubmit = (Date.now() - this.formLoadTime) / 1000;

    if (honeypotValue) { signals.push('Honeypot field filled'); score += 5; }
    if (timeToSubmit < 2) { signals.push('Submitted implausibly fast'); score += 3; }
    if (this.mouseMovements === 0 && this.keystrokes < 3) { signals.push('No human-like interaction'); score += 2; }

    // Cross-session flood detection (persisted, best-effort)
    const now = Date.now();
    const history = this._getHistory().filter((t) => now - t < 5 * 60_000); // 5 min window
    history.push(now);
    this._saveHistory(history);
    if (history.length > 8) { signals.push('Excessive submissions across recent sessions'); score += 4; }
    else if (history.length > 4) { signals.push('Elevated submission frequency'); score += 2; }

    if (text) {
      const linkCount = (text.match(/https?:\/\//g) || []).length;
      if (linkCount >= 3) { signals.push('High link density'); score += 2; }
      if (/(.)\1{7,}/.test(text)) { signals.push('Repeated-character spam pattern'); score += 1; }
      if (text.length > 15 && text === text.toUpperCase()) { signals.push('All-caps text'); score += 1; }

      // Near-duplicate detection against this client's recent posts
      const recentTexts = JSON.parse(localStorage.getItem(`cm_texts_${this.clientId}`) || '[]');
      if (recentTexts.includes(text.trim())) { signals.push('Exact duplicate of a recent post'); score += 3; }
      recentTexts.push(text.trim());
      localStorage.setItem(`cm_texts_${this.clientId}`, JSON.stringify(recentTexts.slice(-10)));
    }

    return {
      likelySpamOrBot: score >= 4,
      score,
      signals,
      action: score >= 8 ? 'block' : score >= 4 ? 'flag_for_review' : 'allow',
    };
  }
}

// ============================================================
// 7. Orchestrator — combined, weighted risk score across everything
// ============================================================

const RISK_THRESHOLDS = {
  block: 8,   // auto-reject
  review: 3,  // hold for human review
};

/**
 * @param {{ text?: string, images?: HTMLImageElement[], video?: HTMLVideoElement,
 *           honeypotValue?: string, spamDetector?: SpamBotDetector }} post
 *
 * Returns not just approved/rejected, but a graded action:
 *   'allow' | 'flag_for_review' | 'block'
 * This is safer than a binary gate — border line content gets queued for
 * a human instead of being silently auto-published OR auto-deleted.
 */
export async function moderatePost(post) {
  const details = {};
  let totalRisk = 0;
  const reasons = [];

  if (post.text) {
    details.text = checkTextContent(post.text);
    details.doxxing = checkForDoxxing(post.text);
    details.links = checkLinksInText(post.text);

    totalRisk += details.text.score;
    if (details.text.score > 0) reasons.push(`Flagged text: ${Object.keys(details.text.hits).join(', ')}`);

    if (!details.doxxing.safe) { totalRisk += 3; reasons.push('PII/doxxing detected'); }

    const unsafeLinks = details.links.filter((l) => !l.safe);
    if (unsafeLinks.length) { totalRisk += unsafeLinks.length * 2; reasons.push('Unsafe link(s) detected'); }
  }

  if (post.images?.length) {
    details.images = await Promise.all(
      post.images.map(async (img) => ({
        nsfw: await checkImageNSFW(img),
        text: await checkImageTextContent(img),
      }))
    );
    for (const img of details.images) {
      if (!img.nsfw.safe) { totalRisk += Math.round(img.nsfw.riskScore * 5); reasons.push('NSFW image content'); }
      if (!img.text.safe) { totalRisk += img.text.score; reasons.push('Flagged text found in image (OCR)'); }
    }
  }

  if (post.video) {
    details.video = await checkVideoNSFW(post.video);
    if (!details.video.safe) { totalRisk += 5; reasons.push('Flagged video content'); }
  }

  if (post.spamDetector) {
    details.spam = post.spamDetector.evaluate({ honeypotValue: post.honeypotValue, text: post.text });
    totalRisk += details.spam.score;
    if (details.spam.likelySpamOrBot) reasons.push('Spam/bot behavior detected');
  }

  const action = totalRisk >= RISK_THRESHOLDS.block
    ? 'block'
    : totalRisk >= RISK_THRESHOLDS.review
      ? 'flag_for_review'
      : 'allow';

  return {
    approved: action === 'allow',
    action,
    riskScore: totalRisk,
    reasons,
    details,
  };
}

// ============================================================
// 8. UPGRADE: real ML text classification (not just keywords)
// ============================================================
// Uses transformers.js to run a small quantized toxicity/NSFW-text model
// entirely in-browser (WASM/WebGPU). This catches paraphrased, obfuscated,
// or context-dependent harmful text that a keyword list will always miss —
// e.g. "let's meet up, I'll bring the stuff, cash only" has no banned
// words but a trained model can pick up the pattern.
//
// npm install @xenova/transformers

import { pipeline } from '@xenova/transformers';

let toxicityClassifier = null;

export async function loadTextClassifier() {
  if (!toxicityClassifier) {
    // Quantized model — a few MB, cached by the browser after first load.
    toxicityClassifier = await pipeline(
      'text-classification',
      'Xenova/toxic-bert' // multi-label: toxic, severe_toxic, obscene, threat, insult, identity_hate
    );
  }
  return toxicityClassifier;
}

/**
 * Runs the ML model on top of (not instead of) the keyword system.
 * Keyword hits are cheap and catch the obvious cases instantly; the model
 * catches what's paraphrased or contextual. Combining both is more robust
 * than either alone.
 */
export async function checkTextContentAdvanced(rawText, extraPolicy = {}) {
  const keywordResult = checkTextContent(rawText, extraPolicy);

  const classifier = await loadTextClassifier();
  const mlResults = await classifier(rawText, { topk: null });
  // mlResults: [{ label: 'toxic', score: 0.92 }, ...]

  const mlFlags = mlResults.filter((r) => r.score >= 0.7);
  const mlScore = mlFlags.reduce((sum, f) => sum + f.score * 3, 0);

  return {
    safe: keywordResult.score === 0 && mlFlags.length === 0,
    score: keywordResult.score + mlScore,
    keywordHits: keywordResult.hits,
    mlFlags: mlFlags.map((f) => ({ label: f.label, confidence: f.score })),
  };
}

// ============================================================
// 9. UPGRADE: perceptual hashing for known-bad images
// ============================================================
// NSFWJS re-evaluates every image from scratch, which is slow and can miss
// edited re-uploads of content you've already identified as violating.
// A perceptual hash (aHash) is a compact fingerprint that stays similar
// even after resizing/cropping/light edits — pair it with a blocklist of
// hashes you maintain (e.g. images already removed) for instant matching.

/** Computes a 64-bit average hash for an image, as a hex string. */
export function computeImageHash(imageElement) {
  const size = 8;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imageElement, 0, 0, size, size);

  const { data } = ctx.getImageData(0, 0, size, size);
  const grays = [];
  for (let i = 0; i < data.length; i += 4) {
    grays.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  const avg = grays.reduce((a, b) => a + b, 0) / grays.length;

  let hash = '';
  let byte = 0;
  grays.forEach((g, i) => {
    byte = (byte << 1) | (g >= avg ? 1 : 0);
    if (i % 8 === 7) {
      hash += byte.toString(16).padStart(2, '0');
      byte = 0;
    }
  });
  return hash;
}

/** Hamming distance between two equal-length hex hashes — lower = more similar. */
function hammingDistance(hashA, hashB) {
  let distance = 0;
  for (let i = 0; i < hashA.length; i++) {
    const diff = parseInt(hashA[i], 16) ^ parseInt(hashB[i], 16);
    distance += diff.toString(2).split('1').length - 1;
  }
  return distance;
}

/**
 * Checks an image's perceptual hash against a blocklist you maintain
 * (e.g. hashes of content already removed for policy violations).
 * threshold: max hamming distance to count as a match (0 = exact, ~10 = loose).
 */
export function checkAgainstImageBlocklist(imageElement, blocklistHashes, threshold = 10) {
  const hash = computeImageHash(imageElement);
  const matches = blocklistHashes.filter((h) => hammingDistance(hash, h) <= threshold);
  return { matched: matches.length > 0, hash, matches };
}

// ============================================================
// 10. UPGRADE: proof-of-work friction against bots
// ============================================================
// Forces the browser to do a small amount of CPU work before submitting.
// Negligible delay for a real user (~100-300ms), but expensive at scale
// for bots firing thousands of automated submissions — a classic
// client-side-only anti-abuse technique (similar to what Anubis/Hashcash use).

export async function computeProofOfWork(challenge, difficulty = 4) {
  const target = '0'.repeat(difficulty);
  let nonce = 0;
  while (true) {
    const data = new TextEncoder().encode(challenge + nonce);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashHex = [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hashHex.startsWith(target)) return { nonce, hash: hashHex };
    nonce++;
  }
}

export async function verifyProofOfWork(challenge, nonce, difficulty = 4) {
  const data = new TextEncoder().encode(challenge + nonce);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashHex = [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hashHex.startsWith('0'.repeat(difficulty));
}

// ============================================================
// 11. Calibrated ensemble — combine every signal into one verdict
// ============================================================
// Instead of ad-hoc addition, this normalizes each subsystem's output to
// a 0–1 risk score and combines with configurable weights, so no single
// noisy signal (e.g. one keyword hit) can single-handedly cross a
// block threshold, while multiple weak signals together still can.

const ENSEMBLE_WEIGHTS = {
  text: 0.25,
  doxxing: 0.2,
  links: 0.2,
  images: 0.25,
  spam: 0.1,
};

export function combineRiskSignals(signals) {
  // signals: { text: 0-1, doxxing: 0-1, links: 0-1, images: 0-1, spam: 0-1 }
  let combined = 0;
  for (const [key, weight] of Object.entries(ENSEMBLE_WEIGHTS)) {
    combined += (signals[key] ?? 0) * weight;
  }
  return {
    combined, // 0-1
    action: combined >= 0.6 ? 'block' : combined >= 0.3 ? 'flag_for_review' : 'allow',
  };
}
