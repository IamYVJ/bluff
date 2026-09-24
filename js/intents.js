// ============================================================================
// intents.js — The one dispatcher that turns a wire message into an engine call.
//
// WHY THIS MODULE EXISTS ON DAY ONE, WITH ONLY ONE TRANSPORT
//   There is one authoritative host today: a player's browser tab. The seam for
//   a second — an authoritative server — is kept open deliberately, and this is
//   the largest part of keeping it open. When a server arrives it will receive
//   the same messages from the same client code and own the same GameEngine,
//   and if it grew its own switch statement the two would drift: one would
//   learn a new intent, or read `msg.claim` where the other reads `msg.rank`,
//   and the bug would only appear on whichever transport was tested less.
//
//   In this game the seam is worth more than in the others in the family. The
//   host's tab can see every hand, so "move the authority off a player's
//   device" is not a scaling feature, it is the fix for the one honesty problem
//   this design has. Making that a cheap change later means routing every move
//   through one function now, even while there is only one caller.
//
// WHAT THIS IS NOT
//   Transport-neutral on purpose: no sockets, no peer ids, no broadcasting. The
//   caller supplies the actor's playerId, having already decided who that is,
//   and deals with the result. `join`, `lobbyQuery` and connection lifecycle
//   stay with the transports, because identity is exactly where the two differ.
//
// Node-safe: imports the engine's vocabulary and the shared bounds in
// guards.js, which imports only rules.js, which imports nothing.
// ============================================================================

import { validConfigPatch, validRankPlay, validClaimRank, validPlayerId } from './guards.js';

// Anyone at the table may send these. The engine's own turn, window and
// ownership checks are the guard — which player may do which of these, and
// when, changes several times a second and is not knowable from the type.
export const PLAYER_INTENTS = Object.freeze([
  'playCards', 'challenge', 'decline',
]);

// Only the owner — the room's host seat — may send these.
export const OWNER_INTENTS = Object.freeze([
  'setConfig', 'movePlayer', 'randomizeOrder', 'addBot', 'removeBot',
  'startGame', 'skipTurn', 'endGame', 'playAgain',
]);

export const GAME_INTENTS = Object.freeze([...PLAYER_INTENTS, ...OWNER_INTENTS]);

// ---------------------------------------------------------------------------
// The owner guard, and why it is here rather than in the engine.
//
// Four of the owner intents already check `actorId !== this.hostId` inside the
// engine: startGame, skipTurn, endGame, playAgain. The rest do NOT — setConfig,
// movePlayer, randomizeOrder, addBot and removeBot only check the phase.
//
// That asymmetry is correct as far as the engine is concerned: those five are
// also called directly by the host's own lobby UI, where there is no untrusted
// caller. Routing them over the wire is what makes them reachable by everyone
// else, so the guard belongs at the seam that made them reachable — here.
// Every remote message passes through this function, so this is a complete
// guard rather than a partial one, and the engine's own four checks still fire
// underneath.
//
// setConfig matters more here than anywhere else in the family: the config
// decides the deck count, and the deck count decides whether a claim of five
// Kings is impossible or routine. A client that could change it could make its
// own bluffs unfalsifiable.
// ---------------------------------------------------------------------------
const NEEDS_OWNER_GUARD = new Set([
  'setConfig', 'movePlayer', 'randomizeOrder', 'addBot', 'removeBot',
]);

/**
 * Apply one game intent.
 *
 * ----------------------------------------------------------------------------
 * `now` IS AN ARGUMENT, AND IT NEVER COMES OUT OF `msg`.
 *
 * Four of these intents are time-sensitive, and in a game about lying the
 * clock is an attack surface rather than a detail. If `now` were read off the
 * wire, a client could:
 *
 *   * challenge a claim minutes after the window shut by backdating itself,
 *   * or arm its own window at `now = Infinity` and never be challenged at all.
 *
 * So the host passes its own clock in, once, and this function threads it
 * through. `msg.now`, `msg.t`, `msg.timestamp` — none of them are read here or
 * anywhere downstream, and the test suite fires a message carrying all three to
 * prove it. The same rule as the engine's: time is a parameter, and it belongs
 * to whoever owns the authority.
 * ----------------------------------------------------------------------------
 *
 * @param engine  the authoritative GameEngine
 * @param actorId the playerId the caller has decided this message came from
 * @param msg     the parsed wire message, already known to be an object
 * @param now     the HOST's clock, in ms
 * @returns { handled, result }
 *          handled=false means the type is not a game intent — the caller's
 *          transport layer owns it (join, lobbyQuery) or it is junk to ignore.
 *          `result` is the engine's usual { ok } / { ok:false, error }.
 */
