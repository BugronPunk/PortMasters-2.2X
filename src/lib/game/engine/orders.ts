// =====================================================================
// Orders, the trade manifest: the orders a captain can fill, what
// filling one actually pays, and the two ways an order can be conjured
// outside the ordinary draw (an Imperial Mandate, or calling in the
// Broker's Favor).
//
// completeOrder is the largest function in the engine and is deliberately
// left whole. Its steps are strictly ordered and the order is the
// behaviour: VAT comes off the original reward before any percentage
// bonus is applied to what remains, freight is charged before the Salvage
// Crane can refund it, and the Broker's commission is taken last of all.
// A past bug came from reordering exactly this sequence and paying every
// crane refund out twice, which is why the cost ledger true up in the
// middle carries the comment it does. Splitting the cross step ordering
// into tidy helpers would make that ordering implicit rather than
// obvious, so it stays as one readable top to bottom settlement.
//
// One block is the exception, and it is the one other surfaces have to
// read: what an order pays lives in quoteOrder above, which runs the
// chain the fill pays through (the percentage bonuses themselves live in
// orderRewardBonusSteps, one step further along), because the board's
// quotes, the planner's totals and the advisor's sentence have to price
// an order through the same arithmetic the fill pays it through. The
// precedent is the freight reader in ./pricing, which the settlement,
// the tooltip and every quote come through as well; the ordering the
// paragraph above protects holds inside that quote too, and it stays
// written down there in its own comment.
//
// The order generators come from ./market: Market and Orders draw from
// the same seeded deck, so there is exactly one implementation of them.
//
// [D2: the nine slot order board] Three of the cards this module deals wait
// on a path. Nothing about them lives on the card beyond one marker
// (isPathOrder), because which path a card waits on is read from the good it
// demands (see pathOrderOf below), the same way the board derives the crest
// and the lock line it prints.
// =====================================================================
import { cardLead, cargoCarriesTag } from "../cards";
import { ICONS } from "../constants/brand";
import { joined, line, type LedgerLine } from "@/lib/game/ledger";
import { t } from "@/lib/game/i18n";
import { PRODUCTS, RESOURCES } from "../constants/goods";
import { PATH_ORDER_SLOTS } from "../constants/paths";
import {
  BROKERS_FAVOR_UNLOCK_LEVEL,
  WORD_ON_THE_DOCKS_REWARD,
  WORD_ON_THE_DOCKS_THRESHOLD,
} from "../constants/world";
import { AUDIT_WINDOW } from "../audit";
import {
  MANDATE_TEMPLATES,
  difficultyConfig,
  mandateIndexFor,
  marketCountsFor,
} from "../difficulty";
import { pathOrdersOn } from "../flags";
import { lockingPathFor, pathLockLedgerLine, type PathId } from "../paths";
import {
  isCharterGood,
  isTier1CharterGood,
  isTier2CharterGood,
} from "../pools";
import { createRng, type Rng } from "../rng";
import type { GameContext, GameState, OrderCard } from "../types";
import { hasModule } from "./core";
import {
  opportunistLedgerLine,
  opportunistMayBorrow,
  opportunistPayout,
} from "./opportunist";
import {
  genMixedOrder,
  genPathOrder,
  genProductOrder,
  genRawOrder,
  poolsFor,
  revealRumor,
} from "./market";
import { queueMilestoneMoment } from "./milestones";
import {
  brokersFavorCommission,
  calcTransportCost,
  explainVAT,
  fleetOfTreasuresUnits,
  getIntelCost,
  type PriceBreakdown,
} from "./pricing";

// The hold's own guard on an order, as one function rather than a loop
// written at every caller. There are two callers now: an order a captain
// presses, and an order a captain's standing orders press for them (see
// [B3] workStandingOrders in ./standing). The second one has to judge the
// board before it acts, and a second copy of this rule is exactly how a
// captain's orders would come to fill an order their own hands could not.
//
// It answers with the good that is short rather than a bare boolean,
// because the refusal below is worth saying out loud and naming the good
// is the whole of what makes it useful. canFillOrder is the same answer
// read as a yes or no, and stays the module's own reading rather than
// being lifted out of it: nothing outside this file needs to know which
// good was short, only whether the hold covers the order.
function orderShortfall(
  state: GameState,
  order: OrderCard,
): OrderCard["resources"][number] | null {
  for (const r of order.resources) {
    if ((state.inventory[r.type] || 0) < (r.required ?? 0)) return r;
  }
  return null;
}

/**
 * The next free id off the board itself: one past the highest any card
 * carries, and 0 on an empty board. Three sites mint a card into a board
 * that has already been dealt (the Broker's Favor, the Imperial Mandate,
 * and the pathbound draw), so the mint lives here once; the seeded draw
 * in startOrders below mints its own contiguous run instead, since it
 * deals a fresh board and already knows how many cards it wrote.
 */
function nextCardId(state: GameState): number {
  return state.customerCards.reduce((m, c) => Math.max(m, c.id), -1) + 1;
}

/**
 * Which path posts an order, or null where none does. [D2: the nine slot
 * order board]
 *
 * The answer is read from the good the order demands, never from the card,
 * which is the plan's own instruction for this feature: a card's lock reason
 * is computed from the path configuration rather than written onto the card,
 * so retuning a pool moves the labels with it. It is also what keeps an
 * ordinary order ordinary: a card the draw happened to deal against a pooled
 * good carries no marker and is no path's locked order (see genMixedOrder in
 * ./market, which writes no marker).
 *
 * The switch is read here as well as at the draw, and that is the rollback
 * clause held at both ends: with path orders off, no card is a path's order,
 * so a board dealt while the feature was on plays on as six ordinary orders
 * rather than as a table where three cards stay grey forever.
 */
