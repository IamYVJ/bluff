// ============================================================================
// main.js — the controller: which of three things this tab is, and the single
// clock everything else runs on.
//
// THE THREE MODES, AND WHY THERE ARE ONLY TWO CODE PATHS
//   solo   — an engine, bots, no transport.
//   host   — the same engine, the same bots, plus a transport that other
//            phones dial into.
//   client — no engine at all. A screen, a socket, and somebody else's
//            authority.
//
//   Solo is not a third thing. It is host mode with `transport === null`, and
//   every host function below is written to tolerate that — push() sends to
//   nobody, refuse() refuses nobody. That collapse is deliberate: the offline
//   game and the hosted game are then the same tested code, so the path
//   somebody plays on a train is the path everybody plays at a table.
//
//   The client path is the genuinely different one, and it is different by
//   subtraction. It owns no GameEngine, which means there is no second copy of
//   the rules to disagree with the first, no local prediction to roll back,
//   and no way for a guest's tab to believe something the host does not. What
//   it does with a tap is put it on the wire; what it does with a frame is
//   draw it.
//
// TIME
//   The engine has no timers — time is a parameter, and whoever owns the
//   engine supplies it. That owner is the interval at the bottom of this file,
//   and it exists on the host's phone only. A guest's countdown is drawn from
//   the DEADLINE in the state frame rather than counted locally, so a slow
//   connection shows the time actually left instead of the time that was left
//   when the packet was sent, and a wrong phone clock draws a wrong bar
//   without ever deciding anything.
//
// IDENTITY, IN ONE PLACE
//   MY_CLIENT_ID is this device's ticket. It is the ONLY thing a seat is
//   reclaimed by — see addPlayer() in state.js for why a name or a peer id
//   would be a seat anyone could steal. It is read once here, passed to the
//   engine on the host's own seat and into the JOIN frame on a guest's, and
//   goes nowhere else in this file.
//
// THE ONE HONESTY PROBLEM, STATED OUT LOUD
//   The host's tab holds every hand, in memory and in localStorage. A host who
//   opens the console can read the table. There is no fix for that inside a
//   peer-to-peer design — only moving the authority to a server fixes it,
//   which is the seam intents.js exists to keep open: applyGameIntent() below
//   takes an engine, an actor and a message, and nothing about that signature
//   assumes the engine is in this process. It goes in the README rather than
//   being quietly hoped about.
// ============================================================================

import { GameEngine } from './state.js';
import { applyGameIntent } from './intents.js';
import { createBotDriver } from './bot.js';
import { createUI } from './ui.js';
import {
  createHost, joinHost, peerAvailable, isFatalPeerError, describePeerError,
  rejectFrame, readRejectFrame, replacedFrame, HOST_ID,
} from './net.js';
import {
  generateRoomCode, normalizeCode, CODE_LENGTH, clientId,
  loadName, saveName, loadCode, saveCode,
  saveSession, loadSession, clearSession,
  saveEngineSnapshot, loadEngineSnapshot,
} from './util.js';

// ---------------------------------------------------------------------------
// Tuning. Every one of these is a number somebody will want to argue with, so
// each says what it is trading off.
// ---------------------------------------------------------------------------

/** How often the host looks at the clock. Fast enough that a 3-second
 *  countdown reads smoothly and a bot's pause lands where it was aimed; slow
 *  enough to be free. */
const TICK_MS = 100;

/** How often the host writes the table to disk. Three seconds is at most three
 *  seconds of play lost to a crash, against a JSON.stringify of every hand in
 *  the game — a few kilobytes — twenty times a minute. */
const SNAPSHOT_MS = 3000;

/**
 * How long a dial may sit there before we call it.
 *
 * NOTHING ELSE IMPOSES THIS. A host that cannot be reached over WebRTC — wrong
 * code that happens to resolve, a phone that went into a tunnel, a corporate
 * Wi-Fi that blocks the traffic — produces no error at all; the connection
 * simply never opens. joinHost() deliberately has no timeout of its own
 * because what a missed deadline MEANS depends on whether there was a game
 * yet, and only this file knows that. Twelve seconds is long enough for a slow
 * ICE negotiation on mobile data and short enough that somebody who mistyped a
 * character finds out while they still remember typing it.
 */
