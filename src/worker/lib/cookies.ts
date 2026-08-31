// Minimal cookie helpers. The Workers runtime has no built-in cookie jar, and pulling in a
// dependency for this is unnecessary — parsing/serializing a `key=value` pair is all that's
// needed for the two cookies this app sets (challenge, session; see challenge.ts/session.ts).

export function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function setCookie(
  headers: Headers,
  name: string,
  value: string,
  opts: { maxAge?: number; path?: string } = {}
): void {
  const parts = [`${name}=${value}`, `Path=${opts.path ?? "/"}`, "HttpOnly", "Secure", "SameSite=Strict"];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  headers.append("Set-Cookie", parts.join("; "));
}

export function clearCookie(headers: Headers, name: string, path = "/"): void {
  headers.append("Set-Cookie", `${name}=; Path=${path}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}
