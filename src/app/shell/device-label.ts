// A first guess at what to call a passkey/device before its reader renames it (Settings'
// rename sheet). Shared between the pre-auth bundle (registration, recovery) and the
// post-auth "add a passkey" flow (add-passkey.ts) — both create a `credentials` row and both
// want the same starting label rather than two copies of the same UA sniff.
export function guessDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android";
  return "Browser";
}
