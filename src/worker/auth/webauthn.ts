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
  return generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    extensions: { prf: { eval: { first: prfSaltFor("master-key") } } } as unknown as AuthenticationExtensionsClientInputs,
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

/** Fixed per-purpose PRF salt (section 2.2) — same salt on every device so the same
 * passkey always re-derives the same master key. Add new named salts for future sub-keys
 * without disturbing this one. */
export function prfSaltFor(purpose: "master-key"): Uint8Array {
  return new TextEncoder().encode(`onedash:prf:${purpose}`).slice(0, 32);
}
