// =====================================================================
// Every "what does this cost" question the game asks: freight, VAT,
// income tax, the price of a market card, the wage of an artisan, and the
// Broker's cut on a favor.
//
// Everything here is a pure function of state plus its arguments. Nothing
// in this file writes to GameState, pushes a log line, or draws from the
// RNG, which is what makes it the safest part of the engine to reason
// about and the natural first real subsystem to stand on its own.
//
// The explain* functions read the same stacks their calc* counterparts
// charge from. Every price the game quotes is an ordered list of rungs,
// and the charge walks the list for the number while the explainer walks
// the same list for the lines it prints, so a tooltip can only ever
// describe the arithmetic the settlement runs.
//
// They used to be two copies of each sum, held together by hand, on the
// reasoning that the balance critical math, ported verbatim from the
// original single player build, should never have to change shape to
// accommodate a tooltip. The copies had already drifted once, when the
// freight mirror reached the harbor's five Gold minimum only if a
// discount existed to trigger a branch, so the arrangement was carrying
// the risk it was meant to avoid. One list per price keeps the ported
// numbers exactly as they are and gives the tooltip nothing of its own
// to be wrong about.
//
// The card price was the first of these to take the shape, and the header
// would be lying if it did not say so: explainCardPrice is the real thing,
// and getCardFinalCost reads the final step off it. The two were never
// independent. A card's price is short enough that the breakdown *is* the
// calculation, so splitting them would mean copying the whole body to buy
// a separation that had already gone, and a second copy is where a drift
// would start.
// =====================================================================
import { cardByFlag, cardName, cardText, carriesTag } from "../cards";
import { t } from "@/lib/game/i18n";
import { WAGES } from "../constants/crew";
import {
  COMMODITIES,
  PRODUCT_PRICES,
  RECIPES,
  RESOURCES,
} from "../constants/goods";
import { SHIP_DISCOUNT_PER_LEVEL } from "../constants/ships";
import type { Tag } from "../constants/tags";
import type { GameState, ResourceCard } from "../types";
import { brokersFavorPayoutCap } from "./ages";
import { hasModule } from "./core";

type PriceStep = { label: string; delta: number };
export type PriceBreakdown = {
  base: number;
  steps: PriceStep[];
  final: number;
};

export type ExpectedPrice = {
  min: number;
  max: number;
  isProduct: boolean;
  modifiers: string[];
};

// One owner per modifier key, which is what makes finding whichever card
// writes a given key a reliable way to name the source of a price
// adjustment for the breakdowns below. That used to be true because only
// one boon's flags were ever active at a time (selecting a new one
// replaced state.modifierFlags wholesale, see applyBoon); held boons
// made several flags ride together, and the pool's own validator is what
// keeps this reader honest through that: no two cards write the same key,
// so the first match is still the only match (see the one owner per key
// clause in ../cards).
//
// [F2: the card record, and the mode weighting field] The name comes off the
// card record rather than off a second walk of the boon table, which is what
// keeps a retune from moving the card and leaving its own breakdown lines
// saying the old name. It reads the card's own text rather than a copy kept
// here, so the label a captain reads on the card and the label the tooltip
// prints for it are one string.
function boonNameForModifierKey(key: string): string {
  const card = cardByFlag(key);
  // The fallback is read where it is used, not at the module's scope: the
  // tooltip that prints it is what decides the language, and this reader
  // only hands the word onward.
  return card === null ? t("Active boon") : cardText(card).name;
}

// ========== The shape a price stack takes ==========
// A price stack is a list of rungs, each one a rule that carries a
// running number to the next. The charge walks the list for the number
// it takes, the explainer walks the same list for the lines it prints,
// and one list cannot describe one price two ways.
type StackRung = {
  // The wording the tooltip prints for this rung. A thunk, because the
  // charge never reads it and some of these labels cost a card lookup.
  label: () => string;
  // Whether the rung is in play for this state. A rung that is not in
  // play moves nothing and prints nothing.
  inPlay: boolean;
  // The number the stack carries out of this rung.
  next: (running: number) => number;
  // The movement the tooltip reports. Left out, the movement is what
  // this rung did to the running number, which is what every freight
  // rung does; the VAT rungs that take from the sale price rather than
  // from the tax say which they mean.
  delta?: (running: number, next: number) => number;
};

