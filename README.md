# Bluff

### [▶ Play it](https://iamyvj.github.io/bluff/)

Cheat. I Doubt It. Bullshit. The game where you put cards face down, say what
they are, and find out whether anybody believes you.

This is that game, played on the phones already at the table. One person opens
a room, everyone else types a four-character code, and the cards go to the
devices. No accounts, no install, no server holding the game — the phones talk
to each other directly over WebRTC.

It is a static site: eleven ES modules, one stylesheet, one service worker and
no build step. `package.json` has no `dependencies` key and that is not an
accident.

---

## Playing it

Open **[iamyvj.github.io/bluff](https://iamyvj.github.io/bluff/)** on every
phone at the table. Nothing to install — though if you add it to your home
screen it runs full-screen and loads offline.

One device taps **Host**, reads the four-character room code out loud, and the
others tap **Join** and type it. Codes come from an alphabet in `js/util.js`
picked so that no two characters sound or look alike across a noisy table, so
reading them aloud works — which is the point.

Three to eight players. Short of humans, the host can fill the empty seats with
bots and play against those; the bots see exactly what a remote player's device
would see and nothing more (`js/bot.js` takes the same two objects the wire
carries, which makes cheating structurally impossible rather than a rule
somebody remembered).

### The rules, and the knobs on them

Everyone knows a slightly different version of this game, so the lobby has
three presets and then the individual settings underneath them:

| Preset | What it is |
| --- | --- |
| **Classic** | I Doubt It as it is usually played: the rank marches on whether you hold it or not. |
| **Cheat** | A little slack in the rank, and only the next player may call you. Quick and quiet. |
| **Loud** | Claim anything, and the whole table races to call it. Chaos, and the best one to learn on. |

**Rank rule** — how much freedom you have in what you claim.

- *Ascending* — A, 2, 3 … K, then back to A. You do not choose the rank, only
  how many cards and whether you are telling the truth. The cycle belongs to
  the turn order, not to the pile, so it marches straight through a pickup.
- *Adjacent* — one above, one below, or the same as the last claim. K and A are
  neighbours.
- *Free* — claim any rank you like.

**Challenge mode** — who may call a bluff, and when.

- *Open window* — everyone gets a few seconds (3–20s, default 5) to call it.
  First tap wins the race.
- *Next player* — only the player after you may call it, and doing so is their
  turn. No timers, no dead time.

**Deck and jokers** — one to three decks, with two jokers per deck optional. In
*wild* mode a joker matches whatever you claimed, so `7D 7S Joker` really is
three sevens and the challenger is wrong. In *junk* mode it matches nothing,
which turns a hand of jokers into a hot potato that can be shed but never
defended.

**Cards per turn** — one to eight, capped by how many of a rank the deck can
actually supply.

### How a hand plays

Put one to `maxPlay` cards face down, announce a rank and a count. If somebody
calls it, **only the cards of that play are turned over** — never the pile,
because the pile may hold fifty cards from a dozen earlier claims and turning
those over would end the deduction the rest of the game is made of. Whoever was
wrong takes the pile and leads.

Going out does not win on its own: the last play has to survive. A player with
an empty hand wins only once that final claim closes unchallenged, or is
challenged and holds. A liar caught on their last card picks up the pile and is
very much back in the game.

---

## The honesty caveat

**The host's device holds every hand in the game — in memory, and in
localStorage.** A host who opens the browser console can read the table.

This is not a bug that can be fixed here. Somebody's device has to be the
authority on what the cards are, and in a peer-to-peer game that device belongs
to one of the players. In a trick-taking game it would be a privacy footnote.
In Bluff it is the whole game, because the whole of Bluff is what the other
players cannot see.

So it is written down here rather than quietly hoped about. Four files point at
this paragraph: `js/main.js`, `js/net.js`, `js/util.js` and `js/bot.js`.

What the code *does* do about it:

- **Nobody except the host has the problem.** No player's device ever receives
  another player's hand, by accident or by asking. That invariant lives in
  exactly one function — `stateFrameFor()` in `js/net.js` — and the test suite
  holds it to account.
- **Nothing is logged.** No hand and no pile content reaches the console, and
  revealed cards are stripped of their ids on the way out so two reveals cannot
  be correlated.
- **Bots read the wire, not the engine.** `js/bot.js` is a pure function of
  `publicState()` and `privateStateFor()` — the same two objects a phone gets.
- **The seam is kept open.** The real fix is moving authority to a server, and
  `applyGameIntent(engine, actor, msg)` in `js/intents.js` is the signature
  that makes that cheap: nothing about it assumes the engine is in this
  process.

Play with people you would lend a tenner to.

---

## Offline, and what that does and does not mean

`sw.js` precaches the shell — the page, the stylesheet, the eleven modules, the
manifest and the icons — so a second visit loads with no network at all, and the
local game against bots works fully offline.

**Multiplayer still needs the internet for a moment.** PeerJS needs a signalling
broker once, to carry the WebRTC handshake; after that, game traffic goes device
to device. The default broker is PeerJS's free public cloud. Two consequences
worth stating plainly:

1. A cold start with no network cannot open or join a room. The app says so
   rather than failing mysteriously — `peerAvailable()` in `js/net.js` checks
   for the bundle before every use.
2. **A room code is an address on a public broker, not a LAN-local one.** The
   peer id is derivable by anybody and there are only 32⁴ ≈ 1M codes. Every
   check in `js/guards.js`, and the client-id rule in `addPlayer()`, exists
   because of that sentence.

For genuinely offline LAN play, run your own broker and point the app at it:

```
npx peer --port 9000 --key peerjs --path /bluff
```

```js
// js/net.js
export const BROKER_CONFIG = {
  host: '192.168.1.50', port: 9000, path: '/bluff',
  key: 'peerjs', secure: false,
};
```

Every device at the table has to use the same broker config to find the others.

### What the worker deliberately does not cache

Three hazards, all documented at the top of `sw.js`:

- **The beacon.** Nothing cross-origin is ever written to the cache. Not the
  PeerJS bundle (a cached copy is a pinned version a `git pull` can no longer
  move) and emphatically not a signalling response, which would be a room code
  that dials a conversation that ended yesterday.
- **The half-stale shell.** One cache, written by one install, all or nothing.
  A shell assembled out of two different versions is the failure mode that is
  hardest to diagnose and easiest to prevent.
- **The host's snapshot.** Cache Storage and localStorage are different stores
  and the worker never touches the second one. That is what makes the footer's
  **Clear cache & reload** button safe to press mid-game: it throws away only
  derived bytes, never `bluff.clientId` (a player's claim to their seat) or
  `bluff.engine` (on the host's device, the only copy of the game).

Fonts are loaded from Google Fonts and are *not* precached, because they are the
one thing here that degrades gracefully on its own — every `--font` token names
a real system fallback behind it.

---

## How it is put together

```
index.html            the shell, the footer, and the recovery button
manifest.webmanifest  PWA metadata
sw.js                 service worker — at the root, because scope
css/styles.css        one stylesheet, design tokens shared with the sibling repos
js/
  rules.js            config vocabulary: presets, rank rules, joker modes, bounds
  cards.js            deck construction, shuffling, card identity
  claims.js           what may legally be claimed, given a rule and a pile
  state.js            GameEngine — the whole game, and no timers anywhere
  intents.js          applyGameIntent(engine, actor, msg) — the one door in
  guards.js           validation of everything that arrives from another device
  bot.js              pure-function opponents, fed the same views a phone gets
  net.js              PeerJS star topology, host authoritative
  ui.js               renders the screen, owns no state, never leaves its root
  util.js             room codes, client id, localStorage, session
  main.js             wiring
scripts/
  test-engine.mjs     the harness — ~3,500 assertions, no framework
  gen-icons.js        hand-written PNG encoder, SDF shapes, 4× supersampling
  peershim.mjs        a fake PeerJS for testing the transport without a network
```

Three design rules hold the thing together:

**The engine has no clock.** `now` is always a parameter. That is what lets the
whole suite run without a single `setTimeout`, and what makes challenge windows
testable at the millisecond.

**Everything from another device goes through one door.** `applyGameIntent()`
takes an engine, an actor and a message; `guards.js` decides whether that
message is anything at all. A host that trusts a frame because it arrived on an
established connection is a host that can be made to deal a player a second
hand.

**A seat is claimed by a 128-bit ticket, not by a name or a peer id.** Names
collide and peer ids change on every reconnect, so either would be a seat anyone
could steal. `bluff.clientId` persists in localStorage, which is why the reset
button must never clear it.

---

MIT. See [LICENSE](LICENSE).
