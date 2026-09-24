// ============================================================================
// guards.js — Bounds on anything that arrived from another device.
//
// WHY A BROWSER HOST NEEDS THESE AT ALL
//   The tempting reasoning is that a peer-to-peer host only ever hears from
//   people on the same Wi-Fi, so nothing hostile can reach it. That is not
//   true: PeerJS signalling goes through a broker on the public internet and
//   the data channel falls back to a relay, so a browser host is reachable
//   from anywhere by anyone who has — or guesses — a four-character room code.
//   The host here is somebody's phone, which is the weaker machine of the two
//   and the one with a battery.
//
// WHAT THESE ARE FOR, AND WHAT THEY ARE NOT
//   Not rule enforcement. The engine is already defensive on its own account:
//   takeByRank() refuses cards the hand does not hold, isLegalClaim() refuses
//   an out-of-sequence claim, and normalizeConfig() rebuilds the config from a
//   fixed key list so a hostile KEY is dropped rather than stored. These bound
//   *work and memory* instead, and they turn junk into a clean refusal rather
//   than a confusing one — a play of ['\0'.repeat(60000)] would otherwise
//   come back as "you do not hold those cards", which is true and useless.
//
//   Neither are they authentication. Nothing here decides who you are; that is
//   the clientId rule in state.js.
//
// WHY THIS FILE IMPORTS rules.js, WHERE sequence/js/guards.js IMPORTS NOTHING
//   Bluff's wire format carries RANK TOKENS, so validating a message means
//   knowing the rank vocabulary. Copying that vocabulary into this file to
//   preserve a zero-import rule would mean two lists of thirteen ranks that
//   must agree forever, which is a worse trade than the import. rules.js itself
//   imports nothing, so this file is still loadable by `node` alone with no
//   build step, which is what the zero-import rule was actually protecting.
//
// ONE THING THIS FILE DELIBERATELY DOES NOT HAVE: a validCardId(). Sequence
// needs one because its clients name cards. Bluff's clients cannot — they say
// "two of my Kings" and the host picks which cards those were — so there is no
// identifier to forge and nothing to validate. The absence is the feature.
// ============================================================================

import {
  RANKS, JOKER, MAX_PLAY_CEILING, MIN_DECKS, MAX_DECKS,
  MIN_WINDOW_MS, MAX_WINDOW_MS, MAX_PLAYERS, CARDS_PER_DECK,
  RANK_RULES, JOKER_MODES, CHALLENGE_MODES,
  jokerCap, playCap, cleanName,
} from './rules.js';

// A type is a short verb like 'playCards'. Anything longer is not a type,
// whatever else it might be.
export const MAX_TYPE_LEN = 40;

/**
 * The shape every wire message must have, checked after parsing and before any
 * dispatch.
 *
 * An ARRAY parses fine as JSON and would sail past a `typeof === 'object'`
 * check while having no `.type`, so it is excluded by name.
 */
export function validEnvelope(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (typeof msg.type !== 'string' || msg.type.length > MAX_TYPE_LEN) return null;
  return msg;
}

