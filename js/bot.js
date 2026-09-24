// ============================================================================
// bot.js — A computer player that lies, and catches liars.
//
// WHY A BOT EXISTS AT ALL
//   Bluff needs three people minimum and is much better with five. Two friends
//   in a room cannot start a game, and a table that loses somebody mid-evening
//   drops below the floor. Bots fill the seats. Playing solo against a table of
//   them works too, but that is the side effect rather than the point.
//
// WHAT MAKES THIS ONE DIFFERENT FROM THE SIBLINGS' BOTS
//   Every other bot in this family plays a game of perfect information badly.
//   This one plays a game of hidden information, and the hidden part is the
//   whole subject: a bot that always told the truth would be transparent within
//   two turns, and a bot that always lied would be free money. So there are two
//   halves here, and neither is optional:
//
//     choosePlay()      — when to tell the truth, when to lie, and what to shed
//     shouldChallenge() — when somebody else is provably or probably lying
//
// THE SHAPE, AND WHY IT IS THIS SHAPE
//   Both are PURE FUNCTIONS of the two views the engine already hands out:
//   publicState() and privateStateFor(). They read no engine internals, hold no
//   state between calls, and return a wire message — the same message a phone
//   would have sent. That buys three things:
//
//     1. THE BOT CANNOT SEE WHAT A PLAYER CANNOT SEE. This is the one that
//        matters here. The host's tab holds every hand, and a bot that reached
//        into engine.hands would be an undetectable cheat living inside the one
//        design weakness this game already has (see the README). Taking exactly
//        the same two objects a remote player's device receives makes that
//        structurally impossible rather than a rule somebody remembered.
//     2. No second copy of the rules. `pub.legalClaims` is the engine's own
//        answer to "what may be claimed", and `priv.counts` is the engine's own
//        count of the hand, so a bot cannot invent an illegal play — it only
//        ranks plays built out of what it was given.
//     3. It is testable without a socket or a clock: hand it two plain objects,
//        get an intent back.
//
// NO TIMERS IN THE SCORING, AND NO SCORING IN THE TIMER
//   The pause before a bot acts is the driver's business, at the bottom of this
//   file, and it follows the same no-timers-in-the-engine rule state.js does:
//   the driver is ticked by whoever owns the engine and time arrives as a
//   parameter.
//
// Node-safe: imports rules.js, cards.js, intents.js and state.js (for the phase
// names only), none of which touch the DOM. That is what lets the harness play
// thousands of games headlessly.
// ============================================================================

import { RANKS, JOKER, rankSupply } from './rules.js';
import { random01 } from './cards.js';
import { applyGameIntent } from './intents.js';
// Only for the phase names. state.js does not import this module, so there is
// no cycle — and taking the constant rather than writing 'play' here is what
// stops a renamed phase leaving the bots quietly asleep instead of failing.
import { PHASES } from './state.js';

// ===========================================================================
// PART ONE — CATCHING A LIAR
// ===========================================================================

/**
 * THE CERTAINTY CHECK. Is this claim arithmetically impossible?
 *
 * ---------------------------------------------------------------------------
 * This is the first thing the bot does and the most important thing it does,
 * because it is the one judgement it can make that is not a guess. A human at
 * this table does exactly the same sum: "one deck, I am holding two Kings, you
 * cannot have three."
 *
 *     claimedCount + accounted > supply   =>   it is a lie, with certainty
 *
 * THREE THINGS IN HERE ARE EASY TO GET WRONG, AND ALL THREE ARE TESTED:
 *
 *   1. `supply` IS NOT FOUR. It is four per deck, plus — in wild mode — every
 *      joker, because a wild joker can satisfy a claim of any rank. A bot that
 *      hardcodes four calls a perfectly ordinary two-deck claim a certain lie
 *      and looks broken. The number comes from rankSupply() in rules.js so that
 *      the literal lives in exactly one place in the repo.
 *
 *   2. THE BOT'S OWN WILD JOKERS COUNT AGAINST THE CLAIMER. They inflate the
 *      supply for everybody, so if the bot is holding them, they are not
 *      available to the person claiming. Forgetting this makes the bound too
 *      loose and the bot misses lies it could have proved.
 *
 *   3. REVEALED CARDS TIGHTEN THE BOUND — see revealedElsewhere() below, which
 *      is where most of the subtlety in this file lives.
 *
 * The bound is deliberately CONSERVATIVE at every step. A false positive here
 * is the worst bug this file could have: the bot would challenge something that
 * is true, lose, and look stupid in a way that a human can see and a test
 * cannot. Wherever the arithmetic is uncertain, this function assumes less.
 * ---------------------------------------------------------------------------
 */
export function claimIsImpossible(pub, priv) {
  if (!pub || !priv || !pub.claim) return false;
  const wild = pub.config.jokerMode === 'wild';
  const counts = priv.counts || {};
  const rank = pub.claim.rank;

  const supply = rankSupply(pub.config);
  const accounted = (counts[rank] || 0)
    + (wild ? (counts[JOKER] || 0) : 0)
    + revealedElsewhere(pub, priv, rank, wild);

  return pub.claim.count + accounted > supply;
}

/**
 * How many cards that could satisfy `rank` are PROVABLY in somebody else's hand
 * because the table watched them go there.
 *
 * ---------------------------------------------------------------------------
 * `pub.seen` is the engine's memory of the last resolved challenge: counts by
 * rank, and the seat that picked them up. Turning that into a sound bound takes
 * three separate subtractions, and skipping any of them makes the bot challenge
 * things that are true.
 *
 *   * IF WE TOOK THEM, they are in our own hand and priv.counts has already
 *     counted them. Counting them again is a double count, and it is the one
 *     that fires most often — the bot eats a pile, then immediately "proves"
 *     the next claim impossible.
 *
 *   * IF THE CLAIMER TOOK THEM, they are available to this very claim and must
 *     not be subtracted at all. This is the opposite mistake and it is worse:
 *     it makes the bound too tight, which is a confident, wrong challenge.
 *
 *   * IF A THIRD PLAYER TOOK THEM they may already have played them again,
 *     because the table kept turning after the pickup and came back round to
 *     them. So the count decays, and the only honest thing
 *     to subtract is what they cannot have got rid of yet. The pile is exactly
 *     the cards played since the pickup, so walking the claim history back over
 *     the current pile says precisely how many cards the taker has laid down.
 * ---------------------------------------------------------------------------
 */
function revealedElsewhere(pub, priv, rank, wild) {
  const seen = pub.seen;
  if (seen && pub.claim && seen.takerId === pub.claim.playerId) return 0;
  return revealedAgainst(pub, priv.playerId, rank, wild);
}

