// =====================================================================
// The wiring layer's part of the three priced markets.
//
// The three markets a captain can sell into (the refit bench, the
// module market and the escort market) ask the same questions in the
// same order, and the questions are the part of a market that is not
// its own: which captain an offer is aimed at, whether a second offer
// may stand, whether the captain who pressed may take the offer, and
// the whole frame of a post and of a take.
//
// What differs between the three is small and known: the name each
// market answers with, the event its refusals go out on, the phase it
// sells in, the term it names, and the bound it keeps on a captain.
// Those differences are the spec each market carries, and the frames
// are here, so that a change to the order of the questions is a change
// in one place rather than in three.
//
// The order is the part worth keeping in one place. Every refusal in
// it is a sentence a captain reads, and a market that asked its
// questions in a different order would refuse the same press for a
// different reason, which is a change to what the captain sees and not
// only to the code.
//
// The board machinery under them is ../consent's; these are the wiring
// layer's part, which is why they live here rather than in the board
// factory.
// =====================================================================

import {
  OFFER_FOR_ANOTHER_CAPTAIN,
  STALE_OFFER,
  TARGET_NOT_IN_HARBOR,
  consentFeeRule,
} from "@/lib/game/constants/copy";
import type { Socket } from "socket.io";

import { db } from "@/lib/db";
import {
  agreeConsent,
  consentFeeFor,
  consentOfferStanding,
  type ConsentTerms,
} from "@/lib/game/engine";
import { tFor, type Locale } from "@/lib/game/i18n";
import type { Phase } from "@/lib/game/types";
import { auditSpentLeg, auditSpentReason } from "../audit";
import { requireAuth, seated } from "../auth";
import { getCheckpoint } from "../checkpoint";
import { makeFail, marketOffRefusal, type MarketName } from "./fail";

type NamedBuyer =
  | { ok: true; buyerUserId: string | null; buyerName: string | null }
  | { ok: false; reason: string };

// The parts of an offer row the take rule reads: who the offer is aimed
// at, and the leg it was made in.
type OfferRow = Pick<ConsentTerms, "buyerUserId" | "round">;

// Resolves the captain a direct offer is aimed at, or the sentence that
// refuses the aim. No target is a valid answer rather than a refusal: that
// is the open offer the whole table can take. The self refusal is the
// caller's sentence, because each market words its own version of it, and
// the captain who is not in the harbor gets the one shared sentence, read
// in the language the caller names: that refusal answers the seller whose
// post it refused, so their socket's locale is the one it wants.
async function resolveNamedBuyer(
  roomId: string,
  sellerId: string,
  targetUserId: string | undefined,
  selfSentence: string,
  locale: Locale,
): Promise<NamedBuyer> {
  if (!targetUserId) {
    return { ok: true, buyerUserId: null, buyerName: null };
  }
  if (targetUserId === sellerId) {
    return { ok: false, reason: selfSentence };
  }
  const targetMember = await db.roomMember.findUnique({
    where: { userId_roomId: { userId: targetUserId, roomId } },
    select: { user: { select: { displayName: true } } },
  });
  if (!targetMember) {
    return { ok: false, reason: tFor(locale, TARGET_NOT_IN_HARBOR) };
  }
  return {
    ok: true,
    buyerUserId: targetUserId,
    buyerName: targetMember.user.displayName,
  };
}

// The refusal for a second offer to the same end, or null when the board
// holds none. Open and direct offers are told apart in the sentence, the
// same way the board's own bound tells them apart. Both sentences are the
// pack's own rows, read through the locale the caller names: the refusal
// answers the seller whose post it refused, so that captain's language is
// the one the caller's socket already holds.
function offerStandingRefusal<T extends ConsentTerms>(
  rows: T[],
  sellerId: string,
  buyerUserId: string | null,
  buyerName: string | null,
  locale: Locale,
): string | null {
  if (!consentOfferStanding(rows, sellerId, buyerUserId)) return null;
  return buyerUserId === null
    ? tFor(
        locale,
        "You already have an offer standing for anyone at this table.",
      )
    : tFor(locale, "You already have an offer standing for {buyerName}.", {
        buyerName: buyerName ?? "",
      });
}

