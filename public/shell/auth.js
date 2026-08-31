// Pre-auth shell script (section 13.1). Performs the WebAuthn ceremony against /auth/*
// and, on success, dynamically imports the gated app bundle from /app/, which the Worker
// only serves once a session token exists (section 13.2). Nothing tile-related is
// reachable from this file before that point.
//
// Registration necessarily generates and wraps a fresh DEK *before* any session exists
// (the wrapped DEK has to travel in the same request that proves the passkey — section
// 2.3), so the handful of WebCrypto calls below duplicate src/app/crypto/keys.ts rather
// than importing it: importing gated code into the public pre-auth bundle would defeat the
// point of the gate. Keep the PRF salt and HKDF params here in sync with that file.

const statusEl = document.getElementById("status");
const unlockBtn = document.getElementById("unlock");
const setupBtn = document.getElementById("setup");

unlockBtn.addEventListener("click", () => void unlock());
setupBtn.addEventListener("click", () => void setup());

async function unlock() {
  statusEl.textContent = "Waiting for Face ID…";
  try {
    const optionsRes = await fetch("/auth/login/start", { method: "POST", credentials: "include" });
    if (!optionsRes.ok) throw new Error("could not start login");
    const options = await optionsRes.json();

    const publicKey = {
      ...options,
      challenge: base64UrlToBuffer(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map((c) => ({
        ...c,
        id: base64UrlToBuffer(c.id),
      })),
      // Set here, never taken from the response: the salt has to reach the authenticator as
      // real bytes (it can't survive JSON), and it decides which master key gets derived, so
      // the client owns it rather than trusting the server to name it (section 2.2).
      extensions: { prf: { eval: { first: PRF_SALT } } },
    };

    const assertion = await navigator.credentials.get({ publicKey });
    if (!assertion) throw new Error("cancelled");

    const extResults = assertion.getClientExtensionResults();
    const prfOutput = extResults.prf?.results?.first;
    if (!prfOutput) throw new Error("this passkey/browser didn't return a PRF result");

    const finishRes = await fetch("/auth/login/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(serializeAssertion(assertion)),
      credentials: "include",
    });
    if (!finishRes.ok) throw new Error("verification failed");
    const { wrappedDek } = await finishRes.json();

    const masterKey = await deriveMasterKeyFromPrf(prfOutput);
    const { iv, ciphertext } = splitIvAndCiphertext(base64UrlToBuffer(wrappedDek));
    const dek = await unwrapDek(ciphertext, iv, masterKey);

    statusEl.textContent = "Unlocked — loading…";
    const app = await import("/app/main.js");
    await app.start({ dek });
  } catch (err) {
    statusEl.textContent = "Unlock failed — try again";
    console.error(err);
  }
}

async function setup() {
  statusEl.textContent = "Setting up your passkey…";
  try {
    const startRes = await fetch("/auth/register/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userName: "onedash" }),
      credentials: "include",
    });
    if (!startRes.ok) {
      throw new Error(startRes.status === 403 ? "an account already exists on this server" : "could not start setup");
    }
    const options = await startRes.json();

    const publicKey = {
      ...options,
      challenge: base64UrlToBuffer(options.challenge),
      user: { ...options.user, id: base64UrlToBuffer(options.user.id) },
      excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({
        ...c,
        id: base64UrlToBuffer(c.id),
      })),
    };

    const credential = await navigator.credentials.create({ publicKey });
    if (!credential) throw new Error("cancelled");

    // Not every authenticator returns the PRF *output* from create() even when it reports
    // `prf.enabled`, so do a follow-up get() against the credential we just made to obtain
    // it — the same pattern src/app/crypto/keys.ts's deriveMasterKey() uses for login.
    const prfOutput = await getPrfOutput(credential.rawId);
    const masterKey = await deriveMasterKeyFromPrf(prfOutput);
    const dek = await generateDek();
    const { iv, ciphertext } = await wrapDek(dek, masterKey);

    const finishRes = await fetch("/auth/register/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        response: serializeAttestation(credential),
        deviceLabel: guessDeviceLabel(),
        wrappedDek: bufferToBase64Url(concatBytes(iv, new Uint8Array(ciphertext))),
      }),
      credentials: "include",
    });
    if (!finishRes.ok) throw new Error("setup failed");

    statusEl.textContent = "Set up — loading…";
    const app = await import("/app/main.js");
    await app.start({ dek });
  } catch (err) {
    statusEl.textContent = "Setup failed — try again";
    console.error(err);
  }
}

// --- WebAuthn PRF -> master key -> DEK (mirrors src/app/crypto/keys.ts) ---

const PRF_SALT = new TextEncoder().encode("onedash:prf:master-key").slice(0, 32);

async function getPrfOutput(credentialId) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ id: credentialId, type: "public-key" }],
      userVerification: "required",
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  });
  const prfOutput = assertion?.getClientExtensionResults().prf?.results?.first;
  if (!prfOutput) throw new Error("authenticator did not return a PRF result");
  return prfOutput;
}

async function deriveMasterKeyFromPrf(prfOutput) {
  const hkdfKey = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: PRF_SALT, info: new TextEncoder().encode("onedash-master-key") },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"]
  );
}

async function generateDek() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function wrapDek(dek, masterKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.wrapKey("raw", dek, masterKey, { name: "AES-GCM", iv });
  return { iv, ciphertext };
}

async function unwrapDek(ciphertext, iv, masterKey) {
  return crypto.subtle.unwrapKey(
    "raw",
    ciphertext,
    masterKey,
    { name: "AES-GCM", iv },
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function splitIvAndCiphertext(buffer) {
  const bytes = new Uint8Array(buffer);
  return { iv: bytes.slice(0, 12), ciphertext: bytes.slice(12).buffer };
}

function guessDeviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android";
  return "Browser";
}

// --- WebAuthn JSON <-> binary plumbing ---

function base64UrlToBuffer(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function serializeAssertion(assertion) {
  return {
    id: assertion.id,
    rawId: bufferToBase64Url(assertion.rawId),
    type: assertion.type,
    response: {
      clientDataJSON: bufferToBase64Url(assertion.response.clientDataJSON),
      authenticatorData: bufferToBase64Url(assertion.response.authenticatorData),
      signature: bufferToBase64Url(assertion.response.signature),
      userHandle: assertion.response.userHandle ? bufferToBase64Url(assertion.response.userHandle) : null,
    },
    clientExtensionResults: {},
  };
}

function serializeAttestation(credential) {
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(credential.response.clientDataJSON),
      attestationObject: bufferToBase64Url(credential.response.attestationObject),
      transports: credential.response.getTransports ? credential.response.getTransports() : [],
    },
    clientExtensionResults: {},
  };
}

function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
