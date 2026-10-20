"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, X, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { cardText } from "@/lib/game/cards";
import {
  flatWorkerRoster,
  type GameState,
  type ModifierKey,
} from "@/lib/game/types";
import type { CardRecord } from "@/lib/game/constants/cards";
import {
  basePriceRange,
  priceRatio,
  canFillOrder,
  getCardFinalCost,
  getHireCost,
  getIntelCost,
  INCOME_TAX_RATE,
  lockedBehind,
  maintenanceDue,
  moduleSlotsOpen,
  quoteOrder,
  wagesDue,
} from "@/lib/game/engine";
import { RECIPES } from "@/lib/game/constants/goods";
import { SHIP_DISCOUNT_PER_LEVEL } from "@/lib/game/constants/ships";
import { listJoiner, t } from "@/lib/game/i18n";
import { TONE_WASH } from "./shared";

/**
 * Autopilot Action Suggester. Analyzes the current game state and
 * recommends the single best action for the current phase. The
 * recommendation is advisory, not prescriptive: a captain who
 * disagrees can close the panel and play their own move.
 *
 * The suggester is intentionally conservative: it only recommends a
 * purchase the captain can afford, and only suggests hiring when at least
 * two rounds of wages would remain in hand. It deliberately says nothing
 * about the pirate escort decision, because the Settlement panel already
 * offers that choice with its comparison spelled out (see
 * analyzeSettlement).
 */

type Suggestion = {
  icon: string;
  title: string;
  body: string;
  tone: "gain" | "warn" | "alarm" | "intel" | "gold";
};

/* One wash per tone. A tone names a meaning rather than a panel, so it
   draws from the meaning half of the palette: a good turn of events
   wears gain, a caution wears warn, a loss wears alarm, and plain
   advice wears intel. Gold is the coin itself, and its wash pairs with
   the gold ink, which is what keeps the words on it legible in either
   mode. */
const TONE_CLASSES: Record<Suggestion["tone"], string> = {
  gain: "border-gain/20 bg-gain/[0.04]",
  warn: "border-warn/20 bg-warn/[0.04]",
  alarm: "border-alarm/20 bg-alarm/[0.04]",
  intel: "border-intel/20 bg-intel/[0.04]",
  gold: "border-gold/20 bg-gold/[0.04]",
};