export function pathOrderOf(order: OrderCard, mode: unknown): PathId | null {
  if (!order.isPathOrder || !pathOrdersOn(mode)) return null;
  return lockingPathFor(order.resources[0]?.type ?? "");
}

/**
 * The path a card waits on for this captain, or null where the card is
 * theirs to fill. The board reads it to grey a card out and print the lock
 * line; the two fill guards below read it to refuse one.
 *
 * A pathless captain is locked out of every pathbound card, and every
 * captain is pathless until D7's draft deals one. The lock teaches by being
 * true rather than by being staged, so it holds for a captain who has not
 * drawn as firmly as for one who drew somebody else's path.
 */
export function lockedBehind(
  state: GameState,
  order: OrderCard,
): PathId | null {
  const path = pathOrderOf(order, state.mode);
  return path === null || path === state.path ? null : path;
}

// The board's guard, read as a yes or no: the hold covers the order and the
// order is not locked behind a path. Both halves live in one function
// because both callers (a captain's press and a standing order's) have to
// ask the same question, and a caller that read only half of it is exactly
// how a standing order would come to fill a card its own captain could not.
//
// [D6: Free Captain: Opportunist] The borrow is a third half, and it is the
// one that is asked rather than assumed: `borrow` names whether the caller
// is spending the Free Captain's once a voyage ability on this card, and it
// defaults to false so every existing caller (a standing order, the
// suggester, a plain press) keeps its reading and no policy surface can
// spend an ability its captain did not choose. The ability itself is asked
// in ./opportunist, which is where the allowance lives; this function only
// says what the board is allowed to offer.
export function canFillOrder(
  state: GameState,
  order: OrderCard,
  borrow = false,
): boolean {
  if (orderShortfall(state, order) !== null) return false;
  const locked = lockedBehind(state, order);
  if (locked === null) return true;
  return borrow && opportunistMayBorrow(state, locked);
}

/**
 * How many orders on this board are this captain's to fill: the board minus
 * the cards locked behind a path they do not hold.
 *
 * [D2] One reader for the leg report's dealt count (see use-leg-report, and
 * the expired orders reading built on it in docs/OCEAN_GAMBIT_AGILE_PLAN.md):
 * a locked card is not an order this captain failed to fill, and counting it
 * as one would charge every captain three expired orders a leg for a feature
 * none of them can touch until the draft that deals a path lands.
 */
export function openOrderCount(state: GameState): number {
  return state.customerCards.filter((o) => lockedBehind(state, o) === null)
    .length;
}

// One step of the reward chain below, as the settle's log loop and any
// reader that wants the itemized uplift consume it.
type OrderRewardStep = { cardId: string; pct: number; amount: number };

