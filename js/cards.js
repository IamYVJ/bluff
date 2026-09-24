// ============================================================================
// cards.js — Building a multi-deck pack, dealing it out entirely, and the
// rank-grouped view of a hand that the whole UI is built on.
//
// Pure except shuffle(), which reads the platform CSPRNG through the same
// crypto.getRandomValues indirection sequence and judgement use, so the
// headless harness can swap in a seeded stream and reproduce a failing deal.
//
// THREE THINGS IN HERE ARE EASY TO GET SUBTLY WRONG:
//
//   1. THE SHUFFLE MUST COVER THE WHOLE ARRAY. Shuffling each 52-card deck and
//      concatenating leaves structure a player can feel — the first third of
//      the deal is one deck's worth of every rank — and at two decks that
//      changes what a claim of five Kings means. See buildDeck().
//
//   2. THE DEAL USES EVERY CARD. Hands come out uneven and that is correct.
//      See deal(), and dealCounts() in rules.js for the arithmetic the lobby
//      shows before any of this runs.
//
//   3. A HAND IS A MULTISET OF RANKS, NOT A LIST OF CARDS. Suits are
//      irrelevant in this game, so two Kings of different suits are genuinely
//      interchangeable. takeByRank() is where that stops being a remark and
//      starts being the wire format.
// ============================================================================

import { RANKS, SUITS, JOKER, CARDS_PER_DECK, nextSeat, CLOCKWISE } from './rules.js';

/**
 * A fresh, ORDERED pack: whole 52-card decks concatenated, then the jokers.
 *
 * Ordered on purpose. This is never dealt as-is — shuffle() is a separate call
 * every caller makes — and keeping the two apart is what lets the test suite
 * deal a known pack and read the turn direction straight out of the result.
 *
 * The deck index is part of the card id and nothing else. It exists so that
 * the Ace of spades from the first deck and the Ace of spades from the second
 * are distinguishable objects; no rule anywhere may read it, because at the
 * table those two cards are the same card.
 */
export function buildDeck({ decks, jokers }) {
  const pack = [];
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) pack.push({ id: `${rank}${suit}${d}`, rank, suit });
    }
  }
  // Appended after the decks rather than folded in, so `jokers` stays a loose
  // count that need not divide by the deck count. A host may ask for three
  // jokers across two decks and get exactly three.
  for (let j = 0; j < jokers; j++) {
    pack.push({ id: `${JOKER}${j}`, rank: JOKER, suit: null });
  }
  return pack;
}

/**
 * Fisher-Yates over the ENTIRE array, returning a new one.
 *
 * Called once, on the whole pack, never per-deck. The difference is not
 * theoretical at this table: a per-deck shuffle followed by a concatenation
 * guarantees that the first 52 cards dealt contain exactly one of every card,
 * so at two decks a player who has seen four Kings go past knows the next King
 * is in the second half. That is detectable structure in a game whose entire
 * subject is what other people can deduce.
 */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * A float in [0, 1), from the same source shuffle() draws on.
 *
 * The bot's only randomness, and it lives here rather than in bot.js so that
 * "what random means" is one decision in one file — swap the CSPRNG for a
 * seeded stream in the harness and the deal AND the bots both become
 * reproducible, which is what makes a failing game replayable.
 *
 * 2^30 rather than 2^32 so the modulo in randomBelow divides exactly and the
 * result is uniform. A biased bot would be a strange thing to debug.
 */
export function random01() {
  const SPAN = 1 << 30;
  return randomBelow(SPAN) / SPAN;
}

// Read at call time, not captured at module load, so a test can replace
// globalThis.crypto before constructing anything and still be obeyed.
function randomBelow(n) {
  try {
    const source = typeof crypto !== 'undefined' ? crypto : globalThis.crypto;
    if (source && source.getRandomValues) {
      const buf = new Uint32Array(1);
      source.getRandomValues(buf);
      return buf[0] % n;
    }
  } catch (_) { /* fall through */ }
  return Math.floor(Math.random() * n);
}

/**
 * Deal the whole pack out, one card at a time, round the table.
 *
 * EVERY CARD IS DEALT. There is no stock, no kitty and no talon — the pile
 * starts empty and the only cards in the game are the ones in people's hands.
 * That is what makes the bot's certainty check sound: `supply` in js/bot.js
 * counts cards in the deck, and it is only equal to cards in play because
 * nothing is held back here.
 *
 * HANDS COME OUT UNEVEN. 53 cards among 3 players is 18/18/17 and there is
 * nothing to fix: evening them up would mean leaving a card out, and a deck
 * that does not add up breaks the one deduction this game is made of. The
 * lobby says so in words before anyone starts — see describeDeal() in
 * rules.js — so the unevenness is expected rather than discovered.
 *
 * One at a time rather than in blocks, and in an explicit direction. Against a
 * shuffled pack the two are statistically identical; against an UNSHUFFLED one
 * they differ, which is what lets scripts/test-engine.mjs deal a known pack and
 * assert the table runs clockwise. That matters because courtpiece next door
 * runs the other way and these helpers are close enough to copy.
 */
