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
// CAVEAT (worth knowing, not hiding): the private key lives in this
// browser's localStorage only. Open the same account in a different
// browser/device and it generates a *new* keypair — old threads there
// show as "can't decrypt on this device" until that device has seen
// the same messages. Full multi-device sync would need a
// passphrase-wrapped key backup, which is a reasonable follow-up but
// isn't in this pass.
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

function chatCryptoSupported() {
  return !!(window.crypto && window.crypto.subtle);
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

// ─────────────────────────────────────────────────────────────
// MULTI-DEVICE KEY BACKUP.
//
// The CAVEAT above was the actual cause of "Can't decrypt this
// message on this device" showing up for real: opening the account
// on a second phone/browser generated a brand-new keypair instead of
// reusing the one earlier messages were encrypted for, so nothing
// old could ever decrypt there. This adds an opt-in, passphrase-
// protected backup of the private key on the profile row (still
// end-to-end: the passphrase never leaves the device, so InteractInk
// only ever stores an encrypted blob it can't open either) so a new
// device can restore the *same* key instead of minting a new one.
//
// Requires three new text columns on `profiles`:
//   key_backup, key_backup_iv, key_backup_salt
// (run once in Supabase SQL editor):
//   alter table profiles
//     add column if not exists key_backup text,
//     add column if not exists key_backup_iv text,
//     add column if not exists key_backup_salt text;
// ─────────────────────────────────────────────────────────────

const CHAT_BACKUP_DONE_LS = 'oc-e2e-backup-done';

async function _deriveWrapKey(passphrase, saltBytes) {
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: 150000, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// Encrypts this device's already-generated private key with a
// passphrase and saves it to the profile row. Call after a key
// exists locally (i.e. after ensureMyKeypair has run once).
async function backupChatKey(myUserId, passphrase) {
  const storedPriv = localStorage.getItem(CHAT_PRIV_KEY_LS);
  if (!storedPriv || !passphrase || !myUserId) return false;
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapKey = await _deriveWrapKey(passphrase, salt);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, new TextEncoder().encode(storedPriv));
    const { error } = await sb.from('profiles').update({
      key_backup: _b64FromBuf(ct), key_backup_iv: _b64FromBuf(iv), key_backup_salt: _b64FromBuf(salt)
    }).eq('id', myUserId);
    if (error) return false;
    try { localStorage.setItem(CHAT_BACKUP_DONE_LS, '1'); } catch (e) {}
    return true;
  } catch (e) { return false; }
}

// Checks whether a backup exists on the profile (without needing the
// passphrase yet) so the caller knows whether to offer "restore" or
// "set up backup" before deciding to mint a fresh key.
async function chatKeyBackupExists(myUserId) {
  try {
    const { data } = await sb.from('profiles').select('key_backup').eq('id', myUserId).maybeSingle();
    return !!(data && data.key_backup);
  } catch (e) { return false; }
}

// Attempts to recover this account's real private key from the
// server-side backup using a passphrase, and — on success — installs
// it into localStorage so ensureMyKeypair() picks it up as normal on
// its next call. Returns false on wrong passphrase / no backup /
// any failure, never throws.
async function restoreChatKeyFromBackup(myUserId, passphrase) {
  if (!myUserId || !passphrase) return false;
  try {
    const { data } = await sb.from('profiles')
      .select('key_backup,key_backup_iv,key_backup_salt').eq('id', myUserId).maybeSingle();
    if (!data || !data.key_backup) return false;
    const wrapKey = await _deriveWrapKey(passphrase, _bufFromB64(data.key_backup_salt));
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: _bufFromB64(data.key_backup_iv) }, wrapKey, _bufFromB64(data.key_backup)
    );
    const privJson = new TextDecoder().decode(pt);
    const privJwk = JSON.parse(privJson); // wrong passphrase decrypts to garbage/throws before we get here
    if (!privJwk || privJwk.kty !== 'EC') return false;
    // The public half (x/y) is embedded in the EC private JWK, so the
    // public JWK for localStorage is just the private one minus `d`.
    const pubJwk = { ...privJwk }; delete pubJwk.d; pubJwk.key_ops = [];
    localStorage.setItem(CHAT_PRIV_KEY_LS, privJson);
    localStorage.setItem(CHAT_PUB_KEY_LS, JSON.stringify(pubJwk));
    try { localStorage.setItem(CHAT_BACKUP_DONE_LS, '1'); } catch (e) {}
    _myKeypairPromise = null; // drop the cached (wrong) in-memory keypair so the next ensureMyKeypair() re-reads localStorage
    return true;
  } catch (e) { return false; }
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