/**
 * The same number, from an arbitrary seat's point of view rather than our own.
 *
 * Split out because choosePlay() needs it pointed at ITSELF: "how much of this
 * claim can the rest of the table already account for, and therefore how few
 * cards do they each need in hand before my lie is not a guess but a proof?"
 * Without that, the bot's model of being caught runs on the supply it would see
 * at the start of the game, and it will keep telling a lie that every opponent
 * can disprove on sight — which measured as 1467 provable lies in 1496 plays,
 * a game that never ends.
 *
 * ONE COUNT SERVES EVERY OPPONENT, which is not obvious but is exact. If the
 * taker was a third party, every other seat credits the cards to them. If the
 * taker was one of the opponents, that opponent is holding them, which their
 * own certainty check counts identically. And if the taker was US, the answer
 * is zero for everybody — the cards are in our hand and available to this very
 * claim, which is the case the caller passes its own id to exclude.
 */
function revealedAgainst(pub, viewerId, rank, wild) {
  const seen = pub.seen;
  if (!seen || !seen.counts) return 0;
  if (seen.takerId === viewerId) return 0;

  const raw = (seen.counts[rank] || 0) + (wild ? (seen.counts[JOKER] || 0) : 0);
  if (raw === 0) return 0;
  return Math.max(0, raw - cardsPlayedSincePickupBy(pub, seen.takerId));
}

/**
 * THE SAME DEDUCTION, POINTED THE OTHER WAY: how many cards that could satisfy
 * `rank` the CLAIMER is known to hold, because the table watched them pick
 * them up.
 *
 * ---------------------------------------------------------------------------
 * This is the reason a game between bots finishes. Without it, a challenge
 * hands the four Aces to whoever picked the pile up, they play the four Aces
 * truthfully, the plausibility heuristic correctly reports that four Aces at
 * one deck is a wild thing to claim, somebody calls it, and the four Aces move
 * to the next seat — where the whole thing happens again. Two thousand plays,
 * nothing shed, nobody out.
 *
 * What is missing there is not caution, it is memory. Four Aces is only a wild
 * claim from somebody who has not just been handed four Aces in front of
 * everybody. A human never falls for this; they say "well, of course you have
 * them" and let it stand, and that is all this is.
 *
 * The last play is EXCLUDED from the decay, unlike in revealedElsewhere(). The
 * cards being judged are the claim itself, and subtracting them would prove
 * that the claimer cannot hold what they have just laid down — which is
 * circular, and gets the answer exactly backwards.
 * ---------------------------------------------------------------------------
 */
function knownHeldBy(pub, playerId, rank, wild) {
  const seen = pub.seen;
  if (!seen || !seen.counts || seen.takerId !== playerId) return 0;
  const raw = (seen.counts[rank] || 0) + (wild ? (seen.counts[JOKER] || 0) : 0);
  if (raw === 0) return 0;
  return Math.max(0, raw - cardsPlayedSincePickupBy(pub, playerId, 1));
}

/**
 * How many cards `playerId` has put on the current pile.
 *
 * The pile was emptied by the pickup, so every card on it now was played after
 * it. Walking claimHistory backwards until the counts add up to pileSize
 * recovers exactly which plays those were.
 *
 * claimHistory is a rolling window, so it can run out before the sum is
 * reached. That is not an error — it is an old, long pile — and the answer then
 * is the conservative one: assume every card on the pile came from this player.
 * Both callers read that the same way: it subtracts everything, which gives up
 * the deduction rather than guessing at it.
 *
 * @param skipLast how many of the most recent plays are the thing being judged
 *                 rather than evidence about it. See knownHeldBy().
 */
function cardsPlayedSincePickupBy(pub, playerId, skipLast = 0) {
  const history = pub.claimHistory || [];
  const judged = history.length - skipLast;
  let remaining = pub.pileSize;
  let mine = 0;
  for (let i = history.length - 1; i >= 0 && remaining > 0; i--) {
    const entry = history[i];
    remaining -= entry.count;
    if (i < judged && entry.playerId === playerId) mine += entry.count;
  }
  return remaining > 0 ? pub.pileSize : mine;
}

// --- The guess, for when there is no proof ---------------------------------
//
// Everything below the certainty check is judgement, and it is deliberately
// expressed as one number — how far the claim is stretched beyond what an
// average hand would hold — compared against a bar that moves with the cost of
// being wrong. Every constant is a multiplier on that comparison, so they can
// be read against each other rather than in isolation.

/**
 * How far past the expected holding a claim must reach before it smells. A
 * claim of exactly what an average hand would hold is 1.0.
 *
 * DELIBERATELY HIGH, and it was tuned down from a much lower number by
 * measurement rather than taste. At 2.6 the heuristic fired on 319 claims
 * across a thousand plays and was WRONG on 313 of them, while the certainty
 * check above was right on all 325 of its own. That is the honest shape of the
 * signal: the expected-holding calculation assumes the claimer's hand is a
 * random sample of the cards we cannot see, and after one pile has changed
 * hands it is nothing of the kind — piles are rank-concentrated, because
 * everybody spent the round playing the same forced rank into them. So a player
 * holding all four Aces is common rather than remarkable, and a bot that finds
 * it remarkable spends the whole game handing that player the pile.
 *
 * The number that makes this heuristic worth having is not this one. It is the
 * ENDGAME multipliers below, where a small hand makes `expected` tiny and the
 * stretch enormous, which is exactly when a call is worth making.
 */
const CALL_BAR = 3.2;

/**
 * How much each ADDITIONAL eligible challenger raises the bar.
 *
 * Every bot at the table is running this same function against the same public
 * state at the same instant, so a bar that is right for one opponent is far too
 * low for seven: at a personal 30% the table calls 92% of everything, and no
 * hand ever empties. Each bot has to aim at the rate it wants the TABLE to
 * produce, not the rate it would pick on its own — which means being quieter in
 * a crowd. A human does this without thinking, by noticing that somebody else
 * will probably call it.
 */
const CROWD_CAUTION = 0.22;

/** How much a big pile raises the bar. Measured in average starting hands, not
 *  in cards, so it means the same thing at one deck and at three. */
const PILE_CAUTION = 0.8;

/** The claimer is one unchallenged window away from winning the game. Almost
 *  nothing is worth not calling: if the claim is true they win either way, so
 *  the only thing a challenge costs is a pile in a game that was already over. */
const LAST_CHANCE = 0.2;

/** A claimer down to a card or two is dangerous for the same reason, less so. */
const CLOSING_IN = 0.7;