const JOIN_BUDGET_MS = 12000;

/**
 * What a dial that never landed is told, from either of the two ways it can
 * fail to land: the budget above running out in silence, or the ladder below
 * being climbed to the top. One sentence rather than two, because the player
 * cannot tell those apart and should not have to — from where they are sitting
 * it is the same event, and it has the same two remedies.
 */
const NO_ANSWER = 'No answer from that table. Check the four characters, and that the host still has the game open.';

/**
 * The reconnect ladder, in order. Four tries, then we stop and say so.
 *
 * Backing off rather than hammering: the commonest cause of a drop is the host
 * walking out of range, and the commonest cure is them walking back, which
 * takes seconds rather than milliseconds. Bounded rather than infinite because
 * a table that has genuinely closed should end up on a home screen with a HOST
 * button on it, not on a spinner that outlives the evening.
 */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000];

/**
 * How long to let a refusal reach a phone before closing its channel.
 *
 * `conn.send()` hands the frame to a DataChannel and returns; closing
 * immediately afterwards can drop it on the floor. A guest who is bounced for
 * a duplicate name must be told WHY, and a silent close is indistinguishable
 * from the host's phone dying — so the close waits a beat. The connection is
 * already out of the engine by then and can do nothing in the meantime.
 */
const FLUSH_MS = 400;

/** How many times a taken room code is silently swapped for another before the
 *  host is asked to deal with it. Two collisions in a row on a 32^4 space is
 *  not a collision, it is something else, and retrying forever would hide it. */
const MAX_REHOSTS = 2;

// ---------------------------------------------------------------------------
// What this tab is.
// ---------------------------------------------------------------------------

/** This device's seat ticket. Read once. See the header. */
const MY_CLIENT_ID = clientId();

let mode = 'home';        // 'home' | 'solo' | 'host' | 'client'
let engine = null;        // host and solo only — a client owns no rules
let transport = null;     // null in solo, and between a drop and a redial
let session = { name: '', code: null };

/**
 * THE STALE-CALLBACK GUARD, and it is load-bearing rather than tidy.
 *
 * A PeerJS peer keeps firing after destroy() — a socket close already in
 * flight, an ICE failure that was queued before we let go. Those callbacks
 * land in the handler set of a transport this file has already replaced, and
 * without a guard a dying connection's `onClose` schedules a reconnect for a
 * table we deliberately left, or a dead host's `onDisconnect` marks a seat
 * away in an engine that belongs to the NEXT game.
 *
 * Every handler set closes over the epoch it was created at and does nothing
 * once the counter has moved. teardown() moves it. That is the whole mechanism
 * and it replaces the alternative, which is remembering to unsubscribe from
 * nine events in five places.
 */
let netEpoch = 0;

let joinTimer = null;
let retryTimer = null;
let snapTimer = null;
let attempt = 0;          // position on the reconnect ladder
let rehosts = 0;          // room codes burned to an id collision
let seatedOnce = false;   // has this client ever received a state frame?

const bots = createBotDriver();

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

const ui = createUI({
  root: document.getElementById('app'),
  savedName: loadName(),
  savedCode: loadCode(),
  send: sendIntent,
  onHost: (name) => startHost(name),
  onJoin: startJoin,
  onSolo: startSolo,
  onLeave: () => goHome(),
});

/**
 * Every tap, as the wire message a remote phone would have sent.
 *
 * On a guest's phone that is literally what happens. On the host's it is
 * routed through applyGameIntent rather than into the engine directly, even
 * though this tab IS the host, and the second of these two reasons is the one
 * that matters: it keeps the owner guard live for the host's own lobby
 * controls, and it means the local path is the tested path — the transport is
 * not exercising code the host's own thumb never touched.
 */
function sendIntent(msg) {
  if (mode === 'client') {
    if (transport) transport.send(msg);
    return;
  }
  if (!engine) return;
  const { handled, result } = applyGameIntent(engine, HOST_ID, msg, Date.now());
  // An unhandled type from our OWN ui is a bug in this file, not in the
  // message: the UI only ever emits intents that dispatcher knows.
  if (!handled) { console.warn('[main] unhandled intent', msg && msg.type); return; }
  if (result && !result.ok) ui.flash(result.error);
  push();
}

