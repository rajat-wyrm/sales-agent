/**
 * Minimal cookie helpers.
 *
 * Session cookies are set/read by hand rather than with @fastify/cookie: the API
 * image installs prod dependencies only, and a new runtime dependency would mean
 * a rebuild plus another supply-chain surface for ~30 lines of well-specified
 * RFC 6265 parsing.
 */

export interface CookieOptions {
  /** Seconds until expiry; also emitted as Max-Age. */
  maxAge?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  if (typeof opts.maxAge === 'number') parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite ?? 'Strict'}`);
  return parts.join('; ');
}

/** Expire a cookie in the browser (Max-Age=0 with the same path/attrs). */
export function clearCookie(name: string, opts: CookieOptions = {}): string {
  return serializeCookie(name, '', { ...opts, maxAge: 0 });
}

/**
 * Read one cookie from a `Cookie:` header.
 *
 * Values are URI-decoded, and a malformed percent-escape falls back to the raw
 * string instead of throwing -- a client sending `%ZZ` must not 500 the refresh
 * endpoint for everyone.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    const raw = pair.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}