// ---------------------------------------------------------------------------
// Per-connection message rate limit.
//
// The point is not to stop one client being annoying to itself — it is that
// every accepted message fans out into a broadcast to the whole room. Without
// a limit, one socket sending in a loop multiplies its own flood by the number
// of players before it leaves the box. So the bucket sits in front of the
// dispatch, not behind it.
//
// A refill rate rather than a fixed window, because real play is bursty. In
// this game specifically: a host nudging the decks stepper sends one message
// per tap, and at the close of a challenge window several devices genuinely
// fire at the same instant. A burst has to be cheap or the rate limit becomes
// a way to lose a challenge you pressed in time.
// ---------------------------------------------------------------------------
export class TokenBucket {
  constructor({ capacity = 40, refillPerSec = 15, now = Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.stamp = now;
  }

  /** True if this message may proceed. Costs one token. */
  take(now = Date.now()) {
    const elapsed = Math.max(0, now - this.stamp) / 1000;
    this.stamp = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * How many data connections the host will hold open at once.
 *
 * Comfortably above MAX_PLAYERS (8) rather than equal to it, because the count
 * includes connections that are not seats: a device browsing the lobby before
 * it joins, and the dead half of a reconnect whose old connection the browser
 * has not reaped yet. Set it to 8 and a player whose phone slept would be
 * locked out of their own seat by their own ghost.
 *
 * Enforced in net.js, defined here so the ceiling is with the other bounds.
 */
export const MAX_CONNECTIONS = 24;

// ---------------------------------------------------------------------------
// Input validation. Every one of these returns a value or null — never throws,
// and never hands back something half-cleaned.
// ---------------------------------------------------------------------------

// Long enough that collisions across a friend group are impossible, short
// enough to be obviously not a payload. The character class rules out anything
// that could confuse a log line or a JSON key.
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function validClientId(raw) {
  return typeof raw === 'string' && CLIENT_ID_RE.test(raw) ? raw : null;
}

export function validPlayerId(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 64 ? raw : null;
}

// cleanName() runs a regex over the whole string before it truncates, so the
// length cap has to come first or a one-megabyte "name" is a one-megabyte
// regex. Generous against the 18-character limit on purpose: this is a bound
// on work, not a second opinion about names.
export const MAX_NAME_BYTES = 200;

export function validName(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_NAME_BYTES) return null;
  return cleanName(raw) || null;
}

// ---------------------------------------------------------------------------
// The play, which is the only part of this wire format that is unusual.
//
// A play is a MULTISET OF RANK TOKENS — ['K','K','7'] — and a claim is a single
// rank. The two are validated by different functions against different
// vocabularies, and that asymmetry is a rule of the game rather than an
// oversight:
//
//   PLAYABLE includes the joker. A joker is a card you are holding and you are
//   entitled to put it face down like any other.
//
//   CLAIMABLE does not. "I play three jokers" is not a thing anybody can say
//   out loud at this table. RANKS has no joker token in it, so claims.js can
//   never generate one either — refusing it here is the second of two locks on
//   the same door, and the cheap one.
// ---------------------------------------------------------------------------
const PLAYABLE = new Set([...RANKS, JOKER]);
const CLAIMABLE = new Set(RANKS);

/**
 * The cards being put face down, as ranks.
 *
 * Bounded by MAX_PLAY_CEILING — the absolute hard ceiling across every legal
 * config — and NOT by the room's own maxPlay. That distinction is the whole
 * division of labour in this file: eight is a bound on how much work a message
 * may cost, four is a rule of the table. A play of six at a table of four gets
 * the engine's "At most 4 cards at a time"; a play of six thousand never
 * reaches the engine at all.
 *
 * A copy comes back rather than the caller's array, so nothing downstream is
 * holding a reference to a structure the sender composed.
 */
export function validRankPlay(raw) {
  if (!Array.isArray(raw)) return null;
  if (raw.length < 1 || raw.length > MAX_PLAY_CEILING) return null;
  // Set.has on a number, an object or undefined is simply false, so there is no
  // typeof check to forget here.
  for (const r of raw) if (!PLAYABLE.has(r)) return null;
  return raw.slice();
}

/** The rank being announced. Never a joker. */
export function validClaimRank(raw) {
  return CLAIMABLE.has(raw) ? raw : null;
}

// A config patch as the lobby UI sends it: one or two keys per tap, or a whole
// preset.
const MAX_PATCH_KEYS = 16;

export function validConfigPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length === 0 || keys.length > MAX_PATCH_KEYS) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// THE LOBBY LOCK
//
// Three guards on the config, and they are not all the same kind of guard.
//
//   CLAMPED, in normalizeConfig() (rules.js): `jokers` to 0..2*decks and
//   `maxPlay` to 1..min(4*decks, 8). Clamped rather than refused because these
//   two are reachable by ordinary use — a host who sets three decks and six
//   jokers and then drops to one deck has not done anything wrong, and the
//   honest response is to bring the jokers down with the decks in the same
//   update rather than to stop them. Because normalizeConfig rebuilds the whole
//   config on every call, that re-clamp cannot be skipped by changing one key.
//
//   REFUSED, here: `decks` outside 1..3, and a `jokerMode` that is not one of
//   the two literals. Neither is reachable by any sequence of taps, so one
//   arriving means the config was assembled by something other than the lobby.
//   Clamping it would be the wrong answer twice over: it would start a game the
//   host did not configure, and it would do so silently. `decks: 9` clamped to
//   3 is a table quietly playing a different game; `decks: 9` refused by name
//   is a host who knows something is wrong.
//
// The function below checks BOTH kinds, because it does not get to assume
// normalizeConfig ran — being the thing that catches a config which bypassed it
// is the entire job. Everything is checked before a card is dealt, because
// after the deal a bad bound has already become 470 cards in six hands.
// ---------------------------------------------------------------------------

/**
 * Why this config must not start a game, or null.
 *
 * Returns a sentence for a human, not a code: it is rendered live in the lobby
 * under the start button, so the host reads it rather than discovering it.
 */
export function configBlocker(config) {
  if (!config || typeof config !== 'object') return 'The setup is missing. Reload to reset it.';

  // FIRST, always. jokerCap() and playCap() are derived from the deck count, so
  // there is nothing meaningful to say about the other two bounds until this
  // one is known good.
  if (!Number.isInteger(config.decks) || config.decks < MIN_DECKS || config.decks > MAX_DECKS) {
    return `Deck count must be ${MIN_DECKS}–${MAX_DECKS} (got ${JSON.stringify(config.decks)}). Reload to reset the setup.`;
  }
  if (!Object.prototype.hasOwnProperty.call(JOKER_MODES, config.jokerMode)) {
    return `Unknown joker mode ${JSON.stringify(config.jokerMode)}. Reload to reset the setup.`;
  }

  // The clamped pair. Unreachable if normalizeConfig ran, which is why these
  // name the bound rather than apologising: seeing one means something skipped
  // it, and the host needs to know that rather than get a tidied number.
  const jc = jokerCap(config.decks);
  if (!Number.isInteger(config.jokers) || config.jokers < 0 || config.jokers > jc) {
    return `At ${config.decks} deck${config.decks === 1 ? '' : 's'} the joker count must be 0–${jc} (got ${JSON.stringify(config.jokers)}). Reload to reset the setup.`;
  }
  const pc = playCap(config.decks);
  if (!Number.isInteger(config.maxPlay) || config.maxPlay < 1 || config.maxPlay > pc) {
    return `At ${config.decks} deck${config.decks === 1 ? '' : 's'} the play size must be 1–${pc} (got ${JSON.stringify(config.maxPlay)}). Reload to reset the setup.`;
  }

  // legalClaims() THROWS on a rank rule it does not know, and it is called on
  // every render. Letting an unknown one through would not produce a strange
  // game, it would produce a host tab that crashes on the first turn.
  if (!Object.prototype.hasOwnProperty.call(RANK_RULES, config.rankRule)) {
    return `Unknown rank rule ${JSON.stringify(config.rankRule)}. Reload to reset the setup.`;
  }
  if (!Object.prototype.hasOwnProperty.call(CHALLENGE_MODES, config.challengeMode)) {
    return `Unknown challenge mode ${JSON.stringify(config.challengeMode)}. Reload to reset the setup.`;
  }
  if (!Number.isFinite(config.windowMs)
    || config.windowMs < MIN_WINDOW_MS || config.windowMs > MAX_WINDOW_MS) {
    return `The challenge window must be ${MIN_WINDOW_MS / 1000}–${MAX_WINDOW_MS / 1000} seconds. Reload to reset the setup.`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// THE OTHER DIRECTION: what a CLIENT will accept from its host.
//
// Everything above this line guards the host against the table. These two
// guard a player against their host, and the reason is not paranoia about
// friends — it is that "the host" is whoever holds a four-character id on a
// public broker. A code typed one character wrong resolves to a stranger, and
// js/ui.js then renders whatever that stranger sends.
//
// render() does no checking whatsoever, and cannot be made to. It reads
// pub.players.map(...), pub.claimHistory.slice(...), priv.hand.map(...) and
// pub.legalClaims.includes(...) directly, because on the host's own device
// those always exist — it is the same function drawing the same objects the
// engine just produced. A `players: 8` instead of an array is a thrown
// TypeError inside screenFor(), and ui.js's render() assigns the result of
// screenFor() to screen.innerHTML, so the throw happens BEFORE the assignment
// and the player is left staring at the last frame that worked, with a dead
// app underneath it and no way back. That is worse than a blank page, because
// it looks fine.
//
// SHAPE CHECKS AND DELIBERATELY ONLY SHAPE CHECKS. Whether the claim is legal,
// whether the counts add up to a whole deck, whether the host is dealing
// itself every ace — none of it is knowable from here. A client cannot referee
// its own host in this game in particular: the entire point of Bluff is that
// nobody else can see the cards, so there is nothing for a client to check
// against. Moving the authority to a server is the only real answer, and
// js/intents.js is the seam kept open for it. What these buy is that a
// malformed payload is a dropped frame instead of a dead tab.
//
// The absolute number of cards that can exist at the largest legal config.
// Also the honest ceiling on ONE hand: a player who has just taken a huge pile
// can be holding very nearly the whole deck, so anything tighter would refuse
// a real frame at the most dramatic moment in the game.
// ---------------------------------------------------------------------------
export const MAX_DECK_CEILING = CARDS_PER_DECK * MAX_DECKS + jokerCap(MAX_DECKS);

/**
 * The public table.
 *
 * The six things js/ui.js walks without looking, plus the phase string every
 * screen switches on. `players` is capped rather than fixed because the lobby
 * legitimately holds 0, 1 or 2 seats while people are still arriving, so there
 * is no exact length to assert — and the cap is what stops a `players` array of
 * a hundred thousand entries becoming a hundred thousand seat rows.
 *
 * `claim`, `reveal` and `seen` are NOT checked, and that is not an oversight.
 * Each is legitimately null most of the time, and every read of them in ui.js
 * is already guarded by a `&&` because the host's own renderer has to handle
 * the null too. They are the fields where "absent" is normal, so the renderer
 * was written defensively for free.
 */
export function validPublicState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.phase !== 'string' || raw.phase.length > MAX_TYPE_LEN) return null;
  if (typeof raw.step !== 'string' || raw.step.length > MAX_TYPE_LEN) return null;
  if (!Array.isArray(raw.players) || raw.players.length > MAX_PLAYERS) return null;
  // Three arrays, three different screens, all mapped unconditionally:
  // claimHistory drives the history strip, legalClaims drives the claim chips
  // (and is `.includes()`d while deciding which are disabled), log is the
  // engine's running commentary.
  if (!Array.isArray(raw.claimHistory) || !Array.isArray(raw.legalClaims)) return null;
  if (!Array.isArray(raw.log)) return null;
  // Read for the deck count, the joker mode and the window length on every
  // render, in the lobby and during play.
  if (!raw.config || typeof raw.config !== 'object' || Array.isArray(raw.config)) return null;
  // Counts, not indices — but `pileSize` is rendered as a number and `turnSeat`
  // is used to index `players`. Bounded rather than range-checked against the
  // array above, because an empty lobby honestly reports turnSeat 0 with no
  // seats to point at and refusing that would refuse the first frame of every
  // session. Out of range is `players[n]` of undefined, which renders as
  // nothing; a non-integer is what breaks arithmetic.
  if (!Number.isInteger(raw.pileSize) || raw.pileSize < 0 || raw.pileSize > MAX_DECK_CEILING) return null;
  if (!Number.isInteger(raw.turnSeat) || raw.turnSeat < 0 || raw.turnSeat > MAX_PLAYERS) return null;
  return raw;
}

/**
 * One device's own cards.
 *
 * Null is a legitimate value — a device that has connected but has not been
 * seated yet has no private state at all — so the CALLER distinguishes
 * "absent" from "malformed" by checking for null before asking this. See
 * readStateFrame() in js/net.js, which is the only caller.
 *
 * `counts` is checked for being an object because every tile in the dock is
 * built from it, and `maxPlay` for being a small integer because it is the
 * upper bound of a `for` loop that builds the count picker: a maxPlay of
 * 1e9 from a hostile host is not a rendering bug, it is a frozen tab.
 */
export function validPrivateState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (validPlayerId(raw.playerId) === null) return null;
  if (!Array.isArray(raw.hand) || raw.hand.length > MAX_DECK_CEILING) return null;
  if (!raw.counts || typeof raw.counts !== 'object' || Array.isArray(raw.counts)) return null;
  if (!Number.isInteger(raw.maxPlay) || raw.maxPlay < 0 || raw.maxPlay > MAX_PLAY_CEILING) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// Frame decoding for the PeerJS transport.
//
// A DataConnection hands back whatever the sender's serializer produced: this
// app sends JSON.stringify()'d text, so a string is the normal case, but
// PeerJS's own BinaryPack serializer would deliver an already-decoded object
// and a custom client could send binary.
//
// The size cap can only be applied to the text case, and that is not a gap
// worth pretending away: by the time an object arrives, PeerJS has already
// allocated it, so the cap would be closing the door on an empty room. The cap
// that matters for the object path is MAX_CONNECTIONS above, which stops the
// flood rather than each frame in it.
// ---------------------------------------------------------------------------
export const MAX_FRAME_BYTES = 65536;

export function decodePeerFrame(raw, { maxBytes = MAX_FRAME_BYTES } = {}) {
  if (typeof raw === 'string') {
    // Compared against the character count rather than the encoded byte
    // length: multi-byte characters make this stricter than the stated cap,
    // never looser, and it avoids allocating a TextEncoder for every frame of
    // every game.
    if (raw.length > maxBytes) return null;
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return null; }
    return validEnvelope(msg);
  }
  // ArrayBuffer, Blob, TypedArray: something no version of this client sends.
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return null;
  return validEnvelope(raw);
}