// The refusal for an offer the captain may not take, or null when the
// offer is theirs to take.
//
// Two reasons, asked in the order the boards show them. An offer aimed at
// another captain is that captain's alone, and an offer left standing from
// an earlier leg is not this leg's to take. The first reaches only a
// direct offer, because an open offer is the whole table's to take.
//
// Both sentences are the pack's own rows, read through the locale the
// caller names: the refusal answers the captain who pressed, so that
// captain's socket holds the one it wants.
export function offerTakeRefusal(
  offer: OfferRow,
  userId: string,
  round: number,
  locale: Locale,
): string | null {
  if (offer.buyerUserId !== null && offer.buyerUserId !== userId) {
    return tFor(locale, OFFER_FOR_ANOTHER_CAPTAIN);
  }
  if (offer.round !== round) {
    return tFor(locale, STALE_OFFER);
  }
  return null;
}

// The wire a post arrives on. The market's own term rides in it, and the
// spec says which field that is.
type ConsentPostPayload = {
  roomId?: string;
  fee?: number;
  targetUserId?: string;
  good?: string;
  module?: string;
};

// The wire an agreement arrives on. The row's id arrives under the key
// the market names in its spec, because a wire field is a contract with
// every client already connected.
type ConsentAcceptPayload = {
  roomId?: string;
  [key: string]: unknown;
};

// What a market answers to the questions the post frame asks. Every field
// is a difference between the three markets, and nothing else is: the
// questions themselves, and the order they are asked in, are the same for
// all three and live in the frame below.
export type ConsentPostSpec<T extends ConsentTerms> = {
  // The market's board, read for the rows it holds.
  board: (roomId: string) => T[];
  // The market, for the sentence that says it is not running.
  market: MarketName;
  // The event a refusal goes out on.
  errorEvent: string;
  // Whether the market runs in this mode.
  on: (mode: unknown) => boolean;
  // The phase a post is made in.
  phase: Phase;
  // The sentence that refuses a post made in another phase, said in the
  // language the captain who pressed reads.
  phaseRefusal: (locale: Locale) => string;
  // The term a post names, where the market has one.
  term?: {
    // The term off the wire, or null where the wire carried none.
    read: (payload: ConsentPostPayload | undefined) => string | null;
    // Whether the term names something this market can trade.
    known: (term: string) => boolean;
    // The sentence that refuses a post naming nothing the market knows.
    refusal: (locale: Locale) => string;
  };
  // The audit's spend that closes this market, where it has one.
  auditSpend?: string;
  // The sentence that refuses a captain selling to themselves.
  selfRefusal: (locale: Locale) => string;
  // The market's own bound on a seller, where it has one.
  bound?: {
    // Whether the seller is already bound this leg.
    busy: (rows: T[], sellerId: string, term: string, round: number) => boolean;
    // The sentence that refuses a post from a bound seller.
    refusal: (locale: Locale) => string;
  };
};

// A post that passed every gate, and the facts the market's own row is
// built from.
type ConsentPost<T extends ConsentTerms> = {
  // The harbor the post was made in.
  roomId: string;
  // The captain who posted.
  sellerUserId: string;
  sellerName: string;
  // The captain the offer is aimed at, or null for an open offer.
  buyerUserId: string | null;
  buyerName: string | null;
  // The price, read through the fee rule.
  fee: number;
  // The leg and the phase the post was made in.
  round: number;
  phase: Phase;
  // The term the post named, or an empty string where the market has none.
  term: string;
  // The board as it stood when the post was made.
  rows: T[];
};