// The percentage bonuses a completed order's reward carries, read as one
// chain rather than at each surface that shows or pays the number.
//
// The settlement used to hold these arms inline and every quoting
// surface (the board's Reward and Net figures, the planner's totals, the
// advisor's sentence) priced the order off the face value, so a captain
// holding any of these cards read one number on the board and was paid
// another at the fill. The chain now lives here, completeOrder applies
// it in one step, and the quoting surfaces call the same function, so
// the number quoted and the number credited cannot drift apart again.
//
// The order inside the chain is the order the settlement has always
// taken: the Woven Monopoly first, then the first charter's boon, the
// Maritime Bureau Token between the charter boons, the second charter's,
// the path quarter, and the two voyage long charters last, because a
// voyage long charter scales the reward the voyage has actually built
// rather than the face value a round card already grew.
//
// Each percentage arm pays `reward + floor(reward * pct)` rather than
// `floor(reward * (1 + pct))`: the latter loses a coin to floating point
// on common rates (100 * 1.15 is 114.999... in binary), so a stated 15%
// quietly paid 14%. The Woven Monopoly keeps its own `floor(reward *
// 1.2)` written out, the exact arithmetic it has always applied.
//
// The reward passed in is the reward after VAT, which is where the
// settlement's first arm sits and what each arm scales in turn. The
// gates are read here rather than passed in: the woven tag (the same
// one the freight reads), the two charter waves (see the readers in
// ../pools for why the wave scopes live there), the any wave test the
// Bureau Token's text promises, and the path lock's own reader, which
// holds the D2 switch at this end too, since with path orders off no
// card is anyone's path order and no order pays the bonus. The pathless
// captain is asked about before the comparison rather than through it,
// since a null path matching a null derivation would pay a bonus for
// following no path at all.
export function orderRewardBonusSteps(
  state: GameState,
  order: OrderCard,
  rewardIn: number,
): { reward: number; steps: OrderRewardStep[] } {
  let reward = rewardIn;
  const steps: OrderRewardStep[] = [];
  // Each arm reads as `pay(card, pct)`: floor the uplift off the running
  // reward, add it, and record the step with its percentage as the whole
  // number the log prints.
  const pay = (cardId: string, pct: number) => {
    const amount = Math.floor(reward * pct);
    reward += amount;
    steps.push({ cardId, pct: Math.round(pct * 100), amount });
  };
  const hasCharterGood = order.resources.some((r) => isCharterGood(r.type));
  // [F2] The three charter reads are the one place in the engine F1's
  // rule does not reach, and the reason is that they are not about what
  // a good is but about when it arrived: a charter good is a good the
  // voyage's schedule opened, and which wave opened it is the tier's
  // fact rather than the good's. There is no tag for "arrived with the
  // second charter" and there should not be one, because a tag that
  // means a schedule would be the same good tagged differently in two
  // harbors. So the cards name their scope in their text (the first
  // charter's goods, the second charter's) and the scope is read off
  // the pool the schedule unlocks.
  //
  // Each charter boon asks about its own wave, not the charter as a
  // whole. The Bureau Token keeps the any wave test, which is what its
  // text promises: it names charter goods without naming a tier.
  const hasTier1Good = order.resources.some((r) => isTier1CharterGood(r.type));
  const hasTier2Good = order.resources.some((r) => isTier2CharterGood(r.type));
  const hasWoven = cargoCarriesTag(order.resources, "woven");
  // [F4: boons at milestone moments] Route Mastery, the boon the first
  // pathbound order deals: a quarter more on the orders that follow the
  // captain's own path, which is what the card's text promises.
  const followsPath =
    state.path !== null && pathOrderOf(order, state.mode) === state.path;
  if (hasModule(state, "silk_monopoly") && hasWoven) {
    const next = Math.floor(reward * 1.2);
    steps.push({ cardId: "silk_monopoly", pct: 20, amount: next - reward });
    reward = next;
  }
  if (hasTier1Good && state.modifierFlags.charter_order_bonus)
    pay("kiln_and_forge_guild", state.modifierFlags.charter_order_bonus);
  if (hasCharterGood && hasModule(state, "bureau_token"))
    pay("bureau_token", 0.1);
  if (hasTier2Good && state.modifierFlags.exotic_order_bonus)
    pay("exotic_treasures", state.modifierFlags.exotic_order_bonus);
  if (followsPath && state.modifierFlags.route_mastery)
    pay("route_mastery", state.modifierFlags.route_mastery);
  // [F6: charters at leg four] The Standing Manifest and the Quality
  // Mark, the two charters that pay on the reward itself, each taken as
  // the same `reward + floor(reward * pct)` the arms above them take and
  // landing last, because a voyage long charter scales the reward the
  // voyage has actually built rather than the face value a round card
  // already grew. The Manifest reads every completed order, which is its
  // whole text; the Mark reads the same woven gate the Woven Monopoly
  // reads above, so the mark and the cloth cannot come to disagree about
  // what counts as woven.
  if (state.modifierFlags.manifest_order_bonus)
    pay("standing_manifest", state.modifierFlags.manifest_order_bonus);
  if (hasWoven && state.modifierFlags.loom_sale_bonus)
    pay("quality_mark", state.modifierFlags.loom_sale_bonus);
  return { reward, steps };
}

/**
 * One order's money, read the way the settlement reads it: the pieces the
 * reward is made of, the reward itself, and what the run costs to carry
 * the goods.
 *
 * The reward is the number the harbor credits and the net is the number
 * the captain banks, so a panel that shows either of them is showing the
 * settlement's own arithmetic rather than a second reading of it.
 */
export type OrderQuote = {
  /**
   * The number the chain starts from: the card's face value, or the
   * payout a borrow would pay when the fill is a borrow.
   */
  basis: number;
  /**
   * The VAT the sale pays, taken off the basis before any bonus is
   * applied to what is left.
   */
  vat: number;
  /**
   * The VAT line by line, per unit, for the tooltip that shows where the
   * tax came from. Null where the order pays no VAT at all, which is a
   * card that sells nothing rather than a card that pays nothing.
   */
  vatBreakdown: PriceBreakdown | null;
  /**
   * The steps of the percentage bonus chain, one per arm that paid, for
   * the settlement's log.
   */
  bonusSteps: OrderRewardStep[];
  /**
   * The Broker's commission, taken last, and on the card's face value.
   */
  commission: number;
  /**
   * The commission as a share of the face value, the way the ledger
   * prints it.
   */
  commissionPct: number;
  /**
   * What the harbor credits for the goods: the basis, less the VAT, plus
   * the bonuses, less the commission.
   */
  reward: number;
  /**
   * What the run costs to carry the goods.
   */
  freight: number;
  /**
   * What the captain banks: the reward less the freight.
   */
  net: number;
};

/**
 * What an order pays, read through the one chain the settlement runs.
 *
 * Every surface that prices an order reads this: the settlement that
 * credits the money, the board's card, the advisor's sentence. The chain
 * is arithmetic with an order to it, and three copies of it is how the
 * board came to quote the face value (which adds the VAT back and
 * forgets the Broker's cut) while the fill credited something else, and
 * how the advisor's sentence came to name a figure the harbor was never
 * going to pay.
 *
 * The order the chain takes is the order the settlement has always taken,
 * and the order is the rule:
 *
 *   the borrow's penalty first, so every step below scales the reduced
 *     payout rather than the card's advertised one;
 *   the VAT next, per unit, off what is left;
 *   the percentage bonuses on what the VAT left, each arm scaling the
 *     running reward;
 *   the Broker's commission last, and on the card's face value, which is
 *     what the settlement has always charged it on;
 *   the freight outside the reward altogether, because the Salvage Crane
 *     can refund it and a refund is a roll at the fill, not a price.
 *
 * The crane's refund and the Tax Evasion audit are both rolls at the
 * fill, so no quote can carry them: the net here is the net before them.
 */