// The one walk both readers make over a stack. The charge asks for the
// number; the explainer hands the walk a collector and takes the lines
// as the rungs pass, so the two read one list rather than two.
function walkStack(
  rungs: StackRung[],
  start: number,
  collect?: (step: PriceStep) => void,
): number {
  let running = start;
  for (const rung of rungs) {
    if (!rung.inPlay) continue;
    const next = rung.next(running);
    if (collect !== undefined) {
      const delta = rung.delta ? rung.delta(running, next) : next - running;
      collect({ label: rung.label(), delta });
    }
    running = next;
  }
  return running;
}

// ========== Transport ==========
// The freight formula, as one stack of rungs: the harbor's minimum
// freight, the two discounts the hull and the round carry, the woven
// goods cut, the charter's per lot cut, the three modules that touch
// freight, and the luxury rule last. The order is the order the
// arithmetic takes, and the order the tooltip prints.
//
// The stack was two copies until the audit found them (ECO-7 in
// docs/STUDIO_AUDIT.md), and the copies had already drifted once: this
// mirror used to reach the harbor's five Gold minimum only when a ship
// level or a flat discount existed to trigger a branch, so a light run
// of one or two lots quoted two or four Gold above its base while the
// settlement took five, and an empty card quoted nothing at all. One
// list cannot drift from itself.
function freightStack(
  state: GameState,
  totalItems: number,
  hasWoven: boolean,
  luxuryUnits: number,
): { base: number; rungs: StackRung[] } {
  const base = totalItems * 2;
  const shipDiscount = state.shipLevel * SHIP_DISCOUNT_PER_LEVEL;
  const flatDiscount = state.modifierFlags.transport_flat_discount ?? 0;
  const silkDiscount = state.modifierFlags.transport_silk_discount ?? 0;
  const perLotDiscount = state.modifierFlags.transport_per_lot_discount ?? 0;
  return {
    base,
    rungs: [
      // The harbor's minimum freight, drawn as its own rung rather than
      // folded into the base: the base is the run's own size, and a
      // captain reading the breakdown is asking where each Gold went.
      // The rung is in play only while the run is under the minimum,
      // which is the only time the floor has anything to say.
      {
        label: () => t("Minimum freight"),
        inPlay: base < 5,
        next: (cost) => Math.max(5, cost),
      },
      // The hull's own discount, and then the round's flat cut. Both
      // floor at the harbor's minimum, so a light run never dips below
      // five however deep the discounts go, and taking them one at a time
      // reaches the same number the old combined subtraction did.
      {
        label: () =>
          t("Ship Level {state.shipLevel} discount", {
            "state.shipLevel": state.shipLevel,
          }),
        inPlay: shipDiscount > 0,
        next: (cost) => Math.max(5, cost - shipDiscount),
      },
      {
        label: () =>
          t("{boonName} (down {down}g)", {
            boonName: boonNameForModifierKey("transport_flat_discount"),
            down: flatDiscount,
          }),
        inPlay: Boolean(state.modifierFlags.transport_flat_discount),
        next: (cost) => Math.max(5, cost - flatDiscount),
      },
      {
        label: () =>
          t("{boonName} on woven goods", {
            boonName: boonNameForModifierKey("transport_silk_discount"),
          }),
        inPlay:
          hasWoven && Boolean(state.modifierFlags.transport_silk_discount),
        next: (cost) => Math.max(5, Math.floor(cost * silkDiscount)),
      },
      // [F6: charters at leg four] The Bulk Charter, the Quartermaster
      // pair's first rule: gold off per lot rather than off the bill.
      // Read after the two round flags and before the modules, and
      // floored at zero rather than at the five the base charge floors
      // at, the same reading the modules under it take: a charter that
      // makes a light run's freight free is doing what its text says,
      // and the fall to zero is a power a card above Classic's ceiling
      // is allowed to carry.
      {
        label: () =>
          t("{boonName} (down {perLot}g per lot)", {
            boonName: boonNameForModifierKey("transport_per_lot_discount"),
            perLot: perLotDiscount,
          }),
        inPlay: Boolean(state.modifierFlags.transport_per_lot_discount),
        next: (cost) =>
          Math.max(0, cost - Math.floor(totalItems * perLotDiscount)),
      },
      {
        label: () =>
          t("{cardName} module", { cardName: cardName("bulk_hauler") }),
        inPlay: hasModule(state, "bulk_hauler"),
        next: (cost) => Math.max(0, cost - totalItems),
      },
      {
        label: () =>
          t("{cardName} module", { cardName: cardName("overdrive_engine") }),
        inPlay: hasModule(state, "overdrive_engine"),
        next: (cost) => Math.max(0, cost - 5),
      },
      {
        label: () =>
          t("{cardName} module (woven freight waived)", {
            cardName: cardName("silk_monopoly"),
          }),
        inPlay: hasModule(state, "silk_monopoly") && hasWoven,
        next: () => 0,
      },
      // The Fleet of Treasures, the luxury tag's freight rule: gold off
      // each luxury unit, taken after every module above so it
      // discounts the freight they have already brought down, and
      // floored at zero like them. It used to live in the settlement
      // alone (see completeOrder), which is how the board came to quote
      // the pre discount freight while the fill charged the discounted
      // one. The count arrives from the caller because this stack is
      // handed numbers, not a manifest (see fleetOfTreasuresUnits below
      // for the count the callers use).
      {
        label: () =>
          t("{cardName} module", { cardName: cardName("fleet_of_treasures") }),
        inPlay: luxuryUnits > 0,
        next: (cost) => Math.max(0, cost - luxuryUnits * 3),
      },
    ],
  };
}

