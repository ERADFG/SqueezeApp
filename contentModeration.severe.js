/**
 * contentModeration.severe.js
 * -----------------------------------------------------------------------
 * Add-on module for contentModeration.js. Adds:
 *   1. A SEVERE text category for explicit statements describing sexual
 *      violence against minors (the gap that let the screenshot post
 *      through — your existing TEXT_POLICY had no category for this).
 *   2. A quarantine/report pathway: severe hits don't just get blocked
 *      client-side, they get logged with enough detail for a human
 *      reviewer to decide on NCMEC reporting (see README).
 *
 * DESIGN NOTE: this deliberately does NOT try to enumerate slang, coded
 * terms, or euphemisms used to evade detection — a list like that is
 * itself a map for evasion, and keyword lists are a losing game against
 * motivated evasion anyway (see the "human review + reporting pipeline"
 * point in the README — that's the part that actually matters here).
 * What this DOES catch reliably: plain, unambiguous statements combining
 * a sexual-violence verb with a minor-referencing noun in the same
 * message — exactly the pattern in your screenshot. It's a floor, not
 * a ceiling. It will not catch obfuscated or coded content; nothing
 * keyword-based will. That's what the human-review queue is for.
 * -----------------------------------------------------------------------
 */

import { normalizeText, checkTextContent, TEXT_POLICY } from './contentModeration.js';

// Two small word lists, combined pairwise rather than as standalone
// "banned words" — this is what keeps the false-positive rate low
// (e.g. "child" alone or "abuse" alone won't trigger anything; only
// the co-occurrence of both categories in one message will).
const VIOLENCE_TERMS = [
  'rape', 'raping', 'raped',
  'molest', 'molesting', 'molested',
  'sexually abuse', 'sexually abusing', 'sexually assaulted',
  'have sex with', 'having sex with',
];

const MINOR_TERMS = [
  'kid', 'kids', 'child', 'children', 'children\'s',
  'minor', 'minors', 'toddler', 'infant', 'baby',
  'underage', 'preteen', 'pre-teen',
];

/**
 * Checks for explicit co-occurrence of a violence term and a minor
 * reference term anywhere in the (normalized) text. Intentionally
 * simple and high-precision — this is meant to reliably catch overt
 * statements, not to be a comprehensive detector.
 */
export function checkChildSafetySevere(rawText) {
  const normalized = normalizeText(rawText || '');
  const hitViolence = VIOLENCE_TERMS.filter((t) => normalized.includes(normalizeText(t)));
  const hitMinor = MINOR_TERMS.filter((t) => normalized.includes(normalizeText(t)));

  const triggered = hitViolence.length > 0 && hitMinor.length > 0;

  return {
    safe: !triggered,
    triggered,
    // Deliberately not returning which exact terms matched to the caller's
    // UI layer — this result should go straight to block+quarantine, not
    // be displayed back to the poster as a hint about what tripped it.
  };
}

/**
 * Full text check: your existing keyword policy PLUS the severe
 * child-safety check. Severe hits short-circuit to a 'quarantine'
 * action distinct from ordinary 'block', so your app can route it to
 * a review queue instead of just showing the poster a rejection.
 */
export function checkTextContentFull(rawText, extraPolicy = {}) {
  const base = checkTextContent(rawText, { ...TEXT_POLICY, ...extraPolicy });
  const severe = checkChildSafetySevere(rawText);

  if (severe.triggered) {
    return {
      ...base,
      safe: false,
      action: 'quarantine', // not just 'block' — see README for why
      severe: true,
    };
  }

  return {
    ...base,
    action: base.score >= 4 ? 'block' : base.score > 0 ? 'flag_for_review' : 'allow',
    severe: false,
  };
}