export function quoteOrder(
  state: GameState,
  order: OrderCard,
  options: { borrowed?: boolean } = {},
): OrderQuote {
  const basis = options.borrowed
    ? opportunistPayout(state, order.reward)
    : order.reward;
  // The taxed line is read once, and only a line that actually sells
  // something is taxed: a card with no resource lines, or a line without
  // a count, pays its reward and no VAT rather than dividing by an
  // absence and carrying a NaN payout into the ledger.
  const productRef = order.isProductOrder ? order.resources[0] : undefined;
  const productUnits = productRef?.required ?? 0;
  let vat = 0;
  let vatBreakdown: PriceBreakdown | null = null;
  if (productRef && productUnits > 0) {
    vatBreakdown = explainVAT(state, productRef.type, basis / productUnits);
    vat = vatBreakdown.final * productUnits;
  }
  const chain = orderRewardBonusSteps(state, order, basis - vat);
  // The commission is a share of the card's face value and not of what
  // the chain left, which is what the settlement has always charged it
  // on: a borrowed order pays less, and the Broker still takes his cut of
  // the advertised reward.
  const commission = order.isBrokerFavor
    ? brokersFavorCommission(order.reward)
    : 0;
  const commissionPct =
    order.reward > 0 ? Math.round((commission / order.reward) * 100) : 0;
  // The chain's own figure is the reward the bonuses were applied to, so
  // the commission comes off that rather than off the face value.
  const reward = chain.reward - commission;
  const freight = calcTransportCost(
    state,
    order.totalItems,
    cargoCarriesTag(order.resources, "woven"),
    fleetOfTreasuresUnits(state, order.resources),
  );
  return {
    basis,
    vat,
    vatBreakdown,
    bonusSteps: chain.steps,
    commission,
    commissionPct,
    reward,
    freight,
    net: reward - freight,
  };
}