/** Spread on the bar, per bot, per decision. Without it every bot at the table
 *  reaches the same verdict at the same instant and the table reads as one
 *  opponent with several names. */
const BAR_JITTER = 0.5;

/**
 * A floor under the expected holding, and it is load-bearing in the endgame.
 *
 * `expected` is a mean under a uniform prior: this many copies are loose, that
 * fraction of the unseen cards is in their hand, multiply. It is a decent
 * yardstick for a full hand and it FALLS APART for a short one, because a
 * player down to two cards has spent the whole game choosing which two. The
 * prior says they hold 0.17 Aces, so a claim of one Ace scores a stretch of
 * six and every bot at the table calls it — and the player who has fought their
 * way down to two cards can never make a play that stands, at any deck count,
 * under any rule.
 *
 * The floor says the quiet part: a claim of ONE CARD is never intrinsically
 * remarkable, whoever makes it. What makes the last play worth calling is not
 * that it is implausible, it is that there is nothing left to lose by being
 * wrong — and that is LAST_CHANCE's job, a few lines down, where it belongs.
 */
const MIN_EXPECTED = 0.5;

/**
 * How often a bot lets a PROVABLE lie go when winning the call would buy it
 * nothing — and the one number in this file that exists to keep the game
 * finishable rather than to make the bot play better.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR. Under the ascending rule there is a position the table can
 * reach from which correct play never escapes. Every rank comes to live
 * entirely in one hand — all eight Sevens here, all eight Jacks there — and
 * once that happens the game is closed:
 *
 *   * a player whose turn lands on a rank they own plays the whole block
 *     truthfully, and it goes on the pile;
 *   * a player whose turn lands on a rank they do not own MUST lie, because
 *     ascending gives them no other rank to claim;
 *   * the owner of that rank holds every copy of it, so `claimed + 8 > 8` for
 *     any claim at all — the lie is provable at any size, by exactly one
 *     player, every single time;
 *   * the liar picks the pile up and gets back precisely the cards they laid
 *     down, so the blocks stay whole.
 *
 * Nothing in that loop can break a block, because a block is only broken by
 * shedding part of one and no bot ever holds cards back. Measured: a game
 * driven to 316,000 plays and still perfectly partitioned, hands sloshing
 * between 17 and 81 cards and no hand ever emptying.
 *
 * Forming it needs `maxPlay` to reach a rank's whole supply, so that a truthful
 * play can ship a complete block and a pickup can deliver several. That is true
 * at one and two decks, where `playCap` is 4 and 8 and the supply is also 4 and
 * 8, and false at three, where a block is twelve against a cap of eight and a
 * remainder always stays behind. Every instance actually reproduced was at two
 * decks and three players — a short table concentrates the hands — and the rate
 * was about one game in four thousand. Dropping `maxPlay` by one finishes the
 * same deal in 37 plays.
 *
 * The same change also cleared a separate cluster of unfinished games at three
 * decks and a maxPlay of two, which cannot be this position and was never
 * diagnosed past "correct play, no progress". Both are the same shape: nothing
 * illegal, nothing thrown, and no winner.
 *
 * WHY IT IS PRICED HERE RATHER THAN VALVED IN. Certainty tells you the claim is
 * false. It does not tell you the call is worth making, and those are different
 * questions. What a won challenge actually buys is the pile — the claimer picks
 * up everything, including what they just laid down — so against letting the
 * claim stand it gains you exactly `pileSize`. On a pile of two that is two
 * cards off one opponent, in exchange for announcing that you hold the rank and
 * resetting the only thing at this table that makes hands uneven. On a pile of
 * forty it is the game. The bot was treating those as the same decision.
 *
 * So the slip decays with the prize and is never large: on a bare pile the bot
 * still calls six provable lies in seven, and once the pile is worth a starting
 * hand, more than twelve in thirteen. That is enough, because escaping the
 * partition needs only ONE lie to stand ONCE — the cards under it are then
 * split between a hand and the pile, and that block is gone for good.
 *
 * It also brings shouldChallenge() back into step with choosePlay(), which has
 * never believed this anyway: CALL_CEIL caps an opponent's chance of calling at
 * 95% precisely so the bot does not refuse lies worth telling. The model was
 * right and the behaviour was the thing out of step.
 *
 * Deliberately not applied when the claimer is going out. There the prize is
 * not the pile, it is the game, and LAST_CHANCE above says so already.
 */
const CERTAIN_SLIP = 0.15;

/**
 * Is a provable lie worth calling? See CERTAIN_SLIP. Almost always yes.
 */
function callTheCertainLie(pub, rnd) {
  const claimer = pub.players.find((p) => p.id === pub.claim.playerId);
  // Nobody walks out on an unchallenged final play, and a hand of one or two
  // is the same argument a beat later.
  if (!claimer || claimer.handCount <= 2) return true;
  const avgHand = Math.max(1, pub.deckSize / pub.players.length);
  return rnd() >= CERTAIN_SLIP / (1 + pub.pileSize / avgHand);
}

/**
 * Should this bot call the current claim a lie?
 *
 * Priority order, and the order is the design:
 *   1. Certainty — the claim cannot be true. Call it, bar the rare case where
 *      winning the call would buy nothing at all; see CERTAIN_SLIP.
 *   2. Plausibility — how far past a normal holding the claim reaches, scaled
 *      by the deck count through `supply` rather than hardcoded.
 *   3. Pile size — being wrong costs you the pile, so a big pile buys silence.
 *   4. The claimer's hand — somebody about to go out has to be called.
 *
 * @param rnd injected so a test can pin the jitter. Defaults to the same
 *            source the deck is shuffled from.
 */
export function shouldChallenge(pub, priv, rnd = random01) {
  if (!pub || !priv || !priv.canChallenge || !pub.claim) return false;
  if (claimIsImpossible(pub, priv)) return callTheCertainLie(pub, rnd);

  const cfg = pub.config;
  const wild = cfg.jokerMode === 'wild';
  const claim = pub.claim;
  const counts = priv.counts || {};

  const revealed = revealedElsewhere(pub, priv, claim.rank, wild);
  const accounted = (counts[claim.rank] || 0)
    + (wild ? (counts[JOKER] || 0) : 0)
    + revealed;
  // Copies that could be anywhere we cannot see — including, but not only, the
  // claimer's hand.
  const loose = Math.max(0, rankSupply(cfg) - accounted);
  if (loose === 0) return true;   // unreachable: the certainty check caught it.

  const claimer = pub.players.find((p) => p.id === claim.playerId);
  if (!claimer) return false;

  // How much of this claim the table has already SEEN in the claimer's hand.
  // A claim that is entirely accounted for is not a bold claim, it is a
  // bookkeeping exercise, and calling it is how a bot hands somebody the pile.
  const unexplained = claim.count - knownHeldBy(pub, claim.playerId, claim.rank, wild);
  if (unexplained <= 0) return false;

  // The claimer's hand BEFORE the play, because that is the hand the cards came
  // out of. Using the post-play count understates it by exactly the claim.
  const before = claimer.handCount + claim.count;
  // Cards whose location we do not know: everything except our own hand and the
  // revealed cards we have just placed elsewhere.
  const unknown = Math.max(1, pub.deckSize - priv.hand.length - revealed);
  // A plain hypergeometric mean. Not a probability — a yardstick. "How many of
  // this rank would a hand that size normally be holding?"
  const expected = (loose * before) / unknown;
  const stretch = unexplained / Math.max(expected, MIN_EXPECTED);

  return rnd() < callChance(stretch, callBar(pub, claimer.handCount));
}

