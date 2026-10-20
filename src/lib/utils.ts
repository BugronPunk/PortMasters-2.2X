import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// The border and wash a captain's own line wears, shared by the roster
// rail and the fleet ticker so the two rows that say "this is you" say
// it the same way.
export function memberRowClass(isMe: boolean): string {
  return isMe
    ? "border-members/30 bg-members/[0.06]"
    : "border-black/5 dark:border-white/10 bg-background/40";
}

// A short clock reading for a timestamp, in the reader's own locale. The
// one place the interface turns a Date into a time of day, so every
// screen shows the same style.
export function formatTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// The calendar day a timestamp falls on, again in the reader's locale.
// Sits beside formatTime above so the two date formats a captain ever
// sees come from one file.
export function formatDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString();
}

// Forwarded from ./rooms so the Lobby and GameRoom can keep importing
// normalizeRoomName from "@/lib/utils" as the original single process build
// did. The function itself lives in ./rooms beside the harbor code that also
// uses it.
export { normalizeRoomName } from "./rooms";
