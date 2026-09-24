// ============================================================================
// util.js — Room codes, device identity, and the little that is written to disk.
//
// WHY THIS FILE ARRIVES AT CHECKPOINT 6 AND NOT EARLIER
//   Nothing needed it. The local driver seated one player under a fixed id and
//   remembered nothing between reloads, so a storage module written in
//   checkpoint 2 would have been written against an imagined caller and tested
//   against nothing. js/net.js is the first thing with an actual opinion about
//   what has to survive a reload, so this is shaped by that and by nothing else.
//
//   It is deliberately smaller than the same file in the sibling repos. There
//   are no DOM helpers here because js/ui.js builds strings rather than nodes,
//   and no plural()/number formatting because those live in js/rules.js next to
//   the vocabulary they format. What is left is the three things that are
//   genuinely shared and genuinely stateful: what a room code is, who this
//   device is, and what is allowed to outlive the tab.
//
// EVERY KEY THIS FILE WRITES IS PREFIXED `bluff.`, and the prefix is load-
// bearing rather than tidy. These games are served from one origin as sibling
// paths — /sequence, /judgement, /bluff — so they share a single localStorage.
// js/state.js binds a seat to the clientId below; two games sharing one key
// would hand a player the wrong identity in the wrong room.
// ============================================================================

// ---------------------------------------------------------------------------
// Room codes
//
// Four characters from an alphabet with no look-alikes: no O or 0, no I or 1.
// A code's whole job is to survive being read aloud across a table and typed
// into somebody else's phone, and "is that an oh or a zero" is the failure it
// is designed around.
//
// THE ALPHABET IS 32 LONG FOR A SECOND REASON. 2^32 is an exact multiple of
// 32, so `random32 % 32` is perfectly uniform — no modulo bias, and no
// rejection loop to write and get wrong. Dropping one more ambiguous letter to
// make it 31 would quietly make some codes likelier than others. If a character
// ever has to go, another has to come back.
//
// 32^4 is 1,048,576 codes, and nothing here checks that one is free. It does
// not need to: the host's peer id is derived from the code, so a collision with
// a table that is live RIGHT NOW is refused by the broker as 'unavailable-id',
// and js/net.js turns that into "host again for a new one". A collision with a
// table that has finished is not a collision at all.
// ---------------------------------------------------------------------------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

export function generateRoomCode() {
  const arr = new Uint32Array(CODE_LENGTH);
  (globalThis.crypto || window.crypto).getRandomValues(arr);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[arr[i] % CODE_ALPHABET.length];
  return code;
}

/**
 * Normalise a typed code: uppercase, then keep only alphabet characters.
 *
 * The look-alikes are not in the alphabet, so a typed O is DROPPED rather than
 * silently read as a zero. That is deliberate and it is the conservative
 * choice: a code that is wrong by one character should fail to find a table,
 * not find the wrong one. Dropping shortens the code, and js/net.js refuses to
 * dial anything that is not exactly CODE_LENGTH.
 *
 * Separators survive the same way, so "QR-TX" and "qr tx" both normalise to
 * QRTX — which matters because a code gets pasted out of a chat message at
 * least as often as it gets typed.
 */
export function normalizeCode(raw) {
  let out = '';
  for (const ch of String(raw || '').toUpperCase()) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
    if (out.length === CODE_LENGTH) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clipboard
//
// Two paths, because the good one is not always available.
// navigator.clipboard needs a secure context, which `file://` and plain http
// are not — and this game is meant to be openable straight off a phone by
// whatever route works. The textarea fallback is deprecated and is still the
// only thing that works there.
//
// Returns a boolean rather than throwing, because the caller's honest response
// to a failure is "read it out instead" and not an error dialog.
// ---------------------------------------------------------------------------
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Lightweight persistence
//
// EVERY ACCESS IS WRAPPED, and the empty catch blocks are load-bearing rather
// than lazy. `localStorage` is not merely empty in private browsing and inside
// a locked-down webview — reading the global THROWS, as does a write past the
// quota. An unwrapped getItem in the app's first ten lines is a blank page on
// somebody's work phone, and the thing they were trying to do was remember a
// name.
// ---------------------------------------------------------------------------
const NAME_KEY = 'bluff.name';
const CODE_KEY = 'bluff.lastCode';

export function loadName()  { try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; } }
export function saveName(n) { try { localStorage.setItem(NAME_KEY, n); } catch (_) {} }
export function loadCode()  { try { return localStorage.getItem(CODE_KEY) || ''; } catch (_) { return ''; } }
export function saveCode(c) { try { localStorage.setItem(CODE_KEY, c); } catch (_) {} }