/**
 * How high the stretch has to reach before this claim is worth calling.
 *
 * Split out of shouldChallenge() so that choosePlay() can call the very same
 * function when it asks "how suspicious will this play look?". Two separate
 * expressions of the same judgement is how a bot ends up telling lies it would
 * itself have called — see the note on `caught` in score().
 *
 * `claimerHand` is the hand size AFTER the play, which is what the public
 * state reports and what makes the going-out case recognisable.
 */
function callBar(pub, claimerHand) {
  const avgHand = Math.max(1, pub.deckSize / pub.players.length);
  let bar = CALL_BAR + (pub.pileSize / avgHand) * PILE_CAUTION;
  // In 'next' mode the decision is ours alone and there is no crowd to defer
  // to, so this term correctly vanishes: rivals is 0 and the bar is unchanged.
  const rivals = pub.config.challengeMode === 'next'
    ? 0
    : Math.max(0, pub.players.length - 2);   // everyone but us and the claimer
  bar *= 1 + rivals * CROWD_CAUTION;
  if (claimerHand === 0) bar *= LAST_CHANCE;
  else if (claimerHand <= 2) bar *= CLOSING_IN;
  return bar;
}

/**
 * The probability that a bar-and-jitter comparison comes out as a challenge.
 *
 * EXACT, not a model of itself. The decision is `stretch > bar * U` for U
 * uniform on [1 - J/2, 1 + J/2], so the chance of firing is just where
 * stretch/bar falls across that interval. shouldChallenge() draws from it and
 * choosePlay() reads it as a number, and because it is the same arithmetic the
 * two can never drift into disagreeing about how bold a claim is.
 */
function callChance(stretch, bar) {
  if (!(bar > 0)) return 1;
  return clamp((stretch / bar - (1 - BAR_JITTER / 2)) / BAR_JITTER, 0, 1);
}

// ===========================================================================
// PART TWO — TELLING A LIE
// ===========================================================================
//
// A play is scored on four things, and the whole personality of the bot is in
// how they trade off:
//
//   position   — how few cards it expects to be holding afterwards, counting
//                the pile it will eat if the lie is called
//   going out  — emptying the hand, weighted by the chance of surviving it
//   shedding   — WHICH cards it chose to be rid of
//   dumping    — how many, which matters more the more it is drowning in
//
// There is no separate "risk" term. The cost of a lie is already inside
// `position`: being caught means picking up the pile, and the expected hand
// afterwards is the honest way to say that. A second penalty on top would be
// counting the same pile twice, which is how a bot ends up refusing to ever
// lie with a pile on the table — and refusing to ever lie is losing.

/** Value of an empty-ish hand. Hyperbolic, not linear: going from forty cards
 *  to thirty-six barely matters, going from three to one decides the game. */
const ENDGAME = 6000;

/**
 * A FLAT PRICE PER CARD, underneath the hyperbola, and it is what stops the
 * bot going blind in a big hand.
 *
 * ENDGAME alone says a card is worth 6000/h - 6000/(h+1). At a hand of
 * thirteen that is 33 points and the bot weighs the pile properly. At a hand
 * of fifty it is TWO, which is less than one DUMP unit and a small fraction of
 * one BLUFF_APPETITE — so every risk term quietly switches off and the bot
 * bluffs into a twenty-card pile as though the pile were not there.
 *
 * That is not a corner case. Three players at three decks is fifty-two cards
 * each from the deal, and it measured exactly as the arithmetic predicts:
 * fifteen thousand plays, hands sitting between forty and sixty the whole
 * time, no player ever getting below four cards, and the game never ending.
 *
 * So the two shapes are added rather than chosen between. The hyperbola is the
 * endgame, where one card really is worth more than the last ten; this is the
 * bulk of the game, where a card is a card and a pile of twenty is twenty
 * times as bad as a pile of one. Set well above DUMP so that shedding can
 * never be worth more than the pile it risks.
 */
const CARD_COST = 12;

/** Emptying the hand, multiplied by the chance of surviving the window. A
 *  TRUTHFUL final play survives with certainty and is therefore worth the whole
 *  of this — which is correct, because it wins the game outright. */
const OUT_VALUE = 3000;

/** Per card shed, scaled by how buried the hand is. Small next to ENDGAME on
 *  purpose: shedding is good, but not at the price of eating a pile. */
const DUMP = 6;

/** Composition tie-breaker: how glad we are to be rid of one card of a rank we
 *  hold `n` of. Singletons are dead weight — a rank you hold one of is a card
 *  you will eventually have to lie about. A rank you hold four of is a turn's
 *  worth of truth waiting for its moment. */
const SHED_SINGLETON = 4;

/** In WILD mode a joker satisfies any claim, which makes it the best card in
 *  the deck and, held to the end, a guaranteed win: your last play is a joker
 *  claimed as anything, and it is the truth. So the bot hoards them, and this
 *  is priced to outweigh any ordinary reason to spend one. OUT_VALUE still
 *  overwhelms it at the moment that matters. */
const JOKER_HOARD = 120;

/** In JUNK mode a joker matches nothing, loses every challenge it appears in,
 *  and can never be played truthfully. It is a hot potato and goes first. */
const JOKER_DUMP = 25;

/** Background suspicion: the chance one opponent calls a claim that nothing at
 *  all is wrong with. Somebody is always feeling lucky. */
const BASE_CALL = 0.06;

/** No opponent is ever treated as certain to call, or as certain not to. The
 *  first would make the bot refuse lies it should tell; the second would let it
 *  walk into a claim the whole table can disprove. */
const CALL_FLOOR = 0.02;
const CALL_CEIL = 0.95;