export function completeOrder(
  state: GameState,
  orderId: number,
  logs: LedgerLine[],
  borrow = false,
) {
  const order = state.customerCards.find((o) => o.id === orderId);
  if (!order) return;
  if (state.completedOrders.includes(order.id)) return;
  // The lock is asked before the hold, and the order of the two matters: a
  // locked card whose goods the captain happens to be carrying is still not
  // theirs to fill, and telling them their inventory is short would be the
  // wrong sentence about the right refusal. The line is pathLockLine's, the
  // same string the board prints on the card, so the ledger and the board
  // cannot come to describe one refusal two ways.
  //
  // [D6: Free Captain: Opportunist] A locked card is fillable by exactly one
  // caller: a Free Captain who passed `borrow` and still has the allowance
  // (see canFillOrder, which is what the board offers this through, and
  // ./opportunist, which owns the allowance). The parameter defaults to
  // false, so a refusal that arrives from anywhere else is the flat one.
  const locked = lockedBehind(state, order);
  if (locked && !(borrow && opportunistMayBorrow(state, locked))) {
    logs.push(pathLockLedgerLine(locked));
    return;
  }
  const short = orderShortfall(state, order);
  if (short) {
    logs.push(
      line("❌ Inventory short! Need {short.type}×{short.required}", {
        "short.type": short.type,
        "short.required": short.required ?? 0,
      }),
    );
    return;
  }
  // Silk, and everything made from it, read off the woven tag rather than a
  // list written out here. The list this replaces had gone stale against
  // the recipe table: it named Cotton Clothes, which uses one Silk, and
  // missed Foreign Balm and Pearl String, which use one Silk each too.
  //
  // [F2: the card record, and the mode weighting field] The tag is the
  // vocabulary the two cards that read this now speak: the Woven Monopoly
  // module (which waives the freight) and Weaver's Winds (which halves it)
  // both say woven in their text, so the class of goods they cover is the
  // class the good carries rather than a second list that has to be kept
  // beside them.
  const hasWoven = cargoCarriesTag(order.resources, "woven");
  // The Fleet of Treasures discount is part of the freight read itself:
  // its units are counted off this manifest and passed in (see
  // fleetOfTreasuresUnits in ./pricing), so the Gold charged here and
  // every quote of it are one arithmetic. The discount used to be
  // subtracted from the quoted freight after the fact, which is how the
  // board came to quote one number and this fill charge another.
  const luxuryUnits = fleetOfTreasuresUnits(state, order.resources);
  // The order priced through the one reader every surface shares (see
  // quoteOrder above): the borrow's penalty, the VAT, the percentage
  // bonuses and the Broker's commission, in the order the settlement has
  // always taken them. The freight comes through the same read, so the
  // Gold charged here and the figures the board and the advisor print are
  // one arithmetic.
  const quote = quoteOrder(state, order, { borrowed: locked !== null });
  let transport = quote.freight;
  // Read through the same absence the shortfall check above reads: a line
  // without a count takes nothing, rather than subtracting an undefined
  // and poisoning every number the hold reports for the rest of the
  // voyage.
  for (const r of order.resources) state.inventory[r.type] -= r.required ?? 0;
  // The reward the fill credits, read out of the quote above.
  const reward = quote.reward;
  // [D6: Free Captain: Opportunist] The borrow's penalty lands on the face
  // value and before anything else touches the number, so every step
  // below (product VAT, the charter percentages, the Woven Monopoly) scales
  // the reduced payout rather than the card's advertised one. That is the
  // order the plan's own price implies: a captain who borrowed the order is
  // paid the borrowed order's reward, and a percentage bonus read off the
  // unreduced face value would quietly refund part of the penalty. The
  // quote above takes that penalty as its basis for exactly this reason.
  //
  // The spend sits at the same line as the payout, which is safe because
  // every guard above has already passed and nothing below can refuse: an
  // order that reaches this point is filled. A reload between the press and
  // the broadcast is covered by the completedOrders guard at the top, so the
  // allowance cannot be spent twice for one fill.
  if (locked) {
    state.opportunistBorrows += 1;
    logs.push(opportunistLedgerLine(state, order.reward, quote.basis));
  }
  // The VAT the sale pays, out of the quote above and into the captain's
  // books, and onto the ledger where it has always been written. The
  // taxed line itself is read once, in the quote: a card with no resource
  // lines, or a line without a count, pays its reward and no VAT rather
  // than dividing by an absence.
  if (quote.vatBreakdown) {
    state.vatPaid += quote.vat;
    logs.push(
      line("🧾 Product Sales VAT: {totalVat} Gold", { totalVat: quote.vat }),
    );
  }
  // The Fleet of Treasures receipt, read here so the line still lands
  // before the money moves. It reports the Gold the discount actually
  // took: the freight read again without the module's units, less the
  // freight just quoted. The floor at zero can shrink the subtraction
  // below the nominal per unit figure, so a line claiming the nominal
  // amount would overstate the discount on a run whose freight the floor
  // has already eaten; a receipt reports what moved.
  //
  // [F2] The two goods it named are the luxury tag now, which is the
  // class its own text promises, and the per unit number is the card's:
  // it sits in ./pricing beside the freight arithmetic it moves (see
  // CardEffect in ../constants/cards), so F2 moves the card's name and
  // its scope into the record and leaves the numbers it applies to the
  // engine that applies them.
  if (luxuryUnits > 0) {
    const freightOff =
      calcTransportCost(state, order.totalItems, hasWoven) - transport;
    if (freightOff > 0) {
      logs.push(
        line("{fleetLead}: {freightOff}g off freight", {
          fleetLead: (locale) => cardLead("fleet_of_treasures", locale),
          freightOff,
        }),
      );
    }
  }
  state.money -= transport;
  state.roundCosts += transport;
  state.totalCosts += transport;
  const origTransport = transport;
  // The percentage bonuses the reward carries, applied as one shared
  // chain: the quote above ran it, and every surface that quotes the
  // order reads that same quote, so the board's Reward and Net figures,
  // the planner's totals, the advisor's sentence and the Gold actually
  // credited here are one arithmetic. The log prints each step under the
  // lead its arm has always named.
  for (const step of quote.bonusSteps) {
    logs.push(
      line("{lead}: +{pct}% Reward!", {
        lead: (locale) => cardLead(step.cardId, locale),
        pct: step.pct,
      }),
    );
  }
  // [F4: boons at milestone moments] The path question, read once here
  // for the moment queue at the bottom of this function; the reward
  // chain above asks the same question about the same card through the
  // quote, which reads orderRewardBonusSteps, the reader every surface
  // shares. The gate is the lock's own reader rather than the card's raw
  // marker, so the D2 switch is held at both ends (with path orders off no
  // card is anyone's path order and no order pays the bonus), and the
  // pathless captain is asked about before the comparison rather than
  // through it, since a null path matching a null derivation would pay a
  // bonus for following no path at all.
  const followsPath =
    state.path !== null && pathOrderOf(order, state.mode) === state.path;
  if (hasModule(state, "salvage_crane") && Math.random() < 0.3) {
    state.money += transport;
    logs.push(
      line("{lead}: Refunded {transport} Gold transport!", {
        lead: (locale) => cardLead("salvage_crane", locale),
        transport,
      }),
    );
    transport = 0;
  }
  if (hasModule(state, "tax_evasion") && Math.random() < 0.15) {
    state.money -= 20;
    logs.push(
      line("🚨 AUDIT! {taxEvasionLead} triggered. Lost 20 Gold!", {
        taxEvasionLead: (locale) => cardLead("tax_evasion", locale),
      }),
    );
  }
  if (transport !== origTransport) {
    // Only the Salvage Crane above can move `transport`, and it has already
    // handed the Gold back. This trues up the cost ledger so the round's
    // freight total reflects the refund; it used to credit state.money a
    // second time here as well, paying every crane refund out twice.
    const diff = origTransport - transport;
    state.roundCosts -= diff;
    state.totalCosts -= diff;
  }
  // Broker's Favor commission: the Broker takes a cut of the order's
  // reward (see brokersFavorCommission, and the quote above that reads
  // it), so the captain's own money, revenue, and score all reflect the
  // amount net of the commission.
  if (order.isBrokerFavor) {
    logs.push(
      line("🤝 Broker's Commission ({pct}%): {commission} Gold", {
        pct: quote.commissionPct,
        commission: quote.commission,
      }),
    );
  }
  state.money += reward;
  state.roundRevenue += reward;
  state.totalRevenue += reward;
  state.score += Math.floor(reward - transport);
  // The Chronicle's "largest single trade" figure, folded from the reward
  // that was actually credited so it matches the log line the captain just
  // read rather than the card's face value.
  state.largestTrade = Math.max(state.largestTrade, reward);
  state.completedOrders.push(order.id);
  state.orderCount++;
  state.totalOrdersCompleted++;
  // [H6: the Manifest Audit] The line an audit may later read, written here
  // because this is the only moment the facts exist: which order, which
  // goods went into it and what it actually paid are all locals that the
  // settlement above has finished adjusting. The reward recorded is the one
  // that was credited rather than the card's face value, so a manifest line
  // shows what the order was worth to the captain after every modifier,
  // which is the same number the log line below prints.
  //
  // Trimmed on every push rather than only when the audit reads it, so the
  // save itself stays the size the sample expects and a long voyage does
  // not quietly accumulate an archive of every order its captain ever
  // filled.
  state.orderFills.push({
    round: state.currentRound,
    port: order.demandPort,
    // The engine's own reading of a missing count, the one canFillOrder
    // and the deduction above both take (`?? 0`): the fill record says
    // what was actually deducted rather than asserting a count onto a
    // line that does not carry one. The audit's reader drops a zero
    // line the same way it drops a non number, so the sample is
    // unchanged; what changes is that the save never holds a record
    // disagreeing with the settlement that wrote it.
    items: order.resources.map((r) => ({ type: r.type, qty: r.required ?? 0 })),
    reward,
  });
  state.orderFills = state.orderFills.slice(-AUDIT_WINDOW);
  // The goods are joined at the read rather than at the write, so the
  // list reads in the reader's language.
  const txt = joined(
    order.resources.map((r) =>
      line("{goodIcon}{r.type}×{r.required}", {
        goodIcon: ICONS[r.type],
        "r.type": line(r.type),
        "r.required": r.required ?? 0,
      }),
    ),
    () => " + ",
  );
  logs.push(
    line("📦 Completed Order at {order.demandPort}: {txt}", {
      "order.demandPort": order.demandPort,
      txt,
    }),
  );
  logs.push(
    line(
      "💰 Reward: {reward} Gold · ⚓ Freight: {transport} Gold = 📊 Net Profit: {netProfit} Gold",
      { reward, transport, netProfit: reward - transport },
      "   ",
    ),
  );
  logs.push(
    line("📊 Completed {state.orderCount} transactions", {
      "state.orderCount": state.orderCount,
    }),
  );
  // [MANIFEST 02: Word on the Docks] Fires exactly once per voyage, the
  // instant this captain's own running total crosses the threshold, whether
  // or not they actually turn out to be first in the harbor. The React layer
  // (see GameRoom.tsx) relays this as a claim to the server, which is the
  // one place that actually knows whether anyone else beat them to it.
  if (state.totalOrdersCompleted === WORD_ON_THE_DOCKS_THRESHOLD) {
    state._pendingDocksClaim = { total: state.totalOrdersCompleted };
  }
  // [F4: boons at milestone moments] The pathbound moment: the plan's
  // "first pathbound order", read as the captain's own order along their
  // path, which is what the moment's own copy promises ("Your first
  // order along your path is filled"). The same reading the bonus above
  // took, so a borrowed fill of another path's card is a fill rather
  // than a pathbound moment, and the trigger's own latch inside the
  // queue call keeps it to the once.
  if (followsPath) queueMilestoneMoment(state, logs, "pathbound_order");
}

