// =====================================================================
// The locale frame: the captain's language, kept current on the socket.
//
// The handshake reads it from the pm_locale cookie (../cookies), which
// covers every connection that follows a reload. This frame covers the
// one the cookie cannot: a captain who flips the pick with the tab
// still open. The server composes some captain facing lines at the send
// (tFor over SocketState.locale), so the write here is what carries a
// live flip to those lines. No authentication gate: a language is a
// taste rather than a credential, and a frame that arrives before the
// auth hold has settled writes the same field the handshake already
// filled.
// =====================================================================

import type { Socket } from "socket.io";

import { isLocale } from "@/lib/game/i18n";
import { sockets } from "../presence";

export function wireLocale(socket: Socket): void {
  socket.on("locale:set", (payload: { locale?: unknown } | undefined) => {
    const next = payload?.locale;
    if (!isLocale(next)) return;
    const state = sockets.get(socket.id);
    if (!state) return;
    state.locale = next;
  });
}
