// ============================================================================
// state.js — The host-authoritative Bluff engine.
//
// One instance lives in the host's tab and owns the whole truth: every
// player's hand, and the real identity of every card on the pile. Clients send
// intents and receive two things back — a PUBLIC state everyone may see, and a
// PRIVATE slice holding only that player's own cards.
//
// ----------------------------------------------------------------------------
// THE HONESTY CAVEAT, IN THE FILE IT APPLIES TO
//
// In every other game in this family, host-authority is a comfortable
// trade-off. HERE IT IS NOT, because Bluff is entirely about whether somebody
// is lying, and this object knows. A host who opens devtools can challenge
// perfectly every time and never be caught; there is no skill left in the game
// against them.
//
// That cannot be fixed inside this file — an authoritative server is the fix,
// and js/config.js keeps the seam for it — but it CAN be made no worse, and
// that is a live constraint on every line below:
//
//   * No hand and no pile content is ever logged. Not to the console, not into
//     this.log, not into an error message.
//   * publicState() carries counts and never contents. The one exception is
//     `reveal.cards` after a challenge, which is the rule of the game: those
//     specific cards are shown to everyone, and only those.
//   * The revealed cards are stripped of their ids on the way out, so nobody
//     can correlate a card across two reveals or read a deck index off it.
//
// The test suite asserts the publicState() boundary directly. It is the most
// important test in the repo.
// ----------------------------------------------------------------------------
//
// Every intent method returns { ok: true } or { ok: false, error } and mutates
// nothing on rejection, so an illegal move from a stale or hostile client can
// never corrupt the game.
// ============================================================================

import {
  MIN_PLAYERS, MAX_PLAYERS, JOKER, DEFAULT_CONFIG, REVEAL_HOLD_MS,
  normalizeConfig, cleanName, deckSize, dealCounts, describeConfig,
  rankLabel, rankName, plural, nextSeat, CLOCKWISE,
} from './rules.js';
import { buildDeck, shuffle, deal, takeByRank, handCounts } from './cards.js';
import { legalClaims, ruleFollowsSequence } from './claims.js';
// The lobby lock lives in guards.js with the other bounds on untrusted input,
// and is called from startBlocker() below so the host reads the same sentence
// live in the lobby that stops the deal. guards.js imports only rules.js, so
// there is no cycle here.
import { configBlocker } from './guards.js';

export const PHASES = Object.freeze({
  LOBBY: 'lobby',
  PLAY: 'play',
  GAME_OVER: 'gameOver',
});

/**
 * The sub-state of PLAY, modelled EXPLICITLY.
 *
 * The temptation is to answer "are we in a challenge window?" by comparing a
 * timestamp against the clock. That is wrong in three separate situations this
 * game actually reaches: the next-player challenge mode has no timestamp at
 * all, a restored snapshot has a timestamp that is stale by however long the
 * reload took, and the instant between a challenge arriving and the reveal
 * being armed has a deadline that has not been cleared yet. A field that says
 * what is happening is answerable in all three.
 *
 *   AWAITING_PLAY    ---play---------> CHALLENGE_WINDOW
 *   CHALLENGE_WINDOW ---expire/decline-> AWAITING_PLAY  (turn advances)
 *                                    \-> GAME_OVER      (a pending win stands)
 *   CHALLENGE_WINDOW ---challenge----> RESOLVING
 *   RESOLVING        ---expire-------> AWAITING_PLAY  (the taker leads)
 *                                    \-> GAME_OVER      (truthful, and empty)
 */
export const STEPS = Object.freeze({
  AWAITING_PLAY: 'awaitingPlay',
  CHALLENGE_WINDOW: 'challengeWindow',
  RESOLVING: 'resolving',
});

const LOG_LIMIT = 14;
const CLAIM_HISTORY_LIMIT = 24;

export class GameEngine {
  constructor() { this.reset(); }