// ---------------------------------------------------------------------------
// Device identity
//
// A random 128-bit value identifying THIS BROWSER to whichever machine is
// running the game. js/state.js calls it a seat ticket in addPlayer(), and that
// is exactly what it is: the only thing a seat in progress is ever bound to,
// and the only thing that gets a hand back after a battery dies.
//
// WHY IT CANNOT BE THE DISPLAY NAME. Anyone holding a four-character room code
// can connect and type any name they like, and every name at the table is on
// everybody's screen. A seat that can be reclaimed by naming it can be stolen
// by naming it — and in THIS game the thing being stolen is a hand of cards
// nobody else is allowed to see. The tempting objection is that a peer-to-peer
// host only ever hears from the same sofa; it doesn't. PeerJS signalling goes
// through a broker on the public internet and the data channel falls back to a
// public relay. See the header of js/net.js.
//
// A TICKET, NOT A CREDENTIAL, AND THE DIFFERENCE IS WORTH BEING PRECISE ABOUT.
// It authenticates nothing. Anybody who learns one can take that seat, and
// nothing in this app can tell them apart from its owner. What it buys is that
// learning one requires guessing 128 bits rather than reading a name off the
// screen. So it is handled with the care that implies and no more: never
// rendered, never logged, never put in a URL, never sent to anything except the
// machine running the game.
//
// ONE DIFFERENCE FROM THE SIBLING REPOS, STATED BECAUSE IT IS A REAL ONE.
// judgement's publicState() publishes no player ids at all, so over there the
// claim is "there is nothing on the wire to correlate a ticket with". Bluff's
// publicState() DOES publish ids — js/ui.js needs them to mark your own seat,
// your own claim and your own history lines — but the id it publishes is the
// PEER id, `peer:<connId>`, minted by js/net.js from the transport. The
// clientId is passed to addPlayer() as a separate argument and is stored on the
// seat, which is host-only memory. So the narrower claim holds and it is the
// one that matters: the ticket is never in publicState(), never in
// privateStateFor(), and never in the log.
//
// GENERATED ONCE AND NEVER REGENERATED. There is no rotation and no expiry,
// because a fresh id is indistinguishable from a different device: the host
// would refuse the reclaim and lock somebody out of their own hand mid-game.
// This is also why the "clear cache" affordance in checkpoint 7 must touch
// Cache Storage and service workers ONLY, and never localStorage. That button
// and this constant are one decision written in two files.
//
// The character class matches validClientId() in js/guards.js exactly (8–64 of
// [A-Za-z0-9_-]), so a value that would be refused on arrival cannot be minted
// here, and a value that has been tampered with in localStorage is replaced
// rather than sent.
// ---------------------------------------------------------------------------
const CLIENT_KEY = 'bluff.clientId';
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Used only when localStorage is unavailable — private browsing, storage
// denied, a locked-down embedded webview. A per-tab identity still lets a
// connection that blips reclaim its own seat; it just does not survive a
// reload, which is the best that can be done with nowhere to write. Held in a
// module variable rather than regenerated per call, because a clientId that
// changed between the join frame and the retry would reclaim nothing.
let volatileClientId = null;

function newClientId() {
  const bytes = new Uint8Array(16);   // 128 bits
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;   // 32 hex characters, comfortably inside the 8–64 bound
}

export function clientId() {
  try {
    const stored = localStorage.getItem(CLIENT_KEY);
    if (stored && CLIENT_ID_RE.test(stored)) return stored;
    const fresh = newClientId();
    localStorage.setItem(CLIENT_KEY, fresh);
    return fresh;
  } catch (_) {
    if (!volatileClientId) volatileClientId = newClientId();
    return volatileClientId;
  }
}

