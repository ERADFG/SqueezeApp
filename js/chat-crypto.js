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
