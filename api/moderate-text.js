// api/moderate-text.js
//
// POST { userId, contentType, text, contentRef }  ->  { decision, scores, flags }
//
// Free, layered text moderation, in the same style as verify-captcha.js:
// cheap checks run first (no API calls, no cost, instant), the self-hosted
// toxicity model only runs if the cheap checks don't already decide.
//
// decision is one of: 'allow' | 'soft_flag' | 'block' | 'human_review'
//
// Wire this in from js/common.js right after verifyHuman() passes and
// before the actual supabase insert for a post/reply/chat message/profile
// bio edit. See MODERATION_SETUP.md for the exact call.
//
// Env vars needed (Vercel dashboard -> Settings -> Environment Variables):
//   MODERATION_SERVICE_URL, MODERATION_SERVICE_TOKEN — your self-hosted
//   moderation server from nsfw-service/main.py (same deployment used for
//   NSFW detection covers toxicity too now — one server, two endpoints).

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ---------------------------------------------------------------
// Local profanity/slur wordlist — runs first, zero cost, catches the
// bulk of casual toxicity before you ever call an external API. Keep
// this list in data/badwords.txt, one term per line, lowercase.
// ---------------------------------------------------------------
let BADWORDS = [];
try {
  const raw = fs.readFileSync(path.join(process.cwd(), 'data', 'badwords.txt'), 'utf8');
  BADWORDS = raw.split('\n').map((w) => w.trim().toLowerCase()).filter(Boolean);
} catch {
  BADWORDS = [];
}

function localProfanityHit(text) {
  const lower = text.toLowerCase();
  return BADWORDS.some((w) => w.length > 2 && lower.includes(w));
}

// ---------------------------------------------------------------
// Doxxing / PII detection
// ---------------------------------------------------------------
const PII_PATTERNS = [
  { label: 'phone_number', pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  { label: 'email_leak', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { label: 'ssn_like', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: 'street_address', pattern: /\b\d{1,5}\s+([A-Za-z0-9.]+\s){1,4}(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct)\b/gi },
  { label: 'credit_card_like', pattern: /\b(?:\d[ -]*?){13,16}\b/g },
];

function detectDoxxing(text) {
  const hits = [];
  for (const { label, pattern } of PII_PATTERNS) {
    const matches = text.match(pattern);
    if (matches && matches.length) hits.push({ label, count: matches.length });
  }
  return hits;
}

// ---------------------------------------------------------------
// Spam heuristics
// ---------------------------------------------------------------
function spamScore(text) {
  let score = 0;
  const linkCount = (text.match(/https?:\/\//g) || []).length;
  if (linkCount >= 3) score += 0.4;
  if (/(.)\1{6,}/.test(text)) score += 0.2;
  const words = text.split(/\s+/);
  const upperRatio = words.filter((w) => w.length > 2 && w === w.toUpperCase()).length / Math.max(words.length, 1);
  if (upperRatio > 0.6) score += 0.2;
  if (/\b(dm me|free followers|crypto giveaway|click here now|guaranteed profit)\b/i.test(text)) score += 0.4;
  return Math.min(score, 1);
}

// ---------------------------------------------------------------
// Toxicity — self-hosted, open-source model (unitary/toxic-bert), the
// same server you're already running for NSFW detection. Free forever,
// no external account or key. (Google's Perspective API — the original
// plan for this — is shutting down entirely on Dec 31, 2026 with no
// migration path, so this avoids that dependency altogether.)
//
// Env vars needed: MODERATION_SERVICE_URL, MODERATION_SERVICE_TOKEN
// (same values as NSFW_SERVICE_URL/NSFW_SERVICE_TOKEN if it's the same
// deployed service, which it is by default — see nsfw-service/main.py).
// ---------------------------------------------------------------
async function toxicityScore(text) {
  const serviceUrl = process.env.MODERATION_SERVICE_URL;
  const token = process.env.MODERATION_SERVICE_TOKEN;
  if (!serviceUrl || !text.trim()) return 0;

  try {
    const res = await fetch(`${serviceUrl}/toxicity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return 0; // fail open on outage, don't block real users
    const data = await res.json();
    return data.toxicity_probability ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------
// Drug-sale / weapon-sale language — zero-shot text classification
// (see nsfw-service/main.py's /text-categories), scores the sentence
// in context instead of matching a fixed wordlist. Catches coded
// phrasing ("plug for that gas, dm for menu") a keyword filter misses
// entirely, since sellers rotate slang specifically to dodge those.
// ---------------------------------------------------------------
async function categoryScores(text) {
  const serviceUrl = process.env.MODERATION_SERVICE_URL;
  const token = process.env.MODERATION_SERVICE_TOKEN;
  if (!serviceUrl || !text.trim()) return [];

  try {
    const res = await fetch(`${serviceUrl}/text-categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.categories ?? [];
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid body' });
  }

  const { userId, contentType, text, contentRef } = body || {};
  if (!userId || !contentType || typeof text !== 'string') {
    return res.status(400).json({ error: 'userId, contentType and text are required' });
  }

  const doxHits = detectDoxxing(text);
  const spam = spamScore(text);
  const badword = localProfanityHit(text);
  // Only pay for a model call if the cheap checks haven't already
  // decided this is fine to skip further scrutiny — saves compute.
  const needsDeepCheck = badword || spam > 0.3 || text.length > 20;
  const [toxic, categories] = await Promise.all([
    needsDeepCheck ? toxicityScore(text) : Promise.resolve(0),
    needsDeepCheck ? categoryScores(text) : Promise.resolve([]),
  ]);
  const topCategory = categories[0] ?? null;

  let decision = 'allow';
  if (doxHits.length > 0) decision = 'human_review';
  else if (toxic >= 0.85 || spam >= 0.8 || (topCategory && topCategory.score >= 0.85)) decision = 'block';
  else if (badword || toxic >= 0.6 || spam >= 0.5 || (topCategory && topCategory.score >= 0.6)) decision = 'soft_flag';

  // Log every decision for the admin panel / audit trail. Uses the same
  // service-role pattern as your other SECURITY DEFINER RPCs.
  try {
    await supabase.rpc('log_moderation_event', {
      p_user_id: userId,
      p_content_type: contentType,
      p_content_ref: contentRef ?? null,
      p_excerpt: text.slice(0, 200),
      p_toxicity: toxic,
      p_spam: spam,
      p_doxxing_flags: doxHits,
      p_decision: decision,
      p_categories: categories,
    });
  } catch (e) {
    console.error('moderation log failed', e);
  }

  return res.status(200).json({ decision, scores: { toxic, spam, badword, categories }, doxHits });
}