// [MANIFEST 02: Word on the Docks] Applied only on the one client the
// server confirmed actually won the race (see the docks:won listener in
// GameRoom.tsx); every other client that also crossed the threshold just
// never receives this call, so a losing claim costs nothing and needs no
// rollback.
export function claimWordOnTheDocksReward(
  state: GameState,
  logs: LedgerLine[],
) {
  state.money += WORD_ON_THE_DOCKS_REWARD;
  logs.push(
    line(
      "📣 Word on the Docks: you were first to complete {WORD_ON_THE_DOCKS_THRESHOLD} trade orders this voyage! +{WORD_ON_THE_DOCKS_REWARD} Gold",
      { WORD_ON_THE_DOCKS_THRESHOLD, WORD_ON_THE_DOCKS_REWARD },
    ),
  );
}

// Broker's Favor: the Renown gated, once per voyage skill (see the flag on
// GameState and BROKERS_FAVOR_UNLOCK_LEVEL). Appends one extra standard trade
// order for a chosen quantity of a good this captain is currently holding,
// so a hold full of otherwise unsellable stock still has a guaranteed buyer.
// Like the paid Broker's Whisper guarantee in startOrders, it draws with
// this captain's own Math.random and only appends to their own
// customerCards, so it can never shift the shared, harbor wide market anyone
// else sees. Quantity is capped at the captain's own hold rather than the
// usual one to three or two to five order range, since
// brokersFavorCommission (see
// completeOrder) is what keeps an oversized ask from paying out too much,
// not a quantity limit.
export function callBrokersFavor(
  state: GameState,
  item: string,
  quantity: number,
  logs: LedgerLine[],
) {
  if (state.phase !== "orders") return;
  if (state.renownLevel < BROKERS_FAVOR_UNLOCK_LEVEL) {
    logs.push(
      line(
        "❌ Broker's Favor unlocks at Renown Level {BROKERS_FAVOR_UNLOCK_LEVEL}",
        {
          BROKERS_FAVOR_UNLOCK_LEVEL,
        },
      ),
    );
    return;
  }
  if (state.brokersFavorUsed) {
    logs.push(line("❌ You've already called in a Broker's Favor this voyage"));
    return;
  }
  const isRaw = (RESOURCES as readonly string[]).includes(item);
  const isProduct = (PRODUCTS as readonly string[]).includes(item);
  if (!isRaw && !isProduct) {
    logs.push(line("❌ The Broker can't find a buyer for {item}", { item }));
    return;
  }
  const held = state.inventory[item] || 0;
  if (held <= 0) {
    logs.push(
      line("❌ You have no {item} in the hold for the Broker to sell", {
        item,
      }),
    );
    return;
  }
  const qty = Math.floor(quantity);
  if (!Number.isFinite(qty) || qty < 1 || qty > held) {
    logs.push(
      line("❌ Choose between 1 and {held} {item} for the Broker to sell", {
        held,
        item,
      }),
    );
    return;
  }
  const localRng: Rng = Math.random;
  const order = isRaw
    ? genRawOrder(localRng, poolsFor(state), item, qty)
    : genProductOrder(localRng, poolsFor(state), item, qty);
  const nextId = nextCardId(state);
  state.customerCards.push({ id: nextId, ...order, isBrokerFavor: true });
  state.brokersFavorUsed = true;
  const txt = order.resources
    .map((r) =>
      t("{goodIcon}{r.type}×{r.required}", {
        goodIcon: ICONS[r.type],
        "r.type": r.type,
        "r.required": r.required ?? 0,
      }),
    )
    .join(" + ");
  logs.push(
    line(
      "🤝 Broker's Favor called in: a buyer at {order.demandPort} now wants {txt}. The bigger the ask, the bigger the Broker's cut.",
      { "order.demandPort": order.demandPort, txt },
    ),
  );
}