/**
 * Publish. THE PRIVACY MODEL OF THE WHOLE GAME IS THIS FUNCTION AND THE LOOP
 * IT CALLS.
 *
 * `pub` is built once and is counts-only; the private half is fetched per
 * connection, inside pushState(), keyed off the map entry being written to.
 * There is deliberately no way from here to address a frame to one device
 * carrying another device's hand — not a rule anyone has to follow, an API
 * that cannot express it.
 */
function push() {
  if (!engine) return;
  const pub = engine.publicState();
  if (transport) transport.pushState(pub, (id) => engine.privateStateFor(id));
  ui.render(pub, engine.privateStateFor(HOST_ID));
}

// ---------------------------------------------------------------------------
// SOLO
// ---------------------------------------------------------------------------

function startSolo(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return ui.flash('Pick a name first.');

  teardown();
  clearSession();
  mode = 'solo';
  engine = new GameEngine();

  const seat = engine.addPlayer(HOST_ID, name, { isHost: true, clientId: MY_CLIENT_ID });
  if (!seat.ok) { mode = 'home'; engine = null; return ui.flash(seat.error); }

  saveName(name);
  // No code, because there is no address. The lobby's room strip renders
  // nothing at all rather than a placeholder, which is the honest answer to
  // "what do I read out" when there is nobody to read it to.
  ui.setNet({ mode: 'solo', code: null, status: 'idle', message: null, detail: null });
  push();
  return undefined;
}

// ---------------------------------------------------------------------------
// HOST
// ---------------------------------------------------------------------------

/**
 * Seat the host and open a table.
 *
 * `opts.code` is the address to listen on, for a resume; absent, one is
 * minted. `opts.snapshot` is a restored engine, in which case the host is NOT
 * added — they are already in there, under a peer id that died with the tab,
 * and resumeAsHost() is what moves that seat onto the live identity.
 */
function startHost(rawName, opts = {}) {
  const name = String(rawName || '').trim();
  if (!name) return ui.flash('Pick a name first.');

  teardown();
  engine = new GameEngine();

  if (opts.snapshot) {
    engine.restore(opts.snapshot);
    // THE HOST'S OWN SEAT MUST BE REMAPPED BEFORE ANYTHING READS IT. The
    // snapshot holds the peer id from before the reload; setting hostId
    // without moving the seat leaves the host as a player nobody can find,
    // whose hand is unreachable and whose turn cannot be taken.
    engine.resumeAsHost(HOST_ID, MY_CLIENT_ID);
  } else {
    const seat = engine.addPlayer(HOST_ID, name, { isHost: true, clientId: MY_CLIENT_ID });
    if (!seat.ok) { mode = 'home'; engine = null; return ui.flash(seat.error); }
  }

  saveName(name);
  session = { name, code: null };
  rehosts = 0;
  openTable(opts.code || generateRoomCode());
  return undefined;
}

/**
 * Start listening on one address. Separate from startHost so that a room code
 * lost to a collision can be swapped WITHOUT rebuilding the engine — a host
 * whose table already has four people in it should not lose them because the
 * broker happened to be holding their four characters.
 */
function openTable(code) {
  teardown();
  mode = 'host';
  session.code = code;

  // 'connecting' rather than 'live', and the room strip shows "Opening…"
  // instead of the code, because until the broker confirms the id this is a
  // code we HOPE to be reachable at. Reading out four characters that are
  // about to be swapped for four others is worse than a second of waiting.
  ui.setNet({ mode: 'host', code, status: 'connecting', message: null, detail: null });

  const epoch = netEpoch;
  transport = createHost(code, hostHandlers(epoch));

  clearInterval(snapTimer);
  snapTimer = setInterval(() => {
    if (mode === 'host' && engine) saveEngineSnapshot(engine.snapshot());
  }, SNAPSHOT_MS);

  push();
}

