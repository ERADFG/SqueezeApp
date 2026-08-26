// ─────────────────────────────────────────────────────────────
// CHAT E2E ENCRYPTION — ECDH (P-256) key agreement + AES-GCM.
//
// Each browser generates its own ECDH keypair the first time it opens
// a chat thread. The private key never leaves the browser (kept in
// localStorage); the public key is pushed to profiles.pubkey so other
// users can derive a shared secret with it. Two users' shared AES key
// is derived independently on each side via ECDH — it's never sent
// over the network or stored anywhere — so message bodies are
// ciphertext the moment they leave the browser, and Supabase (or
// anyone with DB access) only ever sees encrypted text.
//
// CAVEAT (worth knowing, not hiding): by default the private key still
// lives only in whichever browser first generated it — opening the
// same account somewhere new generates a fresh, unrelated keypair. The
// MULTI-DEVICE KEY BACKUP section below fixes this: Settings → Privacy
// → "Set up chat backup" wraps the existing private key with a
// passphrase and stores it on profiles.key_backup, so a new device can
// restore the exact same key (and therefore read old threads) instead
// of starting from scratch. It's opt-in rather than automatic, since
// it requires the person to choose and remember a passphrase.
// ─────────────────────────────────────────────────────────────

const CHAT_PRIV_KEY_LS = 'oc-e2e-priv';
const CHAT_PUB_KEY_LS = 'oc-e2e-pub';

let _myKeypairPromise = null;