// ---------------------------------------------------------------------------
// Session resume
//
// Remembers whether this device was hosting or joining, the room code and the
// name — plus, for a host, a snapshot of the authoritative engine, because the
// host's device holds the only copy of the game that exists. A host reload
// without this ends the game for everybody at the table.
//
// The two are separate keys on purpose. A client writes a session and never an
// engine, and a host that dies between the two writes should resume with a
// stale-but-present snapshot rather than with a half-written single blob.
//
// WHY FOUR HOURS, WHERE judgement USES EIGHT. A judgement match is nineteen
// rounds and genuinely runs to two or three hours, so eight hours there covers
// one long sitting. A game of Bluff is twenty minutes; four hours covers a
// whole evening of them back to back and expires before bed. The failure a TTL
// prevents is specific and is the same in both: a reload the next morning
// otherwise spends its first forty-five seconds dialling a table that stopped
// existing last night, showing "Reconnecting…" the whole time instead of a home
// screen with a HOST button on it.
// ---------------------------------------------------------------------------
const SESSION_KEY = 'bluff.session';
const ENGINE_KEY  = 'bluff.engine';
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Is a stamp still inside the TTL?
 *
 * `Number.isFinite` RATHER THAN A TRUTHINESS TEST, and the difference is a hole
 * rather than a tidy-up. A ts of "yesterday" — a hand-edited entry, an older
 * format, half a write — makes `Date.now() - ts` NaN, and `NaN > TTL` is FALSE.
 * A bare comparison therefore declares that entry fresh, and keeps declaring it
 * fresh forever: the one value that is supposed to expire is the one value that
 * cannot.
 *
 * A stamp in the FUTURE is accepted rather than expired. Phone clocks step
 * backwards across a sleep and after an NTP correction, and ending a live game
 * because the device disagrees with itself by a few minutes is a worse failure
 * than honouring a slightly odd stamp. Same reasoning as the `Math.max(0, ...)`
 * in the TokenBucket in js/guards.js.
 */
function fresh(ts) {
  return Number.isFinite(ts) && (Date.now() - ts) <= SESSION_TTL_MS;
}

export function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, ts: Date.now() })); } catch (_) {}
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !fresh(s.ts)) { clearSession(); return null; }
    return s;
  } catch (_) { return null; }
}

/** Forget the room. NOT the device — CLIENT_KEY is deliberately absent from
 *  this function, and that absence is the whole of the "never regenerated" rule
 *  above. Leaving a table and rejoining it must land on the same seat. */
export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ENGINE_KEY);
  } catch (_) {}
}

/**
 * The host's engine, as state.js's snapshot() produced it.
 *
 * THIS CONTAINS EVERY HAND IN THE GAME. In a trick-taking game that would be a
 * privacy footnote; here it is the entire game, because the whole of Bluff is
 * what the other players cannot see. It is written by the host, to the host's
 * own device, and read back by the same tab. It must never be sent anywhere,
 * and there is nothing in this file that could send it — the only exports that
 * touch it are these two, and neither takes a connection.
 *
 * The same sentence is already true of the host's tab in memory, which is the
 * honesty caveat in the README: a host who opens the console can read the
 * table. Writing the snapshot to disk does not make that worse, and not writing
 * it makes a host's accidental reload end everybody's game.
 *
 * Stamped and expired on the same clock as the session, because the two are one
 * thing: a snapshot without a session has nothing to reconnect to it, and a
 * session without a snapshot rehydrates an empty lobby.
 */
export function saveEngineSnapshot(snap) {
  try { localStorage.setItem(ENGINE_KEY, JSON.stringify({ snap, ts: Date.now() })); } catch (_) {}
}

export function loadEngineSnapshot() {
  try {
    const raw = localStorage.getItem(ENGINE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !fresh(o.ts)) return null;
    // `?? null` because an entry that carries a stamp and no snapshot is a
    // half-written one, and "absent" has exactly one spelling in this file.
    // Handing back undefined would make the caller's `=== null` check wrong
    // without making it look wrong.
    return o.snap ?? null;
  } catch (_) { return null; }
}