/** A player going out WILL be called if anybody can call at all — the table has
 *  nothing left to lose. Applied as a floor rather than a replacement so that a
 *  wildly implausible final claim is still treated as worse. */
const OUT_CALL_P = 0.9;

/**
 * A THUMB ON THE SCALE FOR LYING, and without it this bot does not play Bluff.
 *
 * Everything above prices a lie honestly, and honest pricing says: don't. Work
 * it out for a thirteen-card hand under the free rank rule. The truthful single
 * sheds one card with certainty. The two-card half-lie sheds two cards about
 * 47% of the time and hands back the pile the rest, which comes to 0.94 cards
 * in expectation. Truth wins, every turn, at every hand size — and it measured
 * exactly that: forty plays, forty truths, zero lies. A Bluff bot that never
 * bluffs is not a cautious bot, it is a broken one.
 *
 * The term the honest arithmetic is missing is that shedding is not the only
 * thing a lie buys. It buys a hand whose composition nobody can infer from the
 * claims, and it buys the same for the NEXT lie, the one told when the rank
 * rule leaves no choice — a player who has only ever told the truth is a player
 * whose first lie is read instantly. None of that fits in expected cards shed,
 * so it goes here as an appetite.
 *
 * Scaled three ways, all of which the spec asks for:
 *   * by `stands`, so it never resurrects the provably-false play
 *   * by how many cards the lie sheds BEYOND THE BEST HONEST PLAY, and by
 *     `urgency`, so a drowning hand bluffs bigger — dumping junk is most of
 *     the point
 *   * inversely by the pile, so the bot is BOLDER WHEN THERE IS LITTLE TO LOSE
 *     and goes quiet once the pile is worth eating
 *
 * THE SECOND OF THOSE IS `extra`, NOT k, AND THE DIFFERENCE IS A LIVELOCK.
 * Scaled by k, the appetite pays for a lie whether or not lying bought
 * anything, and a bot holding six Sixes was measured preferring three cards
 * called as Threes — two real, one junk — to four Sixes played straight. It is
 * a worse play by every honest term in the scoring, so it lost the pile every
 * time; and because a caught liar's hand comes back unchanged, the table
 * returned to a position identical to the one before, and three players took
 * turns making the same bad play twenty thousand times. Whole games that never
 * ended, one in a hundred and thirty.
 *
 * The fix is a statement of what lying is FOR: you lie to play cards you do
 * not have. A lie no larger than the honest play available has bought nothing
 * — not deception, because the size gave the game away anyway — so it earns
 * nothing here, and the honest terms decide it. This is not a safety valve
 * bolted on; the k-scaled version was simply pricing the wrong quantity.
 *
 * Calibrated against ENDGAME: one card off a thirteen-card hand is worth about
 * 39 points, so this is roughly "a lie is worth telling for about half a card
 * of extra shedding". At 24 the measured lie rate is around half of all plays
 * under the ascending rule, a quarter to a third under adjacent, and close to
 * nothing under free — which looks lopsided and is not. Under the free rule
 * you may claim any rank at all, so there is always something true to say, and
 * the bot declining to lie there is the correct read of a rule that does not
 * reward it. Pushed higher the free-rule games do fill up with lies, and they
 * are lies that get called: at 60 and 120 the table locks into 99% lies and
 * 99% challenges and stops finishing.
 */
const BLUFF_APPETITE = 24;

/**
 * What a lie is worth when it sheds nothing extra: the concealment alone.
 *
 * `extra` alone would be zero every turn at three decks, where a fifty-card
 * hand holds four of something no matter what and the honest play always
 * reaches maxPlay — and the bot measured at zero percent lies there, which is
 * the same broken bot as before with better arithmetic behind it. The reason
 * to lie when honesty is just as big is the one the appetite was written for
 * in the first place: a hand nobody can read, and a lie that will not be the
 * first one you have ever told.
 *
 * Deliberately under one card. It has to be small enough that a clearly better
 * honest play still wins — that margin is what keeps the livelock shut.
 */
const BLUFF_FLOOR = 0.5;

/** Plays within this of the best are a coin toss between them. Two bots with
 *  similar hands otherwise mirror each other exactly. */
const TIE_EPS = 1e-6;

/**
 * Decide what to put on the pile and what to call it.
 *
 * Enumerates every (claim rank, count) pair the rules allow — at most thirteen
 * by eight, which is nothing — and scores them. Enumerating rather than
 * reasoning is what makes an illegal play unrepresentable: the claim comes from
 * `pub.legalClaims`, which is the engine's own answer, and the cards come from
 * `priv.counts`, which is the engine's own count of the hand.
 */
