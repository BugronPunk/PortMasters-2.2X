"use client";

import { Anchor, Crown, Gem, Trophy } from "lucide-react";
import { t } from "@/lib/game/i18n";
import { StatTile } from "./StatTile";

export function KeyStatsGrid({
  totalVoyages,
  seaMasterCrowns,
  bestScore,
  renownXP,
}: {
  totalVoyages: number;
  seaMasterCrowns: number;
  bestScore: number;
  renownXP: number;
}) {
  // The four labels are read where they are handed over, not where they
  // print: the tile is furniture and fills whatever it is given, and the
  // words here are this profile's own four readings, each with a row.
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile
        icon={Anchor}
        label={t("Voyages")}
        value={totalVoyages}
        tone="sea"
      />
      <StatTile
        icon={Crown}
        label={t("Sea Master")}
        value={seaMasterCrowns}
        tone="gold"
      />
      <StatTile
        icon={Trophy}
        label={t("Best Rep")}
        value={bestScore}
        tone="due"
      />
      <StatTile
        icon={Gem}
        label={t("Renown XP")}
        value={renownXP}
        tone="intel"
      />
    </div>
  );
}
