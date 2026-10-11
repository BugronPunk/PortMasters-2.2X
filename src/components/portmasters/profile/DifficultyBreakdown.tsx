"use client";

import type { CaptainLegacySummary } from "@/lib/game/legacy";
import { t } from "@/lib/game/i18n";
import { SectionHeading } from "./SectionHeading";

// The tier names stay English here; each is read through the pack where the
// tile prints it. The map parameter is named tier rather than t so the
// reader stays reachable inside it.
const TIERS = [
  { id: "fair_winds", name: "Fair Winds", icon: "🌤️" },
  { id: "open_waters", name: "Open Waters", icon: "🌊" },
  { id: "monsoon", name: "Monsoon", icon: "⛈️" },
];

export function DifficultyBreakdown({
  statsByDifficulty,
}: {
  statsByDifficulty: CaptainLegacySummary["statsByDifficulty"];
}) {
  return (
    <div>
      <SectionHeading>{t("By Difficulty")}</SectionHeading>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {TIERS.map((tier) => {
          const s = (
            statsByDifficulty as
              | Record<
                  string,
                  { crowns: number; bestScore: number } | undefined
                >
              | undefined
          )?.[tier.id];
          return (
            <div
              key={tier.id}
              className="pm-glass pm-ink-hover rounded-2xl p-4"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xl">{tier.icon}</span>
                <span className="text-sm font-medium">{t(tier.name)}</span>
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("Crowns")}</span>
                  <span className="font-semibold">{s?.crowns ?? 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("Best Rep")}</span>
                  <span className="font-semibold">{s?.bestScore ?? 0}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