// The stack's last clamp. Every rung that can take a run below zero
// already floors it there, so this is a guard on the arithmetic rather
// than a rule, and it carries no line in the breakdown because no
// captain ever sees it fire. It sits outside the rungs for that reason,
// and both readers call it so the two cannot end a run on different
// numbers.
function freightFloor(cost: number): number {
  return Math.max(0, cost);
}

// What a run's freight costs, as the stack above reads it. The number a
// settlement takes and the number a board quotes are one walk of one list.
export function calcTransportCost(
  state: GameState,
  totalItems: number,
  hasWoven = false,
  luxuryUnits = 0,
): number {
  const { base, rungs } = freightStack(
    state,
    totalItems,
    hasWoven,
    luxuryUnits,
  );
  return freightFloor(walkStack(rungs, base));
}

// The same walk of the same stack, rendered as the lines a captain
// reads: the base, then every rung that was in play with what it moved,
// then the total. The breakdown is a reading of the charge rather than a
// second arithmetic, so the two cannot come apart.
export function explainTransportCost(
  state: GameState,
  totalItems: number,
  hasWoven = false,
  luxuryUnits = 0,
): PriceBreakdown {
  const { base, rungs } = freightStack(
    state,
    totalItems,
    hasWoven,
    luxuryUnits,
  );
  const steps: PriceStep[] = [];
  const final = freightFloor(
    walkStack(rungs, base, (step) => {
      steps.push(step);
    }),
  );
  return { base, steps, final };
}

// How many units on an order the Fleet of Treasures covers: the luxury
// tagged lines' own counts, counted only while the module is bolted on,
// so a call site cannot quote the discount off a hull that does not
// carry it. The settlement, the board's freight line and the planner's
// net all count their units through here, which is what keeps the count
// that prices a run one count (see calcTransportCost above for the
// arithmetic and completeOrder in ./orders for the receipt).
export function fleetOfTreasuresUnits(
  state: GameState,
  resources: readonly { type: string; required?: number }[],
): number {
  if (!hasModule(state, "fleet_of_treasures")) return 0;
  return resources
    .filter((r) => carriesTag("good", r.type, "luxury"))
    .reduce((sum, r) => sum + (r.required ?? 0), 0);
}