export function applyGameIntent(engine, actorId, msg, now = Date.now()) {
  const type = msg && msg.type;
  if (typeof type !== 'string') return { handled: false, result: null };

  if (NEEDS_OWNER_GUARD.has(type) && actorId !== engine.hostId) {
    return { handled: true, result: { ok: false, error: 'Only the host can change the setup.' } };
  }

  switch (type) {
    // --- anyone at the table ------------------------------------------------

    case 'playCards': {
      // Two separate validations against two separate vocabularies, because a
      // joker is a card you may PLAY and never a rank you may CLAIM. See the
      // note above PLAYABLE/CLAIMABLE in guards.js.
      //
      // Neither of these is the ownership check. That is takeByRank() in the
      // engine, and it is sufficient on its own: a client can name a rank but
      // cannot name a card, so "three Kings" from a hand holding two is refused
      // there and there is no identifier anywhere to forge.
      const ranks = validRankPlay(msg.ranks);
      if (!ranks) return done({ ok: false, error: 'That play was not understood.' });
      const claim = validClaimRank(msg.claim);
      if (!claim) return done({ ok: false, error: 'That claim was not understood.' });
      return done(engine.playCards(actorId, ranks, claim, now));
    }

    // Carries no payload at all, and that is the security property rather than
    // a simplification. The claim being challenged is whatever is on top of the
    // pile according to the HOST; a message naming the claim it meant would let
    // a slow client challenge a claim that has already been replaced, and would
    // give the race a field to tie-break on. There is nothing here to lie
    // about: you are either in the window or you are not, and the engine
    // decides which against its own clock.
    case 'challenge':
      return done(engine.challenge(actorId, now));

    case 'decline':
      return done(engine.decline(actorId, now));

    // --- owner only ---------------------------------------------------------

    case 'setConfig': {
      // normalizeConfig rebuilds the config from a known key list, so an
      // unknown or hostile KEY is dropped rather than stored, and every
      // interdependent bound is re-clamped in the same call. What that does not
      // bound is the SIZE of the object we agree to spread, which is what this
      // check is for.
      const patch = validConfigPatch(msg.patch);
      if (!patch) return done({ ok: false, error: 'That setup change was not understood.' });
      return done(engine.setConfig(patch));
    }

    case 'movePlayer':
      // The id is bounded but not otherwise checked: the engine looks it up and
      // refuses anything that is not a seated player, so a junk value finds
      // nothing. The bound is only so that a 60 KiB string is not compared
      // against every seat.
      return done(engine.movePlayer(validPlayerId(msg.playerId), msg.dir));

    case 'randomizeOrder':
      return done(engine.randomizeOrder());

    // Deliberately carries no name. The engine picks BOT-1, BOT-2... itself, so
    // there is no attacker-supplied string on this path at all — nothing to
    // clean, nothing to length-check, and no way to seat a ninth "player"
    // whose name is a copy of somebody real's.
    case 'addBot':
      return done(engine.addBot());

    case 'removeBot':
      // The engine refuses any id that is not a seated BOT, so this cannot be
      // repurposed into a way of ejecting a human from the table.
      return done(engine.removeBot(validPlayerId(msg.playerId)));

    case 'startGame':
      return done(engine.startGame(actorId));

    case 'skipTurn':
      return done(engine.skipTurn(actorId, now));

    case 'endGame':
      return done(engine.endGame(actorId));

    case 'playAgain':
      return done(engine.playAgain(actorId));

    default:
      return { handled: false, result: null };
  }
}

// An engine method that returns nothing at all still counts as handled, so the
// caller syncs. Defensive: every current method returns { ok }.
function done(result) {
  return { handled: true, result: result || { ok: true } };
}
