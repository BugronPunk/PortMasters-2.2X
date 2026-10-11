"use client";

import { Coins, Handshake } from "lucide-react";
import { t } from "@/lib/game/i18n";

export function ChronicleLoans({
  lendCount,
  borrowCount,
}: {
  lendCount: number;
  borrowCount: number;
}) {
  return (
    <>
      {/* Barter and loan stats. The space before each phrase stays outside
          the read, so the English keeps the gap it has today. */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-intel/5 border border-intel/15 p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Handshake className="h-3.5 w-3.5" /> {t("Lending")}
          </div>
          <div className="mt-1 text-sm">
            <span className="font-bold text-intel">{lendCount}</span>
            <span className="text-muted-foreground"> {t("loans given")}</span>
          </div>
        </div>
        <div className="rounded-xl bg-warn/5 border border-warn/15 p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Coins className="h-3.5 w-3.5" /> {t("Borrowing")}
          </div>
          <div className="mt-1 text-sm">
            <span className="font-bold text-warn">{borrowCount}</span>
            <span className="text-muted-foreground"> {t("loans taken")}</span>
          </div>
        </div>
      </div>
    </>
  );
}
