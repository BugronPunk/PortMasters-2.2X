// =====================================================================
// Realtime layer: the handshake cookie header, read by name.
//
// Two cookies matter on a connection: the session (../auth authenticates
// from it) and the captain's language (./wiring/locale keeps the socket
// current with it). Both arrive in the same raw header and come out with
// the same walk, so the walk lives here rather than twice beside its two
// callers.
// =====================================================================
import { SESSION_COOKIE_NAME } from "@/lib/auth";
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_COOKIE_NAME,
  type Locale,
} from "@/lib/game/i18n";

/** One named cookie's value out of a raw cookie header, or null. */
function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** The session token off a handshake, or null where none is carried. */
export function readSessionCookie(
  cookieHeader: string | undefined,
): string | null {
  return readCookie(cookieHeader, SESSION_COOKIE_NAME);
}

/**
 * The captain's language off a handshake, for the frames this layer
 * composes per captain.
 *
 * The shipped language stands wherever the cookie is absent or names
 * something this pack cannot print, the same honest fallback isLocale
 * gives every other door: a value from outside the tree is an ordinary
 * event, and the answer for it is English rather than a fault.
 */
export function readLocaleCookie(cookieHeader: string | undefined): Locale {
  const value = readCookie(cookieHeader, LOCALE_COOKIE_NAME);
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
