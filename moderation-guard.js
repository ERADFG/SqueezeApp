/**
 * moderation-guard.js
 * -----------------------------------------------------------------------
 * Wired specifically for interactink.html's actual form structure:
 *   - threadForm / threadContent / threadSubmitBtn / threadHoneypot (new posts)
 *   - commentForm / commentInput / commentSubmitBtn (replies)
 *
 * This runs BEFORE interactink.html's own submit handlers (which post
 * straight to Supabase), using a document-level capture listener — that's
 * the only reliable way to guarantee we check content before it's already
 * been sent, since both scripts listen for the same 'submit' event.
 *
 * This does NOT replace or touch the existing runModerationCheck() /
 * Sightengine / Thorn Safer pipeline for media — that's the correct,
 * legitimate system for NSFW/CSAM on uploaded images and video and should
 * stay exactly as is. This script only adds a fast pre-check for TEXT
 * content (doxxing, dangerous links, spam patterns, text-based NSFW/illegal
 * keywords) — the part your own code currently posts unscanned.
 * -----------------------------------------------------------------------
 */

import { checkTextContent, checkForDoxxing, checkLinksInText, SpamBotDetector } from './contentModeration.js';

const spamDetector = new SpamBotDetector();
spamDetector.attachListeners();

// Maps each form's id to where to find its text and (optional) honeypot field.
const FORM_CONFIG = {
  threadForm: { textFieldId: 'threadContent', honeypotId: 'threadHoneypot', submitBtnId: 'threadSubmitBtn' },
  commentForm: { textFieldId: 'commentInput', honeypotId: null, submitBtnId: 'commentSubmitBtn' },
};

document.addEventListener('submit', async (event) => {
  const form = event.target;
  const config = FORM_CONFIG[form.id];
  if (!config) return; // not one of our forms — ignore

  // Already checked and cleared this exact submission? Let it through so
  // we don't loop forever (see the re-dispatch at the bottom).
  if (form.dataset.moderationPassed === 'true') {
    delete form.dataset.moderationPassed;
    return;
  }

  // Stop this submission from reaching interactink.html's own handler
  // (and from actually submitting) until we've checked it.
  event.preventDefault();
  event.stopImmediatePropagation();

  const textField = document.getElementById(config.textFieldId);
  const text = textField ? textField.value.trim() : '';
  const honeypotValue = config.honeypotId
    ? document.getElementById(config.honeypotId)?.value
    : undefined;

  const submitBtn = document.getElementById(config.submitBtnId);
  const originalLabel = submitBtn?.textContent;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Checking...';
  }

  try {
    const textResult = checkTextContent(text);
    const doxxingResult = checkForDoxxing(text);
    const linkResults = checkLinksInText(text);
    const spamResult = spamDetector.evaluate({ honeypotValue, text });

    const unsafeLinks = linkResults.filter((l) => !l.safe);
    const reasons = [];
    if (textResult.score > 0) reasons.push(`Flagged content: ${Object.keys(textResult.hits).join(', ')}`);
    if (!doxxingResult.safe) reasons.push(`Possible personal info detected: ${Object.keys(doxxingResult.findings).join(', ')}`);
    if (unsafeLinks.length) reasons.push(`Unsafe link detected: ${unsafeLinks[0].reasons.join(', ')}`);
    if (spamResult.action === 'block') reasons.push('Automated/spam behavior detected');

    const shouldBlock =
      textResult.score >= 4 ||
      !doxxingResult.safe ||
      unsafeLinks.length > 0 ||
      spamResult.action === 'block';

    if (shouldBlock) {
      alert('This post can\'t be submitted:\n\n' + reasons.join('\n') + '\n\nPlease edit your message and try again.');
      return; // stop — do not let it through
    }

    // Passed our checks — let it proceed to interactink.html's own handler
    // (which does the real Supabase insert + media moderation).
    form.dataset.moderationPassed = 'true';
    form.requestSubmit ? form.requestSubmit(submitBtn) : form.submit();
  } catch (err) {
    console.error('[moderation-guard] Pre-check failed, letting post through:', err);
    form.dataset.moderationPassed = 'true';
    form.requestSubmit ? form.requestSubmit(submitBtn) : form.submit();
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  }
}, true); // capture: true — this is what guarantees we run before interactink.html's own listener