// ========== Taxes ==========
// The VAT stack, as one list of rungs: what the goods cost to make, the
// wage of the artisan who made them, the tax on what is left of the
// sale, and then the three round discounts and the module's halving,
// folded into the tax one after another.
//
// The stack carries the tax. It starts at nothing, the two cost rungs
// report what the sale spent without touching it, and the tax on the
// margin sets it. A sale that does not clear the cost of making the
// thing owes nothing, and the stack ends at the margin: there is no tax
// for the discounts below to fold into, which is why they are in play
// only once the margin has taxed something.
function vatStack(
  state: GameState,
  product: string,
  sellingPrice: number,
): StackRung[] {
  const recipe = RECIPES[product];
  let matCost = 0;
  for (const [m, a] of Object.entries(recipe.materials)) {
    matCost +=
      ((COMMODITIES[m].basePrice[0] + COMMODITIES[m].basePrice[1]) / 2) * a;
  }
  const workerCost = WAGES[recipe.worker_type];
  const taxable = sellingPrice - matCost - workerCost;
  const vatDiscount = state.modifierFlags.vat_discount ?? 0;
  const harborCredit = state.modifierFlags.harbor_credit ?? 0;
  const voyageDues = state.modifierFlags.voyage_dues_discount ?? 0;
  return [
    {
      label: () => t("Average material cost"),
      inPlay: true,
      next: (tax) => tax,
      delta: () => -matCost,
    },
    {
      // The artisan's name reads here because the tooltip prints it inside
      // this label, the same reading the wage bill's lines take (see the
      // singular arm in ./workers).
      label: () =>
        t("{workerLabel} wage", {
          workerLabel: t(
            recipe.worker_type === "weaver"
              ? "Weaver"
              : recipe.worker_type === "master"
                ? "Master Weaver"
                : "Sachet Maker",
          ),
        }),
      inPlay: true,
      next: (tax) => tax,
      delta: () => -workerCost,
    },
    {
      label: () =>
        t("{vatPct}% VAT on the margin", {
          vatPct: Math.round(VAT_RATE * 100),
        }),
      inPlay: taxable > 0,
      next: () => Math.floor(taxable * VAT_RATE),
      delta: (_tax, tax) => -tax,
    },
    {
      label: () =>
        t("{boonName} (down {pct}%)", {
          boonName: boonNameForModifierKey("vat_discount"),
          pct: Math.round(vatDiscount * 100),
        }),
      inPlay: taxable > 0 && Boolean(state.modifierFlags.vat_discount),
      next: (tax) => Math.floor(tax * (1 - vatDiscount)),
    },
    {
      // [F4: boons at milestone moments] Harbor Credit, the boon a crossed
      // rung deals: the dues a quarter lower, taken as the same
      // multiplication the round's own discount takes and landing after it
      // rather than beside it, so a captain holding both pays the product
      // of the two. The order is a declaration rather than a rule, the way
      // applyBoon's merge is: the two flags multiply and multiplication
      // commutes.
      label: () =>
        t("{boonName} (down {pct}%)", {
          boonName: boonNameForModifierKey("harbor_credit"),
          pct: Math.round(harborCredit * 100),
        }),
      inPlay: taxable > 0 && Boolean(state.modifierFlags.harbor_credit),
      next: (tax) => Math.floor(tax * (1 - harborCredit)),
    },
    {
      // [F6: charters at leg four] The Quiet Account, the other half of the
      // Aroma pair: the harbor dues halved, taken as the same
      // multiplication Harbor Credit takes and landing after it rather
      // than beside it, so a captain holding both pays the product of the
      // two, floored at each step the way every multiplication above it is.
      label: () =>
        t("{boonName} (down {pct}%)", {
          boonName: boonNameForModifierKey("voyage_dues_discount"),
          pct: Math.round(voyageDues * 100),
        }),
      inPlay: taxable > 0 && Boolean(state.modifierFlags.voyage_dues_discount),
      next: (tax) => Math.floor(tax * (1 - voyageDues)),
    },
    {
      label: () =>
        t("{cardName} module (down 50%)", {
          cardName: cardName("tax_evasion"),
        }),
      inPlay: taxable > 0 && hasModule(state, "tax_evasion"),
      next: (tax) => Math.floor(tax * 0.5),
    },
  ];
}

// The tax a finished good sale pays, as the stack above reads it. The
// number a settlement takes and the number a board quotes are one walk of
// one list.
export function calcVAT(
  state: GameState,
  product: string,
  sellingPrice: number,
): number {
  return walkStack(vatStack(state, product, sellingPrice), 0);
}

// The same walk of the same stack, rendered as the lines a captain reads:
// what the goods cost to make, the wage behind them, the tax on what is
// left, and every discount that folded into it. The tooltip reads the
// charge rather than repeating it, so the two cannot come apart.
export function explainVAT(
  state: GameState,
  product: string,
  sellingPrice: number,
): PriceBreakdown {
  const steps: PriceStep[] = [];
  const final = walkStack(vatStack(state, product, sellingPrice), 0, (step) => {
    steps.push(step);
  });
  return { base: sellingPrice, steps, final };
}

// The rate a voyage pays until something dials it, and the only thing
// that dials it today is the Tax Shelter boon (see tax_shelter). Named
// because the Welcome screen quotes the same figure to a new captain,
// and two copies of it had already been written.
export const INCOME_TAX_RATE = 0.1;

// The tax on the margin of a finished good sale. Written out four times
// before this existed, and the tooltip was one of them, which is the copy
// a captain reads while deciding whether to sell.
export const VAT_RATE = 0.05;