export function ActionSuggester({ game }: { game: GameState }) {
  const [open, setOpen] = useState(false);
  // The reading, held until the game itself changes. The suggestion is
  // worked out from the whole game, and this panel is mounted more than
  // once in the harbor, so a reading taken on every render was taken
  // again for every panel, every time anything above it drew.
  const suggestion = useMemo(() => analyzePhase(game), [game]);

  if (!suggestion) return null;

  return (
    <>
      {/* Toggle button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "pm-pressable inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-medium",
          /* The fill is the wash its tone carries, from the one shared
             table, so the toggle and the panel it opens cannot disagree
             about a colour. Read by tone name and never by matching the
             class string that tone produces: a match like that held only
             while the classes were raw palette names, and quietly sent
             every suggestion down the last branch once they became
             tokens. */
          TONE_WASH[suggestion.tone],
        )}
        title={t("Show the recommended action for this phase")}
        aria-label={t("Show action suggestion")}
      >
        <Sparkles className="h-3 w-3" />
        <span className="hidden sm:inline">{t("Suggest")}</span>
      </button>

      {/* Suggestion panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className={cn(
              "absolute right-0 top-full mt-1.5 w-72 rounded-xl border p-3.5 shadow-lg pm-glass-strong",
              TONE_CLASSES[suggestion.tone],
            )}
            style={{ zIndex: 30 }}
          >
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-base">{suggestion.icon}</span>
                <span className="text-xs font-bold text-advisor">
                  {suggestion.title}
                </span>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="pm-pressable rounded-full p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
                aria-label={t("Close suggestion")}
              >
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-foreground">
              {suggestion.body}
            </p>
            <button
              onClick={() => setOpen(false)}
              className="mt-2 flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className="h-3 w-3" /> {t("Got it")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/**
 * The core analyzer. Given the current game state, returns the single
 * best recommendation for the active phase, or null if the seat has no
 * move of its own to name (the pier, the path draft, the two module sub
 * states, and the two terminals).
 */
function analyzePhase(game: GameState): Suggestion | null {
  const phase = game.phase;

  switch (phase) {
    case "dawn":
      return analyzeBoonDraft(game);
    // Market is two stations and the advice follows them in order: the port
    // board speaks first, and it answers null for itself once every card on
    // it has been bought, which is what hands the bench its turn. Which
    // station a captain is standing at is container state (see
    // phases/Market.tsx) and deliberately not on the state, so this reads
    // what the phase still has left to do rather than where they clicked.
    case "market":
      return analyzePurchase(game) ?? analyzeWorkerMgmt(game);
    // The table is where the fleet trades directly, so the move to name is
    // the trade itself: posting an offer is this captain's own move on
    // every board around them. A hold carrying nothing of theirs reads the
    // other honest answer, that readying up is the move that costs nothing
    // (see analyzeParley).
    case "parley":
      return analyzeParley(game);
    case "orders":
      return analyzeOrders(game);
    case "resolve":
      return analyzeSettlement(game);
    case "dusk":
      return analyzeShipyard(game);
    default:
      return null;
  }
}

// The flags a card record writes, or an empty record for a card that
// writes none. Every sentence below that quotes a figure quotes the card
// it names, reading the number here rather than retyping it: a retune
// moves the record and the suggestion together, and a card that stopped
// writing the flag stops producing that sentence rather than printing a
// number the card no longer promises.
function cardFlags(card: CardRecord): Partial<Record<ModifierKey, number>> {
  return card.effect.kind === "flags" ? card.effect.flags : {};
}

function analyzeBoonDraft(game: GameState): Suggestion | null {
  const choices = game.boonChoices ?? [];
  if (choices.length === 0) return null;

  const round = game.currentRound;
  const maxRounds = game.maxRounds;
  const score = game.score;

  // If money is low, recommend Emergency Loan
  const emergency = choices.find((b) => b.id === "emergency_loan");
  const emergencyGold = emergency
    ? cardFlags(emergency).instant_gold
    : undefined;
  if (emergency && emergencyGold && game.money < 30) {
    return {
      icon: emergency.icon,
      title: t("Take the {name}", { name: cardText(emergency).name }),
      body: t(
        "You have {gold} Gold. The {name} gives {amount} Gold immediately, which should cover wages and maintenance this round. Without it, you risk bankruptcy at Resolve.",
        {
          gold: game.money,
          name: cardText(emergency).name,
          amount: emergencyGold,
        },
      ),
      tone: "alarm",
    };
  }

  // If no workers hired, recommend Master's Apprentice. The pair of
  // prices in the sentence is a projection rather than a retyping: the
  // Weaver's price as the state stands, then the same price with the
  // card's own discount flag written over a copy, so both numbers come
  // out of getHireCost, the one function a hire is charged through. A
  // hand written pair sat here before, and both numbers were wrong for a
  // captain holding an Artisan's Workshop or a House wage perk.
  const apprentice = choices.find((b) => b.id === "master_apprentice");
  const hireDiscount = apprentice
    ? cardFlags(apprentice).hire_discount
    : undefined;
  const hasWorkers = flatWorkerRoster(game).length > 0;
  if (apprentice && hireDiscount && !hasWorkers && round <= maxRounds - 3) {
    const weaverNow = getHireCost(game, "weaver");
    const weaverThen = getHireCost(
      {
        ...game,
        modifierFlags: { ...game.modifierFlags, hire_discount: hireDiscount },
      },
      "weaver",
    );
    return {
      icon: apprentice.icon,
      title: t("Pick {name}", { name: cardText(apprentice).name }),
      body: t(
        "You have no artisans yet. {apprenticeName} cuts hiring costs by {hireDiscountPct}% this round, letting you get a Weaver for {weaverThen} Gold instead of {weaverNow}. Good for establishing production early.",
        {
          apprenticeName: cardText(apprentice).name,
          hireDiscountPct: Math.round(hireDiscount * 100),
          weaverThen,
          weaverNow,
        },
      ),
      tone: "gain",
    };
  }

  // If income is expected to be high, recommend Tax Shelter. The two
  // rates are the engine's own: the base rate a voyage pays and the
  // override this card writes (see calcIncomeTax in engine/pricing).
  const taxShelter = choices.find((card) => card.id === "tax_shelter");
  const shelterRate = taxShelter
    ? cardFlags(taxShelter).income_tax_override
    : undefined;
  if (taxShelter && shelterRate && score > 50) {
    return {
      icon: taxShelter.icon,
      title: t("Grab the {name}", { name: cardText(taxShelter).name }),
      body: t(
        "You have {score} Reputation. With high earnings expected, the {name} cuts income tax from {taxRatePct}% to {shelterRatePct}%, saving Gold at round end.",
        {
          score,
          name: cardText(taxShelter).name,
          taxRatePct: Math.round(INCOME_TAX_RATE * 100),
          shelterRatePct: Math.round(shelterRate * 100),
        },
      ),
      tone: "warn",
    };
  }

  // Default: recommend the first boon with a brief note. Every branch
  // here names its card and draws its glyph off the record through
  // cardText, so the suggestion and the card agree on words.
  const first = cardText(choices[0]);
  return {
    icon: "🧭",
    title: t("Consider {first.name}", { "first.name": first.name }),
    body: first.desc,
    tone: "intel",
  };
}

function analyzePurchase(game: GameState): Suggestion | null {
  const cards = game.resourceCards ?? [];
  const unpurchased = cards.filter((c) => !game.purchasedCards.includes(c.id));
  if (unpurchased.length === 0) return null;

  // Find the best deal (lowest unit price relative to range). The winning
  // resource's own price is kept beside its name, because the two bodies
  // below quote both: reading resources[0] instead would quote whichever
  // good the card happens to list first, which is not always the one the
  // score picked.
  let bestCard = null as (typeof unpurchased)[0] | null;
  let bestPriceRatio = -1;
  let bestGoodName = "";
  let bestGoodPrice = 0;
  for (const card of unpurchased) {
    for (const r of card.resources) {
      const range = basePriceRange(r.type) ?? [0, 100];
      const unit = r.price ?? 0;
      const score = 1 - priceRatio(unit, range);
      if (score > bestPriceRatio) {
        bestPriceRatio = score;
        bestCard = card;
        bestGoodName = r.type;
        bestGoodPrice = unit;
      }
    }
  }

  if (!bestCard) return null;
  const finalCost = getCardFinalCost(game, bestCard);

  // Check if we can afford it
  if (game.money < finalCost) {
    return {
      icon: "⚠️",
      title: t("Skip buying this round"),
      body: t(
        "The best deal costs {finalCost} Gold but you only have {game.money}. Save your Gold for the Resolve bills. You can still barter for goods you need.",
        { finalCost, "game.money": game.money },
      ),
      tone: "alarm",
    };
  }

  // Check if we should buy intel instead
  const intelCost = getIntelCost(game);
  if (
    game.revealedIntel.length === 0 &&
    game.money > intelCost + finalCost + 20
  ) {
    return {
      icon: "🔮",
      title: t("Buy a Broker's Rumor"),
      body: t(
        "You have {game.money} Gold. Spending {intelCost} Gold on a rumor guarantees a matching order in Orders, then buying the {bestGoodName} at {bestPrice} Gold per unit sets up a profitable trade.",
        {
          "game.money": game.money,
          intelCost,
          bestGoodName: t(bestGoodName),
          bestPrice: bestGoodPrice,
        },
      ),
      tone: "intel",
    };
  }

  return {
    icon: "🛒",
    title: t("Buy {name}", { name: t(bestGoodName) }),
    body: t(
      "Best deal this round: {bestGoodName} at {bestPrice} Gold per unit from {bestCard.port}. This is {pricePct}% of the typical price range, making it a good value.",
      {
        bestGoodName: t(bestGoodName),
        bestPrice: bestGoodPrice,
        "bestCard.port": t(bestCard.port),
        pricePct: Math.round(bestPriceRatio * 100),
      },
    ),
    tone: "gain",
  };
}

function analyzeWorkerMgmt(game: GameState): Suggestion | null {
  const hasWorkers = flatWorkerRoster(game).length > 0;
  const roundsLeft = game.maxRounds - game.currentRound;

  if (!hasWorkers && roundsLeft >= 3) {
    // Recommend hiring a Weaver (cheapest)
    // The engine's own price, not the list wage: the same modifiers that
    // move every other payroll figure move this one, and this screen quotes
    // the number out loud in both branches below.
    const weaverWage = getHireCost(game, "weaver");
    // The purse bar both branches below quote, named once: the advice that
    // hires and the advice that waits both speak about the same number, and
    // two spellings of one arithmetic claim is how advice starts disagreeing
    // with itself.
    const hireBar = weaverWage * 2 + 20;
    if (game.money >= hireBar) {
      return {
        icon: t("👩‍🔧"),
        title: t("Hire a Weaver"),
        body: t(
          "A Weaver costs {weaverWage} Gold per round and can make Linen Clothes from Hemp. You have {game.money} Gold, enough for {wageRounds} rounds of wages. Production runs the same round you assign it, so hire now to get goods by Resolve.",
          {
            weaverWage,
            "game.money": game.money,
            wageRounds: Math.floor(game.money / weaverWage),
          },
        ),
        tone: "gain",
      };
    }
    return {
      icon: "⚠️",
      title: t("Hold off on hiring"),
      body: t(
        "A Weaver needs {weaverWage} Gold per round in wages. With {gold} Gold, you can only cover {wageRounds} rounds. Wait until you have at least {hireBar} Gold before hiring.",
        {
          weaverWage,
          gold: game.money,
          wageRounds: Math.floor(game.money / weaverWage),
          hireBar,
        },
      ),
      tone: "warn",
    };
  }

  if (hasWorkers && roundsLeft <= 1) {
    return {
      icon: "🏁",
      title: t("Last round, no new hires"),
      body: t(
        "Only one round remains. Hiring now wastes Gold on wages with no production return. Focus on filling orders with what you already have.",
      ),
      tone: "warn",
    };
  }

  // Check if any worker is idle
  for (const [type, list] of Object.entries(game.workers ?? {})) {
    for (const w of list ?? []) {
      if (!w.task) {
        // Find a recipe this worker can craft
        const craftable = Object.entries(RECIPES).find(
          ([, recipe]) =>
            recipe.worker_type === type ||
            (type === "master" && recipe.worker_type === "weaver"),
        );
        if (craftable) {
          const [product, recipe] = craftable;
          const canCraft = Object.entries(recipe.materials).every(
            ([mat, qty]) => (game.inventory[mat] || 0) >= qty,
          );
          if (canCraft) {
            return {
              icon: "🔨",
              title: t("Assign task: {product}", { product: t(product) }),
              body: t(
                "Your {type} is idle and you have the materials to make {product}. Assign the task now so production lands at this round's Resolve. Materials: {materialsList}.",
                {
                  type,
                  product: t(product),
                  materialsList: Object.entries(recipe.materials)
                    .map(([m, q]) => `${t(m)} x${q}`)
                    .join(listJoiner()),
                },
              ),
              tone: "gain",
            };
          }
          return {
            icon: "📦",
            title: t("Buy materials for {product}", { product: t(product) }),
            body: t(
              "Your {type} is idle but you lack materials for {product}. You need: {materialsList}. Buy these next round.",
              {
                type,
                product: t(product),
                materialsList: Object.entries(recipe.materials)
                  .map(
                    ([m, q]) =>
                      `${t(m)} x${q} (have ${game.inventory[m] || 0})`,
                  )
                  .join(listJoiner()),
              },
            ),
            tone: "warn",
          };
        }
      }
    }
  }

  return null;
}

// Parley is where a captain recovers from a bad draw, so the move to name
// is the trade itself. What they can offer is read off the hold, their
// largest stack first, and a hold carrying nothing names the other half
// honestly, that readying up is the move that costs nothing. The sentence
// about orders stays mode blind: a Gambit lap runs the manifest before
// this table and a Classic lap runs it after, so the good named is the one
// this captain is still short of rather than one waiting on a later phase.
function analyzeParley(game: GameState): Suggestion {
  let top = "";
  let count = 0;
  for (const [good, held] of Object.entries(game.inventory)) {
    if (held > count) {
      top = good;
      count = held;
    }
  }
  if (count < 1) {
    return {
      icon: "🤝",
      title: t("Ready up when you are done"),
      body: t(
        "Your hold carries no goods to trade this Parley. Post a Gold offer for the good you still need, or ready up so the fleet can move on.",
      ),
      tone: "intel",
    };
  }
  return {
    icon: "🤝",
    title: t("Post a barter offer"),
    body: t(
      "You are holding {count} {top}. Post what your voyage can spare and name the good you are still short of, then ready up once the table is done with you.",
      { count, top: t(top) },
    ),
    tone: "gold",
  };
}

function analyzeOrders(game: GameState): Suggestion | null {
  const orders = game.customerCards ?? [];
  if (orders.length === 0) return null;

  // Find the most profitable completable order
  let bestOrder = null as (typeof orders)[0] | null;
  let bestProfit = -Infinity;
  let bestReward = 0;
  for (const o of orders) {
    if (game.completedOrders.includes(o.id)) continue;
    // The engine's own reader rather than a second copy of the hold test,
    // because it now answers both halves of the question: the hold covers
    // the order and the order is not locked behind a path. A card the board
    // greys out can therefore never be suggested here, and the two surfaces
    // cannot come to disagree about which orders are a captain's (see [D2]
    // in ./engine/orders).
    if (!canFillOrder(game, o)) continue;
    // The order priced through the engine's own quote (see quoteOrder),
    // which is the chain the fill pays through: the VAT per unit, the
    // percentage bonuses off what is left, and the Broker's cut last. The
    // estimate this replaced left the Broker's cut out of the reward the
    // sentence named, so it quoted a sum the harbor was never going to
    // pay, and the net it ranked the orders by was priced a second way.
    const quote = quoteOrder(game, o);
    if (quote.net > bestProfit) {
      bestProfit = quote.net;
      bestOrder = o;
      bestReward = quote.reward;
    }
  }

  if (bestOrder && bestProfit > 0) {
    return {
      icon: "🤝",
      title: t("Trade order #{id}", { id: bestOrder.id }),
      body: t(
        "This order pays {bestOrder.reward} Gold with an estimated net profit of {bestProfit} Gold after transport and taxes. It is the most profitable order you can complete right now.",
        { "bestOrder.reward": bestReward, bestProfit },
      ),
      tone: "gain",
    };
  }

  // No completable order
  const closeOrders = orders.filter((o) => {
    if (game.completedOrders.includes(o.id)) return false;
    // A locked card is never close, however full the hold is. This branch
    // tells a captain to go and find the one good they are missing, and
    // there is no good to find for a card that waits on somebody else's
    // path (see [D2] in ./engine/orders).
    if (lockedBehind(game, o)) return false;
    const missing = o.resources.filter(
      (r) => (game.inventory[r.type] || 0) < (r.required ?? 0),
    );
    return missing.length <= 1;
  });
  if (closeOrders.length > 0) {
    const close = closeOrders[0];
    const missing = close.resources.find(
      (r) => (game.inventory[r.type] || 0) < (r.required ?? 0),
    );
    // This branch is reached with a hold that already covers the card (an
    // order complete but not worth filling), and then there is no missing
    // good to name. The two reads below keep printing what the old
    // template printed for that state, which is the word "undefined":
    // stringifying the absent value is what the sentence did before the
    // row took it over, and the row's English is pinned as it stands.
    const missingGood = missing?.type;
    const missingNeed = missing?.required;
    return {
      icon: "⏳",
      title: t("Almost ready for order #{close.id}", { "close.id": close.id }),
      body: t(
        "You are only missing {missingGood} (have {missingHave}, need {missingNeed}). Try bartering for it now; a fresh order board is dealt each round.",
        {
          missingGood:
            missingGood === undefined ? String(missingGood) : t(missingGood),
          missingHave: game.inventory[missingGood ?? ""] || 0,
          missingNeed:
            missingNeed === undefined ? String(missingNeed) : missingNeed,
        },
      ),
      tone: "warn",
    };
  }

  return null;
}

function analyzeSettlement(game: GameState): Suggestion | null {
  if (game.pirateAttackResolved) {
    // Already resolved the pirate attack, now it is about bills.
    //
    // The engine's own bills (see wagesDue and maintenanceDue), so the
    // advice quotes the figures payWages and payMaintenance are about to
    // charge rather than a second opinion about the same roster: a sum
    // counted off the raw roster would include the wage a Jade Pavilion
    // pledge waives and could warn a captain about to settle cleanly that
    // they were going bankrupt, and a flat per artisan multiple would be
    // wrong twice over (the trades do not share a wage, and every wage
    // carries the captain's own modifiers), which could call a captain
    // solvent on the round they went bankrupt.
    const totalDue = wagesDue(game) + maintenanceDue(game);

    if (game.money < totalDue) {
      return {
        icon: "🆘",
        title: t("Request a loan"),
        body: t(
          "You owe about {totalDue} Gold in wages and maintenance but only have {game.money} Gold. Ask the harbor for a loan before settling, or you will go bankrupt.",
          { totalDue, "game.money": game.money },
        ),
        tone: "alarm",
      };
    }
    return {
      icon: "✅",
      title: t("Settle your bills"),
      body: t(
        "You have {game.money} Gold, enough to cover the estimated {totalDue} Gold in wages and maintenance. Settle your bills and move on to Dusk.",
        { "game.money": game.money, totalDue },
      ),
      tone: "gain",
    };
  }

  // Nothing to suggest here. The escort is the only pirate decision a
  // captain makes, and the Settlement panel already offers it with the
  // comparison spelled out (escort fee against expected loss, see
  // phases/Settlement.tsx), so a second recommendation from here would
  // only repeat a choice the captain is looking at.
  return null;
}

function analyzeShipyard(game: GameState): Suggestion | null {
  const roundsLeft = game.maxRounds - game.currentRound;

  // If ship is level 0 and rounds remain, recommend upgrading
  if (game.shipLevel === 0 && roundsLeft >= 2) {
    const cost = game.shipUpgradeCost[0] + game.shipUpgradePenalty;
    if (game.money >= cost + 20) {
      return {
        icon: "⚓",
        title: t("Upgrade to Ship Level 1"),
        body: t(
          "Upgrading costs {cost} Gold and gives +1 module slot and +{SHIP_DISCOUNT_PER_LEVEL} Gold transport discount. With {roundsLeft} rounds left, the transport savings alone will pay for the upgrade.",
          { cost, SHIP_DISCOUNT_PER_LEVEL, roundsLeft },
        ),
        tone: "gain",
      };
    }
    return {
      icon: "⏭️",
      title: t("Skip the shipyard"),
      body: t(
        "Ship upgrade costs {cost} Gold but you only have {game.money}. Save the Gold for the Resolve bills and continue the voyage.",
        { cost, "game.money": game.money },
      ),
      tone: "warn",
    };
  }

  // If ship has empty slots, recommend drafting a module
  if (game.shipLevel > 0 && moduleSlotsOpen(game) > 0) {
    return {
      icon: "🔧",
      title: t("Draft and install a module"),
      body: t(
        "You have {game.equippedModules.length} of {game.shipLevel} module slots filled. An empty slot is wasted potential. Draft a module now to gain a permanent bonus.",
        {
          "game.equippedModules.length": game.equippedModules.length,
          "game.shipLevel": game.shipLevel,
        },
      ),
      tone: "intel",
    };
  }

  return null;
}