export function choosePlay(pub, priv, rnd = random01) {
  if (!pub || !priv || !priv.isTurn) return null;

  const cfg = pub.config;
  const wild = cfg.jokerMode === 'wild';
  const counts = priv.counts || {};
  const handSize = priv.hand.length;
  const maxPlay = Math.min(priv.maxPlay, handSize);
  const claims = pub.legalClaims || [];
  if (!handSize || maxPlay < 1 || !claims.length) return null;

  // The hand as a flat list of rank tokens, worst first. A bluff of k cards is
  // the first k of this, which is the whole of "dump the least useful cards".
  const junk = shedOrder(counts, wild);
  const supply = rankSupply(cfg);

  const avgHand = Math.max(1, pub.deckSize / pub.players.length);
  const urgency = 1 + handSize / avgHand;

  // WHO COULD CALL THIS, AND HOW BIG THEIR HANDS ARE.
  //
  // In 'window' mode everybody can, and each of them is an independent chance
  // of being caught. In 'next' mode exactly one player may, and it is a NAMED
  // one — so the same lie is a different decision under the two modes, and a
  // different decision again depending on whose hand happens to be sitting
  // next. Carrying the seats rather than a count is what makes that possible.
  const opponents = pub.players.filter((p) => p.id !== priv.playerId);
  const named = opponents.filter((p) => p.id === pub.nextPlayerId);
  const eligible = (cfg.challengeMode === 'next' && named.length) ? named : opponents;

  // Every card whose location we do not know: the pile and all the other hands.
  // The denominator for "would that seat be holding one of these?".
  const unseen = Math.max(1, pub.deckSize - handSize);

  // THE BIGGEST HONEST PLAY ON THE TABLE, over every claim the rules allow.
  // This is the yardstick the bluff appetite is measured against — see the
  // note on BLUFF_APPETITE — so it has to be the best honest play AVAILABLE,
  // not the best one under the claim being scored. A bot holding six Sixes and
  // two Threes has an honest four on offer; that its Threes only stretch to two
  // is no reason to pay it for a three-card lie about Threes.
  const bestTruthK = claims.reduce(
    (m, r) => Math.max(m, truthfulComposition(counts, r, wild, maxPlay).length), 0);

  const candidates = [];
  for (const claim of claims) {
    // Copies of the claimed rank that are NOT in this hand, and so are the only
    // ones an opponent could be holding. Depends on the claim and not on the
    // size of the play, so it is hoisted out of the scoring.
    const held = (counts[claim] || 0) + (wild ? (counts[JOKER] || 0) : 0);
    const loose = Math.max(0, supply - held);
    // How much of this rank the whole table has already watched land in one
    // known hand. It comes straight off the number of copies an opponent needs
    // before their own certainty check trips, so it is the difference between a
    // lie that is a gamble and a lie that is a public admission.
    const credit = revealedAgainst(pub, priv.playerId, claim, wild);
    // And the mirror of it: how much of this rank the table already knows WE
    // hold, because they watched us pick it up. Cards they have already
    // accounted for are cards our claim does not have to explain — this is the
    // "well, of course you have them" that knownHeldBy() exists for, read from
    // the other side of the table.
    const excused = knownHeldBy(pub, priv.playerId, claim, wild);
    // ------------------------------------------------------------------
    // THREE COMPOSITIONS PER SIZE, and the third one is the whole reason this
    // bot is worth playing against.
    //
    //   truthful  — k real copies of the claim. Unloseable, but capped at how
    //               many the hand actually holds.
    //   junk      — the k cards the hand is gladdest to be rid of, under a
    //               claim it may hold none of.
    //   padded    — every real copy it holds, TOPPED UP with junk to reach k.
    //
    // The padded one is the bluff a person actually makes: "I have three
    // Kings, I'll say four and slip the seven in with them." It is not a
    // compromise between the other two, it is strictly better than the junk
    // bluff at the same size, and for a reason the scoring can see. Claiming
    // a rank you hold three of leaves only one copy loose in the whole game,
    // so almost nobody can be holding enough to disprove you — where the same
    // sized bluff on a rank you hold none of leaves all four out there.
    //
    // Where it earns its place is under the SEQUENCE rules, which force a rank
    // on you whether or not you hold enough of it. Without padding the only
    // lie on offer there is an all-junk claim, with the rank's full supply
    // still loose to convict it — correctly a bad idea, so the bot played one
    // or two cards a turn and the games crawled. Adding it took ascending at
    // three decks from 290 plays to 69.
    //
    // It does NOT rescue the free rank rule, and an earlier version of this
    // comment claimed it did. With every rank legal there is always something
    // true to say, so the bot goes on saying it: 0–2% lies, measured, at every
    // deck count. That is the right read of a rule that does not reward
    // bluffing rather than a gap in the compositions — see BLUFF_APPETITE,
    // where pushing the table into lying anyway is measured and is worse.
    // ------------------------------------------------------------------
    const truthful = truthfulComposition(counts, claim, wild, maxPlay);
    const compositions = [];
    for (let k = 1; k <= maxPlay; k++) {
      if (k <= truthful.length) compositions.push(truthful.slice(0, k));
      else if (truthful.length) {
        // Padded. The junk is drawn from the shed order, skipping anything
        // already committed as one of the real copies.
        const pad = junk.filter((r) => r !== claim && !(wild && r === JOKER));
        if (truthful.length + pad.length >= k) {
          compositions.push([...truthful, ...pad.slice(0, k - truthful.length)]);
        }
      }
      compositions.push(junk.slice(0, k));
    }
    // De-duplicated PER CLAIM rather than globally, because the same multiset
    // means something different under a different claim — three Kings is the
    // truth called as Kings and a lie called as Sevens. The two compositions
    // coincide whenever the shed order happens to start with the claimed rank,
    // which is common, so without this the same play would be scored twice and
    // would win every tie-break by sheer weight of duplicates.
    const seen = new Set();
    for (const ranks of compositions) {
      const key = ranks.slice().sort().join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(score(ranks, claim, loose, credit, excused, truthful.length > 0));
    }
  }

  function score(ranks, claim, loose, credit, excused, couldTellTruth) {
    const k = ranks.length;
    // Recomputed from the cards rather than taken from which branch built them,
    // and deliberately the SAME expression the engine resolves a challenge with
    // (see _resolveChallenge in state.js). A "bluff" that happens to be all of
    // the claimed rank is the truth, and must be scored as the truth.
    const isTruth = ranks.every((r) => r === claim || (wild && r === JOKER));
    const handAfter = handSize - k;

    // ------------------------------------------------------------------
    // THE CHANCE OF BEING CAUGHT, MODELLED AS THE TABLE RUNNING THIS VERY FILE
    // BACK AT US.
    //
    // The first draft made this a flat function of how many cards were played,
    // and it produced a bot that lied every single turn and was called every
    // single turn, so no hand ever emptied and no game ever ended. The reason
    // is the whole point of the certainty check at the top of this file: at one
    // deck a claim of four Kings is not merely bold, it is PROVABLE by anybody
    // holding a single King, and "provable" is a different quantity from
    // "implausible". A bot that cannot tell them apart plays a different game
    // from the one everyone else is playing.
    //
    // So the estimate is the mirror of claimIsImpossible(): work out how many
    // copies an opponent would need before that function fires on them, and ask
    // how likely their hand is to hold that many.
    // ------------------------------------------------------------------
    let caught = 0;
    if (!isTruth) {
      // The holding at which an opponent's own certainty check trips — LESS
      // whatever the table has already accounted for. At or below zero the
      // claim needs no cards at all to disprove and the lie is not a lie, it is
      // an announcement.
      const need = supply - k + 1 - credit;
      // What the claim still has to explain, from where they are sitting.
      const unexplained = k - excused;
      // The bar every one of them is measuring this play against. It is the
      // same number shouldChallenge() computes, because it is the same call.
      const bar = callBar(pub, handAfter);

      let survives = 1;
      for (const p of eligible) {
        // -- their certainty check ---------------------------------------
        const provable = atLeast(loose, need, p.handCount / unseen);

        // -- their plausibility check, run as they would run it -----------
        //
        // We cannot see their hand, so we use the holding a hand that size
        // would average. Everything else is exactly shouldChallenge()'s
        // arithmetic with their numbers substituted for ours.
        const theirs = ((loose - credit) * p.handCount) / unseen;
        const looseToThem = Math.max(0, loose - credit - theirs);
        const unknownToThem = Math.max(1, pub.deckSize - p.handCount - credit);
        const expected = (looseToThem * handSize) / unknownToThem;
        const stretch = unexplained <= 0
          ? 0
          : unexplained / Math.max(expected, MIN_EXPECTED);

        const chance = Math.max(provable, callChance(stretch, bar));
        survives *= 1 - clamp(BASE_CALL + chance, CALL_FLOOR, CALL_CEIL);
      }
      caught = 1 - survives;
      if (handAfter === 0) caught = Math.max(caught, OUT_CALL_P);
    }

    // The honest cost of a lie: the hand we expect to be holding once the
    // window has closed, pile and all.
    const expectedHand = handAfter + caught * (pub.pileSize + k);

    // ------------------------------------------------------------------
    // EVERY GAIN IS CONTINGENT ON THE PLAY STANDING, and this multiplier is the
    // difference between a bot and a loop.
    //
    // A caught liar hands the cards straight back, so a lie that is certain to
    // be called does not cost a single card — the hand it started the turn with
    // is the hand it ends the turn with. It is therefore free if you only price
    // what it risks. The first draft priced it that way, counted the shedding
    // regardless, and produced a bot that opened every single turn with four
    // cards claimed as four Aces at one deck: provably false, instantly called,
    // picked straight back up, and round again. Forty thousand plays, not one
    // hand emptied.
    //
    // Weighting the gains — not adding another penalty — is the fix, because
    // the thing that is wrong with that play is not that it is dangerous. It is
    // that it achieves nothing.
    // ------------------------------------------------------------------
    const stands = 1 - caught;

    let total = ENDGAME / (1 + expectedHand) - CARD_COST * expectedHand;
    total += DUMP * k * urgency * stands;
    if (handAfter === 0) total += stands * OUT_VALUE;
    for (const r of ranks) total += shedValue(r, counts, wild) * stands;
    // ONLY WHEN THERE WAS A TRUTH TO TELL. The appetite is a thumb on the
    // scale for CHOOSING to lie, and where the rank rule leaves no choice
    // there is nothing for it to weigh — every candidate is a lie and the only
    // question left is how many cards. Applied there it answers that question
    // wrongly, because it scales with k: under the ascending rule it turned a
    // forced one-card lie into a forced eight-card lie, which is the same lie
    // with seven more reasons to call it. Measured at three decks, ungated:
    // 97% of plays lies, 64% of plays challenged, and four games in ten that
    // never finished. Gated: 71% and 26%, and all ten finish.
    const gain = Math.max(BLUFF_FLOOR, k - bestTruthK);
    if (!isTruth && couldTellTruth) {
      total += (BLUFF_APPETITE * stands * gain * urgency) / (1 + pub.pileSize / avgHand);
    }

    return { ranks, claim, total };
  }

  const best = candidates.reduce((m, c) => (c.total > m ? c.total : m), -Infinity);
  const tied = candidates.filter((c) => c.total >= best - TIE_EPS);
  const pick = tied[Math.floor(rnd() * tied.length)] || tied[0];
  return { type: 'playCards', ranks: pick.ranks, claim: pick.claim };
}