function _b64FromBuf(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function _bufFromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── MULTI-DEVICE KEY BACKUP ──
// Fixes the "can't decrypt this message on this device" problem: since
// every browser used to generate its own throwaway ECDH keypair, opening
// the same account somewhere new made all old threads permanently
// unreadable there (the shared AES key is derived from the *private*
// key, so a different private key = a different, useless shared key).
//
// This wraps the *same* private key JWK with a passphrase-derived
// AES-GCM key (PBKDF2, 250k iterations, random salt) and stores the
// wrapped blob on profiles.key_backup. A new device can then pull that
// blob down, ask for the passphrase, unwrap it, and end up with the
// exact same private key the original device had — so every old
// conversation decrypts correctly again. Nothing here changes how
// messages themselves are encrypted; it only lets the private key
// follow the user instead of being stranded in one browser's
// localStorage. Entirely best-effort/non-blocking: any failure here
// just leaves things at the old single-device behavior.
async function _deriveWrapKey(passphrase, saltBytes) {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: 250000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function wrapPrivateKeyBackup(privJwk, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapKey = await _deriveWrapKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, new TextEncoder().encode(JSON.stringify(privJwk)));
  return JSON.stringify({ v: 1, salt: _b64FromBuf(salt), iv: _b64FromBuf(iv), ct: _b64FromBuf(ct) });
}

// Returns the original privJwk, or throws (wrong passphrase / corrupt
// backup) — callers should catch and show a friendly retry prompt.
async function unwrapPrivateKeyBackup(backupStr, passphrase) {
  const backup = JSON.parse(backupStr);
  const salt = _bufFromB64(backup.salt);
  const iv = _bufFromB64(backup.iv);
  const wrapKey = await _deriveWrapKey(passphrase, salt);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrapKey, _bufFromB64(backup.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// Prompts for a passphrase (up to `tries` attempts) and tries to
// restore the backed-up private key into localStorage on this device.
// Returns true on success, false if the person cancels or every
// attempt fails.
async function restoreKeyBackup(backupStr, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const label = i === 0
      ? 'Enter your chat passphrase to unlock your old messages on this device.'
      : 'That passphrase didn\'t work. Try again (or press Cancel to skip for now).';
    const pass = window.prompt(label);
    if (pass === null) return false; // cancelled
    if (!pass) continue;
    try {
      const privJwk = await unwrapPrivateKeyBackup(backupStr, pass);
      // An EC private JWK already carries the public x/y coordinates
      // alongside the private 'd' — so the matching public JWK is just
      // this same object with 'd' (and the private-only key_ops)
      // removed, no separate derivation needed.
      const { d, key_ops, ...pubJwk } = privJwk;
      pubJwk.key_ops = [];
      // Validate the restored key actually imports before trusting it.
      await crypto.subtle.importKey('jwk', privJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
      return { privJwk, pubJwk };
    } catch (e) { /* wrong passphrase or corrupt blob — loop and retry */ }
  }
  return false;
}

// Called from Settings → Privacy → "Set up chat backup". Wraps THIS
// device's existing private key with a passphrase and uploads it, so
// any other device that later signs into this account can restore the
// exact same key (see restoreKeyBackup above) instead of generating an
// incompatible new one. Safe to run again later (e.g. from a device
// that was itself restored) — it just re-wraps and overwrites.
async function setupChatKeyBackup() {
  const statusEl = document.getElementById('chat-backup-st');
  const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };
  if (!chatCryptoSupported()) { setStatus('Not supported in this browser.'); return; }
  // Reuses the already-resolved shared session instead of calling
  // sb.auth.getSession() again — see the note in ensureLikesLoaded()
  // (js/common.js). This is a button click well after page load, so
  // currentSession is reliable.
  const session = currentSession;
  if (!session) { setStatus('Log in first.'); return; }

  let privJwk;
  try { privJwk = JSON.parse(localStorage.getItem(CHAT_PRIV_KEY_LS) || 'null'); } catch (e) {}
  if (!privJwk) {
    // No key on this device to back up yet — create one first the
    // normal way, then continue.
    await ensureMyKeypair(session.user.id);
    try { privJwk = JSON.parse(localStorage.getItem(CHAT_PRIV_KEY_LS) || 'null'); } catch (e) {}
  }
  if (!privJwk) { setStatus('Could not read your chat key on this device.'); return; }

  // Guard against overwriting a real backup with a throwaway key: if
  // the server already has a backup AND this device never restored it
  // this session (i.e. resolveChatIdentity() didn't just pull it down
  // — checked via the same session flag it sets), the local key here
  // is very likely a fresh, never-backed-up device key rather than the
  // account's real one. Overwriting the backup with it would orphan
  // every other device permanently. Confirm explicitly in that case.
  let sessionRestored = false;
  try { sessionRestored = !!sessionStorage.getItem(CHAT_RESTORE_PROMPTED_SS); } catch (e) {}
  const existingBackup = await chatBackupExists(session.user.id);
  if (existingBackup && !sessionRestored) {
    const proceed = window.confirm(
      'This account already has a chat backup saved, but this device hasn\'t restored it. ' +
      'Setting up a new backup now will REPLACE it, and any device using the old one will ' +
      'permanently lose access to older messages.\n\nIf you just want to unlock old messages ' +
      'here, cancel and use "Restore chat backup" instead. Continue anyway?'
    );
    if (!proceed) { setStatus('Cancelled — try "Restore chat backup" instead.'); return; }
  }

  const pass = window.prompt('Choose a chat backup passphrase. You\'ll enter this on any new device to unlock your old messages there. Keep it somewhere safe — it can\'t be recovered if you lose it.');
  if (!pass) { setStatus('Cancelled.'); return; }
  const confirmPass = window.prompt('Enter the same passphrase again to confirm.');
  if (pass !== confirmPass) { setStatus('Passphrases didn\'t match — nothing was saved. Try again.'); return; }

  setStatus('Saving…');
  try {
    const backup = await wrapPrivateKeyBackup(privJwk, pass);
    const { error } = await sb.from('profiles').update({ key_backup: backup }).eq('id', session.user.id);
    if (error) throw error;
    setStatus('Chat backup is set up. Use this same passphrase on any new device.');
  } catch (e) {
    setStatus('Could not save backup — try again later.');
  }
}

// Called from Settings → Privacy → "Restore chat backup". Explicit,
// on-demand version of the restore flow — only runs when the person
// taps the button, never automatically on page load.
async function restoreChatBackupNow() {
  const statusEl = document.getElementById('chat-backup-st');
  const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };
  if (!chatCryptoSupported()) { setStatus('Not supported in this browser.'); return; }
  // Reuses the already-resolved shared session — see the note in
  // setupChatKeyBackup() above.
  const session = currentSession;
  if (!session) { setStatus('Log in first.'); return; }

  setStatus('Checking for a backup…');
  let backupStr;
  try {
    const { data } = await sb.from('profiles').select('key_backup').eq('id', session.user.id).maybeSingle();
    backupStr = data?.key_backup;
  } catch (e) {}
  if (!backupStr) { setStatus('No chat backup found for this account yet.'); return; }

  const restored = await restoreKeyBackup(backupStr);
  if (!restored) { setStatus('Cancelled, or passphrase didn\'t work.'); return; }
  try {
    localStorage.setItem(CHAT_PRIV_KEY_LS, JSON.stringify(restored.privJwk));
    localStorage.setItem(CHAT_PUB_KEY_LS, JSON.stringify(restored.pubJwk));
  } catch (e) {}
  _myKeypairPromise = null; // drop the cached (freshly-generated) keypair so the restored one is used from here on
  setStatus('Restored — reload the page and your old chats should decrypt.');
}

function chatCryptoSupported() {
  return !!(window.crypto && window.crypto.subtle);
}

const CHAT_RESTORE_PROMPTED_SS = 'oc-e2e-restore-prompted';

// ── THE FIX FOR "CAN'T DECRYPT" DATA LOSS ──
// Root cause: ensureMyKeypair() used to generate AND PUBLISH a brand
// new keypair the instant a device had no local key — even if this
// account already had a real backup on the server. That created a
// race: for however many seconds it took the person to find Settings
// → "Restore chat backup", their profile's public key was a throwaway
// one, so anything sent to them in that window got encrypted to a key
// that's now gone forever (never backed up). Worse, hitting "Set up
// chat backup" on such a device would wrap that throwaway key and
// silently overwrite the real backup, orphaning it too.
//
// resolveChatIdentity() closes that race: called once, before
// ensureMyKeypair(), it checks the SERVER for an existing backup
// first. If one exists, it prompts to restore right then — no new
// key is generated or published until that's resolved (or explicitly
// skipped). Only when there's genuinely nothing to restore does it
// fall through to ensureMyKeypair()'s normal fresh-key path.
//
// Prompts at most once per browser tab session (sessionStorage, not
// localStorage) so it doesn't nag on every navigation within one visit.
async function resolveChatIdentity(myUserId) {
  if (!chatCryptoSupported() || !myUserId) return;
  let hasLocalKey = false;
  try { hasLocalKey = !!(localStorage.getItem(CHAT_PRIV_KEY_LS) && localStorage.getItem(CHAT_PUB_KEY_LS)); } catch (e) {}
  if (hasLocalKey) return; // normal device, nothing to resolve

  try { if (sessionStorage.getItem(CHAT_RESTORE_PROMPTED_SS)) return; } catch (e) {}

  let backupStr = null;
  try {
    const { data } = await sb.from('profiles').select('key_backup').eq('id', myUserId).maybeSingle();
    backupStr = data?.key_backup || null;
  } catch (e) {}
  if (!backupStr) return; // nothing to restore — safe for ensureMyKeypair() to generate a fresh key

  try { sessionStorage.setItem(CHAT_RESTORE_PROMPTED_SS, '1'); } catch (e) {}
  const restored = await restoreKeyBackup(backupStr);
  if (restored) {
    try {
      localStorage.setItem(CHAT_PRIV_KEY_LS, JSON.stringify(restored.privJwk));
      localStorage.setItem(CHAT_PUB_KEY_LS, JSON.stringify(restored.pubJwk));
    } catch (e) {}
  }
  // If the person cancels or every attempt fails, we fall through and
  // ensureMyKeypair() generates a fresh device key — but now that's a
  // conscious "start fresh here" outcome reached only after being
  // offered the real key, not a silent race won by default.
}

// Cheap, non-prompting check for whether this ACCOUNT has a chat
// backup saved anywhere (not specific to this device). Never prompts
// or restores anything itself — just lets a caller decide what to
// show ("tap to unlock" vs "set up backup") before the person acts.
async function chatBackupExists(myUserId) {
  if (!myUserId) return false;
  try {
    const { data } = await sb.from('profiles').select('key_backup').eq('id', myUserId).maybeSingle();
    return !!data?.key_backup;
  } catch (e) { return false; }
}

// Generates (once per browser) or loads this browser's ECDH keypair,
// and makes sure the public half is on this user's profile row so
// the other side of any conversation can find it. Safe to call
// repeatedly — cached in-memory after the first call per page load.
function ensureMyKeypair(myUserId) {
  if (_myKeypairPromise) return _myKeypairPromise;
  _myKeypairPromise = (async () => {
    if (!chatCryptoSupported()) return null;
    let privJwk, pubJwk;
    try {
      const storedPriv = localStorage.getItem(CHAT_PRIV_KEY_LS);
      const storedPub = localStorage.getItem(CHAT_PUB_KEY_LS);
      if (storedPriv && storedPub) { privJwk = JSON.parse(storedPriv); pubJwk = JSON.parse(storedPub); }
    } catch (e) {}

    // NOTE: restoring a passphrase-backed-up key is intentionally NOT
    // automatic here — it used to prompt on every single page load
    // whenever this device had no local key yet, which interrupted
    // normal chat use with an unwanted popup. Restoring now only
    // happens when the person explicitly asks for it (Settings →
    // Privacy → "Restore chat backup", see restoreChatBackupNow()
    // below) or from the in-thread "unlock old messages" prompt.
    // Until then this device just gets its own fresh keypair, exactly
    // like before the backup feature existed — new messages send and
    // receive normally either way.

    if (!privJwk || !pubJwk) {
      const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
      privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
      pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
      try {
        localStorage.setItem(CHAT_PRIV_KEY_LS, JSON.stringify(privJwk));
        localStorage.setItem(CHAT_PUB_KEY_LS, JSON.stringify(pubJwk));
      } catch (e) {}
    }

    const privateKey = await crypto.subtle.importKey(
      'jwk', privJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']
    );

    // Push the public key to the profile if it's missing/out of date.
    // Cheap best-effort — failures here just mean this device's msgs
    // stay unencrypted until it succeeds on a later page load.
    if (myUserId) {
      const pubStr = JSON.stringify(pubJwk);
      try {
        const { data } = await sb.from('profiles').select('pubkey').eq('id', myUserId).maybeSingle();
        if (!data || data.pubkey !== pubStr) {
          await sb.from('profiles').update({ pubkey: pubStr }).eq('id', myUserId);
        }
        if (typeof currentProfile !== 'undefined' && currentProfile) currentProfile.pubkey = pubStr;
      } catch (e) {}
    }

    return { privateKey, pubJwk };
  })();
  return _myKeypairPromise;
}

// Derives the shared AES-GCM key for a conversation with `theirPubkeyStr`
// (the JSON-stringified JWK from the other profile's pubkey column).
// Returns null if either side doesn't have usable key material yet —
// callers fall back to sending/rendering plaintext in that case.
async function deriveChatKey(myUserId, theirPubkeyStr) {
  if (!chatCryptoSupported() || !theirPubkeyStr) return null;
  try {
    const me = await ensureMyKeypair(myUserId);
    if (!me) return null;
    const theirJwk = JSON.parse(theirPubkeyStr);
    const theirKey = await crypto.subtle.importKey(
      'jwk', theirJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
    return await crypto.subtle.deriveKey(
      { name: 'ECDH', public: theirKey },
      me.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  } catch (e) { return null; }
}

async function chatEncrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { body: _b64FromBuf(ct), iv: _b64FromBuf(iv) };
}

// Returns null (rather than throwing) on failure, so callers can fall
// back to a "couldn't decrypt" placeholder instead of breaking the
// whole thread render.
async function chatDecrypt(key, bodyB64, ivB64) {
  if (!key || !ivB64) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: _bufFromB64(ivB64) }, key, _bufFromB64(bodyB64)
    );
    return new TextDecoder().decode(pt);
  } catch (e) { return null; }
}
