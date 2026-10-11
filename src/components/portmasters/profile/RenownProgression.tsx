"use client";

import {
  RENOWN_MAX_LEVEL,
  RENOWN_TITLES,
  renownTitleForLevel,
} from "@/lib/game/legacy";
import { t } from "@/lib/game/i18n";
import { cn } from "@/lib/utils";
import { SectionHeading } from "./SectionHeading";

export function RenownProgression({ renownLevel }: { renownLevel: number }) {
  return (
    <div>
      <SectionHeading>{t("Renown Progression")}</SectionHeading>
      <div className="pm-glass rounded-2xl p-4">
        <div className="flex items-center justify-between text-sm">
          {/* The ladder's own names are read where the rung is printed. */}
          <span className="font-medium">
            {t(renownTitleForLevel(renownLevel))}
          </span>
          <span className="text-muted-foreground">
            {t("Level {n}", { n: renownLevel })}
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-celadon to-jade transition-all duration-500"
            style={{
              width: `${Math.min(100, (renownLevel / RENOWN_MAX_LEVEL) * 100)}%`,
            }}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {RENOWN_TITLES.map((title) => (
            <div
              key={title.minLevel}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-[10px] font-medium",
                renownLevel >= title.minLevel
                  ? "pm-grad-medal-gold"
                  : "bg-black/5 text-muted-foreground dark:bg-white/10",
              )}
            >
              {t(title.title)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