// The two module factors the tax reads: the Smuggler's Hold surcharge
// and Tax Evasion's halving. Named so the charge and the rate below fold
// the same pair, and the pair is listed once so a retune cannot move one
// and leave the other: a receipt that quotes a rate the charge no
// longer takes is worse than the bare constant it replaced.
const SMUGGLERS_HOLD_TAX_FACTOR = 1.2;
const TAX_EVASION_FACTOR = 0.5;

// The factors in force for a state, in the order the charge folds them.
// One list, read by both the charge and the rate, so the two cannot
// disagree about which factors apply or in what order they land.
function incomeTaxFactors(state: GameState): number[] {
  const factors: number[] = [];
  if (hasModule(state, "smugglers_hold"))
    factors.push(SMUGGLERS_HOLD_TAX_FACTOR);
  if (hasModule(state, "tax_evasion")) factors.push(TAX_EVASION_FACTOR);
  return factors;
}

export function calcIncomeTax(state: GameState, preTax: number): number {
  if (preTax <= 0) return 0;
  const rate = state.modifierFlags.income_tax_override || INCOME_TAX_RATE;
  let tax = Math.floor(preTax * rate);
  // The charge floors after each multiply, which is where the coins come
  // from.
  for (const factor of incomeTaxFactors(state)) tax = Math.floor(tax * factor);
  return tax;
}

// The rate as charged, for the one reader that has to print it: the
// round's income tax receipt (see the Resolve step in ./lifecycle). The
// same base calcIncomeTax charges from, with the same module factors
// folded in, so the percentage the ledger prints and the Gold it takes
// tell one story. Note this folds the factors on the rate rather than
// reading them back out of the charge, because the charge floors after
// each multiply and a rate written back out of two floors would be a
// third number matching neither the base nor the coins. The receipt
// used to read the base constant alone, so a Smuggler's Hold round
// printed ten percent over a charge it took twelve of.
export function incomeTaxRate(state: GameState): number {
  let rate = state.modifierFlags.income_tax_override || INCOME_TAX_RATE;
  // The rate does not floor, and that difference is deliberate: only the
  // charge rounds what it takes.
  for (const factor of incomeTaxFactors(state)) rate *= factor;
  return rate;
}

// ========== Market card pricing ==========
// The two per unit module discounts: the tag each one covers, and how many
// Gold it takes off each unit. Named here because two places apply them, the
// card charge below and the hover preview in explainExpectedPrice, and
// keeping the tag and the amount in one place is what stops the two from
// drifting apart again. They had: the preview applied neither, so a captain
// holding the Kiln Cellar saw a Porcelain Clay price two Gold a unit above
// what the card went on to charge.
//
// [F2: the card record, and the mode weighting field] They read tags now
// rather than naming goods (the Kiln Cellar its two, the Foreign Quarter
// Pass its own two), which is the shape the epic exists to end: with a tag
// in the line the card's copy and the card's arithmetic agree, and a good
// added to the catalogue under one of these tags joins the discount the same
// afternoon. One consequence is worth stating where the numbers are: the
// Bulk Monopoly boon reads the same tag the Kiln Cellar does, and the two
// could not overlap before, when each named goods the other did not. A
// captain holding both now takes four Gold off a bulk unit. That is the
// trade the card's own new text promises, and it is a pair for the
// combination instrument F7 describes rather than a reason to keep two
// disjoint item lists here.
const KILN_CELLAR_TAG: Tag = "bulk";
const KILN_CELLAR_PER_UNIT = 2;
const FOREIGN_QUARTER_TAG: Tag = "luxury";
const FOREIGN_QUARTER_PER_UNIT = 3;

