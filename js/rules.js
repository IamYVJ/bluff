// ============================================================================
// rules.js — The vocabulary of the game and the shape of a legal setup.
//
// Everything here is pure and imports nothing, so `node` can exercise it and the
// browser can load it without a build step. It is the bottom of the import
// graph: cards.js, claims.js, state.js, bot.js and guards.js all read from it
// and none of them are read back.
//
// TWO NUMBERS IN THIS FILE REACH FURTHER THAN THEY LOOK.
//
//   `decks` changes what is PROVABLE. At one deck a claim of five Kings is
//   impossible and therefore a certain lie; at two it is ordinary. Every bound
//   in the game — the bot's certainty check, the joker supply, the biggest legal
//   play — is a function of it, and nothing anywhere may hardcode "four of a
//   rank". Search this repo for the literal 4 and you will find it only in
//   SUITS.length and in the expressions that multiply it by decks.
//
//   `jokers` changes what a rank MEANS. In wild mode a joker satisfies any
//   claim, so the supply of every rank goes up by the joker count and claims
//   that look absurd become legal. In junk mode it satisfies nothing and is pure
//   hot potato. The mode is a host toggle rather than a house rule because the
//   two play completely differently and neither is obviously correct.
//
// See normalizeConfig() at the bottom for how the two are kept consistent with
// each other, and js/guards.js for the rules that are refused rather than
// tidied away.
// ============================================================================

// --- The table ------------------------------------------------------------

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;

// --- Card vocabulary ------------------------------------------------------

/**
 * Ranks in ASCENDING CLAIM ORDER, which is the only order this game has.
 *
 * Not "ace high" or "ace low" — there is no trick to win and no hand to
 * compare, so a rank has no value at all. What it has is a POSITION, because
 * the ascending rank rule walks this array from A to K and wraps back to A, and
 * the adjacent rule reads one step either side of it. Reorder this array and
 * you have changed both rules at once.
 *
 * 'T' rather than '10' so every code is exactly two characters and a card id is
 * a fixed width. rankLabel() puts the 10 back for display; nothing else in the
 * engine ever needs to.
 */
export const RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K']);

/**
 * Suits exist only so the deck has 52 cards and a card face has something to
 * draw. NOTHING in this game compares them, sorts by them or cares which one a
 * card is — a claim is a RANK, and four Kings of the same suit beat nothing
 * because there is nothing to beat.
 *
 * That is not a simplification, it is the rule, and it is load-bearing far
 * downstream: it is why a play can be sent over the wire as a multiset of ranks
 * instead of a list of card ids. See js/cards.js (takeByRank).
 */
export const SUITS = Object.freeze(['S', 'H', 'D', 'C']);

export const CARDS_PER_DECK = 52;

/**
 * The joker's rank token.
 *
 * Deliberately NOT in RANKS, and that single fact is the whole of "a joker is
 * never a claimable rank". claims.js generates legal claims out of RANKS, so
 * there is no code path that could offer 'X' as a claim and no guard needed to
 * refuse one — it is unrepresentable rather than forbidden.
 */
export const JOKER = 'X';

export function isJoker(rank) { return rank === JOKER; }

/** '10' for T, the token itself otherwise. Display only. */
export function rankLabel(rank) {
  if (rank === 'T') return '10';
  if (rank === JOKER) return 'JOKER';
  return rank;
}

// Spoken forms, for aria-labels and the live region. A screen reader saying
// "Q" is not the same as saying "Queen", and this game is played by ear as much
// as by eye — the claim is announced, not read.
const RANK_NAMES = Object.freeze({
  A: 'Ace', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven',
  8: 'Eight', 9: 'Nine', T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King',
  [JOKER]: 'Joker',
});
const RANK_PLURALS = Object.freeze({
  A: 'Aces', 2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes',
  7: 'Sevens', 8: 'Eights', 9: 'Nines', T: 'Tens', J: 'Jacks', Q: 'Queens',
  K: 'Kings', [JOKER]: 'Jokers',
});

export function rankName(rank, count = 1) {
  return count === 1 ? (RANK_NAMES[rank] || rank) : (RANK_PLURALS[rank] || rank);
}