/**
 * The cards that would make a claim of `rank` TRUE, best composition first.
 *
 * Real cards of the rank before jokers, even in wild mode where both are
 * equally true — because the joker will still be true next turn and for every
 * other rank, and the King will not.
 */
function truthfulComposition(counts, rank, wild, maxPlay) {
  const out = [];
  for (let i = 0; i < (counts[rank] || 0) && out.length < maxPlay; i++) out.push(rank);
  if (wild) {
    for (let i = 0; i < (counts[JOKER] || 0) && out.length < maxPlay; i++) out.push(JOKER);
  }
  return out;
}

/** How glad the bot is to be rid of one card of this rank. */
function shedValue(rank, counts, wild) {
  if (rank === JOKER) return wild ? -JOKER_HOARD : JOKER_DUMP;
  return SHED_SINGLETON / Math.max(1, counts[rank] || 1);
}

/**
 * P(at least `k` of `n` loose copies landed in one particular hand), where each
 * copy is in that hand with probability `q`.
 *
 * Binomial rather than hypergeometric, which is the wrong distribution by a
 * little: the copies are dealt without replacement, so they are very slightly
 * anti-correlated. The error is a fraction of a percent at these sizes, it is
 * feeding a heuristic rather than a proof, and the exact version needs
 * factorials of numbers this loop does not otherwise touch. The SOUND
 * arithmetic in this file is claimIsImpossible(), which uses no probability at
 * all — this is the guessing half, and it is allowed to guess.
 *
 * The pmf is stepped rather than recomputed, so there is no pow() and no
 * factorial in the loop; `n` is at most 4*decks+jokers, so at most eighteen.
 */
function atLeast(n, k, q) {
  if (k <= 0) return 1;
  if (n <= 0 || k > n) return 0;
  // q = 1 would divide by zero below, and means "that hand is the whole deck",
  // which cannot happen at a table of three or more.
  const p = clamp(q, 0, 0.999);
  let pmf = (1 - p) ** n;
  const step = p / (1 - p);
  let tail = 0;
  for (let i = 0; i <= n; i++) {
    if (i >= k) tail += pmf;
    pmf *= ((n - i) / (i + 1)) * step;
  }
  return clamp(tail, 0, 1);
}

/** The hand flattened into rank tokens, gladdest-to-lose first. */
function shedOrder(counts, wild) {
  const held = [...RANKS, JOKER].filter((r) => (counts[r] || 0) > 0);
  held.sort((a, b) => shedValue(b, counts, wild) - shedValue(a, counts, wild));
  const flat = [];
  for (const r of held) for (let i = 0; i < counts[r]; i++) flat.push(r);
  return flat;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(n, hi)); }

// ===========================================================================
// PART THREE — one function that answers "what would this bot do right now"
// ===========================================================================

/**
 * The bot's whole decision, as the wire message a phone would have sent.
 *
 * @returns an intent, or null when there is nothing for this bot to do.
 */
export function chooseMove(pub, priv, rnd = random01) {
  if (!pub || !priv || pub.phase !== PHASES.PLAY) return null;

  if (priv.canChallenge && shouldChallenge(pub, priv, rnd)) return { type: 'challenge' };

  // 'next' mode only. Declining explicitly rather than playing over the open
  // window: the two are the same thing to the engine, but they are not the same
  // thing to the table — LET IT STAND and then a play reads as two decisions,
  // which is what they are.
  if (priv.canDecline) return { type: 'decline' };

  if (priv.isTurn) return choosePlay(pub, priv, rnd);
  return null;
}

// ===========================================================================
// THE DRIVER — turning "a bot could act" into an action, at a human pace
// ===========================================================================

/** How long a bot appears to think before playing. Long enough that the table
 *  sees whose turn it was and what they claimed before anything else moves. */
