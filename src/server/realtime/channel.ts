// =====================================================================
// Realtime layer: the room channel name.
//
// A room's sockets all sit on one socket.io channel, and the channel's
// name is a protocol contract: the joins, the leaves, the room wide
// emits and the room member reads have to spell it the same way or a
// frame lands nowhere. The template used to be written out at every
// site in this layer, so this module owns the spelling the way ./types
// owns the wire shapes: one reader, called everywhere.
// =====================================================================

/** The channel a room's sockets sit on. */
export function roomChannel(roomId: string): string {
  return `room:${roomId}`;
}
