"use client";

import { VoyageChronicle } from "@/types/realtime/voyage";
import { Coins, Star, TrendingUp, Trophy } from "lucide-react";
import { t } from "@/lib/game/i18n";
import { TrendCard } from "./TrendCard";
import { SectionHeading } from "./SectionHeading";

export function VoyageTrends({
  chronicles,
}: {
  chronicles: VoyageChronicle[];
}) {
  return (
    <div>
      <SectionHeading>{t("Recent Voyage Trends")}</SectionHeading>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TrendCard
          label={t("Final Reputation")}
          data={chronicles.map((c) => c.finalReputation).reverse()}
          icon={Trophy}
          gradient="bg-profile/5"
          textTone="text-profile"
        />
        <TrendCard
          label={t("Final Gold")}
          data={chronicles.map((c) => c.finalGold).reverse()}
          icon={Coins}
          gradient="bg-gold/5"
          textTone="text-gold-ink"
        />
        <TrendCard
          label={t("Peak Reputation")}
          data={chronicles.map((c) => c.peakReputation).reverse()}
          icon={TrendingUp}
          gradient="bg-sea/5"
          textTone="text-sea"
        />
        <TrendCard
          label={t("Largest Trade")}
          data={chronicles.map((c) => c.largestTrade).reverse()}
          icon={Star}
          gradient="bg-gain/5"
          textTone="text-gain"
        />
      </div>
      {/* The count line is one row, its two tokens filled from this site's
          own values: the number, and the plural the English sentence wants
          while the Mandarin carries its own word for the count. */}
      <p className="mt-2 text-center text-[10px] text-muted-foreground">
        {t(
          "{chronicles.length} recent voyage{pluralS} shown, oldest to newest",
          {
            "chronicles.length": chronicles.length,
            pluralS: chronicles.length === 1 ? "" : "s",
          },
        )}
      </p>
    </div>
  );
}