  reset() {
    this.phase = PHASES.LOBBY;
    this.step = STEPS.AWAITING_PLAY;
    this.hostId = null;
    this.players = [];
    this.config = { ...DEFAULT_CONFIG };
    this.dir = CLOCKWISE;

    // --- HOST-ONLY. Never in any broadcast, never in any log line. ---------
    this.hands = {};        // playerId -> [card]
    this.pile = [];         // [card], face down, in play order
    // The cards of the most recent play, kept apart from the pile so a
    // challenge reveals ONLY THOSE and never the whole pile. They are also in
    // `pile`; this is a window onto its tail, not a second copy.
    this.lastPlayCards = [];
    // -----------------------------------------------------------------------

    this.turn = 0;                    // seat index of the player to act
    this.claim = null;                // { playerId, rank, count } — the top of the pile
    this.claimHistory = [];           // [{ playerId, rank, count }], oldest first
    this.reveal = null;               // public record of the last resolved challenge

    // ------------------------------------------------------------------
    // THE RANK OF THE LAST CLAIM MADE, WHICH OUTLIVES THE PILE.
    //
    // `claim` is the top of the pile and dies with it. This does not, and
    // under the ascending rule that difference is the difference between a
    // game and a livelock.
    //
    // Found by a bot game that ran forty thousand plays without finishing.
    // Ana held no Aces. BOT-2 held all four. An empty pile restarts the
    // ascending cycle at the Ace, so Ana had to claim one; BOT-2 could prove
    // she had not; a caught liar takes the pile AND LEADS (see
    // _resolveChallenge), so Ana led again — into an empty pile, an Ace, and
    // exactly the same position. No policy escapes that. It is not a bot that
    // plays badly, it is a position with no legal move that changes anything.
    //
    // Traditional "I Doubt It" does not have this problem because the rank
    // marches with the TURN ORDER rather than with the pile: A, 2, 3 and on
    // round the table whatever happens to the pile in between. Carrying the
    // rank across the pickup is that rule, and it breaks the cycle
    // structurally — the forced rank can never be the same rank twice running,
    // so no seat can be trapped on one it does not hold.
    //
    // Only the sequence rules read it; see currentLegalClaims(). For
    // 'adjacent' and 'free' the chain genuinely is a property of the pile, and
    // an empty pile genuinely does mean "play anything".
    // ------------------------------------------------------------------
    this.sequenceRank = null;

    // ------------------------------------------------------------------
    // `reveal` is the MOMENT; `seen` is the MEMORY.
    //
    // A new play clears `reveal`, because that is what takes the reveal off
    // everyone's screen. But a card that has been turned over in front of the
    // table does not go back to being unknown — everybody watched somebody
    // pick it up, and that is a deduction the game is played on.
    //
    // So the same knowledge is kept in a second, tiny, long-lived form:
    // counts by rank plus the seat that took them. No ids, no suits, nothing
    // that was not already shown to every device. It is what makes
    // revealedCountOf() in js/bot.js more than a name, and it is what a human
    // is doing when they say "you can't have three Kings, Ana just picked up
    // three Kings". Overwritten by the next reveal, cleared with the deal.
    // ------------------------------------------------------------------
    this.seen = null;                 // { takerId, counts: { rank: n } } | null

    // Two deadlines, each with exactly one writer. See _armWindow / _armReveal.
    this.challengeEndsAt = null;
    this.revealEndsAt = null;

    // Set when a player empties their hand, confirmed only when the window on
    // that final play closes without a successful challenge. See playCards().
    this.pendingWinnerId = null;

    this.winner = null;               // playerId | null
    this.log = [];
    this.gamesPlayed = 0;
  }

  // -------------------------------------------------------------------------
  // The table
  // -------------------------------------------------------------------------

  getPlayer(id) { return this.players.find((p) => p.id === id) || null; }

  seatOf(id) { return this.players.findIndex((p) => p.id === id); }

  get currentPlayer() { return this.players[this.turn] || null; }

  /** The seat that acts after the current one. During a challenge window this
   *  is the only player who may challenge in 'next' mode. */
  get nextPlayer() {
    if (!this.players.length) return null;
    return this.players[nextSeat(this.turn, this.players.length, this.dir)];
  }

  handCount(id) { return (this.hands[id] || []).length; }

  /**
   * Seat a device, or hand it back the seat it already had.
   *
   * SEAT RECLAIM IS BOUND TO clientId AND NOTHING ELSE. The transport's own id
   * changes on every reconnect, and the display name is public — anyone who can
   * reach a four-character room code can type somebody else's name — so a seat
   * that could be reclaimed by naming it could be stolen by naming it. The
   * clientId is a 128-bit secret the browser never renders and never sends
   * anywhere but the host. Same rule as sequence's addPlayer(), and it applies
   * to both transports for the same reason: PeerJS signalling is a public
   * broker, not a LAN.
   */
  addPlayer(id, name, { isHost = false, clientId = null } = {}) {
    const clean = cleanName(name);
    if (!clean) return { ok: false, error: 'Pick a name first.' };

    // A returning device: same secret, seat still held.
    if (clientId) {
      const seat = this.players.find((p) => p.clientId === clientId);
      if (seat) {
        this._remapPlayerId(seat.id, id);
        seat.online = true;
        seat.name = clean;
        if (isHost) { seat.isHost = true; this.hostId = id; }
        return { ok: true, reconnected: true, playerId: id };
      }
    }

    if (this.phase !== PHASES.LOBBY) {
      // Mid-game, a device with no held seat has nothing to join. Deliberately
      // vague: "that game has started" tells a stranger nothing about who is at
      // the table.
      return { ok: false, error: 'That game has already started.' };
    }
    if (this.players.length >= MAX_PLAYERS) {
      return { ok: false, error: `This table is full (${MAX_PLAYERS} players).` };
    }
    if (this.players.some((p) => p.online && p.name.toLowerCase() === clean.toLowerCase())) {
      return { ok: false, error: 'Someone at this table is already using that name.' };
    }

    this.players.push({ id, name: clean, isHost, clientId, online: true, isBot: false });
    if (isHost) this.hostId = id;
    return { ok: true, reconnected: false, playerId: id };
  }

  _remapPlayerId(oldId, newId) {
    if (oldId === newId) return;
    const player = this.players.find((p) => p.id === oldId);
    if (player) player.id = newId;
    if (this.hands[oldId]) {
      this.hands[newId] = this.hands[oldId];
      delete this.hands[oldId];
    }
    if (this.hostId === oldId) this.hostId = newId;
    if (this.pendingWinnerId === oldId) this.pendingWinnerId = newId;
    if (this.winner === oldId) this.winner = newId;
    if (this.claim && this.claim.playerId === oldId) this.claim.playerId = newId;
    for (const c of this.claimHistory) if (c.playerId === oldId) c.playerId = newId;
    if (this.reveal) {
      if (this.reveal.playerId === oldId) this.reveal.playerId = newId;
      if (this.reveal.challengerId === oldId) this.reveal.challengerId = newId;
      if (this.reveal.takerId === oldId) this.reveal.takerId = newId;
    }
    // Missing this one would not crash anything — it would quietly point the
    // deduction at a seat that no longer exists, so the bot would stop
    // discounting the cards it watched somebody pick up, one reconnect ago.
    if (this.seen && this.seen.takerId === oldId) this.seen.takerId = newId;
  }