// The frame a post is answered in, and the one place the three markets
// ask the same questions in the same order.
//
// The order is the frame. The switch, the price, the term, the phase, the
// audit's spend, the captain the offer is aimed at, the seller's own
// bound and the standing offer are asked in that order, and each of them
// is a refusal a captain reads, so a market that asked them in another
// order would refuse the same press for another reason.
//
// Every refusal is sent on the market's own event and in the language of
// the captain who pressed, and a refusal that has already been sent ends
// the frame: the frame answers null, and the market's own handler stops
// there.
export async function postConsentOffer<T extends ConsentTerms>(
  socket: Socket,
  payload: ConsentPostPayload | undefined,
  spec: ConsentPostSpec<T>,
): Promise<ConsentPost<T> | null> {
  const s = seated(socket, payload);
  if (!s) return null;
  const { roomId } = s;
  const fail = makeFail(socket, roomId, spec.errorEvent);
  if (!spec.on(s.mode)) {
    fail(marketOffRefusal(spec.market, s.locale));
    return null;
  }
  // The fee is read through the same reader the panel reads it through,
  // so a posting form and a posting socket cannot disagree about what a
  // price is (see consentFeeFor).
  const fee = consentFeeFor(payload?.fee);
  if (fee === null) {
    fail(consentFeeRule(s.locale));
    return null;
  }
  // The term, where the market has one, is read against the game layer's
  // own table rather than bounded, because a term is a good rather than a
  // number, and a row naming a thing nobody can trade is a row nobody
  // could take.
  let term = "";
  if (spec.term) {
    const named = spec.term.read(payload);
    if (named === null || !spec.term.known(named)) {
      fail(spec.term.refusal(s.locale));
      return null;
    }
    term = named;
  }
  // The one await in this frame, and every check is after it, so nothing
  // between a check and the change it guards can yield.
  const cp = await getCheckpoint(roomId);
  if (cp.phase !== spec.phase) {
    fail(spec.phaseRefusal(s.locale));
    return null;
  }
  // The audit's spend closes this board on the tick it lands rather than
  // on the advance that follows it (see auditSpentLeg).
  if (spec.auditSpend !== undefined && auditSpentLeg(roomId, cp.round)) {
    fail(auditSpentReason(spec.auditSpend, s.locale));
    return null;
  }
  const named = await resolveNamedBuyer(
    roomId,
    s.userId,
    payload?.targetUserId,
    spec.selfRefusal(s.locale),
    s.locale,
  );
  if (!named.ok) {
    fail(named.reason);
    return null;
  }
  const { buyerUserId, buyerName } = named;
  const rows = spec.board(roomId);
  // The market's own bound, refused where the seller is the one who can
  // act on it.
  if (spec.bound && spec.bound.busy(rows, s.userId, term, cp.round)) {
    fail(spec.bound.refusal(s.locale));
    return null;
  }
  const standing = offerStandingRefusal(
    rows,
    s.userId,
    buyerUserId,
    buyerName,
    s.locale,
  );
  if (standing !== null) {
    fail(standing);
    return null;
  }
  return {
    roomId,
    sellerUserId: s.userId,
    sellerName: s.user.displayName,
    buyerUserId,
    buyerName,
    fee,
    round: cp.round,
    phase: cp.phase,
    term,
    rows,
  };
}

// What a market answers to the questions the accept frame asks.
export type ConsentAcceptSpec<T extends ConsentTerms> = {
  // The market's board, read for the rows it holds.
  board: (roomId: string) => T[];
  // The market, for the sentence that says it is not running.
  market: MarketName;
  // The event a refusal goes out on.
  errorEvent: string;
  // Whether the market runs in this mode.
  on: (mode: unknown) => boolean;
  // The payload key the row's id arrives under.
  idKey: "contractId" | "tradeId";
  // The phase an offer is agreed in.
  phase: Phase;
  // The sentence that refuses an offer taken in another phase.
  phaseRefusal: (locale: Locale) => string;
  // The sentence that refuses a row that is not on the board.
  missingRefusal: (locale: Locale) => string;
  // The sentence that refuses a row that is on the board and is not an
  // offer, where the market words those apart rather than as one.
  statusRefusal?: (row: T, locale: Locale) => string | null;
  // The sentence that refuses a captain taking their own offer.
  selfRefusal: (locale: Locale) => string;
  // The audit's spend that closes this market, where it has one.
  auditSpend?: string;
  // The market's own bound on a party, where it has one.
  busy?: (
    rows: T[],
    opening: T,
    userId: string,
    round: number,
    locale: Locale,
  ) => string | null;
};