export function purchaseIntel(state: GameState, logs: LedgerLine[]) {
  // Sold on the Market board and only there, because that is the one screen
  // whose banner makes the promise this purchase depends on: the whisper is
  // cashed by startOrders below, so a rumor bought after the board is dealt
  // could never be honoured. The dialog can outlive the market leg, so the
  // engine refuses a late press rather than charging for it.
  if (state.phase !== "market") {
    logs.push(line("🔮 The Broker only deals during Market."));
    return;
  }
  if (!state.marketDemandTags.length) {
    logs.push(line("🔮 The Broker has no more whispers..."));
    return;
  }
  const cost = getIntelCost(state);
  if (state.money < cost) {
    logs.push(line("❌ Need {cost} Gold for a rumor", { cost }));
    return;
  }
  // One press is one purchase, and one fee: what the hull's modules
  // change is how many whispers the one purchase brings back. The
  // Brokers' Network brings two and the Ocean Interpreter adds a third
  // on the house, which is what the module's own card promises: a rumor
  // at 2 Gold that reveals two.
  const paidCount = hasModule(state, "brokers_network") ? 2 : 1;
  const count = paidCount + (hasModule(state, "ocean_relay") ? 1 : 0);
  // [bug cycle: one purchase, one fee] The fee is paid once, here, which
  // is the price the button that led to this press displayed and the
  // price the guard above checked against. It used to be billed inside
  // the loop, once per paid reveal, so a hull carrying the Brokers'
  // Network paid double the price its own button named, and a captain
  // holding more than one fee but less than two passed a guard that
  // only ever read one and left the press with a negative purse.
  state.money -= cost;
  for (let i = 0; i < count; i++) {
    if (!state.marketDemandTags.length) break;
    revealRumor(
      state,
      logs,
      "🗣️ Broker's Whisper: 'Word from {port}: High demand for {item}!'",
    );
    // [DIFFICULTY] Corrupt broker (Monsoon only). The rumor above is always
    // delivered and always true, on every tier: the intel guarantee is never
    // touched. What a corrupt broker does instead is also sell word of this
    // hold to the pirates, raising the round's raid chance once. Announced
    // plainly here rather than hidden, so the captain can price the risk.
    const cfg = difficultyConfig(state.difficulty);
    if (
      cfg.brokerCorruption &&
      !state.brokerTippedPirates &&
      Math.random() < cfg.brokerCorruptionChance
    ) {
      state.brokerTippedPirates = true;
      logs.push(
        line(
          "🕵️ That broker was corrupt. The word is good, but your position leaked: raid risk is up {riskPoints} points this round.",
          { riskPoints: Math.round(cfg.brokerCorruptionRisk * 100) },
        ),
      );
    }
  }
}

