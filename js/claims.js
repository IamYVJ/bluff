// ============================================================================
// claims.js — Which ranks a player is allowed to CLAIM, and nothing else.
//
// PURE. No state, no config object, no engine, no clock. Every function here
// takes a rank rule and the previous claim and returns ranks. That narrowness
// is the point: the rank rule is the axis most likely to grow a fourth option
// one day, and when it does this is the only file that has to change.
//
// THE CLAIM IS A RANK, NEVER A CARD. What was actually put on the pile is a
// different question entirely and lives in js/state.js. Keeping the two apart
// in separate modules is what makes "the cards need not match the claim" — the
// whole game — a structural fact rather than something the engine remembers to
// allow.
//
// Jokers never appear here. RANKS does not contain the joker token, so no code
// path can generate one as a legal claim and no guard is needed to refuse one.
// ============================================================================

import { RANKS } from './rules.js';

/** Position of a rank in the ascending cycle, or -1. */
export function rankIndex(rank) { return RANKS.indexOf(rank); }

/**
 * The next rank up, wrapping K -> A.
 *
 * THE WRAP IS A RULE, NOT AN EDGE CASE. Under the ascending rank rule a game
 * routinely runs past the King — a table of three at two decks will go round
 * the cycle several times — so a `Math.min(i + 1, 12)` that sticks on K is not
 * a rare bug, it is a game that jams within the first few minutes. Tested
 * explicitly in both directions.
 */
export function nextRank(rank) {
  const i = rankIndex(rank);
  if (i < 0) return null;
  return RANKS[(i + 1) % RANKS.length];
}

/** The next rank down, wrapping A -> K. */
export function prevRank(rank) {
  const i = rankIndex(rank);
  if (i < 0) return null;
  return RANKS[(i - 1 + RANKS.length) % RANKS.length];
}

/**
 * Every rank that may legally be claimed next, in ascending order.
 *
 * `previous` is the rank of the last claim ON THE CURRENT PILE, or null when
 * the pile is empty. Null is not a special case to be tolerated, it is a state
 * the game enters several times a match: the pile empties every time a
 * challenge resolves, and the claim chain restarts with it.
 *
 * Returns an ARRAY rather than a predicate because the caller needs both. The
 * engine asks "is this claim legal" and the UI asks "which chips do I draw",
 * and if those were two functions they would eventually disagree about the
 * wrap. Same reasoning as legalTargets() in sequence's rules.js.
 */
export function legalClaims(rankRule, previous = null) {
  switch (rankRule) {
    case 'ascending':
      // Not a choice at all. The cycle opens on the Ace, which is where "I
      // Doubt It" has always started; after that the rank marches on whether
      // or not anyone holds it. That is the entire pressure of this rule —
      // most turns you are lying because you have to be, not because you
      // decided to.
      //
      // `previous` stays non-null across a pickup here, unlike under the pile
      // rules below, so this only sees null on the opening play of a deal.
      // See ruleFollowsSequence() for why that distinction is load-bearing.
      return previous === null ? [RANKS[0]] : [nextRank(previous)];

    case 'adjacent': {
      // An empty pile has no neighbour to be adjacent to, so the opening claim
      // is free. Anything else would need an arbitrary starting rank, and an
      // arbitrary rule is worse than a free one.
      if (previous === null) return RANKS.slice();
      const up = nextRank(previous);
      const down = prevRank(previous);
      // Returned in RANKS order rather than [down, same, up], so the UI draws
      // the chips in the same order it draws them under 'free' and a player
      // does not have to re-find the rank they wanted. Deduped because at a
      // hypothetical three-rank deck up and down would collide; harmless here,
      // and it keeps the function honest if RANKS ever shrinks.
      const allowed = new Set([down, previous, up]);
      return RANKS.filter((r) => allowed.has(r));
    }

    case 'free':
      return RANKS.slice();

    default:
      // An unrecognised rule reaching here means normalizeConfig() did not run,
      // which is a programming error rather than bad input. Returning "nothing
      // is legal" would surface as a player who simply cannot move, with no
      // message anywhere; throwing points at the line that skipped the
      // normalisation.
      throw new Error(`legalClaims: unknown rank rule ${JSON.stringify(rankRule)}`);
  }
}

/**
 * Whether the rule's chain belongs to the TURN ORDER rather than to the pile.
 *
 * ---------------------------------------------------------------------------
 * The two kinds of rank rule look alike from inside legalClaims() and behave
 * completely differently the moment somebody picks the pile up.
 *
 *   'adjacent' and 'free' are PILE rules. They ask what is lying on the table,
 *   and an empty table honestly means "play whatever you like". Resetting is
 *   not a gap in those rules, it IS those rules.
 *
 *   'ascending' is a SEQUENCE rule. A, 2, 3 and on round the table — that is
 *   how "I Doubt It" has always been played, and it is deliberately unmoved by
 *   what happens to the pile in between.
 *
 * Treating the second as though it were the first is a livelock, not a
 * blemish, and a headless bot game found it. If an empty pile restarts the
 * cycle at the Ace, a player holding no Aces across the table from a player
 * holding all four is stuck: they must claim an Ace, it is provably false, and
 * a caught liar takes the pile and leads (see _resolveChallenge in state.js) —
 * straight back into an empty pile and another forced Ace. Forty thousand
 * plays, one position, and no move available to anybody that changes it.
 * Carrying the rank across the pickup makes the forced rank different every
 * turn, so the trap cannot form in the first place.
 *
 * A predicate rather than `rankRule === 'ascending'` at the call site, for the
 * same reason claimIsForced() is one: a future sequence rule should inherit
 * the behaviour without anyone having to remember that state.js asks.
 * ---------------------------------------------------------------------------
 */
export function ruleFollowsSequence(rankRule) {
  return rankRule === 'ascending';
}

/** Whether one specific claim is allowed. The engine's check; derived from
 *  legalClaims so the two can never disagree. */
export function isLegalClaim(rankRule, previous, rank) {
  return legalClaims(rankRule, previous).includes(rank);
}

/**
 * True when the rank rule leaves the player no choice of rank.
 *
 * The UI needs this to know whether to draw a row of chips or a single forced
 * rank stated prominently. Asked as a question about the rule rather than
 * `rankRule === 'ascending'`, so a future forced rule gets the same treatment
 * without anyone having to remember this call site exists.
 */
export function claimIsForced(rankRule, previous = null) {
  return legalClaims(rankRule, previous).length === 1;
}