// What a market card actually costs, reported as a step by step breakdown
// so the Market tooltip can show exactly where a price came from:
// base cost, then whatever boon or module touched it. getCardFinalCost
// below reads the final step, so this is the only price of a card there is
// rather than a second opinion of one.
export function explainCardPrice(
  state: GameState,
  card: ResourceCard,
): PriceBreakdown {
  const steps: PriceStep[] = [];
  let cost = card.totalCost;

  if (state.modifierFlags.purchase_discount) {
    const next = Math.floor(cost * (1 - state.modifierFlags.purchase_discount));
    steps.push({
      label: t("{boonName} (down {pct}%)", {
        boonName: boonNameForModifierKey("purchase_discount"),
        pct: Math.round(state.modifierFlags.purchase_discount * 100),
      }),
      delta: next - cost,
    });
    cost = next;
  }
  // [F6: charters at leg four] The Long Ledger, the Aroma pair's first
  // money rule: port purchases a tenth cheaper, taken as the same
  // multiplication the round's own discount takes and landing right
  // after it rather than beside it, so a captain holding both pays the
  // product of the two. This is the charge's copy of the rule; the
  // preview mirror below folds the same read into its range.
  if (state.modifierFlags.voyage_purchase_discount) {
    const next = Math.floor(
      cost * (1 - state.modifierFlags.voyage_purchase_discount),
    );
    steps.push({
      label: t("{boonName} (down {pct}%)", {
        boonName: boonNameForModifierKey("voyage_purchase_discount"),
        pct: Math.round(state.modifierFlags.voyage_purchase_discount * 100),
      }),
      delta: next - cost,
    });
    cost = next;
  }
  if (state.modifierFlags.hemp_price_reduction) {
    const hempReduction = state.modifierFlags.hemp_price_reduction;
    // The card is the Bulk Monopoly and reads the bulk tag. The flag's own
    // name is a persisted handle (a save carries it, and the ledger reads it
    // by this key), so it keeps the spelling it has always had rather than
    // moving with the card's caption: a persisted name is a migration, not a
    // copy change (see the same note in ../paths.ts).
    const reduction = card.resources.reduce(
      (sum, r) =>
        carriesTag("good", r.type, "bulk")
          ? sum + (r.quantity ?? 0) * hempReduction
          : sum,
      0,
    );
    if (reduction > 0) {
      steps.push({
        label: t("{hempBoon} (down {hempReduction}g per unit)", {
          hempBoon: boonNameForModifierKey("hemp_price_reduction"),
          hempReduction,
        }),
        delta: -reduction,
      });
      cost -= reduction;
    }
  }
  if (hasModule(state, "kiln_cellar")) {
    const reduction = card.resources.reduce(
      (sum, r) =>
        carriesTag("good", r.type, KILN_CELLAR_TAG)
          ? sum + (r.quantity ?? 0) * KILN_CELLAR_PER_UNIT
          : sum,
      0,
    );
    if (reduction > 0) {
      steps.push({
        label: t(
          "{kilnCellarName} module (down {KILN_CELLAR_PER_UNIT}g per unit)",
          {
            kilnCellarName: cardName("kiln_cellar"),
            KILN_CELLAR_PER_UNIT,
          },
        ),
        delta: -reduction,
      });
      cost -= reduction;
    }
  }
  if (hasModule(state, "foreign_quarter_pass")) {
    const reduction = card.resources.reduce(
      (sum, r) =>
        carriesTag("good", r.type, FOREIGN_QUARTER_TAG)
          ? sum + (r.quantity ?? 0) * FOREIGN_QUARTER_PER_UNIT
          : sum,
      0,
    );
    if (reduction > 0) {
      steps.push({
        label: t("{cardName} module (down {perUnit}g per unit)", {
          cardName: cardName("foreign_quarter_pass"),
          perUnit: FOREIGN_QUARTER_PER_UNIT,
        }),
        delta: -reduction,
      });
      cost -= reduction;
    }
  }
  if (hasModule(state, "smugglers_hold")) {
    const next = Math.floor(cost * 0.85);
    steps.push({
      label: t("{smugglersHoldName} module (down 15%)", {
        smugglersHoldName: cardName("smugglers_hold"),
      }),
      delta: next - cost,
    });
    cost = next;
  }

  const final = Math.max(0, cost);
  if (final !== cost)
    steps.push({ label: t("Floor at 0 Gold"), delta: final - cost });
  return { base: card.totalCost, steps, final };
}

export function getCardFinalCost(state: GameState, card: ResourceCard): number {
  return explainCardPrice(state, card).final;
}

// The typical price range for any tradable good, resource or product. A
// raw material carries its range on the COMMODITIES entry it already has
// for its ports, a finished good keeps its own in PRODUCT_PRICES, and
// nothing carries both, so one lookup answers for either kind.
//
// Returns undefined rather than a made up range for an item that is
// neither. Callers that only want to annotate a price can then skip an
// unknown good, while the ones that need a number to divide by, like the
// deal scoring, can supply their own fallback and make that choice where
// the division actually happens.
//
// Exists because five screens were each rebuilding it with the same two
// optional chains, three of them with a hand written [0, 100] fallback
// that only some of them wanted and none of them explained.
export function basePriceRange(item: string): [number, number] | undefined {
  return COMMODITIES[item]?.basePrice ?? PRODUCT_PRICES[item];
}