export function deal(pack, { players, from = 0, dir = CLOCKWISE }) {
  if (!Number.isInteger(players) || players < 1) {
    throw new Error(`deal: ${players} is not a player count`);
  }
  const hands = Array.from({ length: players }, () => []);
  let seat = from;
  for (const card of pack) {
    hands[seat].push(card);
    seat = nextSeat(seat, players, dir);
  }
  return hands;
}

// ---------------------------------------------------------------------------
// The rank-grouped view — the primitive the entire hand UI is built on
// ---------------------------------------------------------------------------

/** How many cards of one rank a hand holds. */
export function countOf(hand, rank) {
  let n = 0;
  for (const c of hand) if (c.rank === rank) n++;
  return n;
}

/** Plain { rank: count } over a hand. The shape the bot reasons with and the
 *  shape the private state carries. */
export function handCounts(hand) {
  const counts = Object.create(null);
  for (const c of hand) counts[c.rank] = (counts[c.rank] || 0) + 1;
  return counts;
}

/**
 * A hand as ordered rank groups: [{ rank, count, cards }].
 *
 * THIS IS THE ANSWER TO THE BIGGEST LAYOUT PROBLEM IN THE REPO. Every other
 * card game in this family has a bounded hand — judgement caps at ten,
 * courtpiece at thirteen — but here a player who eats the pile can be holding
 * forty cards at one deck and something like eighty at three. Rendering a node
 * per card does not survive that on a phone at any font size.
 *
 * Grouping collapses any hand, however enormous, to at most fourteen rows. It
 * is also how a player actually thinks in this game: the question you ask of
 * your own hand is never "which cards do I have", it is "how many Kings do I
 * have", because that is the only question a claim can be answered with.
 *
 * Empty ranks are omitted rather than shown as zero rows — a fan of fourteen
 * rows of which nine are empty is the 80-card problem again in a different
 * costume.
 *
 * Jokers sort LAST, after the King, in both modes. In wild mode they are the
 * most valuable cards in the hand and in junk mode the most dangerous, and
 * either way the player wants them somewhere they will not be scrolled past.
 * Sorting them by value would mean the group moved when the host changed a
 * toggle, which is worse than either position.
 */
export function groupHand(hand) {
  const order = [...RANKS, JOKER];
  const byRank = new Map(order.map((r) => [r, []]));
  for (const c of hand) {
    const bucket = byRank.get(c.rank);
    // A card whose rank is not in the vocabulary cannot be produced by
    // buildDeck() and has nowhere sensible to be drawn. Dropping it silently
    // would hide a corrupted hand; there is no such thing as a card this
    // engine did not make, so this is a programming error.
    if (!bucket) throw new Error(`groupHand: unknown rank ${JSON.stringify(c.rank)}`);
    bucket.push(c);
  }
  return order
    .filter((r) => byRank.get(r).length > 0)
    .map((rank) => ({ rank, count: byRank.get(rank).length, cards: byRank.get(rank) }));
}

/** Flat, sorted by rank then suit. Used where a plain ordering is wanted —
 *  the grouped view is what the hand actually renders. */
export function sortHand(hand) {
  const order = [...RANKS, JOKER];
  return hand.slice().sort((a, b) => {
    const d = order.indexOf(a.rank) - order.indexOf(b.rank);
    if (d !== 0) return d;
    return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
  });
}

/**
 * Pull a multiset of ranks out of a hand.
 *
 * ----------------------------------------------------------------------------
 * WHY A PLAY IS SENT AS RANKS AND NOT AS CARD IDS
 *
 * Suits are irrelevant in Bluff. Two Kings in the same hand are not merely
 * similar, they are interchangeable in every way the rules can observe — there
 * is no trick to win with one, no flush to build, and the pile is face down.
 *
 * So the wire carries `['K', 'K', '7']` and the host picks which actual cards
 * those were. That buys three things:
 *
 *   * The client never needs card ids, so the hand UI can be built entirely out
 *     of rank groups and counts — which is what makes an 80-card hand tractable
 *     (see groupHand above).
 *   * There is no id to tamper with. A client cannot name a card it does not
 *     hold, because the only thing it can say is "two of my Kings", and this
 *     function refuses if it does not hold two.
 *   * The payload is a handful of characters rather than a list of identifiers,
 *     which matters on a data channel that may be running over a relay.
 *
 * Deterministic — first matching cards in hand order — so a replay of the same
 * game from the same snapshot puts the same physical cards on the pile. Nobody
 * can tell the difference, but a test can.
 *
 * Returns null rather than throwing when the hand is short. A short hand is the
 * ordinary case of a stale client sending a play it can no longer make, not a
 * programming error, and the caller turns it into a refusal message.
 * ----------------------------------------------------------------------------
 */
export function takeByRank(hand, ranks) {
  const need = Object.create(null);
  for (const r of ranks) need[r] = (need[r] || 0) + 1;

  const have = handCounts(hand);
  for (const r of Object.keys(need)) {
    if ((have[r] || 0) < need[r]) return null;
  }

  const remaining = { ...need };
  const taken = [];
  const rest = [];
  for (const c of hand) {
    if (remaining[c.rank] > 0) {
      remaining[c.rank]--;
      taken.push(c);
    } else {
      rest.push(c);
    }
  }
  return { taken, rest };
}
