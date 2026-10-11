// POST /api/rooms/[id]/join: join a room by id
// The admission rule lives in admitToRoom, shared with the by code route so
// the two cannot disagree about who may come aboard.
import { NextRequest, NextResponse } from "next/server";
import { ROOM_NOT_FOUND } from "@/lib/api";
import { db, PUBLIC_USER_SELECT } from "@/lib/db";
import {
  getCurrentUser,
  requestLocale,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { admitToRoom } from "@/lib/rooms";
import { tFor } from "@/lib/game/i18n";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return unauthorizedResponse();
  const { id } = await params;
  // Both refusals below are sentences the joining captain reads, so the
  // language is read once, here.
  const locale = await requestLocale();

  const room = await db.room.findUnique({
    where: { id },
    include: {
      members: true,
      host: {
        select: PUBLIC_USER_SELECT,
      },
    },
  });
  if (!room)
    return NextResponse.json(
      { error: tFor(locale, ROOM_NOT_FOUND) },
      { status: 404 },
    );

  const admitted = await admitToRoom(room, user.id);
  if ("error" in admitted)
    return NextResponse.json(
      { error: tFor(locale, admitted.error) },
      { status: 403 },
    );

  return NextResponse.json({ room: admitted.room });
}