// Where a price sits inside its range, as a 0 to 1 fraction: 0 at the
// floor of the range, 1 at the ceiling, and anything outside pinned to
// the nearer end. Three screens were working this out for themselves,
// two of them to colour a cell and one to score a deal, and each of the
// three wrote the divide by zero guard and the clamp out by hand.
//
// Takes an already resolved range rather than an item name, so the
// caller still chooses its own fallback for a good with no range at all,
// which is the choice basePriceRange deliberately leaves open above.
export function priceRatio(
  unitPrice: number,
  [min, max]: [number, number],
): number {
  return Math.max(0, Math.min(1, (unitPrice - min) / (max - min || 1)));
}

// A general "what does this typically cost" estimate for a raw material
// or product, independent of any specific market card. Used for the
// hover preview during Market so a captain can size up the whole market,
// including goods that didn't happen to roll onto one of this round's
// market cards. Ports nudge a raw material's roll by 1 Gold up or down
// depending on whether the port specializes in it (see genResourceCard),
// which is why the range carries a margin note instead of trying to fold
// that into the numbers themselves.
export function explainExpectedPrice(
  state: GameState,
  itemType: string,
): ExpectedPrice {
  const isResource = (RESOURCES as readonly string[]).includes(itemType);
  let [min, max] = basePriceRange(itemType) ?? [0, 100];
  const modifiers: string[] = [];

  // The chain below is read for both kinds of item. It used to sit
  // inside an `if (isResource)` wrapper, and that wrapper was the whole
  // difference between this preview and the card charge: a captain
  // holding a purchase discount while hovering a finished good was told
  // the good carried no discount at all, and then the market card went
  // on to charge the discounted price. Every gate inside is already the
  // narrower question (the boon's flag, the good's tag, the module), the
  // same gates the charge reads, so the tags decide which lines a raw
  // good and a product share and the wrapper only ever suppressed the
  // product's.
  if (state.modifierFlags.purchase_discount) {
    const factor = 1 - state.modifierFlags.purchase_discount;
    min = Math.floor(min * factor);
    max = Math.floor(max * factor);
    modifiers.push(
      t("{boonName} (down {pct}%)", {
        boonName: boonNameForModifierKey("purchase_discount"),
        pct: Math.round(state.modifierFlags.purchase_discount * 100),
      }),
    );
  }
  // [F6: charters at leg four] The Long Ledger, folded into the range
  // exactly the way the round's own discount above is and in the same
  // order the card charge takes the two (see explainCardPrice), so the
  // preview and the charge cannot come to describe one purchase two
  // ways.
  if (state.modifierFlags.voyage_purchase_discount) {
    const factor = 1 - state.modifierFlags.voyage_purchase_discount;
    min = Math.floor(min * factor);
    max = Math.floor(max * factor);
    modifiers.push(
      t("{boonName} (down {pct}%)", {
        boonName: boonNameForModifierKey("voyage_purchase_discount"),
        pct: Math.round(state.modifierFlags.voyage_purchase_discount * 100),
      }),
    );
  }
  if (
    carriesTag("good", itemType, "bulk") &&
    state.modifierFlags.hemp_price_reduction
  ) {
    min = Math.max(0, min - state.modifierFlags.hemp_price_reduction);
    max = Math.max(0, max - state.modifierFlags.hemp_price_reduction);
    modifiers.push(
      t("{hempBoon} (down {hempReduction}g per unit)", {
        hempBoon: boonNameForModifierKey("hemp_price_reduction"),
        hempReduction: state.modifierFlags.hemp_price_reduction,
      }),
    );
  }
  // The two per unit module discounts. Flat Gold off a single unit, so
  // they come off the range the same way the Bulk Monopoly boon above
  // does rather than scaling it. Applied in the order the card charge
  // applies them (see explainCardPrice), since a percentage taken before
  // a flat subtraction and one taken after settle on different numbers.
  if (
    hasModule(state, "kiln_cellar") &&
    carriesTag("good", itemType, KILN_CELLAR_TAG)
  ) {
    min = Math.max(0, min - KILN_CELLAR_PER_UNIT);
    max = Math.max(0, max - KILN_CELLAR_PER_UNIT);
    modifiers.push(
      t("{kilnCellarName} module (down {KILN_CELLAR_PER_UNIT}g per unit)", {
        kilnCellarName: cardName("kiln_cellar"),
        KILN_CELLAR_PER_UNIT,
      }),
    );
  }
  if (
    hasModule(state, "foreign_quarter_pass") &&
    carriesTag("good", itemType, FOREIGN_QUARTER_TAG)
  ) {
    min = Math.max(0, min - FOREIGN_QUARTER_PER_UNIT);
    max = Math.max(0, max - FOREIGN_QUARTER_PER_UNIT);
    modifiers.push(
      t("{cardName} module (down {perUnit}g per unit)", {
        cardName: cardName("foreign_quarter_pass"),
        perUnit: FOREIGN_QUARTER_PER_UNIT,
      }),
    );
  }
  if (hasModule(state, "smugglers_hold")) {
    min = Math.floor(min * 0.85);
    max = Math.floor(max * 0.85);
    modifiers.push(
      t("{smugglersHoldName} module (down 15%)", {
        smugglersHoldName: cardName("smugglers_hold"),
      }),
    );
  }

  return { min, max, isProduct: !isResource, modifiers };
}