function hostHandlers(epoch) {
  const live = () => epoch === netEpoch && mode === 'host' && !!engine;

  /**
   * Say no to a device, and then stop talking to it.
   *
   * The refusal goes first and the close waits FLUSH_MS, so the phone gets a
   * sentence rather than a silence. dropConnection() does NOT fire
   * onDisconnect — correct here, because a device that was never seated has no
   * seat to mark away, and firing one would mark somebody ELSE's seat away if
   * the ids had since been reused.
   */
  const refuse = (playerId, text) => {
    transport.sendTo(playerId, rejectFrame(text));
    setTimeout(() => { if (live() && transport) transport.dropConnection(playerId); }, FLUSH_MS);
  };

  return {
    onOpen(room) {
      if (!live()) return;
      // The NORMALISED code, which is the address actually being listened on
      // rather than the string we asked for.
      session.code = room;
      saveCode(room);
      saveSession({ role: 'host', code: room, name: session.name });
      ui.setNet({ code: room, status: 'live', message: null });
    },

    onJoin(playerId, hello) {
      if (!live()) return;
      // A hello that arrived and was unusable. The sender is told, because a
      // joiner dropped in silence sits on a spinner until their own deadline.
      if (!hello) return refuse(playerId, 'Pick a name first.');

      // THE HOST'S OWN TICKET, ARRIVING OVER THE WIRE. This is the host with
      // their own game open in a second tab, and left alone it is a
      // self-inflicted disaster rather than an attack: addPlayer() reclaims by
      // clientId, finds the host's seat, and remaps it — hostId and all — onto
      // the peer id of the second tab. The first tab, the one holding every
      // hand in the game, then has no seat, no hand and no controls. Refused
      // by identity rather than by seat, because at this point the seat is
      // exactly what is about to be taken.
      if (hello.clientId === MY_CLIENT_ID) {
        return refuse(playerId, 'That is this phone — you are already at this table as the host.');
      }

      // TWO TABS, ONE TICKET, and this is the loop the REPLACED frame exists
      // to break. Both tabs share one localStorage clientId, so the second to
      // arrive reclaims the seat from the first; the first then sees its
      // channel close, redials, reclaims it back, and the two trade the seat
      // forever with neither able to play. The old channel is told explicitly
      // that it lost, which is a fact it cannot deduce from a close.
      //
      // `engine.players` is read directly because the engine indexes seats by
      // id and there is no by-ticket lookup — deliberately, since nothing
      // inside the rules should ever be asking that question.
      //
      // THE TRUTHINESS CHECK IS NOT DEFENSIVE PADDING. readJoinFrame drops an
      // unusable ticket to null rather than refusing the join, so that a phone
      // with storage switched off can still play — which means null is a value
      // that genuinely arrives here. Without the guard, `null === null` makes
      // every OTHER ticketless seat look like a prior tab of this one, and the
      // second storage-disabled phone to join would silently boot the first.
      // Bots carry a null ticket too, and would have matched as well. Same
      // reasoning as addPlayer()'s `if (clientId)` in state.js: no ticket means
      // no claim on anything, in both directions.
      const prior = hello.clientId
        ? engine.players.find((p) => p.clientId === hello.clientId && p.id !== playerId)
        : null;
      if (prior) {
        transport.sendTo(prior.id, replacedFrame());
        const stale = prior.id;
        setTimeout(() => { if (live() && transport) transport.dropConnection(stale); }, FLUSH_MS);
      }

      const seat = engine.addPlayer(playerId, hello.name, { clientId: hello.clientId });
      if (!seat.ok) return refuse(playerId, seat.error);
      return push();
    },

    onData(playerId, msg) {
      if (!live()) return;
      const { handled, result } = applyGameIntent(engine, playerId, msg, Date.now());
      // An unknown type from a peer is not a bug in this file and not worth a
      // frame back. It has already cost the sender a token.
      if (!handled) return;
      // A refused MOVE is ordinary play — a mistimed challenge, a claim that
      // is not next in sequence — so the sentence goes back and the connection
      // stays. Only refuse() above closes anything.
      if (result && !result.ok) transport.sendTo(playerId, rejectFrame(result.error));
      push();
    },

    onDisconnect(playerId) {
      if (!live()) return;
      // NOT a forfeit. markOffline() drops a lobby seat and merely flags an
      // in-game one: a dropped player's hand survives, their seat survives,
      // and their turn becomes the host's to nudge. Somebody walking through a
      // dead spot must not lose their cards to it.
      engine.markOffline(playerId);
      push();
    },

    onError(err) {
      if (!live()) return;
      const type = err && err.type;
      // Somebody else already holds that address on the public broker. Mint
      // another and move the same table onto it — the host has done nothing
      // wrong and should not be reading an error about a number.
      if ((type === 'unavailable-id' || type === 'invalid-id') && rehosts < MAX_REHOSTS) {
        rehosts += 1;
        openTable(generateRoomCode());
        return;
      }
      if (isFatalPeerError(err)) { fatal(err); return; }
      // Non-fatal: the table on this phone is still a game. Existing
      // connections run device to device and are unaffected; what is lost is
      // the ability for anybody NEW to arrive.
      ui.setNet({ status: 'lost', message: describePeerError(err) });
    },

    onBrokerDown() {
      if (!live()) return;
      ui.setNet({ status: 'retrying', message: 'Lost the connection server — nobody new can join for a moment.' });
    },
    onBrokerUp() {
      if (!live()) return;
      ui.setNet({ status: 'live', message: null });
    },
    onBrokerLost() {
      if (!live()) return;
      ui.setNet({
        status: 'lost',
        message: 'Cannot reach the connection server. Everyone already here can keep playing; nobody new can join.',
      });
    },
  };
}

