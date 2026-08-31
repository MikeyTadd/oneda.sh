// Pre-auth shell script (section 13.1). Only performs the WebAuthn ceremony against
// /auth/*; on success it dynamically imports the gated app bundle from /app/, which the
// Worker only serves once a session token exists (section 13.2). Nothing tile-related is
// reachable from this file before that point.

const statusEl = document.getElementById("status");
const unlockBtn = document.getElementById("unlock");

unlockBtn.addEventListener("click", () => void unlock());

async function unlock() {
  statusEl.textContent = "Waiting for Face ID…";
  try {
    const optionsRes = await fetch("/auth/login/start", { method: "POST" });
    const options = await optionsRes.json();

    const publicKey = {
      ...options,
      challenge: base64UrlToBuffer(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map((c) => ({
        ...c,
        id: base64UrlToBuffer(c.id),
      })),
    };

    const assertion = await navigator.credentials.get({ publicKey });
    if (!assertion) throw new Error("cancelled");

    const finishRes = await fetch("/auth/login/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(serializeAssertion(assertion)),
      credentials: "include",
    });

    if (!finishRes.ok) throw new Error("verification failed");

    statusEl.textContent = "Unlocked — loading…";
    // Session cookie is now set by the Worker; the /app/ bundle route will accept requests
    // from this device. The DEK is unwrapped client-side inside the app bundle using the
    // same passkey (section 2.3) — the Worker never sees it.
    const app = await import("/app/main.js");
    app.start();
  } catch (err) {
    statusEl.textContent = "Unlock failed — try again";
    console.error(err);
  }
}

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
  };
}

function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