// ========== Wages ==========
// The canonical per worker, per round wage for a given type, given every
// currently active modifier. There is no separate one time "hiring fee"
// in this game (see hireWorker, which never touches state.money);
// the number this returns is what Resolve actually charges for that
// worker, so every place that shows or charges a wage, this function,
// payWages, and the Pending Payroll preview in phases/WorkerMgmt.tsx,
// must all read from here rather than derive the formula again themselves.
// Root cause of the Master's Apprentice bug: payWages and that preview
// used to hardcode WAGES[type] with only the Artisan's Workshop
// surcharge, so hire_discount silently never reduced the actual wage
// payment even though the hiring screen's own price looked discounted.
export function getHireCost(state: GameState, type: string): number {
  let wage = WAGES[type];
  if (state.modifierFlags.hire_discount)
    wage = Math.floor(wage * (1 - state.modifierFlags.hire_discount));
  if (hasModule(state, "artisans_workshop")) wage = Math.floor(wage * 1.2);
  // Golden Lotus's pledge takes a fifth off every wage. Applied last, so it
  // discounts the wage actually due rather than the list price, and read
  // here so hiring, payroll, severance and every interface preview quote
  // the same figure (see payWages, fireWorker, and the Pending Payroll
  // preview in phases/WorkerMgmt.tsx).
  if (state.housePerks.goldenWageDiscount) wage = Math.floor(wage * 0.8);
  return wage;
}

// ========== Broker intel ==========
// The Gold a captain pays for one Broker's rumor in Market. Used to live
// directly on GameState as `intelCost`, set to 5 by createInitialGameState
// and toggled to 2 by the Broker's Network module's equip/unequip hooks in
// ./boons.ts. Derived here now instead, so the cost can never drift out of
// sync with whether the module is actually equipped: the field is gone from
// the state, and the answer is read straight off hasModule, the same way
// the rest of this file derives a price from any other module flag.
//
// Callers (purchaseIntel in ./orders.ts and the Broker UI in GamePhasePanel)
// should call this rather than reading state.intelCost, which no longer
// exists. Reading it once per purchase keeps the Brokers Network module's
// discount live the instant it is equipped, with no separate state write
// needed to keep the field current.
// The two prices of one rumor, named rather than left inline: the guide
// states the first to every captain, and a second copy of either number
// would be the one that went stale. The discounted price is read only by
// the reader just below, so it is not exported.
export const INTEL_COST = 5;
const INTEL_COST_WITH_NETWORK = 2;

export function getIntelCost(state: GameState): number {
  return hasModule(state, "brokers_network")
    ? INTEL_COST_WITH_NETWORK
    : INTEL_COST;
}

// ========== Broker's Favor ==========
// The Broker's cut on a Broker's Favor order, a saturating curve rather
// than a flat rate. Net payout climbs almost one for one with reward at
// first (a small order keeps the feel of a low flat rate) but bends hard as
// reward grows, approaching the cap in force without ever reaching it. That
// gives callBrokersFavor a hard ceiling on what a single favor can pay out
// regardless of how large a quantity a captain asks for, instead of needing
// to cap the quantity itself. The cap is the Age's, not a fixed constant:
// see brokersFavorPayoutCap.
export function brokersFavorCommission(reward: number): number {
  // The cap comes from the Age in force, not straight off the constant, so
  // the Broker's Age genuinely lets one favor pay out more than usual (see
  // brokersFavorPayoutCap). Reading it here rather than at the call sites
  // keeps the Orders panel, the action suggester's net figure and the
  // payout itself all quoting the same number.
  const cap = brokersFavorPayoutCap();
  const net = cap * (1 - Math.exp(-reward / cap));
  return Math.max(0, reward - Math.floor(net));
}