export function startOrders(
  state: GameState,
  ctx: GameContext,
  logs: LedgerLine[],
) {
  state.phase = "orders";
  state.orderCount = 0;
  state.completedOrders = [];
  logs.push(
    line("\n🤝=== Round {state.currentRound} · Orders: Trade Transaction ===", {
      "state.currentRound": state.currentRound,
    }),
  );
  // [ONLINE] Deterministic trade orders: this captain's seed, this voyage,
  // this round. The loop below reads nothing captain specific, so what
  // differs between two captains at the same table is the seed and nothing
  // else, which is what keeps a reload from dealing a fresh hand.
  const orderRng = createRng(
    `${ctx.seedBase}:V${state.voyageEpoch}:R${state.currentRound}:orders`,
  );
  state.customerCards = [];
  const orderPools = poolsFor(state);
  // [DIFFICULTY] Same widening as the port market above, applied to the trade
  // board, so both boards grow together as a tier's charter opens.
  const orderCount = marketCountsFor(
    state.difficulty,
    state.currentRound,
  ).order;
  for (let i = 0; i < orderCount; i++) {
    state.customerCards.push({ id: i, ...genMixedOrder(orderRng, orderPools) });
  }
  const extraOrders = state.modifierFlags.extra_order ?? 0;
  for (let i = 0; i < extraOrders; i++) {
    const nextId = orderCount + i;
    state.customerCards.push({
      id: nextId,
      ...genMixedOrder(orderRng, orderPools),
    });
    logs.push(
      line("{lead}: One extra order appeared.", {
        lead: (locale) => cardLead("merchants_converge", locale),
      }),
    );
  }
  // Broker's Whisper guarantee, applied after the seeded draw above and
  // entirely with this captain's own randomness, so it cannot shift the
  // drawn stream that produced the board. One order slot is overwritten per
  // rumor this captain has revealed and not yet cashed in this round
  // (see purchaseIntel), up to however many revealed items and order
  // slots there are; previously a single `intelOrderUsed` flag capped
  // this at one guarantee per round no matter how many rumors a captain
  // had revealed (Broker's Network reveals two per purchase), so the
  // second rumor's "guaranteed" order silently never appeared.
  //
  // Both halves of the rumor are honoured, which is the whole of what the
  // word guarantee means on the four screens that print it: the good the
  // whisper names is the good the card asks for (the generators' filter)
  // and the harbor it names is the harbor the card pays at
  // (portOverride). The port half used to be left to the draw, which
  // quietly made a word that reads as a fact ("Word from Tortuga: High
  // demand for Silk") false on every card that paid somewhere else.
  const guaranteedCount = Math.min(
    state.revealedIntel.length,
    state.customerCards.length,
  );
  for (let i = 0; i < guaranteedCount; i++) {
    const intel = state.revealedIntel[i];
    const localRng: Rng = Math.random;
    const guaranteed = (RESOURCES as readonly string[]).includes(intel.item)
      ? genRawOrder(localRng, orderPools, intel.item, undefined, intel.port)
      : genProductOrder(
          localRng,
          orderPools,
          intel.item,
          undefined,
          intel.port,
        );
    state.customerCards[i] = { id: state.customerCards[i].id, ...guaranteed };
  }
  // [DIFFICULTY] Imperial mandate: on the rounds this tier schedules one, the
  // Emperor commissions a single large order. Fixed template data with no rng,
  // appended after the seeded draw, so it shifts nobody's stream, and the same
  // template for everyone on that round, since the tier and round it reads are
  // the harbor's rather than this captain's. Flagged isProductOrder: false, since
  // an imperial levy is never charged VAT.
  const mandateIdx = mandateIndexFor(state.difficulty, state.currentRound);
  const mandate =
    mandateIdx === undefined ? undefined : MANDATE_TEMPLATES[mandateIdx];
  if (mandate) {
    const nextId = nextCardId(state);
    // Placed first rather than appended. It is the round's headline commission
    // and should read that way regardless of how wide the charter has grown
    // the board. Inserted after the intel guarantee loop above, which writes
    // by index, so it cannot be overwritten; card identity stays on `id`, so
    // position carries presentation only and no logic depends on it.
    state.customerCards.unshift({
      id: nextId,
      demandPort: mandate.port,
      resources: mandate.resources.map((r) => ({
        type: r.type,
        required: r.required,
      })),
      reward: mandate.reward,
      totalItems: mandate.resources.reduce((s, r) => s + r.required, 0),
      isProductOrder: false,
      isMandate: true,
    });
    const need = mandate.resources
      .map((r) =>
        t("{goodIcon}{r.type}×{r.required}", {
          goodIcon: ICONS[r.type],
          "r.type": r.type,
          "r.required": r.required,
        }),
      )
      .join(" + ");
    logs.push(
      line(
        "📜 Imperial Mandate at {mandate.port}: {need} for {mandate.reward} Gold. The Emperor's commission is exempt from VAT.",
        {
          "mandate.port": mandate.port,
          need,
          "mandate.reward": mandate.reward,
        },
      ),
    );
  }
  // [D2: the nine slot order board] The pathbound slots, filled last and
  // drawn from a stream of their own (`:pathorders` rather than `:orders`),
  // for the reason the intel guarantee above is applied after the seeded
  // draw rather than inside it: the six the tier schedules have to stay the
  // same six, seed for seed, so a table playing with the switch off is dealt
  // exactly the board it was dealt before this feature existed. Appended
  // rather than inserted, for the same reason and for one more: the mandate
  // reads as the round's headline, and the tier's own orders keep the
  // positions they have always held on the board.
  //
  // These cards are the board's invitation rather than its tax: each one
  // names a good the path's trade lives in and pays what that trade pays, so
  // a captain can see the whole of what holding the path would open without
  // a panel explaining it.
  if (pathOrdersOn(state.mode)) {
    const pathOrderRng = createRng(
      `${ctx.seedBase}:V${state.voyageEpoch}:R${state.currentRound}:pathorders`,
    );
    for (let i = 0; i < PATH_ORDER_SLOTS; i++) {
      const order = genPathOrder(pathOrderRng, orderPools);
      if (!order) break;
      const nextId = nextCardId(state);
      state.customerCards.push({ id: nextId, ...order });
    }
  }
}