// ---------------------------------------------------------------------------
// CLIENT
// ---------------------------------------------------------------------------

function startJoin(rawName, rawCode) {
  const name = String(rawName || '').trim();
  if (!name) return ui.flash('Pick a name first.');

  // normalizeCode DROPS characters outside the alphabet rather than guessing
  // at them — a typed O is not read as a zero — so what comes back is SHORT,
  // not null. The length is the check. Done here rather than left to net.js
  // so the player gets a sentence at the moment they pressed the button,
  // instead of a dial that fails twelve seconds later for reasons of its own.
  const code = normalizeCode(rawCode);
  if (code.length !== CODE_LENGTH) {
    return ui.flash('That is not a room code — four characters, with no O, zero, I or one.');
  }

  saveName(name);
  saveCode(code);
  session = { name, code };
  engine = null;
  attempt = 0;
  seatedOnce = false;
  mode = 'client';
  dial(false);
  return undefined;
}

function dial(isRetry) {
  teardown();
  mode = 'client';
  ui.setNet({
    mode: 'client',
    code: session.code,
    status: isRetry ? 'retrying' : 'connecting',
    message: null,
    detail: null,
  });

  const epoch = netEpoch;
  // The JOIN frame is sent by joinHost() itself, on open, before onOpen fires.
  // That is not a convenience: it makes "the ticket travels" a property of the
  // transport rather than of whoever remembered to write the line.
  transport = joinHost(session.code, clientHandlers(epoch), {
    name: session.name,
    clientId: MY_CLIENT_ID,
  });

  joinTimer = setTimeout(() => {
    if (epoch !== netEpoch) return;
    // See JOIN_BUDGET_MS. What a missed deadline MEANS is the whole reason
    // this lives here: never seated is a wrong code and belongs on the home
    // screen; seated once is a table we are trying to get back to, and the
    // last good frame stays on screen while we try.
    if (seatedOnce) scheduleRetry();
    else goHome(NO_ANSWER);
  }, JOIN_BUDGET_MS);
}