const SUIT_NAMES = Object.freeze({ S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' });
export function suitName(suit) { return SUIT_NAMES[suit] || ''; }

// --- Config axes ----------------------------------------------------------

export const MAX_DECKS = 3;
export const MIN_DECKS = 1;

/** Two per deck is what a real pack ships with, so the ceiling follows the
 *  boxes rather than being invented. */
export const JOKERS_PER_DECK = 2;

/**
 * The hard ceiling on how many cards may be played at once, regardless of deck
 * count.
 *
 * `4 * decks` alone would allow twelve at three decks, which is legal in the
 * sense that the cards exist but is not a game — one player dumps their whole
 * hand in four turns and the bluffing never starts. Eight is the point at which
 * a claim still has to be believed rather than merely counted.
 */
export const MAX_PLAY_CEILING = 8;

export const RANK_RULES = Object.freeze({
  ascending: {
    label: 'Ascending',
    blurb: 'A, 2, 3 … K, then back to A. You do not choose the rank — only how many cards, and whether you are telling the truth.',
  },
  adjacent: {
    label: 'Adjacent',
    blurb: 'One above, one below, or the same as the last claim. K and A are neighbours.',
  },
  free: {
    label: 'Free',
    blurb: 'Claim any rank you like. The gentlest version, and the easiest to start with.',
  },
});

export const JOKER_MODES = Object.freeze({
  wild: {
    label: 'Wild',
    blurb: 'A joker matches whatever you claimed. Three sevens can be two sevens and a joker, and that is the truth.',
  },
  junk: {
    label: 'Junk',
    blurb: 'A joker matches nothing. You can still shed one unchallenged — but you lose every challenge it is in.',
  },
});

export const CHALLENGE_MODES = Object.freeze({
  window: {
    label: 'Open window',
    blurb: 'Everyone gets a few seconds to call it. First tap wins the race.',
  },
  next: {
    label: 'Next player',
    blurb: 'Only the player after you may call it, and doing so is their turn. No timers, no dead time.',
  },
});

/** Bounds on the open window. Three seconds is about the floor for a human to
 *  read a claim and decide; past twenty the table is waiting rather than
 *  thinking. */
export const MIN_WINDOW_MS = 3000;
export const MAX_WINDOW_MS = 20000;

/**
 * How long the revealed cards stay on screen after a challenge resolves.
 *
 * ENGINE STATE, NOT A UI ANIMATION, and deliberately not configurable.
 *
 * The reveal is the payoff of the entire game — it is the only moment anyone
 * finds out whether they were lied to — and without a hold the next player can
 * act immediately and wipe it off the screen before the table has read it. A
 * CSS transition would not do: every device has to agree that nobody may move
 * yet, or the player with the fastest thumbs decides how long everyone else
 * gets to look.
 *
 * Not configurable because there is no version of this anybody wants to tune,
 * and the lobby already has six axes.
 */
export const REVEAL_HOLD_MS = 3200;

// --- Names ----------------------------------------------------------------

/** Long enough for a real name, short enough that it cannot be used as a
 *  message. Collapses whitespace so a name of spaces is an empty name. */
export const MAX_NAME_LEN = 18;

export function cleanName(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}

export const DEFAULT_CONFIG = Object.freeze({
  decks: 1,
  jokers: 0,
  jokerMode: 'wild',
  maxPlay: 4,
  rankRule: 'ascending',
  challengeMode: 'window',
  windowMs: 5000,
});

/**
 * Presets cover HOW THE GAME PLAYS and deliberately leave decks, jokers and
 * maxPlay alone.
 *
 * Those three are a function of how many people are at the table, not of what
 * kind of game they want — a host who has set two decks for seven players did
 * not ask to be put back to one because they fancied the adjacent rule. Nudging
 * a preset must never undo a table-size decision.
 */
export const PRESETS = Object.freeze([
  {
    id: 'classic',
    label: 'Classic',
    blurb: 'I Doubt It as it is usually played: the rank marches on whether you hold it or not.',
    patch: { rankRule: 'ascending', challengeMode: 'window', windowMs: 5000 },
  },
  {
    id: 'cheat',
    label: 'Cheat',
    blurb: 'A little slack in the rank, and only the next player may call you. Quick and quiet.',
    patch: { rankRule: 'adjacent', challengeMode: 'next' },
  },
  {
    id: 'loud',
    label: 'Loud',
    blurb: 'Claim anything, and the whole table races to call it. Chaos, and the best one to learn on.',
    patch: { rankRule: 'free', challengeMode: 'window', windowMs: 6000 },
  },
]);

/** Which preset, if any, this config currently matches. Null means the host has
 *  edited it into something of their own, which is a legitimate state and not
 *  an error — see judgement's lobby for the same treatment. */
export function presetMatching(config) {
  for (const p of PRESETS) {
    if (Object.entries(p.patch).every(([k, v]) => config[k] === v)) return p.id;
  }
  return null;
}

// --- Derived bounds -------------------------------------------------------
//
// These four are THE ONLY PLACE the relationships between decks, jokers and
// maxPlay are written down. The lobby draws its steppers from them, the host
// clamps with them, the guards validate with them and the bot reasons with
// them, so a change here moves all four at once and none of them can drift.

/** Total cards on the table: whole decks plus loose jokers. */
export function deckSize(config) {
  return CARDS_PER_DECK * config.decks + config.jokers;
}

/** The most jokers this deck count may carry. */
export function jokerCap(decks) {
  return JOKERS_PER_DECK * clampInt(decks, MIN_DECKS, MAX_DECKS);
}

/** The most cards that may be played in one turn at this deck count. */
export function playCap(decks) {
  return Math.min(SUITS.length * clampInt(decks, MIN_DECKS, MAX_DECKS), MAX_PLAY_CEILING);
}

/**
 * How many cards of rank R could legitimately be in the deck at all.
 *
 * THE SINGLE MOST IMPORTANT NUMBER IN THE GAME, and the one every naive
 * implementation gets wrong by writing 4. It is the bound the bot proves a lie
 * against (js/bot.js), and it is what a human is doing in their head when they
 * decide whether "five Kings" is absurd — which is why the deck and joker
 * counts stay on screen during play and not just in the lobby.
 *
 * In wild mode every joker is a card that could satisfy a claim of ANY rank, so
 * it counts toward the supply of all thirteen ranks at once. That is not double
 * counting: the bound asks "could this many exist", not "how many exist in
 * total", and a single joker really could be the fifth King and the fifth Ace
 * on different turns.
 */
export function rankSupply(config) {
  return SUITS.length * config.decks + (config.jokerMode === 'wild' ? config.jokers : 0);
}

// --- Dealing arithmetic ---------------------------------------------------
//
// Pure counting, kept out of cards.js so the lobby can show the host what a
// setup will feel like before a single card exists. The derived line under the
// steppers is the most useful thing on that panel: three decks at three players
// is fifty-two cards each, and a host needs to find that out from a sentence
// rather than from a game.

/**
 * How many cards each seat starts with, by seat index.
 *
 * THE HANDS ARE UNEVEN AND THAT IS CORRECT. Every card is dealt — 52 × decks +
 * jokers of them — so unless the count divides exactly, the first `remainder`
 * seats hold one more than the rest. Do not try to even it up: holding back the
 * odd cards would mean a pile that starts non-empty and a supply bound that no
 * longer adds up, and both of those are visible in play.
 */
export function dealCounts(total, players) {
  const base = Math.floor(total / players);
  const extra = total % players;
  return Array.from({ length: players }, (_, i) => base + (i < extra ? 1 : 0));
}

/** The lobby's live line: "2 decks · 4 jokers · 6 players — 18 or 19 cards each
 *  to start". Recomputed on every config change AND on every join and leave,
 *  because the last clause moves when somebody sits down. */
export function describeDeal(config, players) {
  const total = deckSize(config);
  const bits = [
    plural(config.decks, 'deck'),
    config.jokers > 0 ? plural(config.jokers, 'joker') : 'no jokers',
  ];
  if (players < MIN_PLAYERS) {
    bits.push(`${total} cards`);
    return `${bits.join(' · ')} — seat ${MIN_PLAYERS} players to see the deal`;
  }
  bits.push(plural(players, 'player'));
  const counts = dealCounts(total, players);
  const low = counts[counts.length - 1];
  const high = counts[0];
  const each = low === high ? `${low} cards each` : `${low} or ${high} cards each`;
  return `${bits.join(' · ')} — ${each} to start`;
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// --- Turn direction -------------------------------------------------------

/**
 * Clockwise, as an EXPLICIT PARAMETER rather than a buried +1.
 *
 * The sibling repo courtpiece runs anticlockwise and judgement runs clockwise,
 * and the two engines are close enough to copy helpers between. A flipped sign
 * is wrong on every single turn and produces a game that still runs and still
 * finishes, so it is exactly the bug that survives a smoke test. Naming the
 * direction is cheap; finding it later is not.
 */
export const CLOCKWISE = 1;
export const ANTICLOCKWISE = -1;

export function nextSeat(seat, players, dir = CLOCKWISE) {
  return ((seat + dir) % players + players) % players;
}

/** Every seat once, starting at `from` and moving in `dir`. */
export function seatsFrom(from, players, dir = CLOCKWISE) {
  return Array.from({ length: players }, (_, i) => nextSeat(from, players, dir * i) );
}

// --- Config normalisation -------------------------------------------------

function clampInt(value, lo, hi) {
  const n = Math.floor(Number(value));
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(n, hi));
}

function pick(value, table, fallback) {
  return Object.prototype.hasOwnProperty.call(table, value) ? value : fallback;
}

/**
 * Clean an untrusted config into a playable, frozen one.
 *
 * REBUILT FROM A FIXED KEY LIST, so an unknown or hostile key is dropped rather
 * than stored. Same contract as judgement's normalizeConfig().
 *
 * ----------------------------------------------------------------------------
 * WHY `decks` AND `jokerMode` ARE NOT CLAMPED HERE, WHICH LOOKS LIKE A BUG
 *
 * Every other field falls back or clamps, on the reasoning that a host running
 * an older build should still get a game. These two do not: they pass through
 * whatever arrived, and js/guards.js REFUSES to lock the lobby on them.
 *
 * The reason is that they cannot arrive wrong by accident. The lobby's stepper
 * cannot produce `decks: 9` and the toggle cannot produce `jokerMode: 'chaos'`,
 * so a value outside the range is a tampered or badly-stale client and nothing
 * else. Clamping it to 3 would start a game that the sender believes is being
 * played under different rules, and the mismatch would surface as an argument
 * about a challenge rather than as an error message. Refusing to start says so
 * out loud, once, to the host who can do something about it.
 *
 * This is the one place in the family where "be liberal in what you accept" is
 * the wrong instinct, and it is because this game is adversarial by design.
 * ----------------------------------------------------------------------------
 *
 * The interdependent clamps DO happen here, and they happen on every call
 * rather than only when the relevant key is present. That is what makes
 * "lowering the deck count re-clamps the joker count in the same update" true
 * by construction: setConfig() spreads the patch over the old config and hands
 * the whole thing to this function, so a 3-deck joker count of 6 meets a
 * jokerCap of 2 the instant decks drops to 1 — no ordering to get right, and no
 * second update in which a 1-deck game briefly holds six jokers.
 */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  // Preserved rather than clamped — see the note above. A value that is not a
  // number at all is noise rather than tampering, so it lands on the default.
  const rawDecks = Math.floor(Number(c.decks));
  const decks = Number.isFinite(rawDecks) ? rawDecks : DEFAULT_CONFIG.decks;

  // Preserved rather than defaulted, for the same reason. A non-string is noise.
  const jokerMode = typeof c.jokerMode === 'string' ? c.jokerMode : DEFAULT_CONFIG.jokerMode;

  // Key order deliberately matches DEFAULT_CONFIG. Two configs that differ only
  // in insertion order are the same config, but JSON.stringify disagrees — and
  // the config is stringified for the wire and compared in the test suite, so a
  // reordered rebuild would show up as a spurious change on both.
  return Object.freeze({
    decks,
    // Both bounds are computed from `decks` on every call, which is the whole
    // re-clamp rule. jokerCap and playCap clamp `decks` into range themselves,
    // so even a nonsense deck count cannot make these allocate something absurd
    // in the window before the guard refuses the start.
    jokers: clampInt(c.jokers === undefined ? DEFAULT_CONFIG.jokers : c.jokers, 0, jokerCap(decks)),
    jokerMode,
    maxPlay: clampInt(c.maxPlay === undefined ? DEFAULT_CONFIG.maxPlay : c.maxPlay, 1, playCap(decks)),
    rankRule: pick(c.rankRule, RANK_RULES, DEFAULT_CONFIG.rankRule),
    challengeMode: pick(c.challengeMode, CHALLENGE_MODES, DEFAULT_CONFIG.challengeMode),
    windowMs: clampInt(
      c.windowMs === undefined ? DEFAULT_CONFIG.windowMs : c.windowMs,
      MIN_WINDOW_MS, MAX_WINDOW_MS,
    ),
  });
}

/** Human summary of the rules in force, for the log and for the play screen's
 *  config strip. A player cannot judge a claim without this. */
export function describeConfig(config) {
  const bits = [
    plural(config.decks, 'deck'),
    config.jokers > 0
      ? `${plural(config.jokers, 'joker')} (${JOKER_MODES[config.jokerMode]?.label.toLowerCase() || config.jokerMode})`
      : 'no jokers',
    `${RANK_RULES[config.rankRule]?.label.toLowerCase() || config.rankRule} ranks`,
    `up to ${plural(config.maxPlay, 'card')} a turn`,
  ];
  return bits.join(' · ');
}

// A deck that is not 52 cards would break every bound above, and the symptom
// would surface a long way from the cause. Cheap to check once at module load,
// in the browser and in `node` alike.
if (SUITS.length * RANKS.length !== CARDS_PER_DECK) {
  throw new Error('SUITS x RANKS must equal CARDS_PER_DECK');
}
