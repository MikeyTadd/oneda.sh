// Passkey registration & authentication (section 2.1). The Worker never sees a private
// key or the PRF output — it only verifies WebAuthn ceremonies and issues session tokens.
// Uses @simplewebauthn/server; swap for the Workers-runtime equivalent if that package's
// Node dependencies don't run cleanly under `nodejs_compat`.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { Env } from "../lib/session.js";

const RP_NAME = "onedash";

// Named aliases for the (identically-named, easily confused) "response" parameter each
// verify*Response function takes — this is the full *ResponseJSON object the browser
// produces from navigator.credentials.create()/get(), not just its inner `.response` field.
export type RegistrationResponseJSON = Parameters<typeof verifyRegistrationResponse>[0]["response"];
export type AuthenticationResponseJSON = Parameters<typeof verifyAuthenticationResponse>[0]["response"];

function rpConfig(env: Env) {
  const rpID = env.WEBAUTHN_RP_ID ?? "oneda.sh";
  const origin = env.WEBAUTHN_ORIGIN ?? `https://${rpID}`;
  return { rpID, origin };
}

/** Step 1 of registration: issue a challenge. Store it (e.g. in a short-lived KV/DO entry)
 * keyed to the pending signup so verifyRegistration can check it. */
export async function startRegistration(env: Env, userId: string, userName: string) {
  const { rpID } = rpConfig(env);
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName,
    // Whatever this says is what the passkey is labelled in iCloud Keychain / 1Password,
    // permanently — it's fixed at registration and can't be changed without re-registering.
    // Without it the label renders blank (section 2.1 has no usernames to draw on).
    userDisplayName: userName,
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    extensions: { prf: {} } as unknown as AuthenticationExtensionsClientInputs,
  });
}

/** Step 2 of registration: verify the browser's response, persist the credential.
 * Caller is responsible for writing the resulting credential + a fresh wrapped_dek row —
 * the DEK itself is generated and wrapped client-side (section 2.2/2.3); the Worker never
 * receives an unwrapped key. */
export async function finishRegistration(
  env: Env,
  expectedChallenge: string,
  response: Parameters<typeof verifyRegistrationResponse>[0]["response"]
) {
  const { rpID, origin } = rpConfig(env);
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });
}

export async function startAuthentication(env: Env) {
  const { rpID } = rpConfig(env);
  // Deliberately no `prf.eval` salt here. It used to be sent, and it was doubly wrong: a
  // Uint8Array JSON-serialises to {"0":111,"1":110,...}, which is not the BufferSource the
  // WebAuthn API needs, so the client silently got no PRF result and login could never
  // derive the master key. Even encoded properly it shouldn't come from the server — the
  // salt decides which key gets derived (section 2.2), so letting a response dictate it
  // would let a tampered-with server steer the client onto a different master key. The
  // salt is a fixed constant the client derives itself (public/shell/auth.js's prfSalt()).
  return generateAuthenticationOptions({
    rpID,
    userVerification: "required",
  });
}

export async function finishAuthentication(
  env: Env,
  expectedChallenge: string,
  response: Parameters<typeof verifyAuthenticationResponse>[0]["response"],
  credential: Parameters<typeof verifyAuthenticationResponse>[0]["credential"]
) {
  const { rpID, origin } = rpConfig(env);
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential,
  });
}