function clientHandlers(epoch) {
  const live = () => epoch === netEpoch && mode === 'client';

  return {
    onOpen() {
      if (!live()) return;
      // Open is not seated. The channel exists; the host has yet to accept the
      // hello, and may refuse it.
      ui.setNet({ detail: 'Found the table — waiting to be dealt in.' });
    },

    onState(pub, priv) {
      if (!live()) return;
      clearTimeout(joinTimer);
      joinTimer = null;
      attempt = 0;
      seatedOnce = true;
      // Written on every frame rather than once, because it is the TIMESTAMP
      // that matters: a session is only worth resuming while the table it
      // names is still being played, and this is the only evidence of that.
      saveSession({ role: 'client', code: session.code, name: session.name });
      ui.setNet({ status: 'live', message: null, detail: null });
      ui.render(pub, priv);
    },

    onReplaced() {
      if (!live()) return;
      // The seat was reclaimed by another tab on this same device. Not an
      // error and not something to retry — redialling is exactly the loop the
      // frame exists to stop. The session is kept, because the OTHER tab is
      // using it and this one is simply the loser.
      goHome('You have this table open in another tab, and that one has the seat.', { keepSession: true });
    },

    onData(msg) {
      if (!live()) return;
      // The host said no. readRejectFrame returns null for anything that is
      // not a refusal, and never an empty string for one that is.
      const text = readRejectFrame(msg);
      if (text) ui.flash(text);
    },

    onClose() {
      if (!live()) return;
      // A REPLACED frame is always followed by this close, and net.js's doc
      // requires the caller to make it inert — otherwise "reconnect", which is
      // the right answer to an ordinary drop, restarts the loop. goHome() has
      // already bumped the epoch by the time we get here, so live() is false
      // and this line is never reached in that case. Stated because the
      // inertness is a requirement, not an accident of ordering.
      scheduleRetry();
    },

    onError(err) {
      if (!live()) return;
      // Before the first frame, a fatal error is a dead end and the player
      // needs the sentence. After it, the table was real — keep it on screen
      // and keep the seat, because a host who walked into a lift is coming
      // back and a guest staring at a home screen has already lost their hand.
      if (isFatalPeerError(err)) {
        if (!seatedOnce) { fatal(err); return; }
        ui.setNet({ status: 'lost', message: describePeerError(err) });
        return;
      }
      scheduleRetry();
    },

    onBrokerDown() {
      if (!live() || seatedOnce) return;
      // Only worth saying before we are in. Once the DataConnection is up it
      // runs device to device and the broker is irrelevant to this tab.
      ui.setNet({ detail: 'Reaching the connection server…' });
    },
    onBrokerUp() { /* nothing to undo — see onBrokerDown */ },
    onBrokerLost() {
      if (!live() || seatedOnce) return;
      fatal({ type: 'network' });
    },
  };
}

/**
 * Climb the ladder, or stop climbing.
 *
 * Idempotent on purpose: errors arrive in bursts — an ICE failure and a socket
 * close for the same event — and three of them must schedule one retry rather
 * than three, or the ladder is consumed in a single second.
 */
function scheduleRetry() {
  if (mode !== 'client') return;

  if (attempt >= RECONNECT_DELAYS_MS.length) {
    // THE TOP OF THE LADDER MEANS TWO DIFFERENT THINGS, exactly as a missed
    // join budget does, and the same rule decides between them. Never seated
    // is a code that answers nothing — there is no seat to keep and no frame
    // to keep on screen, so the home screen with its HOST button is the only
    // useful place to be, and "could not get BACK to the table" would be a
    // sentence about a table this player was never at. Seated once is a real
    // table that has gone quiet: hold the last good frame and the seat.
    if (!seatedOnce) { goHome(NO_ANSWER); return; }

    teardown();
    mode = 'client';   // teardown does not change mode; the screen stays put
    ui.setNet({
      status: 'lost',
      message: 'Could not get back to the table. The host may have closed it.',
    });
    return;
  }

  const delay = RECONNECT_DELAYS_MS[attempt];
  attempt += 1;

  // Torn down FIRST, so the dead peer stops firing into handlers we are about
  // to replace and the broker socket is released while we wait.
  teardown();
  mode = 'client';
  ui.setNet({ status: 'retrying', message: null, detail: null });

  const epoch = netEpoch;
  retryTimer = setTimeout(() => { if (epoch === netEpoch) dial(true); }, delay);
}

// ---------------------------------------------------------------------------
// Leaving, and the shapes of leaving
// ---------------------------------------------------------------------------