export const BOT_THINK_MS = 1500;

/** A bot never acts inside the last stretch of a challenge window. The pause is
 *  politeness, and a bot that misses its own window out of politeness is a bug
 *  the host would rightly report as "the bots never challenge anything". */
const MIN_LEAD_MS = 700;

/** Nor does a bot ever challenge instantly. An instant call is the tell that
 *  the thing calling you can see your cards, which in this game of all games is
 *  the accusation to avoid — even though it cannot. */
const CHALLENGE_MIN_MS = 350;

/**
 * A stateful ticker, one per game.
 *
 * Called from the interval the host already runs to expire the challenge window
 * (js/main.js) rather than from a timer of its own, so nothing new starts
 * ticking to add bots and the engine stays free of clocks.
 *
 * The state it holds is only "which decision am I waiting on, and until when",
 * keyed by a fingerprint of the game position. It is never serialised: a host
 * reload rebuilds it from the engine, so the worst a crash mid-pause costs is
 * that a bot thinks for a second and a half again.
 */
export function createBotDriver({ thinkMs = BOT_THINK_MS, rnd = random01 } = {}) {
  const pending = new Map();   // botId -> { key, move, dueAt, acted }

  /**
   * A fingerprint of the current decision point.
   *
   * The pile size is in it because that is what changes on every single play,
   * and the claim is in it because in 'next' mode two consecutive positions can
   * otherwise look identical. When this changes, every bot re-decides — which
   * is exactly right: somebody else challenging first genuinely is new
   * information.
   *
   * `sequenceRank` is in it for a reason that is invisible until it bites. It
   * is the only thing distinguishing two empty-pile positions at the same seat
   * under the ascending rule, where `claim` is null and the legal claim has
   * nonetheless moved on — so without it a plan made for "claim an Ace" is
   * replayed into a position that demands a Three. The engine refuses it,
   * correctly; the slot is already marked acted, correctly; and the table stops
   * with nobody's move outstanding. A stale key here is not a stale decision,
   * it is a dead game.
   */
  function positionKey(engine) {
    const c = engine.claim;
    return [
      engine.gamesPlayed, engine.step, engine.turn, engine.pile.length,
      engine.sequenceRank || '-',
      c ? `${c.playerId}|${c.rank}|${c.count}` : '-',
    ].join(':');
  }

  function plan(engine, pub, bot, now, key) {
    let move = null;
    try {
      move = chooseMove(pub, engine.privateStateFor(bot.id), rnd);
    } catch (err) {
      // A throw in here is a bug in the scoring, and the right response is
      // still to get the turn moving — a table stuck behind a bot is a dead
      // game, where a skipped turn is something somebody can play on from.
      console.warn('[bot] chooseMove threw', err);
    }
    // Unreachable in practice: choosePlay only returns null on an empty hand,
    // and an empty hand means the game is already being decided. It exists
    // because the alternative to a wrong move is no move at all, and no move at
    // all stops the game for everybody, permanently.
    if (!move && engine.privateStateFor(bot.id)?.isTurn) move = { type: 'skipTurn' };

    return { key, move, acted: false, dueAt: dueAt(engine, move, now) };
  }

  function dueAt(engine, move, now) {
    if (!move) return Infinity;
    if (move.type !== 'challenge' && move.type !== 'decline') return now + thinkMs;

    const ends = engine.challengeEndsAt;
    // 'next' mode has no clock at all and nobody else may act, so the only
    // constraint is that it should not look instant.
    if (ends == null) return now + CHALLENGE_MIN_MS + rnd() * thinkMs;

    // A RANDOMISED delay inside the window, and it is not decoration. Every bot
    // plans on the same tick, so a fixed delay would have them all fire on the
    // same tick too — and the engine takes the first challenge to arrive, which
    // would be whichever bot happens to sit earliest in the players array. The
    // same seat would win every contested challenge of every game.
    const room = Math.max(0, ends - MIN_LEAD_MS - CHALLENGE_MIN_MS - now);
    return now + CHALLENGE_MIN_MS + rnd() * room;
  }

  function act(engine, bot, move, now) {
    // skipTurn is an owner intent and is refused from anybody else, so the
    // last-resort escape is sent as the host — the same way the host's own
    // SKIP button sends it.
    const actor = move.type === 'skipTurn' ? engine.hostId : bot.id;
    const { result } = applyGameIntent(engine, actor, move, now);
    if (result && result.ok) return true;

    // Losing the race is the expected outcome for every bot but one, and is not
    // a fault. Matching the engine's own sentence is deliberate: if that
    // sentence ever changes, this stops matching and the harness — which treats
    // any warning as a failure — says so.
    const lostTheRace = move.type === 'challenge' && result && result.error === 'Too late.';
    if (!lostTheRace) console.warn('[bot] move refused:', result && result.error, move.type);
    return false;
  }

  return {
    /**
     * @returns true if the engine changed and the caller should broadcast.
     */
    tick(engine, now = Date.now()) {
      if (!engine || engine.phase !== PHASES.PLAY) { pending.clear(); return false; }
      const key = positionKey(engine);
      // Built once and shared. It is the same object for every bot by
      // definition — that is what "public" means — and building it per bot on
      // every tick of a fast interval is the one place this file could get
      // expensive enough to notice.
      let pub = null;

      for (const bot of engine.players) {
        if (!bot.isBot) continue;
        let slot = pending.get(bot.id);
        if (!slot || slot.key !== key) {
          if (!pub) pub = engine.publicState();
          slot = plan(engine, pub, bot, now, key);
          pending.set(bot.id, slot);
        }
        if (slot.acted || !slot.move || now < slot.dueAt) continue;

        // Set before acting, not after. Whatever happens below — a refusal, a
        // throw — this decision gets exactly one attempt, so a bot that cannot
        // be satisfied costs one tick rather than spinning forever.
        slot.acted = true;
        // At most one action per tick: each one changes the position, which
        // every other bot is entitled to re-decide against.
        if (act(engine, bot, slot.move, now)) {
          // Forget every plan, rather than relying on the key having moved.
          // Two positions can share a fingerprint — same seat, same empty pile,
          // same absent claim — and every slot would still be marked acted, so
          // the game would stop dead with nobody's move outstanding and nothing
          // left to change their minds. Clearing makes that unrepresentable
          // instead of merely unlikely, which is the right trade for a cache
          // whose whole purpose is to save a few milliseconds.
          pending.clear();
          return true;
        }
      }
      return false;
    },

    /** Forget every pause in progress. For a host that has just taken over an
     *  engine, where "waiting since" means nothing. */
    reset() { pending.clear(); },
  };
}