// An agreement that was made, and the facts the market's own line about
// it is built from.
type ConsentAccepted<T extends ConsentTerms> = {
  // The harbor the offer was taken in.
  roomId: string;
  // The row as it stood before the agreement.
  opening: T;
  // The board as it stands after the agreement.
  rows: T[];
  // The captain who took the offer.
  taker: { userId: string; name: string };
};

// The frame an agreement is answered in, and the one place the three
// markets ask the same questions in the same order.
//
// The order is the frame, and it is the order the boards show: the
// switch, the phase, the row itself, whether the captain is the one
// selling, whether the offer is theirs to take, the audit's spend, the
// market's own bound, and then the agreement. A row that is not an offer
// is refused before the phase, because a captain pressing an offer that
// has already moved is owed that row's own answer rather than a
// sentence about the phase.
//
// The agreement itself is the engine's (see agreeConsent), so what the
// board holds afterwards is the game layer's answer and not this
// frame's.
export async function acceptConsentOffer<T extends ConsentTerms>(
  socket: Socket,
  payload: ConsentAcceptPayload | undefined,
  spec: ConsentAcceptSpec<T>,
): Promise<ConsentAccepted<T> | null> {
  const s = requireAuth(socket);
  if (!s) return null;
  const roomId = payload?.roomId ?? s.roomId;
  const id = payload?.[spec.idKey] as string | undefined;
  if (!roomId || roomId !== s.roomId || !id) return null;
  const fail = makeFail(socket, roomId, spec.errorEvent);
  if (!spec.on(s.mode)) {
    fail(marketOffRefusal(spec.market, s.locale));
    return null;
  }
  const cp = await getCheckpoint(roomId);
  // Synchronous from here down, so the offer cannot be taken by
  // somebody else between the read and the write: JavaScript runs
  // this block to the end before any other handler sees it.
  const rows = spec.board(roomId);
  const opening = rows.find((r) => r.id === id);
  if (!opening) {
    fail(spec.missingRefusal(s.locale));
    return null;
  }
  const status = spec.statusRefusal
    ? spec.statusRefusal(opening, s.locale)
    : null;
  if (status !== null) {
    fail(status);
    return null;
  }
  if (opening.sellerUserId === s.userId) {
    fail(spec.selfRefusal(s.locale));
    return null;
  }
  const takeRefusal = offerTakeRefusal(opening, s.userId, cp.round, s.locale);
  if (takeRefusal !== null) {
    fail(takeRefusal);
    return null;
  }
  if (cp.phase !== spec.phase) {
    fail(spec.phaseRefusal(s.locale));
    return null;
  }
  // An agreement made after the spend is trading the leg the harbor just
  // closed (see auditSpentLeg).
  if (spec.auditSpend !== undefined && auditSpentLeg(roomId, cp.round)) {
    fail(auditSpentReason(spec.auditSpend, s.locale));
    return null;
  }
  const busy = spec.busy
    ? spec.busy(rows, opening, s.userId, cp.round, s.locale)
    : null;
  if (busy !== null) {
    fail(busy);
    return null;
  }
  return {
    roomId,
    opening,
    rows: agreeConsent(rows, id, {
      userId: s.userId,
      name: s.user.displayName,
    }),
    taker: { userId: s.userId, name: s.user.displayName },
  };
}