/**
 * Drop the transport and every timer that could resurrect it.
 *
 * Does NOT touch the engine, the mode or the screen — those outlive a
 * reconnect, and a teardown that cleared them would blank a guest's table
 * every time their host's phone changed cell.
 */
function teardown() {
  netEpoch += 1;
  clearTimeout(joinTimer);  joinTimer = null;
  clearTimeout(retryTimer); retryTimer = null;
  clearInterval(snapTimer); snapTimer = null;
  if (transport) { try { transport.destroy(); } catch (_) {} }
  transport = null;
}

/**
 * Back to the start.
 *
 * A HOST LEAVING DOES NOT ANNOUNCE IT, and that is a decision rather than an
 * omission. There is no LEAVE frame in the wire vocabulary; the guests' peers
 * see the channel close, climb their own ladders, and land on the honest
 * message that the host may have closed the table — which is exactly what
 * happened. A frame saying so would be one more thing every reader has to be
 * suspicious of, in exchange for four seconds.
 */
function goHome(message = null, { keepSession = false } = {}) {
  teardown();
  if (!keepSession) clearSession();
  mode = 'home';
  engine = null;
  attempt = 0;
  rehosts = 0;
  seatedOnce = false;
  session = { name: session.name, code: null };
  ui.resetEntry();
  ui.setNet({ mode: 'home', code: null, status: 'idle', message, detail: null });
}

/**
 * A dead end, in the words describePeerError chose for it.
 *
 * `peer-missing` keeps the session, and the exception is the point: that error
 * is about THIS TAB's network — the CDN did not answer — and not about the
 * table. Clearing would delete the stored snapshot, which is every hand in the
 * game, over a blip that a reload with signal fixes.
 */
function fatal(err) {
  goHome(describePeerError(err), { keepSession: err && err.type === 'peer-missing' });
}

// ---------------------------------------------------------------------------
// The host's heartbeat.
//
// Three jobs, in this order, and the order is not arbitrary: an expired window
// changes whose turn it is, so the bots must decide against the position AFTER
// the expiry rather than the one before it.
//
// When nothing moved, only the countdown is touched — a full re-render ten
// times a second would rebuild the screen under a thumb reaching for
// CHALLENGE, which is the one moment in this game where that is unforgivable.
//
// A client falls straight through the first line. It has no engine, nothing to
// expire and no bots to run; its clock is the host's, and arrives in frames.
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  if (!engine) { ui.tick(now); return; }
  let moved = false;
  if (engine.resolveExpiredWindow(now).fired) moved = true;
  if (bots.tick(engine, now)) moved = true;
  if (moved) push();
  else ui.tick(now);
}, TICK_MS);

// ---------------------------------------------------------------------------
// Boot.
//
// A reload is the commonest disaster in this game: the host's phone locks, a
// browser reclaims the tab's memory, somebody pulls to refresh. Every one of
// those is survivable because the two facts needed to rebuild — who this
// device is, and which table it was at — are on disk, and the host's copy of
// the game is too.
//
// Both stores are TTL'd together in util.js, so a session found here is one
// from tonight rather than one from last week.
// ---------------------------------------------------------------------------
function boot() {
  const saved = loadSession();

  if (saved && saved.role === 'host' && saved.code && saved.name) {
    // A session with no snapshot is a host who never got past the lobby, or
    // one whose snapshot expired first. Reopening the same code with an empty
    // table is still right: every guest's own session points at that address.
    startHost(saved.name, { code: saved.code, snapshot: loadEngineSnapshot() || undefined });
    return;
  }

  if (saved && saved.role === 'client' && saved.code && saved.name) {
    session = { name: saved.name, code: saved.code };
    attempt = 0;
    seatedOnce = false;
    mode = 'client';
    dial(false);
    return;
  }

  // Nothing to resume. One setNet is enough to paint — the UI's default mode
  // is already 'home', so this is a repaint rather than a transition.
  ui.setNet({ mode: 'home' });

  // Said on the home screen rather than discovered on the first tap. The
  // local game still works without it, which is why the button offering that
  // is the one thing this message does not apologise for.
  if (!peerAvailable()) {
    ui.setNet({ message: describePeerError({ type: 'peer-missing' }) });
  }
}

boot();