  addBot() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The game has already started.' };
    if (this.players.length >= MAX_PLAYERS) {
      return { ok: false, error: `This table is full (${MAX_PLAYERS} players).` };
    }
    const name = this._freeBotName();
    if (!name) return { ok: false, error: 'Could not name the bot.' };
    // Prefixed so it can never collide with a seat id from either transport,
    // and re-rolled on a clash so "two players share an id" — which here would
    // mean two players sharing a hand — is impossible rather than improbable.
    let id;
    do { id = `bot:${Math.random().toString(36).slice(2, 10)}`; }
    while (this.players.some((p) => p.id === id));
    this.players.push({ id, name, isHost: false, clientId: null, online: true, isBot: true });
    return { ok: true, id, name };
  }

  _freeBotName() {
    const taken = new Set(this.players.map((p) => p.name.toLowerCase()));
    for (let n = 1; n <= MAX_PLAYERS; n++) {
      const name = `BOT-${n}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
    return null;
  }

  /** It must actually be a bot: this is the fence that stops "remove" being a
   *  way to eject a human from the table. */
  removeBot(id) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The game has already started.' };
    const bot = this.players.find((p) => p.id === id);
    if (!bot || !bot.isBot) return { ok: false, error: 'That is not a bot.' };
    this.players = this.players.filter((p) => p.id !== id);
    delete this.hands[id];
    return { ok: true };
  }

  movePlayer(id, dir) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The game has already started.' };
    const from = this.seatOf(id);
    if (from < 0) return { ok: false, error: 'No such player.' };
    const to = from + (dir < 0 ? -1 : 1);
    if (to < 0 || to >= this.players.length) return { ok: false, error: 'Already at the end.' };
    [this.players[from], this.players[to]] = [this.players[to], this.players[from]];
    return { ok: true };
  }

  randomizeOrder() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The game has already started.' };
    this.players = shuffle(this.players);
    return { ok: true };
  }

  /**
   * A connection dropped.
   *
   * In the lobby the seat is released outright. Once play begins it is HELD —
   * the player's hand is the game, and releasing the seat would either delete
   * cards out of the deck (breaking every supply bound) or hand them to
   * somebody else. A dropped player's turn is the host's problem to nudge, not
   * a reason to destroy their hand.
   */
  markOffline(id) {
    const player = this.getPlayer(id);
    if (!player) return;
    if (this.phase === PHASES.LOBBY) {
      this.players = this.players.filter((p) => p.id !== id);
      delete this.hands[id];
      return;
    }
    player.online = false;
  }

  /**
   * Take ownership of a restored snapshot after the host's tab reloaded.
   *
   * THE HOST'S OWN SEAT MUST BE REMAPPED FIRST. The snapshot holds the peer id
   * the host had before the reload, and that id died with the tab. Setting
   * hostId without moving the seat leaves the host as a player nobody can find
   * — getPlayer(hostId) is null, so their hand is unreachable and their own
   * turn cannot be taken. The seat is found by clientId, which survives the
   * reload in localStorage, falling back to the isHost flag for a snapshot
   * written before a clientId existed.
   *
   * The reload also destroyed every peer connection, so the online flags all
   * point at dead ids and must be cleared or every genuine rejoin looks like an
   * impostor. Bots stay online: there is no socket to lose.
   */
  resumeAsHost(hostId, clientId = null) {
    const seat = (clientId && this.players.find((p) => p.clientId === clientId))
      || this.players.find((p) => p.isHost)
      || null;
    if (seat) this._remapPlayerId(seat.id, hostId);

    for (const p of this.players) {
      p.online = !!p.isBot || p.id === hostId;
      if (p.id === hostId) p.isHost = true;
    }
    this.hostId = hostId;
    // Both deadlines are wall-clock and the reload took real time, so they are
    // almost always already past. Re-arm rather than expire: nobody should lose
    // a challenge window to somebody else's crash.
    const now = Date.now();
    if (this.phase === PHASES.PLAY && this.step === STEPS.CHALLENGE_WINDOW) this._armWindow(now);
    if (this.phase === PHASES.PLAY && this.step === STEPS.RESOLVING) this._armReveal(now);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  setConfig(patch) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The game has already started.' };
    // The whole config goes through normalizeConfig, not just the changed key.
    // That is what makes the re-clamp rule work: dropping `decks` to 1 brings
    // `jokers` and `maxPlay` down in the same call, with no ordering to get
    // right and no instant in which a one-deck game holds six jokers.
    this.config = normalizeConfig({ ...this.config, ...patch });
    return { ok: true };
  }

  applyPreset(patch) { return this.setConfig(patch); }

  /**
   * Why the table cannot start yet, or null. Shown live in the lobby, and
   * checked again in startGame — a message the host can read is not a guard.
   */
  startBlocker() {
    if (this.players.length < MIN_PLAYERS) {
      const need = MIN_PLAYERS - this.players.length;
      return `Needs ${MIN_PLAYERS} players. ${plural(need, 'seat')} to go — or fill them with bots.`;
    }
    if (this.players.length > MAX_PLAYERS) return `Too many players (max ${MAX_PLAYERS}).`;
    return configBlocker(this.config);
  }

  startGame(actorId) {
    if (actorId !== this.hostId) return { ok: false, error: 'Only the host can start the game.' };
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The game has already started.' };
    const blocker = this.startBlocker();
    if (blocker) return { ok: false, error: blocker };

    const pack = shuffle(buildDeck(this.config));
    const hands = deal(pack, { players: this.players.length, from: 0, dir: this.dir });
    this.hands = {};
    this.players.forEach((p, seat) => { this.hands[p.id] = hands[seat]; });

    this.pile = [];
    this.lastPlayCards = [];
    this.claim = null;
    this.claimHistory = [];
    this.reveal = null;
    this.seen = null;
    this.sequenceRank = null;
    this.winner = null;
    this.pendingWinnerId = null;
    this.challengeEndsAt = null;
    this.revealEndsAt = null;

    // Rotated so the same seat does not open every game of a long evening.
    this.turn = this.gamesPlayed % this.players.length;
    this.phase = PHASES.PLAY;
    this.step = STEPS.AWAITING_PLAY;

    this._log(`${describeConfig(this.config)}.`);
    const counts = dealCounts(deckSize(this.config), this.players.length);
    this._log(counts[0] === counts[counts.length - 1]
      ? `${plural(counts[0], 'card')} each.`
      : `${counts[counts.length - 1]}–${counts[0]} cards each — the deal does not divide evenly, which is normal.`);
    this._log(`${this.currentPlayer.name} opens.`);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // A turn
  // -------------------------------------------------------------------------

  /**
   * Which ranks the player to act may claim right now.
   *
   * Normally the pile's top claim, which is why the chain resets when the pile
   * is taken. The exception is the sequence rules, where the rank belongs to
   * the turn order rather than to the pile and therefore survives a pickup —
   * see `sequenceRank` in the constructor for the livelock that establishes.
   */
  currentLegalClaims() {
    const onPile = this.claim ? this.claim.rank : null;
    const previous = onPile !== null ? onPile
      : (ruleFollowsSequence(this.config.rankRule) ? this.sequenceRank : null);
    return legalClaims(this.config.rankRule, previous);
  }

  /**
   * Put cards face down on the pile and announce a rank and a count.
   *
   * `ranks` is a MULTISET OF RANK TOKENS from the player's own hand, e.g.
   * ['K','K','7'] — not card ids. See takeByRank() in js/cards.js for why. The
   * claim is a separate argument entirely, and the two are allowed to have
   * nothing to do with each other. That is the game.
   *
   * In 'next' challenge mode this doubles as declining to challenge: the
   * previous play's window is still open, and playing over it is how the next
   * player says they believe it. Closing the window first is what makes a
   * pending win resolve before the game moves on.
   */
  playCards(actorId, ranks, claimRank, now = Date.now()) {
    if (this.phase !== PHASES.PLAY) return { ok: false, error: 'No game in progress.' };

    // 'next' mode: the player after the claimer plays INSTEAD of challenging,
    // so their play implicitly closes the open window. In 'window' mode the
    // clock owns the window and nobody may play over it.
    if (this.step === STEPS.CHALLENGE_WINDOW) {
      if (this.config.challengeMode !== 'next') {
        return { ok: false, error: 'Wait for the challenge window to close.' };
      }
      const next = this.nextPlayer;
      if (!next || next.id !== actorId) return { ok: false, error: 'Not your turn.' };
      this._closeWindow(now);
      // Closing it may have ended the game: the previous player went out and
      // this player chose not to challenge, which is them conceding.
      if (this.phase !== PHASES.PLAY) return { ok: true };
    }

    if (this.step !== STEPS.AWAITING_PLAY) {
      return { ok: false, error: 'Wait for the reveal to finish.' };
    }
    const player = this.currentPlayer;
    if (!player || player.id !== actorId) return { ok: false, error: 'Not your turn.' };

    if (!Array.isArray(ranks) || ranks.length < 1) {
      return { ok: false, error: 'Choose at least one card.' };
    }
    if (ranks.length > this.config.maxPlay) {
      return { ok: false, error: `At most ${plural(this.config.maxPlay, 'card')} at a time.` };
    }
    // Asked THROUGH currentLegalClaims() rather than by rebuilding the
    // "previous rank" expression here. The two used to be written out
    // separately and drifted the moment the ascending chain started surviving
    // a pickup: the check said Ace, the sentence underneath said Four, and a
    // correct client was refused its only legal move by an engine disagreeing
    // with itself. One source, and the refusal and its explanation cannot part
    // company again.
    const legalNow = this.currentLegalClaims();
    if (!legalNow.includes(claimRank)) {
      // Names the legal claim rather than only refusing, because under the
      // ascending rule there is exactly one and a client that got it wrong is
      // out of step rather than cheating.
      return { ok: false, error: `You must claim ${legalNow.map(rankLabel).join(', ')}.` };
    }

    const hand = this.hands[actorId] || [];
    const pulled = takeByRank(hand, ranks);
    // The only ownership check there is, and it is sufficient: the client can
    // name a rank but cannot name a card, so "I play three Kings" from a hand
    // holding two is refused here and there is no id to forge.
    if (!pulled) return { ok: false, error: 'You do not hold those cards.' };

    this.hands[actorId] = pulled.rest;
    this.pile.push(...pulled.taken);
    this.lastPlayCards = pulled.taken;

    this.claim = { playerId: actorId, rank: claimRank, count: ranks.length };
    // Written here and cleared only by a deal, so it outlives the pickup that
    // clears `claim`. This is the only writer.
    this.sequenceRank = claimRank;
    this.claimHistory.push({ ...this.claim });
    if (this.claimHistory.length > CLAIM_HISTORY_LIMIT) this.claimHistory.shift();
    // A new play supersedes the last reveal, which is what takes it off screen.
    this.reveal = null;

    // rankName() already carries the plural, so plural() must not be layered on
    // top of it — "3 kingss" shipped once and reads as a typo, not a count.
    this._log(`${player.name}: ${this.claim.count} ${rankName(claimRank, this.claim.count).toLowerCase()}.`);

    // ------------------------------------------------------------------
    // GOING OUT IS NOT WINNING. Not yet.
    //
    // The classic implementation bug in this game is declaring a winner the
    // moment their hand empties. It is wrong: the final play can still be
    // challenged, and a player caught lying on it picks up the whole pile and
    // is very much still playing. So the win is PENDING until the window on
    // this play closes — see _closeWindow() and _resolveChallenge().
    // ------------------------------------------------------------------
    if (this.hands[actorId].length === 0) {
      this.pendingWinnerId = actorId;
      this._log(`${player.name} is out of cards — if that stands, they win.`);
    }

    this.step = STEPS.CHALLENGE_WINDOW;
    this._armWindow(now);
    return { ok: true };
  }

  /**
   * Decline to challenge, in 'next' mode.
   *
   * Only strictly needed when the previous player has gone out, where playing
   * over the claim is not available as a way of saying "I believe you" —
   * there is nothing to play on to. Offered as its own intent rather than
   * folded into playCards() so the UI can put a plain LET IT STAND next to
   * CHALLENGE at exactly the moment the game is about to be decided.
   */
  decline(actorId, now = Date.now()) {
    if (this.phase !== PHASES.PLAY) return { ok: false, error: 'No game in progress.' };
    if (this.step !== STEPS.CHALLENGE_WINDOW) return { ok: false, error: 'Nothing to let stand.' };
    if (this.config.challengeMode !== 'next') {
      return { ok: false, error: 'The window closes on its own.' };
    }
    const next = this.nextPlayer;
    if (!next || next.id !== actorId) return { ok: false, error: 'Not your decision.' };
    this._closeWindow(now);
    return { ok: true };
  }

  /**
   * Call the last claim a lie.
   *
   * ----------------------------------------------------------------------
   * THE RACE, AND WHY IT IS DECIDED HERE AND NOWHERE ELSE
   *
   * In 'window' mode every device at the table can tap CHALLENGE at the same
   * moment, and several messages genuinely arrive together. The host applies
   * them one at a time, and the FIRST one moves the step to RESOLVING — so
   * every later one finds a step that is no longer CHALLENGE_WINDOW and is
   * refused by the check three lines below. No timestamps are compared, no
   * client is asked when it tapped, and there is no tie to break.
   *
   * A client must never be allowed to decide this. A client's clock is its
   * own, its latency is its own, and both are trivially forged. `now` here is
   * the HOST's clock, passed in by whoever owns the engine.
   * ----------------------------------------------------------------------
   */
  challenge(actorId, now = Date.now()) {
    if (this.phase !== PHASES.PLAY) return { ok: false, error: 'No game in progress.' };
    if (this.step !== STEPS.CHALLENGE_WINDOW) {
      // Covers both "too late, the window closed" and "somebody beat you to
      // it". Deliberately one message: from the player's side they are the
      // same event, and the difference is not theirs to act on.
      return { ok: false, error: 'Too late.' };
    }
    if (!this.claim) return { ok: false, error: 'There is nothing to challenge.' };
    if (this.claim.playerId === actorId) {
      return { ok: false, error: 'You cannot challenge your own claim.' };
    }
    const challenger = this.getPlayer(actorId);
    if (!challenger) return { ok: false, error: 'You are not at this table.' };

    if (this.config.challengeMode === 'next') {
      const next = this.nextPlayer;
      if (!next || next.id !== actorId) {
        return { ok: false, error: 'Only the next player may call this one.' };
      }
    } else if (this.challengeEndsAt != null && now >= this.challengeEndsAt) {
      // The host's own tick may not have closed the window yet, so a genuinely
      // late message can still arrive while the step says otherwise. Checked
      // against the host's clock, never the sender's.
      return { ok: false, error: 'Too late.' };
    }

    this.step = STEPS.RESOLVING;
    this.challengeEndsAt = null;
    return this._resolveChallenge(challenger, now);
  }

  /**
   * Turn over the challenged cards and hand the pile to whoever was wrong.
   *
   * ONLY THE CHALLENGED CARDS ARE REVEALED. Not the pile — the pile may hold
   * fifty cards from a dozen earlier claims, and turning those over would end
   * the deduction the rest of the game is made of. `lastPlayCards` is exactly
   * the cards of the most recent play and nothing else.
   */
  _resolveChallenge(challenger, now) {
    const claimer = this.getPlayer(this.claim.playerId);
    const cards = this.lastPlayCards;
    const wild = this.config.jokerMode === 'wild';

    // The whole of both joker modes, in one expression. In wild mode a joker
    // satisfies whatever was claimed, so `7D 7S Joker` really is three sevens
    // and the challenger is wrong. In junk mode it satisfies nothing, so the
    // same hand is a lie — which is what makes a hand of jokers a hot potato
    // that can be shed but never defended.
    const truthful = cards.every((c) => c.rank === this.claim.rank || (wild && c.rank === JOKER));
    const jokerSaved = wild && truthful && cards.some((c) => c.rank === JOKER);

    const taker = truthful ? challenger : claimer;
    const pileSize = this.pile.length;
    this._takePile(taker.id);

    this.reveal = {
      claimRank: this.claim.rank,
      claimCount: this.claim.count,
      // The one deliberate hole in the privacy boundary, and it is the rule of
      // the game rather than a leak. Ids are stripped: the rank and suit are
      // what the table is entitled to see, and an id would additionally say
      // which deck the card came from and let two reveals be correlated.
      cards: cards.map((c) => ({ rank: c.rank, suit: c.suit })),
      playerId: claimer ? claimer.id : null,
      playerName: claimer ? claimer.name : '',
      challengerId: challenger.id,
      challengerName: challenger.name,
      truthful,
      jokerSaved,
      takerId: taker.id,
      takerName: taker.name,
      pileSize,
    };

    // The memory that outlives the moment. Counts only — a rank and a number
    // are exactly what the table just watched, and nothing more. The joker
    // count rides along under its own token because in wild mode a revealed
    // joker is a card that could have satisfied any rank, so it has to be
    // subtractable from every rank's supply and not just from its own.
    const seenCounts = Object.create(null);
    for (const c of cards) seenCounts[c.rank] = (seenCounts[c.rank] || 0) + 1;
    this.seen = { takerId: taker.id, counts: seenCounts };

    this._log(truthful
      ? `${challenger.name} called it. ${claimer.name} was telling the truth${jokerSaved ? ' — a joker covered it' : ''}; ${challenger.name} takes ${plural(pileSize, 'card')}.`
      : `${challenger.name} called it. ${claimer.name} was lying and takes ${plural(pileSize, 'card')}.`);

    // The pile is gone, so the pile rules' chain restarts and the next claim
    // may be anything. `sequenceRank` is deliberately NOT cleared here — the
    // ascending cycle belongs to the turn order and marches straight through a
    // pickup. See currentLegalClaims() and ruleFollowsSequence().
    this.claim = null;
    this.lastPlayCards = [];

    // ------------------------------------------------------------------
    // SURVIVING THE CHALLENGE IS WHAT WINS IT.
    //
    // A truthful claimer with an empty hand has now done both halves of the
    // rule and the game is over. A caught liar has just taken the pile, so
    // their hand is emphatically not empty and the pending win evaporates —
    // they are back in the game, which is exactly what should happen.
    // ------------------------------------------------------------------
    if (truthful && this.pendingWinnerId === claimer.id && this.handCount(claimer.id) === 0) {
      // `truthful` is merged in rather than left off, because every caller of
      // challenge() branches on it to word the reveal, and a challenge that
      // happens to end the game is still a challenge that was answered.
      return { ...this._declareWinner(claimer.id, ' — and out on a claim that held.'), truthful };
    }
    this.pendingWinnerId = null;

    // ------------------------------------------------------------------
    // A CHALLENGE DOES NOT CHANGE WHOSE TURN IT IS NEXT. The table rotates
    // past the player who was challenged exactly as if nothing had happened.
    //
    // The first version handed the lead to whoever picked the pile up, on the
    // reasoning that they are the only player whose position changed. It reads
    // well and it is wrong, for a reason only a few thousand headless games
    // make visible: it means being caught costs no tempo. A caught liar takes
    // the pile and immediately leads, and under the ascending rule that drops
    // them straight back into a forced rank they probably still do not hold —
    // lie, caught, lead, lie, caught, lead. Measured at one deck: an average
    // of 4821 plays per game and three games in twelve that never finished at
    // all. Rotating instead: 54 plays, twelve games in twelve.
    //
    // It is also the better rule on its own terms. Losing your turn is what
    // makes a challenge a punishment rather than an inconvenience, and
    // "nothing about the turn order changes" is one sentence to explain, where
    // "the person who picked up goes next, and that might be the challenger"
    // is three and still surprises people at the table.
    // ------------------------------------------------------------------
    // `claimer || taker` because a player can leave between the claim and the
    // resolution; the turn still has to land somewhere real.
    const from = this.seatOf((claimer || taker).id);
    this.turn = nextSeat(from < 0 ? this.turn : from, this.players.length, this.dir);
    this._armReveal(now);
    return { ok: true, truthful };
  }

  _takePile(playerId) {
    const hand = this.hands[playerId] || (this.hands[playerId] = []);
    hand.push(...this.pile);
    this.pile = [];
  }

  _declareWinner(playerId, suffix = '') {
    const player = this.getPlayer(playerId);
    this.winner = playerId;
    this.phase = PHASES.GAME_OVER;
    this.step = STEPS.AWAITING_PLAY;
    this.pendingWinnerId = null;
    this.challengeEndsAt = null;
    this.revealEndsAt = null;
    this.gamesPlayed++;
    this._log(`${player ? player.name : 'Somebody'} wins${suffix}`);
    return { ok: true, winner: playerId };
  }

  // -------------------------------------------------------------------------
  // The clocks
  //
  // HOUSE RULE: NO TIMERS IN THE ENGINE. Time is a parameter. This class is
  // serialized to localStorage and rehydrated after a host reload, driven
  // identically by a browser tab and (one day) by a server, and played
  // thousands of times per second by the test suite. An interval living in
  // here would survive none of that. Whoever owns the engine ticks it — see
  // resolveExpiredWindow() and js/main.js.
  //
  // Two deadlines, each with EXACTLY ONE WRITER. Nothing else in this file
  // assigns to challengeEndsAt or revealEndsAt; grep for them and you will
  // find only the arming functions and the paths that clear both to null.
  // -------------------------------------------------------------------------

  /**
   * The only function that sets challengeEndsAt.
   *
   * Null in 'next' mode, and that is not an omission: that mode has no clock
   * at all, and a deadline nobody watches would be a second source of truth
   * about when the window is open. The step field is the truth in both modes.
   */
  _armWindow(now = Date.now()) {
    this.challengeEndsAt = this.config.challengeMode === 'window'
      ? now + this.config.windowMs
      : null;
  }

  /** The only function that sets revealEndsAt. */
  _armReveal(now = Date.now()) {
    this.revealEndsAt = now + REVEAL_HOLD_MS;
  }

  /**
   * Advance anything whose deadline has passed. PURE IN `now`.
   *
   * Safe and cheap to call on any interval from anywhere: a no-op unless a
   * game is running and something is actually overdue. Whoever owns the engine
   * calls it and broadcasts when it reports back that it fired.
   *
   * Clients NEVER call this. They render a countdown from the broadcast
   * deadline and wait to be told what happened — a client that decided a
   * window had expired would be a client deciding whether a challenge counted.
   */
  resolveExpiredWindow(now = Date.now()) {
    if (this.phase !== PHASES.PLAY) return { fired: false };

    if (this.step === STEPS.CHALLENGE_WINDOW) {
      if (this.challengeEndsAt == null || now < this.challengeEndsAt) return { fired: false };
      this._closeWindow(now);
      return { fired: true, what: 'window' };
    }

    if (this.step === STEPS.RESOLVING) {
      if (this.revealEndsAt == null || now < this.revealEndsAt) return { fired: false };
      this.revealEndsAt = null;
      this.step = STEPS.AWAITING_PLAY;
      return { fired: true, what: 'reveal' };
    }

    return { fired: false };
  }

  /**
   * The challenge window closed with nobody calling it.
   *
   * The pending-win check lives here rather than in playCards() because this
   * is the moment the rule is actually satisfied: the hand emptied a few
   * seconds ago, and what has just happened is that it survived.
   */
  _closeWindow(now) {
    this.challengeEndsAt = null;
    if (this.pendingWinnerId) {
      return this._declareWinner(this.pendingWinnerId, ' — nobody called the last claim.');
    }
    this.step = STEPS.AWAITING_PLAY;
    this.turn = nextSeat(this.turn, this.players.length, this.dir);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Host controls
  // -------------------------------------------------------------------------

  /** Nudge past a player who has dropped or gone to sleep. Deliberately does
   *  not play a card for them — the host picking a claim on someone else's
   *  behalf is not a thing this game can allow. */
  skipTurn(actorId, now = Date.now()) {
    if (actorId !== this.hostId) return { ok: false, error: 'Only the host can skip a turn.' };
    if (this.phase !== PHASES.PLAY) return { ok: false, error: 'No game in progress.' };
    if (this.step === STEPS.CHALLENGE_WINDOW) { this._closeWindow(now); return { ok: true }; }
    if (this.step === STEPS.RESOLVING) {
      this.revealEndsAt = null;
      this.step = STEPS.AWAITING_PLAY;
      return { ok: true };
    }
    const skipped = this.currentPlayer;
    this.turn = nextSeat(this.turn, this.players.length, this.dir);
    if (skipped) this._log(`${skipped.name} was skipped.`);
    return { ok: true };
  }

  endGame(actorId) {
    if (actorId !== this.hostId) return { ok: false, error: 'Only the host can end the game.' };
    if (this.phase !== PHASES.PLAY) return { ok: false, error: 'No game in progress.' };
    this.phase = PHASES.GAME_OVER;
    this.step = STEPS.AWAITING_PLAY;
    this.winner = null;
    this.pendingWinnerId = null;
    this.challengeEndsAt = null;
    this.revealEndsAt = null;
    this.gamesPlayed++;
    this._log('The host ended the game.');
    return { ok: true };
  }

  /** Back to the lobby with the same table. */
  playAgain(actorId) {
    if (actorId !== this.hostId) return { ok: false, error: 'Only the host can restart.' };
    if (this.phase !== PHASES.GAME_OVER) return { ok: false, error: 'The game is still going.' };
    this.phase = PHASES.LOBBY;
    this.step = STEPS.AWAITING_PLAY;
    this.hands = {};
    this.pile = [];
    this.lastPlayCards = [];
    this.claim = null;
    this.claimHistory = [];
    this.reveal = null;
    this.seen = null;
    this.sequenceRank = null;
    this.winner = null;
    this.pendingWinnerId = null;
    this.challengeEndsAt = null;
    this.revealEndsAt = null;
    this.log = [];
    // Players who dropped during the finished game do not hold seats in the
    // rematch. Bots are kept whatever their flag says — a host who seated two
    // of them expects the same table back.
    this.players = this.players.filter((p) => p.online || p.isBot);
    return { ok: true };
  }

  _log(text) {
    // Every call site is audited for this: no card, hand or pile content ever
    // reaches this array. It is public, it is serialized, and it is the
    // easiest place in the codebase to accidentally publish the whole game.
    this.log.push(text);
    if (this.log.length > LOG_LIMIT) this.log.shift();
  }

  // -------------------------------------------------------------------------
  // Snapshot — host reload only, never sent anywhere
  // -------------------------------------------------------------------------

  snapshot() {
    return {
      phase: this.phase, step: this.step, hostId: this.hostId,
      players: this.players, config: this.config, dir: this.dir,
      hands: this.hands, pile: this.pile, lastPlayCards: this.lastPlayCards,
      turn: this.turn, claim: this.claim, claimHistory: this.claimHistory,
      reveal: this.reveal, seen: this.seen,
      // Both are stale by definition once restored; resumeAsHost re-arms them.
      // Carried anyway so a restore can tell "no window" from "a window whose
      // value we lost", which restore() would otherwise read as the former.
      challengeEndsAt: this.challengeEndsAt, revealEndsAt: this.revealEndsAt,
      pendingWinnerId: this.pendingWinnerId, winner: this.winner,
      log: this.log, gamesPlayed: this.gamesPlayed,
    };
  }

  restore(s) {
    if (!s) return;
    this.reset();
    Object.assign(this, s);
  }

  // -------------------------------------------------------------------------
  // Views sent over the wire
  // -------------------------------------------------------------------------

  lobbyInfo(hostName) {
    return {
      hostName: hostName || '',
      playerCount: this.players.length,
      phase: this.phase,
      joinable: this.phase === PHASES.LOBBY && this.players.length < MAX_PLAYERS,
    };
  }

  /**
   * What every device may see.
   *
   * THE MOST SECURITY-SENSITIVE FUNCTION IN THE REPO. `hands`, `pile` and
   * `lastPlayCards` are deliberately absent; only counts go out. Adding a field
   * here that carries a card is how this game stops working, because the whole
   * of it is what other people cannot see.
   *
   * `reveal.cards` is the single exception and it is the rule of the game: a
   * resolved challenge shows the challenged cards to everyone. It is built in
   * _resolveChallenge() with ids stripped.
   *
   * Hand COUNTS are public and load-bearing — a player down to one card is the
   * entire tension of an endgame, and hiding it would make the game worse, not
   * fairer. So is the config: nobody can judge whether "five Kings" is absurd
   * without knowing the deck count, which is why it is on screen during play
   * and not only in the lobby.
   */
  publicState() {
    const current = this.currentPlayer;
    const next = this.nextPlayer;
    return {
      phase: this.phase,
      step: this.step,
      hostId: this.hostId,
      winner: this.winner,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        online: p.online,
        isHost: !!p.isHost,
        // Public: everyone at the table is entitled to know which of the other
        // names is a computer before they agree to play.
        isBot: !!p.isBot,
        handCount: this.handCount(p.id),
      })),
      config: this.config,
      deckSize: deckSize(this.config),
      turnPlayerId: current ? current.id : null,
      turnSeat: this.turn,
      nextPlayerId: next ? next.id : null,
      // Rank and count only. What was actually played is host-only until a
      // challenge turns it over.
      claim: this.claim ? { ...this.claim } : null,
      claimHistory: this.claimHistory.map((c) => ({ ...c })),
      legalClaims: this.phase === PHASES.PLAY ? this.currentLegalClaims() : [],
      pileSize: this.pile.length,
      // An absolute timestamp, so a device on a slow connection counts down to
      // the time that is actually left rather than the time that was left when
      // the packet was sent. Null in 'next' mode, where there is no clock.
      challengeEndsAt: this.challengeEndsAt,
      revealEndsAt: this.revealEndsAt,
      // Sent alongside the deadline because the view needs both: the deadline
      // to count down to, and the full duration to draw the bar as a fraction.
      windowMs: this.config.windowMs,
      pendingWinnerId: this.pendingWinnerId,
      reveal: this.reveal,
      // Public because it was public the moment it happened — this is a
      // summary of what every device already saw, kept in a form that can
      // still be reasoned with after the reveal has left the screen. It
      // carries no ids and no suits, so it is not a second route to a hand.
      seen: this.seen,
      log: this.log,
      startBlocker: this.phase === PHASES.LOBBY ? this.startBlocker() : null,
    };
  }

  /** One player's own cards, and what they may do with them. */
  privateStateFor(id) {
    const player = this.getPlayer(id);
    if (!player) return null;
    const hand = this.hands[id] || [];
    const inWindow = this.phase === PHASES.PLAY && this.step === STEPS.CHALLENGE_WINDOW;
    const isNext = !!(this.nextPlayer && this.nextPlayer.id === id);

    return {
      playerId: id,
      // The player's own cards. The only place card contents leave this object
      // on purpose, and they go to exactly one device.
      hand: hand.map((c) => ({ id: c.id, rank: c.rank, suit: c.suit })),
      counts: handCounts(hand),
      isTurn: this.phase === PHASES.PLAY
        && this.step === STEPS.AWAITING_PLAY
        && !!this.currentPlayer && this.currentPlayer.id === id,
      // A play is capped by the rules AND by what is actually held — offering a
      // count the player cannot reach is a button that can only fail.
      maxPlay: Math.min(this.config.maxPlay, hand.length),
      canChallenge: inWindow
        && !!this.claim && this.claim.playerId !== id
        && (this.config.challengeMode === 'window' || isNext),
      canDecline: inWindow && this.config.challengeMode === 'next' && isNext,
      // In 'next' mode the player after the claimer may play over an open
      // window, which is how they decline. Everyone else must wait.
      canPlayOverWindow: inWindow && this.config.challengeMode === 'next' && isNext,
    };
  }
}
