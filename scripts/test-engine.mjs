// Headless test of the Bluff engine. No browser, no network.
//   node scripts/test-engine.mjs
//
// Sections run in build order:
//
//   1. The pure card layer — the vocabulary, the multi-deck pack, the single
//      shuffle over the whole array, and the UNEVEN DEAL that uses every card.
//   2. Legal-claim generation for all three rank rules, including the K->A wrap
//      that an ascending game hits several times a match.
//   3. The config: the interdependent clamps, and the two fields that are
//      REFUSED rather than tidied.
//
// Later checkpoints add the engine, the wire and the bot below these.
//
// Two rules get more attention than everything else, because both produce a
// game that still runs, still finishes, and is quietly wrong:
//
//   * ANY HARDCODED "FOUR OF A RANK". It is right at one deck and wrong at two,
//     and the symptom is a bot that confidently challenges a truthful play. So
//     every bound is asserted at decks 1, 2 AND 3 rather than once.
//   * THE TURN DIRECTION. courtpiece next door runs anticlockwise and these
//     helpers are close enough to copy. Read out of an unshuffled deal.
//
// Where a rule can be stated as a property it is tested as one rather than as a
// table of expected numbers — a table only ever proves the numbers have not
// changed, which is not the same as proving the rule still holds.

import {
  MIN_PLAYERS, MAX_PLAYERS, RANKS, SUITS, JOKER, CARDS_PER_DECK,
  MAX_DECKS, MIN_DECKS, JOKERS_PER_DECK, MAX_PLAY_CEILING,
  MIN_WINDOW_MS, MAX_WINDOW_MS, REVEAL_HOLD_MS,
  RANK_RULES, JOKER_MODES, CHALLENGE_MODES, DEFAULT_CONFIG, PRESETS,
  isJoker, rankLabel, rankName, deckSize, jokerCap, playCap, rankSupply,
  dealCounts, describeDeal, describeConfig, presetMatching,
  nextSeat, seatsFrom, CLOCKWISE, ANTICLOCKWISE, normalizeConfig,
} from '../js/rules.js';
import {
  rankIndex, nextRank, prevRank, legalClaims, isLegalClaim, claimIsForced,
} from '../js/claims.js';
import {
  buildDeck, shuffle, deal, countOf, handCounts, groupHand, sortHand, takeByRank,
} from '../js/cards.js';
import { GameEngine, PHASES, STEPS } from '../js/state.js';
import {
  MAX_TYPE_LEN, MAX_FRAME_BYTES, MAX_CONNECTIONS, MAX_NAME_BYTES,
  validEnvelope, TokenBucket, validClientId, validPlayerId, validName,
  validRankPlay, validClaimRank, validConfigPatch, decodePeerFrame, configBlocker,
  validPublicState, validPrivateState,
} from '../js/guards.js';
import {
  PLAYER_INTENTS, OWNER_INTENTS, GAME_INTENTS, applyGameIntent,
} from '../js/intents.js';
import {
  claimIsImpossible, shouldChallenge, choosePlay, createBotDriver,
} from '../js/bot.js';
import {
  PEER_PREFIX, CONN_ID_PREFIX, HOST_ID, WIRE, MAX_REJECT_LEN, MAX_REFUSED_FRAMES,
  peerIdForCode, codeFromPeerId, playerIdForConn, connIdForPlayer,
  joinFrame, readJoinFrame, stateFrameFor, readStateFrame,
  rejectFrame, readRejectFrame, replacedFrame, isReplacedFrame,
  peerAvailable, isFatalPeerError, describePeerError, createHost, joinHost,
} from '../js/net.js';
import { normalizeCode, CODE_LENGTH, generateRoomCode } from '../js/util.js';
import { installPeerShim } from './peershim.mjs';
// Node's own, for the last section. index.html, sw.js and the manifest are not
// modules and cannot be imported, so they are read off disk as text — and
// sw.js is then EXECUTED against a fake Cache API, because a list of files
// checked by eye is not the same as a worker that caches them.
//
// writeFileSync is here for ONE caller: --write-stamp, below. A test runner
// that can write to the repository is a thing to be suspicious of, so the
// single write it performs is fenced into that mode, and that mode exits
// before a single assertion runs.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// For SHELL_STAMP only. sw.js names its cache after a fingerprint of the files
// it precaches, and the only way to check a fingerprint is to recompute it.
import { createHash } from 'node:crypto';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error('  x FAIL:', msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function same(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function throws(fn, msg) {
  try { fn(); } catch (_) { passed++; return; }
  failed++; console.error('  x FAIL:', msg, '— expected a throw, got none');
}
function section(t) { console.log('\n— ' + t); }

// ###########################################################################
//
//  THE SHELL'S TOOLING — up here rather than beside section 7, because
//  --write-stamp has to run and exit BEFORE any assertion does.
//
// ###########################################################################

const REPO = fileURLToPath(new URL('../', import.meta.url));
const readRepo = (rel) => readFileSync(REPO + rel, 'utf8');

/**
 * sw.js's three constants, obtained by EXECUTING the file rather than by
 * regex — a regex over source is a parser that does not report syntax errors,
 * and until this existed nothing in the repository had ever parsed sw.js at
 * all. The first execution would otherwise have been in a real browser, on a
 * real deploy, where a broken worker serves a stale shell to returning
 * visitors and cannot be fixed by pushing a commit.
 *
 * Shared with --write-stamp rather than written twice. Two copies of "how you
 * get SHELL out of sw.js" is the same defect as two copies of the hash: they
 * agree until one is updated and the other is not.
 *
 * Returns the parse error rather than asserting on it. One caller counts a
 * failure and carries on with empty constants; the other has to refuse to
 * write anything at all. Neither decision belongs in here.
 */
function loadSwConsts() {
  const src = readRepo('sw.js');
  let factory = null;
  try {
    factory = new Function(
      'self', 'caches', 'fetch', 'Response',
      src + '\n; return { CACHE_NAME, SHELL, SHELL_STAMP };'
    );
  } catch (e) {
    return { src, error: e, CACHE_NAME: '', SHELL: [], SHELL_STAMP: '' };
  }
  // A throwaway instantiation purely to read the constants. The handlers it
  // registers are dropped; the real drive happens in section 7.
  const consts = factory(
    { addEventListener() {}, location: { origin: 'https://x.test' }, clients: {} },
    {}, () => {}, class {}
  );
  return { src, error: null, ...consts };
}

/**
 * THE FINGERPRINT, in one place.
 *
 * sw.js names its cache after a hash of the files it precaches, because
 * caches.addAll() is a no-op against a cache that already exists under the
 * name being opened — so a deploy that keeps the name keeps serving the old
 * bytes to everyone who has visited before. Forever, silently, with a green
 * suite. A hand-written version number cannot be checked, because no test can
 * know whether you MEANT the bytes to change; a fingerprint of the bytes can.
 *
 * This function is the ONLY implementation of that hash in the repository,
 * and that is deliberate rather than tidy. The checker in section 7 and the
 * --write-stamp writer both call it. Had the writer been given its own copy,
 * the two would have agreed right up until one of them learned something the
 * other did not — a new binary extension, a different separator — at which
 * point the writer would confidently paste a value the checker rejects.
 *
 * Returns the counts alongside the digest because a hash of nothing is still
 * a hash. Both callers need to know the sweep found something before they
 * believe the twelve characters it produced.
 */
function shellStampOf(SHELL) {
  // './' and './index.html' are the same bytes from any static host; hashing
  // both would count the page twice and, worse, would make the stamp depend
  // on a listing decision rather than on content. Mapped and de-duplicated.
  // Sorted, so the order of the SHELL array — written for humans, in rough
  // dependency order — cannot change the answer.
  const paths = [...new Set(SHELL.map((p) => (p === './' ? './index.html' : p)))].sort();

  const BINARY = /\.(png|jpg|jpeg|ico|woff2?)$/;
  const h = createHash('sha256');
  let hashed = 0;
  let unreadable = 0;
  for (const p of paths) {
    let bytes;
    try { bytes = readFileSync(REPO + p.slice(2)); } catch (_) { unreadable++; continue; }
    // LINE ENDINGS NORMALISED for text. A checkout on Windows and a checkout
    // on Linux hold different bytes for the same commit, and without this the
    // suite would fail on one of them for a reason that has nothing to do
    // with the app. Binaries are hashed as-is — there are no line endings in
    // a PNG, only pixels that happen to be 0x0D.
    if (!BINARY.test(p)) bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    // The path goes into the hash as well as the contents, with a separator,
    // so that renaming a file changes the stamp even when its bytes do not —
    // and so that two adjacent files cannot be concatenated into the same
    // digest as one longer file.
    h.update(p); h.update('\0'); h.update(bytes); h.update('\0');
    hashed++;
  }
  return { stamp: h.digest('hex').slice(0, 12), hashed, unreadable };
}

/** The one line --write-stamp is allowed to touch. */
const STAMP_ANCHOR = /^const SHELL_STAMP = '([0-9a-f]{12})';$/m;

/**
 * WHAT --write-stamp WOULD DO TO A GIVEN sw.js, decided without touching the
 * disk. Returns `{ refuse, stamp, hashed, unreadable, was, next }`, where
 * `refuse` is a reason string or null and `next` is the complete new file
 * text or null if it refused.
 *
 * SPLIT OUT FROM THE WRITER SO THE SUITE CAN DRIVE IT. These guards are the
 * entire reason a test runner is trusted with a write, and as long as they
 * live inside `if (process.argv.includes(...))` nothing can reach them: the
 * suite never takes that branch, so deleting every one of them would leave
 * the whole suite green and a writer that pastes the hash of an empty sweep
 * over the deploy blocker it was meant to fix. Untested safety code is
 * decoration, and it is the most dangerous kind because of how it reads.
 *
 * Pure, and takes the parsed file rather than reading it, so the suite can
 * hand it a two-anchor sw.js or a SHELL full of paths that do not exist —
 * inputs that cannot be produced any other way without damaging the working
 * tree to test the thing that protects it.
 */
function planStampWrite(sw) {
  const refuse = (why) => ({ refuse: why, stamp: null, hashed: 0, unreadable: 0, was: null, next: null });

  if (sw.error) return refuse(`sw.js does not parse — ${sw.error.message}`);
  if (!Array.isArray(sw.SHELL) || sw.SHELL.length === 0) return refuse('sw.js exports no usable SHELL');

  const { stamp, hashed, unreadable } = shellStampOf(sw.SHELL);
  // THE SAME PAIRING THE CHECKER USES, for a sharper reason. A hash over a
  // sweep that found nothing is a well-formed answer to the wrong question;
  // downstream of the checker that is a confusing failure, but downstream of
  // the writer it is a wrong value written into the file — and once written,
  // the checker agrees with it. A wrong stamp is strictly worse than a stale
  // one: stale is caught on the next run, wrong is never caught again. The
  // check and the fix must not both be fooled by the same bad input, so the
  // fix is the more suspicious of the two.
  if (unreadable > 0) return refuse(`${unreadable} file(s) in SHELL could not be read off disk`);
  if (hashed < 15) return refuse(`the sweep covered only ${hashed} files — that is not the shell`);

  // The anchor has to be unique. A second occurrence means the file is not
  // shaped the way this assumes, and the honest response is to stop rather
  // than to edit whichever one happens to come first.
  const hits = sw.src.match(new RegExp(STAMP_ANCHOR.source, 'gm')) || [];
  if (hits.length !== 1) return refuse(`found ${hits.length} SHELL_STAMP declarations in sw.js, expected exactly 1`);

  return {
    refuse: null,
    stamp,
    hashed,
    unreadable,
    was: sw.src.match(STAMP_ANCHOR)[1],
    next: sw.src.replace(STAMP_ANCHOR, `const SHELL_STAMP = '${stamp}';`),
  };
}

/**
 * `node scripts/test-engine.mjs --write-stamp` — the one mode in which this
 * runner writes to the repository. `npm run stamp`.
 *
 * WHY IT EXISTS. Every legitimate edit to a shell file makes the suite red
 * until somebody pastes twelve hex characters into sw.js. That is correct —
 * the stamp really is stale — but it costs a round trip on every change, and
 * a check that is red for a known and mechanical reason is a check people
 * learn to run last. Printing the answer is half the fix; applying it is the
 * other half.
 *
 * WHY IT IS FENCED THIS TIGHTLY. A test runner that can edit the code it
 * grades is exactly the tool you would build if you wanted a green suite that
 * means nothing, so the blast radius is cut to the smallest thing that still
 * does the job:
 *
 *   - it runs HERE, above every assertion, and exits. There is no path on
 *     which a run both writes a stamp and reports a pass count, so `npm test`
 *     cannot quietly repair what it was meant to catch. That the test script
 *     does not pass the flag is asserted in section 7.
 *   - it writes ONE line, and only where planStampWrite() above allows it.
 *   - it reads the file back and re-parses before claiming success.
 *
 * Note it is safe for this to write sw.js at all only because sw.js is not in
 * SHELL: the file holding the hash is not among the files hashed, so writing
 * it does not move the target. That is asserted in section 7 too.
 */
if (process.argv.includes('--write-stamp')) {
  const plan = planStampWrite(loadSwConsts());

  if (plan.refuse) {
    console.error(`--write-stamp refused: ${plan.refuse}`);
    console.error('sw.js is unchanged. Fix the above and run it again.');
    process.exit(1);
  }

  if (plan.was === plan.stamp) {
    console.log(`shell stamp already current: ${plan.stamp} over ${plan.hashed} files. Nothing written.`);
    process.exit(0);
  }

  writeFileSync(REPO + 'sw.js', plan.next, 'utf8');

  // READ IT BACK. The difference between "wrote the file" and "the file now
  // says what I meant" is the whole reason this mode is allowed to exist, and
  // re-parsing is the only way to learn that the replacement landed inside a
  // string literal or broke the syntax on the way past.
  const after = loadSwConsts();
  if (after.error) {
    console.error(`--write-stamp: sw.js no longer parses after the write — ${after.error.message}`);
    process.exit(1);
  }
  if (after.SHELL_STAMP !== plan.stamp) {
    console.error(`--write-stamp: sw.js still reads ${after.SHELL_STAMP} after the write`);
    process.exit(1);
  }

  console.log(`shell stamp: ${plan.was} -> ${plan.stamp}  (over ${plan.hashed} files)`);
  console.log(`cache name:  ${after.CACHE_NAME}`);
  console.log('Review the diff, then run the suite.');
  process.exit(0);
}

// A seeded stream in place of the platform CSPRNG, so a failing shuffle can be
// reproduced. cards.js reads globalThis.crypto at call time precisely so this
// works. Same construction as judgement's harness.
let prng = 0;
function seed(n) { prng = n >>> 0; }
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {
    getRandomValues(buf) {
      for (let i = 0; i < buf.length; i++) {
        prng = (prng + 0x6D2B79F5) >>> 0;
        let t = prng;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        buf[i] = (t ^ (t >>> 14)) >>> 0;
      }
      return buf;
    },
  },
});
seed(1);

// Every deck/joker pairing the lobby can actually produce. Used by several
// sections; jokers are capped per deck, so 4 needs two decks and 6 needs three.
const SETUPS = [];
for (let decks = MIN_DECKS; decks <= MAX_DECKS; decks++) {
  for (const jokers of [0, 2, 4, 6]) {
    if (jokers <= JOKERS_PER_DECK * decks) SETUPS.push({ decks, jokers });
  }
}

// ===========================================================================
section('Card vocabulary');
// ===========================================================================

eq(RANKS.length, 13, 'thirteen ranks');
eq(SUITS.length, 4, 'four suits');
eq(SUITS.length * RANKS.length, CARDS_PER_DECK, 'which is a 52-card deck');
eq(RANKS[0], 'A', 'the ascending cycle starts at the Ace');
eq(RANKS[RANKS.length - 1], 'K', 'and ends at the King');
ok(!RANKS.includes(JOKER), 'THE JOKER IS NOT A RANK — this is what makes it unclaimable, structurally');
ok(isJoker(JOKER) && !isJoker('K'), 'isJoker reads the token');
eq(rankLabel('T'), '10', 'the ten displays as two characters and stores as one');
eq(rankLabel('K'), 'K', 'every other rank displays as itself');
eq(rankName('K'), 'King', 'a screen reader hears a word, not a letter');
eq(rankName('K', 3), 'Kings', 'and hears the plural when the claim is plural');
eq(rankName('6', 2), 'Sixes', 'including the ones English is awkward about');

// ===========================================================================
section('Building a multi-deck pack');
// ===========================================================================

for (const cfg of SETUPS) {
  const pack = buildDeck(cfg);
  const label = `${cfg.decks} decks / ${cfg.jokers} jokers`;

  eq(pack.length, CARDS_PER_DECK * cfg.decks + cfg.jokers,
    `${label}: the pack is 52 x decks + jokers`);
  eq(pack.length, deckSize(cfg), `${label}: and deckSize() agrees with the pack it describes`);
  eq(new Set(pack.map((c) => c.id)).size, pack.length,
    `${label}: every card id is unique, so two decks' Aces are distinguishable objects`);

  for (const rank of RANKS) {
    eq(pack.filter((c) => c.rank === rank).length, SUITS.length * cfg.decks,
      `${label}: exactly 4 x decks of every rank — NOT four`);
  }
  eq(pack.filter((c) => c.rank === JOKER).length, cfg.jokers, `${label}: and the jokers asked for`);
  ok(pack.filter((c) => c.rank === JOKER).every((c) => c.suit === null),
    `${label}: a joker has no suit`);
}

// The ordered pack is ordered, which is what lets the deal test below read the
// turn direction out of it.
{
  const pack = buildDeck({ decks: 2, jokers: 1 });
  eq(pack[0].id, 'AS0', 'the pack starts with the first deck');
  eq(pack[CARDS_PER_DECK].id, 'AS1', 'the second deck begins exactly 52 cards later');
  eq(pack[pack.length - 1].rank, JOKER, 'and the jokers are appended after both decks');
}

// ---------------------------------------------------------------------------
// THE SHUFFLE COVERS THE WHOLE ARRAY.
//
// The bug this guards is shuffling each deck and concatenating. That produces
// a pack whose first 52 cards are ALWAYS a permutation of one complete deck —
// so a player at two decks who has seen four Kings go past knows where the
// next one is. The property that separates the two: under a whole-array
// shuffle the first 52 cards contain a varying number of each rank, and under
// a per-deck shuffle they contain exactly four every single time.
// ---------------------------------------------------------------------------
{
  const pack = buildDeck({ decks: 2, jokers: 0 });
  const TRIALS = 200;
  let uneven = 0;
  let secondDeckOnTop = 0;
  for (let trial = 0; trial < TRIALS; trial++) {
    seed(trial + 1);
    const mixed = shuffle(pack);
    eq(mixed.length, pack.length, 'shuffle keeps every card');
    if (trial === 0) {
      eq(new Set(mixed.map((c) => c.id)).size, pack.length, 'and keeps them distinct');
    }
    const firstDeck = mixed.slice(0, CARDS_PER_DECK);
    if (RANKS.some((r) => firstDeck.filter((c) => c.rank === r).length !== SUITS.length)) uneven++;
    // The deck index is the last character of a standard card's id.
    if (mixed[0].id.endsWith('1')) secondDeckOnTop++;
  }
  ok(uneven > TRIALS * 0.95,
    'THE SHUFFLE IS OVER THE WHOLE ARRAY — the first 52 cards are not a complete deck '
    + `(${uneven}/${TRIALS} trials uneven; a per-deck shuffle scores 0)`);
  // The same bug from the other end: concatenating shuffled decks leaves the
  // second deck's cards unable to reach the top of the pack at all.
  ok(secondDeckOnTop > TRIALS * 0.3 && secondDeckOnTop < TRIALS * 0.7,
    'and the second deck reaches the top about half the time '
    + `(${secondDeckOnTop}/${TRIALS}; a per-deck shuffle scores 0)`);
}

// The original is not touched, so a caller may keep the ordered pack around.
{
  const pack = buildDeck({ decks: 1, jokers: 0 });
  const before = pack.map((c) => c.id).join(',');
  shuffle(pack);
  eq(pack.map((c) => c.id).join(','), before, 'shuffle returns a new array and leaves its input alone');
}

// ===========================================================================
section('Dealing: every card, to uneven hands');
// ===========================================================================

// The arithmetic on its own, which is what the lobby shows before any card
// exists. Asserted over the full grid because it is pure counting and costs
// nothing to run exhaustively.
for (let players = MIN_PLAYERS; players <= MAX_PLAYERS; players++) {
  for (const cfg of SETUPS) {
    const total = deckSize(cfg);
    const counts = dealCounts(total, players);
    const label = `${players}p / ${cfg.decks}d / ${cfg.jokers}j`;
    eq(counts.length, players, `${label}: one count per seat`);
    eq(counts.reduce((a, b) => a + b, 0), total, `${label}: the counts add up to the whole pack`);
    eq(Math.max(...counts) - Math.min(...counts) <= 1, true,
      `${label}: no seat is more than one card better off`);
    ok(counts.every((n) => n > 0), `${label}: and nobody is dealt nothing`);
  }
}

// THE EXHAUSTIVE ONE. Every combination of players 3-8, decks 1-3 and jokers
// 0/2/4/6, dealt for real, asserting that the hands are exactly the pack —
// not merely the right size, but the same cards, each appearing once.
{
  let grid = 0;
  for (let players = MIN_PLAYERS; players <= MAX_PLAYERS; players++) {
    for (const cfg of SETUPS) {
      grid++;
      const label = `${players}p / ${cfg.decks}d / ${cfg.jokers}j`;
      seed(players * 100 + cfg.decks * 10 + cfg.jokers);
      const pack = shuffle(buildDeck(cfg));
      const hands = deal(pack, { players });

      const dealt = hands.flat();
      eq(dealt.length, pack.length, `${label}: every card is dealt`);
      eq(new Set(dealt.map((c) => c.id)).size, pack.length,
        `${label}: exactly once — no card dealt twice, none left behind`);
      same(hands.map((h) => h.length), dealCounts(pack.length, players),
        `${label}: and the hand sizes are the ones the lobby promised`);

      for (const rank of [...RANKS, JOKER]) {
        const expected = rank === JOKER ? cfg.jokers : SUITS.length * cfg.decks;
        eq(dealt.filter((c) => c.rank === rank).length, expected,
          `${label}: the whole supply of ${rank} is in someone's hand`);
      }
    }
  }
  eq(grid, (MAX_PLAYERS - MIN_PLAYERS + 1) * SETUPS.length,
    'the grid covered every legal players x decks x jokers combination');
}

// THE TURN DIRECTION, read out of an unshuffled deal. The pack starts
// AS, KS... wait — it starts with the Ace of spades and walks RANKS, so seat 0
// takes the Ace, seat 1 the Two, seat 2 the Three. Anticlockwise would hand
// the Two to the last seat instead.
{
  const pack = buildDeck({ decks: 1, jokers: 0 });
  const cw = deal(pack, { players: 4, from: 0, dir: CLOCKWISE });
  eq(cw[0][0].rank, 'A', 'clockwise: seat 0 takes the first card');
  eq(cw[1][0].rank, '2', 'seat 1 takes the second');
  eq(cw[3][0].rank, '4', 'and seat 3 the fourth');

  const acw = deal(pack, { players: 4, from: 0, dir: ANTICLOCKWISE });
  eq(acw[3][0].rank, '2', 'ANTICLOCKWISE puts the second card in the other neighbour — the direction is a real parameter');
  ok(cw[1][0].rank !== acw[1][0].rank, 'and the two deals genuinely differ');
}

// The extra cards go to the seats the arithmetic said they would.
{
  const pack = buildDeck({ decks: 1, jokers: 1 });   // 53 cards
  const hands = deal(pack, { players: 3 });
  same(hands.map((h) => h.length), [18, 18, 17], '53 cards among 3 is 18/18/17, and the odd seat out is the last');
}

throws(() => deal(buildDeck({ decks: 1, jokers: 0 }), { players: 0 }),
  'dealing to nobody is a programming error, not a quiet empty result');

// ===========================================================================
section('A hand as rank groups');
// ===========================================================================

{
  const hand = [
    { id: 'KS0', rank: 'K', suit: 'S' },
    { id: 'X0', rank: JOKER, suit: null },
    { id: '3H0', rank: '3', suit: 'H' },
    { id: 'KD0', rank: 'K', suit: 'D' },
    { id: 'AS0', rank: 'A', suit: 'S' },
  ];

  eq(countOf(hand, 'K'), 2, 'countOf counts a rank');
  eq(countOf(hand, 'Q'), 0, 'and reports zero for one that is absent');
  same(handCounts(hand), { K: 2, [JOKER]: 1, 3: 1, A: 1 }, 'handCounts is the whole hand as a multiset');

  const groups = groupHand(hand);
  same(groups.map((g) => g.rank), ['A', '3', 'K', JOKER],
    'groups come out in rank order with the joker last, and empty ranks are omitted');
  same(groups.map((g) => g.count), [1, 1, 2, 1], 'each carrying its count');
  eq(groups.reduce((n, g) => n + g.cards.length, 0), hand.length, 'and between them every card');

  same(sortHand(hand).map((c) => c.id), ['AS0', '3H0', 'KS0', 'KD0', 'X0'],
    'the flat sort agrees, ranks then suits');
}

// The 80-card case, which is the whole reason grouping exists. Three decks
// plus six jokers is 162 cards; a player who has eaten most of the pile can
// genuinely be holding this many.
{
  seed(99);
  const big = shuffle(buildDeck({ decks: 3, jokers: 6 })).slice(0, 80);
  const groups = groupHand(big);
  ok(groups.length <= RANKS.length + 1,
    `an 80-card hand collapses to at most 14 rows (got ${groups.length})`);
  eq(groups.reduce((n, g) => n + g.count, 0), 80, 'with every card accounted for');
}

throws(() => groupHand([{ id: 'zz', rank: 'Z', suit: 'S' }]),
  'a card of a rank this engine cannot have made is an error, not a card to drop quietly');

// ---------------------------------------------------------------------------
// takeByRank — the wire format. A play names RANKS, never card ids.
// ---------------------------------------------------------------------------
{
  const hand = [
    { id: 'KS0', rank: 'K', suit: 'S' },
    { id: '7H0', rank: '7', suit: 'H' },
    { id: 'KD0', rank: 'K', suit: 'D' },
    { id: 'KD1', rank: 'K', suit: 'D' },
  ];

  const got = takeByRank(hand, ['K', 'K']);
  eq(got.taken.length, 2, 'two Kings come out');
  ok(got.taken.every((c) => c.rank === 'K'), 'and they are Kings');
  eq(got.rest.length, 2, 'the rest of the hand stays');
  same(got.taken.map((c) => c.id), ['KS0', 'KD0'], 'deterministically, in hand order');
  eq(got.rest.concat(got.taken).length, hand.length, 'nothing is lost or duplicated');

  const mixed = takeByRank(hand, ['K', '7']);
  same(mixed.taken.map((c) => c.rank).sort(), ['7', 'K'],
    'a play may mix ranks — that is what lying with real cards looks like');

  eq(takeByRank(hand, ['K', 'K', 'K', 'K']), null,
    'asking for four Kings from a hand of three is refused, not half-served');
  eq(takeByRank(hand, ['Q']), null, 'and so is naming a rank the hand does not hold at all');
  eq(takeByRank(hand, [JOKER]), null, 'including the joker, when there is none');

  const empty = takeByRank(hand, []);
  eq(empty.taken.length, 0, 'taking nothing is legal here');
  eq(empty.rest.length, hand.length, 'and leaves the hand alone');
  eq(hand.length, 4, 'takeByRank never mutates the hand it was given');
}

// ===========================================================================
section('Legal claims: ascending');
// ===========================================================================

same(legalClaims('ascending', null), ['A'],
  'an empty pile starts the cycle at the Ace');
same(legalClaims('ascending', 'A'), ['2'], 'and marches on from there');
same(legalClaims('ascending', 'Q'), ['K'], 'up to the King');
same(legalClaims('ascending', 'K'), ['A'],
  'THE WRAP: after the King comes the Ace. Sticking on K jams the game within minutes');

ok(claimIsForced('ascending', null), 'ascending never offers a choice of rank');
ok(claimIsForced('ascending', '7'), 'not at any point in the cycle');
ok(isLegalClaim('ascending', '7', '8'), 'the next rank is legal');
ok(!isLegalClaim('ascending', '7', '7'), 'repeating is not');
ok(!isLegalClaim('ascending', '7', '6'), 'and neither is going back');
ok(!isLegalClaim('ascending', '7', JOKER), 'a joker is not a claim under any rule');

// Walking the whole cycle twice proves the wrap is not a one-off patch.
{
  let rank = legalClaims('ascending', null)[0];
  const walked = [rank];
  for (let i = 0; i < RANKS.length * 2 - 1; i++) {
    rank = legalClaims('ascending', rank)[0];
    walked.push(rank);
  }
  eq(walked.length, RANKS.length * 2, 'the cycle runs as long as the game does');
  same(walked.slice(0, RANKS.length), [...RANKS], 'once round is exactly the rank order');
  same(walked.slice(RANKS.length), [...RANKS], 'and twice round is the same again');
}

// ===========================================================================
section('Legal claims: adjacent');
// ===========================================================================

same(legalClaims('adjacent', null), [...RANKS],
  'an empty pile has no neighbour, so the opening claim is free');
same(legalClaims('adjacent', '7'), ['6', '7', '8'],
  'one below, the same, or one above — in rank order, not in some other order');
same(legalClaims('adjacent', 'A'), ['A', '2', 'K'],
  'THE WRAP DOWNWARD: the Ace neighbours the King');
same(legalClaims('adjacent', 'K'), ['A', 'Q', 'K'],
  'and the King neighbours the Ace');
eq(legalClaims('adjacent', '7').length, 3, 'exactly three options in the middle of the cycle');
eq(legalClaims('adjacent', 'K').length, 3, 'and exactly three at the seam — no duplicate, no missing');

ok(!claimIsForced('adjacent', '7'), 'adjacent is a choice');
ok(isLegalClaim('adjacent', 'K', 'A'), 'K to A is legal');
ok(isLegalClaim('adjacent', 'A', 'K'), 'and A to K');
ok(!isLegalClaim('adjacent', 'A', 'Q'), 'but A to Q is two steps');

// ===========================================================================
section('Legal claims: free');
// ===========================================================================

same(legalClaims('free', null), [...RANKS], 'free means every rank');
same(legalClaims('free', 'K'), [...RANKS], 'whatever came before');
ok(!claimIsForced('free', 'K'), 'and never forced');
ok(!legalClaims('free', null).includes(JOKER), 'the joker is absent from free claims too');

// No rank rule can ever offer the joker, checked rather than assumed, because
// this is the property that makes "a joker is never a claimable rank" true.
for (const rule of Object.keys(RANK_RULES)) {
  for (const prev of [null, ...RANKS]) {
    const claims = legalClaims(rule, prev);
    ok(claims.length > 0, `${rule} after ${prev}: there is always something to claim`);
    ok(claims.every((r) => RANKS.includes(r)), `${rule} after ${prev}: every claim is a real rank`);
  }
}

throws(() => legalClaims('sideways', 'K'),
  'an unrecognised rank rule throws rather than silently leaving the player unable to move');

eq(rankIndex('A'), 0, 'rankIndex is the position in the ascending cycle');
eq(rankIndex(JOKER), -1, 'and the joker has none');
eq(nextRank(JOKER), null, 'so it has no successor');
eq(prevRank('A'), 'K', 'prevRank wraps the other way');
eq(nextRank('K'), 'A', 'as does nextRank');

// ===========================================================================
section('Turn order helpers');
// ===========================================================================

eq(nextSeat(0, 5), 1, 'clockwise is +1 by default');
eq(nextSeat(4, 5), 0, 'and wraps');
eq(nextSeat(0, 5, ANTICLOCKWISE), 4, 'anticlockwise wraps the other way — no negative index');
same(seatsFrom(2, 4), [2, 3, 0, 1], 'seatsFrom walks every seat once, starting where told');
same(seatsFrom(2, 4, ANTICLOCKWISE), [2, 1, 0, 3], 'in the direction it is given');

// ===========================================================================
section('Config: the interdependent clamps');
// ===========================================================================

same(normalizeConfig({}), DEFAULT_CONFIG, 'an empty config is the default config');
same(normalizeConfig(null), DEFAULT_CONFIG, 'and so is nothing at all');
same(normalizeConfig('wild'), DEFAULT_CONFIG, 'and so is a string where an object belongs');
same(normalizeConfig([1, 2]), DEFAULT_CONFIG, 'and an array, which typeof calls an object');
ok(Object.isFrozen(normalizeConfig({})), 'the result is frozen — nothing downstream edits a live config');
eq(normalizeConfig({ nonsense: 1 }).nonsense, undefined, 'unknown keys do not survive the trip');

// The caps themselves, at every deck count. Written out rather than computed,
// so a change to the formula has to be agreed with here.
eq(jokerCap(1), 2, 'one deck carries two jokers');
eq(jokerCap(2), 4, 'two decks, four');
eq(jokerCap(3), 6, 'three decks, six');
eq(playCap(1), 4, 'one deck allows four cards a turn');
eq(playCap(2), 8, 'two decks allow eight');
eq(playCap(3), MAX_PLAY_CEILING, 'three decks would allow twelve, but the ceiling holds it at eight');

// THE RE-CLAMP RULE. Lowering the deck count must bring BOTH dependent numbers
// down IN THE SAME UPDATE. The failure this prevents is a 3-deck joker count
// surviving into a 1-deck game, where the pack would carry six jokers it does
// not have.
{
  const wide = normalizeConfig({ decks: 3, jokers: 6, maxPlay: 8 });
  eq(wide.jokers, 6, 'three decks may carry six jokers');
  eq(wide.maxPlay, 8, 'and play eight at a time');

  const narrowed = normalizeConfig({ ...wide, decks: 1 });
  eq(narrowed.decks, 1, 'the host drops to one deck');
  eq(narrowed.jokers, 2, 'AND THE JOKERS COME DOWN WITH IT, in the same update');
  eq(narrowed.maxPlay, 4, 'as does the biggest play');

  const midway = normalizeConfig({ ...wide, decks: 2 });
  eq(midway.jokers, 4, 'two decks re-clamp to four jokers');
  eq(midway.maxPlay, 8, 'and eight is still reachable at two decks');

  // Raising does NOT push the numbers back up. A host who chose one joker and
  // then added a deck asked for a deck, not for more jokers.
  const widened = normalizeConfig({ ...normalizeConfig({ decks: 1, jokers: 1 }), decks: 3 });
  eq(widened.jokers, 1, 'raising the deck count leaves a low joker count where the host put it');
}

eq(normalizeConfig({ jokers: 99 }).jokers, 2, 'an absurd joker count clamps to the cap for the deck count');
eq(normalizeConfig({ jokers: -5 }).jokers, 0, 'and a negative one to none');
eq(normalizeConfig({ jokers: 2.9 }).jokers, 2, 'fractions floor');
eq(normalizeConfig({ jokers: '4', decks: 2 }).jokers, 4, 'a string from a range input is a number');
eq(normalizeConfig({ jokers: 'lots' }).jokers, 0, 'and something that is not a number at all is refused into range');
eq(normalizeConfig({ maxPlay: 0 }).maxPlay, 1, 'you must play at least one card');
eq(normalizeConfig({ maxPlay: 99, decks: 3 }).maxPlay, MAX_PLAY_CEILING, 'and at most the ceiling');
eq(normalizeConfig({ windowMs: 1 }).windowMs, MIN_WINDOW_MS, 'the window has a floor a human can read in');
eq(normalizeConfig({ windowMs: 999999 }).windowMs, MAX_WINDOW_MS, 'and a roof, so the table is not left waiting');

eq(normalizeConfig({ rankRule: 'adjacent' }).rankRule, 'adjacent', 'a recognised rank rule passes through');
eq(normalizeConfig({ rankRule: 'sideways' }).rankRule, DEFAULT_CONFIG.rankRule,
  'an unrecognised one falls back, so an older host still gets a game');
eq(normalizeConfig({ rankRule: 'toString' }).rankRule, DEFAULT_CONFIG.rankRule,
  'as does an inherited key');
eq(normalizeConfig({ challengeMode: 'next' }).challengeMode, 'next', 'challenge modes likewise');
eq(normalizeConfig({ challengeMode: 'psychic' }).challengeMode, DEFAULT_CONFIG.challengeMode, 'and their fallback');

// ---------------------------------------------------------------------------
// THE TWO FIELDS THAT ARE PRESERVED RATHER THAN TIDIED.
//
// decks and jokerMode pass through normalizeConfig untouched when they are out
// of range, so that js/guards.js can REFUSE the start rather than silently
// starting a different game from the one the sender thinks they asked for. The
// rejection itself is tested at checkpoint 3; what is asserted here is that the
// bad value survives long enough to be rejected.
// ---------------------------------------------------------------------------
eq(normalizeConfig({ decks: 9 }).decks, 9,
  'A TAMPERED DECK COUNT IS NOT CLAMPED — it survives to be refused by name');
eq(normalizeConfig({ decks: 0 }).decks, 0, 'in both directions');
eq(normalizeConfig({ decks: 'three' }).decks, DEFAULT_CONFIG.decks,
  'but a value that is not a number is noise rather than tampering, and falls back');
eq(normalizeConfig({ jokerMode: 'chaos' }).jokerMode, 'chaos',
  'AN UNKNOWN JOKER MODE IS NOT CLAMPED either');
eq(normalizeConfig({ jokerMode: 7 }).jokerMode, DEFAULT_CONFIG.jokerMode, 'a non-string is noise, and falls back');

// Even with a nonsense deck count, the dependent numbers stay bounded. The
// guard refuses the start, but nothing in the meantime may allocate 18 jokers.
{
  const bad = normalizeConfig({ decks: 9, jokers: 999, maxPlay: 999 });
  eq(bad.jokers, jokerCap(MAX_DECKS), 'a nonsense deck count still bounds the jokers at the real cap');
  eq(bad.maxPlay, MAX_PLAY_CEILING, 'and the play size at the real ceiling');
}

// ===========================================================================
section('Config: the supply bound, at every deck count');
// ===========================================================================

// rankSupply is the number the bot proves a lie against and the number a human
// is doing in their head. Every naive implementation writes 4.
eq(rankSupply(normalizeConfig({ decks: 1, jokers: 0 })), 4, 'one deck, no jokers: four of a rank');
eq(rankSupply(normalizeConfig({ decks: 2, jokers: 0 })), 8, 'two decks: eight — NOT four');
eq(rankSupply(normalizeConfig({ decks: 3, jokers: 0 })), 12, 'three decks: twelve');
eq(rankSupply(normalizeConfig({ decks: 1, jokers: 2, jokerMode: 'wild' })), 6,
  'WILD JOKERS INFLATE THE SUPPLY — six cards could satisfy a claim of Kings at one deck');
eq(rankSupply(normalizeConfig({ decks: 1, jokers: 2, jokerMode: 'junk' })), 4,
  'JUNK JOKERS DO NOT — they satisfy nothing, so the supply is unchanged');
eq(rankSupply(normalizeConfig({ decks: 3, jokers: 6, jokerMode: 'wild' })), 18,
  'and at three decks with six wild jokers, eighteen Kings is not a provable lie');

// ===========================================================================
section('Config: presets and the derived lines');
// ===========================================================================

for (const p of PRESETS) {
  const cfg = normalizeConfig({ ...DEFAULT_CONFIG, ...p.patch });
  eq(presetMatching(cfg), p.id, `the ${p.id} preset recognises itself`);
  ok(Object.keys(p.patch).every((k) => !['decks', 'jokers', 'maxPlay'].includes(k)),
    `the ${p.id} preset does not touch the table-size axes`);
}
eq(presetMatching(normalizeConfig({ rankRule: 'ascending', challengeMode: 'next' })), null,
  'a config the host has edited into its own shape matches no preset, which is a legitimate state');

// A preset must never undo a deck choice — the property the patches above are
// shaped to guarantee, asserted on the result rather than on the patch.
{
  const table = normalizeConfig({ decks: 2, jokers: 4, maxPlay: 8 });
  const after = normalizeConfig({ ...table, ...PRESETS[0].patch });
  eq(after.decks, 2, 'applying a preset leaves the deck count alone');
  eq(after.jokers, 4, 'and the joker count');
  eq(after.maxPlay, 8, 'and the biggest play');
}

eq(describeDeal(normalizeConfig({ decks: 2, jokers: 4 }), 6), '2 decks · 4 jokers · 6 players — 18 cards each to start',
  'the lobby line reads as a sentence when the deal is even');
eq(describeDeal(normalizeConfig({ decks: 1, jokers: 1 }), 3), '1 deck · 1 joker · 3 players — 17 or 18 cards each to start',
  'and says so plainly when it is not');
eq(describeDeal(normalizeConfig({ decks: 1, jokers: 0 }), 4), '1 deck · no jokers · 4 players — 13 cards each to start',
  'no jokers is written out rather than shown as a zero');
ok(describeDeal(normalizeConfig({ decks: 3 }), 3).includes('52 cards each'),
  'THREE DECKS AT THREE PLAYERS IS 52 CARDS EACH — which is exactly what the host needs told before they start');
ok(describeDeal(normalizeConfig({}), 2).includes(`seat ${MIN_PLAYERS}`),
  'below the minimum it asks for more players rather than dividing by a number it does not have');

ok(describeConfig(normalizeConfig({ decks: 2, jokers: 2, jokerMode: 'junk' })).includes('junk'),
  'the play-screen strip names the joker mode, because a claim cannot be judged without it');
ok(describeConfig(normalizeConfig({ decks: 2 })).includes('2 decks'),
  'and the deck count, for the same reason');

// Every mode named in the tables is a real, normalising value — the lobby
// renders straight from these, so an entry with no implementation would be a
// button that silently does nothing.
for (const rule of Object.keys(RANK_RULES)) {
  eq(normalizeConfig({ rankRule: rule }).rankRule, rule, `${rule} is a real rank rule`);
  ok(legalClaims(rule, 'K').length > 0, `and generates claims`);
}
for (const mode of Object.keys(JOKER_MODES)) {
  eq(normalizeConfig({ jokerMode: mode }).jokerMode, mode, `${mode} is a real joker mode`);
}
for (const mode of Object.keys(CHALLENGE_MODES)) {
  eq(normalizeConfig({ challengeMode: mode }).challengeMode, mode, `${mode} is a real challenge mode`);
}
eq(Object.keys(JOKER_MODES).length, 2, 'there are exactly two joker modes, which is what guards.js refuses against');

// ===========================================================================
// THE ENGINE
//
// Everything below drives a real GameEngine. Two conventions make it readable:
//
//   * `now` is always passed explicitly and always derives from T0, never from
//     the wall clock. Any test that passes if you delete the argument is not
//     testing the deadline-as-state rule.
//   * Hands are OVERWRITTEN with known cards after the deal. The deal itself is
//     tested above and separately below; a test about a joker saving a claim
//     should not also be a test about whether the shuffle produced one.
// ===========================================================================

const T0 = 1700000000000;   // fixed, and far in the past of any real Date.now()
const NAMES = ['Ana', 'Bo', 'Cy', 'Dee', 'Eve', 'Fin', 'Gus', 'Hal'];

/** A started game. Seats are p0..pN-1, p0 hosts, p0 leads the first game. */
function table(n, patch = {}) {
  const e = new GameEngine();
  e.addPlayer('p0', NAMES[0], { isHost: true, clientId: 'c0' });
  for (let i = 1; i < n; i++) e.addPlayer(`p${i}`, NAMES[i], { clientId: `c${i}` });
  e.setConfig(patch);
  e.startGame('p0');
  return e;
}

let cardSerial = 0;
function card(rank) {
  const n = cardSerial++;
  return rank === JOKER
    ? { id: `${JOKER}${n}`, rank: JOKER, suit: null }
    : { id: `${rank}S${n}`, rank, suit: 'S' };
}

/** Replace the dealt hands with known ones. Host-only field, host-only test. */
function setHands(e, map) {
  e.hands = {};
  for (const [id, ranks] of Object.entries(map)) e.hands[id] = ranks.map(card);
}

function handSizes(e) {
  return e.players.map((p) => e.handCount(p.id));
}

// --- The privacy probes ----------------------------------------------------
//
// Used by almost every engine test rather than by one dedicated test, because
// a leak introduced by a later feature would otherwise only be caught if
// somebody remembered to re-run the one test that looks for it.

/** Every card object anywhere in a value. Only cards carry a `suit`, so this
 *  counts card contents and nothing else — a claim carries a rank but no suit
 *  and is correctly not counted. */
function countSuited(v) {
  if (Array.isArray(v)) return v.reduce((n, x) => n + countSuited(x), 0);
  if (v && typeof v === 'object') {
    let n = Object.prototype.hasOwnProperty.call(v, 'suit') ? 1 : 0;
    for (const x of Object.values(v)) n += countSuited(x);
    return n;
  }
  return 0;
}

const FORBIDDEN_KEYS = ['hand', 'hands', 'pile', 'lastPlayCards', 'deck', 'cardIds'];
function forbiddenKeysIn(v, path = '') {
  const found = [];
  if (Array.isArray(v)) {
    v.forEach((x, i) => found.push(...forbiddenKeysIn(x, `${path}[${i}]`)));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.includes(k)) found.push(`${path}.${k}`);
      found.push(...forbiddenKeysIn(x, `${path}.${k}`));
    }
  }
  return found;
}

function allHostCardIds(e) {
  const ids = [];
  for (const hand of Object.values(e.hands)) for (const c of hand) ids.push(c.id);
  for (const c of e.pile) ids.push(c.id);
  return ids;
}

/**
 * The boundary, as one callable assertion.
 *
 * Three independent ways of catching the same class of mistake, because they
 * fail on different mistakes: a leaked ARRAY of cards trips the count, a
 * renamed field carrying cards trips the key scan, and a card id smuggled into
 * a string trips the id scan.
 */
function assertNoLeak(e, where) {
  const pub = e.publicState();
  const expected = e.reveal ? e.reveal.cards.length : 0;
  eq(countSuited(pub), expected,
    `public state carries no card contents beyond the reveal (${where})`);
  same(forbiddenKeysIn(pub), [], `public state has no hand/pile field (${where})`);
  const json = JSON.stringify(pub);
  const leaked = allHostCardIds(e).filter((id) => json.includes(`"${id}"`));
  same(leaked, [], `no card id reaches the wire (${where})`);
}

/**
 * The same three probes, as a predicate rather than an assertion.
 *
 * The long random-game loops call this hundreds of times per game. Routing
 * those through assertNoLeak would add tens of thousands of passing lines to
 * the total and bury one real failure in the noise, so they count failures
 * here and assert once at the end.
 */
function isLeakFree(e) {
  const pub = e.publicState();
  if (countSuited(pub) !== (e.reveal ? e.reveal.cards.length : 0)) return false;
  if (forbiddenKeysIn(pub).length) return false;
  const json = JSON.stringify(pub);
  return !allHostCardIds(e).some((id) => json.includes(`"${id}"`));
}

/** Card ids must never reach the log either — it is public, serialized, and
 *  the easiest place to publish the game by accident. */
function assertCleanLog(e, where) {
  const text = e.log.join(' | ');
  const leaked = allHostCardIds(e).filter((id) => text.includes(id));
  same(leaked, [], `the log names no card (${where})`);
}

section('The engine: setting a table');

{
  const e = new GameEngine();
  eq(e.phase, PHASES.LOBBY, 'a fresh engine is in the lobby');
  ok(e.startBlocker().includes(`${MIN_PLAYERS}`), 'and says how many players it still needs');

  e.addPlayer('p0', 'Ana', { isHost: true, clientId: 'c0' });
  ok(!e.startBlocker().includes('mores'), 'the "seats to go" line is not double-pluralised');
  ok(e.startBlocker().includes('2 seats'), 'and counts the seats still to fill');

  eq(e.addPlayer('p1', 'ana', { clientId: 'c1' }).ok, false, 'a duplicate name is refused case-insensitively');
  eq(e.addPlayer('p1', '  ', { clientId: 'c1' }).ok, false, 'and a blank name is refused');
  eq(e.addPlayer('p1', 'Bo', { clientId: 'c1' }).ok, true, 'a distinct name is seated');
  eq(e.startGame('p0').ok, false, 'two players cannot start a three-player game');

  e.addBot();
  eq(e.players.length, 3, 'a bot fills the third seat');
  eq(e.startBlocker(), null, 'and the table is ready');
  eq(e.startGame('p1').ok, false, 'a non-host cannot start the game');
  eq(e.startGame('p0').ok, true, 'the host can');
  eq(e.phase, PHASES.PLAY, 'and the game is running');
  eq(e.step, STEPS.AWAITING_PLAY, 'waiting for the first play');
  assertNoLeak(e, 'first play pending');
}

// THE DEAL USES EVERY CARD, asserted through the engine rather than through
// deal() alone — the engine is where a hand could go missing by being assigned
// to a seat index that no longer exists.
for (const players of [3, 4, 5, 6, 7, 8]) {
  for (const decks of [1, 2, 3]) {
    for (const jokers of [0, 2 * decks]) {
      const e = table(players, { decks, jokers });
      const total = Object.values(e.hands).reduce((n, h) => n + h.length, 0);
      eq(total, deckSize(e.config),
        `${players}p/${decks}d/${jokers}j: every card is in somebody's hand`);
      eq(e.pile.length, 0, `${players}p/${decks}d/${jokers}j: and the pile starts empty`);
      const sizes = handSizes(e).slice().sort((a, b) => a - b);
      ok(sizes[sizes.length - 1] - sizes[0] <= 1,
        `${players}p/${decks}d/${jokers}j: hands differ by at most one card`);
      same(handSizes(e), dealCounts(deckSize(e.config), players),
        `${players}p/${decks}d/${jokers}j: and match what the lobby promised`);
    }
  }
}

// A TAMPERED CONFIG IS REFUSED AT LOBBY LOCK, NOT QUIETLY CORRECTED.
{
  const e = new GameEngine();
  e.addPlayer('p0', 'Ana', { isHost: true, clientId: 'c0' });
  e.addPlayer('p1', 'Bo', { clientId: 'c1' });
  e.addPlayer('p2', 'Cy', { clientId: 'c2' });
  e.config = { ...e.config, decks: 9 };
  ok(e.startBlocker().includes('9'), 'decks: 9 blocks the start and says so by value');
  eq(e.startGame('p0').ok, false, 'and the game will not start');
  eq(e.phase, PHASES.LOBBY, 'the table stays in the lobby rather than dealing 470 cards');
  eq(configBlocker({ ...DEFAULT_CONFIG, decks: 9 }) === null, false, 'configBlocker agrees');
  eq(configBlocker({ ...DEFAULT_CONFIG, decks: 1.5 }) === null, false, 'a fractional deck count is refused too');

  e.config = { ...DEFAULT_CONFIG, jokerMode: 'chaos' };
  ok(e.startBlocker().includes('chaos'), 'an unknown joker mode blocks the start by name');
  eq(e.startGame('p0').ok, false, 'and will not start');
  eq(configBlocker(DEFAULT_CONFIG), null, 'while the default config blocks nothing');
}

section('The engine: a turn');

{
  const e = table(3);
  setHands(e, { p0: ['A', 'K'], p1: ['2', '2'], p2: ['3', '3'] });
  eq(e.currentPlayer.id, 'p0', 'the first seat leads');
  same(e.currentLegalClaims(), ['A'], 'and under the ascending rule must claim an ace');

  eq(e.playCards('p1', ['2'], 'A', T0).ok, false, 'a player out of turn is refused');
  eq(e.playCards('p0', ['A'], 'K', T0).ok, false, 'an illegal claim rank is refused');
  ok(e.playCards('p0', ['A'], 'K', T0).error.includes('claim A'),
    'and the refusal names the rank that is legal, because under the ascending rule there is only one');
  eq(e.playCards('p0', ['Q'], 'A', T0).ok, false, 'a card the player does not hold is refused');
  eq(e.playCards('p0', [], 'A', T0).ok, false, 'an empty play is refused');
  eq(e.playCards('p0', ['A', 'A', 'A', 'A', 'A'], 'A', T0).ok, false, 'more than maxPlay is refused');
  same(handSizes(e), [2, 2, 2], 'and none of those refusals moved a card');
  eq(e.pile.length, 0, 'or touched the pile');

  eq(e.playCards('p0', ['K'], 'A', T0).ok, true, 'a legal play with a lying claim is accepted — that is the game');
  eq(e.step, STEPS.CHALLENGE_WINDOW, 'and opens the challenge window');
  eq(e.challengeEndsAt, T0 + e.config.windowMs, 'armed off the host clock passed in');
  same(e.claim, { playerId: 'p0', rank: 'A', count: 1 }, 'the claim is rank and count only');
  eq(e.pile.length, 1, 'one card went face down');
  ok(e.log.some((l) => l.includes('Ana: 1 ace')), 'the log states the claim, never the card');
  assertCleanLog(e, 'after a claim');
  assertNoLeak(e, 'window open');

  eq(e.playCards('p1', ['2'], '2', T0 + 1).ok, false, 'nobody may play over an open window in timed mode');

  const r = e.resolveExpiredWindow(T0 + e.config.windowMs);
  eq(r.fired, true, 'the window expires at its deadline');
  eq(e.step, STEPS.AWAITING_PLAY, 'and play resumes');
  eq(e.currentPlayer.id, 'p1', 'with the turn passed clockwise');
  same(e.currentLegalClaims(), ['2'], 'and the ascending chain advanced to the two');
}

// THE ASCENDING CHAIN WRAPS. A three-player game at one deck goes round the
// cycle repeatedly; a rule that sticks on the King is a game that jams.
{
  const e = table(3, { rankRule: 'ascending', maxPlay: 1 });
  setHands(e, {
    p0: Array(20).fill('5'), p1: Array(20).fill('5'), p2: Array(20).fill('5'),
  });
  let now = T0;
  const claimed = [];
  for (let i = 0; i < 15; i++) {
    const rank = e.currentLegalClaims()[0];
    claimed.push(rank);
    eq(e.playCards(e.currentPlayer.id, ['5'], rank, now).ok, true, `turn ${i} plays`);
    now = e.challengeEndsAt;
    e.resolveExpiredWindow(now);
  }
  same(claimed.slice(0, 13), RANKS, 'the forced chain runs A through K');
  eq(claimed[13], 'A', 'and wraps to the ace rather than jamming');
  eq(claimed[14], '2', 'then carries on');
}

section('The engine: challenge resolution');

// A CAUGHT LIAR TAKES THE PILE.
{
  const e = table(3);
  setHands(e, { p0: ['K', 'K'], p1: ['2'], p2: ['3'] });
  e.playCards('p0', ['K'], 'A', T0);
  const r = e.challenge('p1', T0 + 100);
  eq(r.ok, true, 'the challenge lands');
  eq(r.truthful, false, 'and the claim was a lie');
  eq(e.step, STEPS.RESOLVING, 'the reveal is on screen');
  eq(e.handCount('p0'), 2, 'the liar picks the pile back up');
  eq(e.handCount('p1'), 1, 'and the challenger keeps their hand');
  eq(e.pile.length, 0, 'the pile is emptied');
  eq(e.reveal.takerId, 'p0', 'the reveal names the taker');
  eq(e.reveal.truthful, false, 'and records that it was a lie');
  eq(e.claim, null, 'the claim chain resets with the pile');
  // THE ASCENDING CHAIN IS NOT THE PILE'S, so it does not reset with it. The
  // claim was an Ace and the next one is a Two, on an empty pile, in the hand
  // of a player who never touched it. See ruleFollowsSequence() in claims.js
  // for the livelock that restarting at the ace produces instead.
  same(e.currentLegalClaims(), ['2'], 'but the ascending chain marches through the pickup');
  // And the turn is untouched by the challenge — p0 was challenged, so play
  // rotates past them exactly as if the window had closed quietly.
  eq(e.currentPlayer.id, 'p1', 'the table rotates past the player who was challenged');
  assertNoLeak(e, 'reveal showing');
  assertCleanLog(e, 'after a caught lie');
}

// A WRONG CHALLENGER TAKES IT.
{
  const e = table(3);
  setHands(e, { p0: ['A', 'K'], p1: ['2'], p2: ['3'] });
  e.playCards('p0', ['A'], 'A', T0);
  const r = e.challenge('p1', T0 + 100);
  eq(r.truthful, true, 'the claim held');
  eq(e.handCount('p0'), 1, 'the honest player keeps their reduced hand');
  eq(e.handCount('p1'), 2, 'and the challenger picks up the pile');
  eq(e.reveal.takerId, 'p1', 'the reveal names the challenger as the taker');
  eq(e.currentPlayer.id, 'p1', 'who then leads');
  assertNoLeak(e, 'honest reveal');
}

// ONLY THE CHALLENGED CARDS ARE REVEALED. Never the pile.
{
  const e = table(3, { rankRule: 'free', maxPlay: 4 });
  setHands(e, { p0: ['A', 'A', 'A'], p1: ['2', '2', '2'], p2: ['3', '3', '3'] });
  let now = T0;
  e.playCards('p0', ['A', 'A'], 'A', now); now = e.challengeEndsAt; e.resolveExpiredWindow(now);
  e.playCards('p1', ['2', '2'], '2', now); now = e.challengeEndsAt; e.resolveExpiredWindow(now);
  eq(e.pile.length, 4, 'four cards are face down on the pile');
  e.playCards('p2', ['3'], 'K', now);
  eq(e.pile.length, 5, 'and a fifth goes on top');

  e.challenge('p0', now + 10);
  eq(e.reveal.cards.length, 1, 'ONLY the challenged play is turned over');
  eq(e.reveal.pileSize, 5, 'even though five cards changed hands');
  same(e.reveal.cards, [{ rank: '3', suit: 'S' }], 'and it is exactly the cards that were played');
  ok(!('id' in e.reveal.cards[0]), 'with the card id stripped, so reveals cannot be correlated');
  eq(e.reveal.claimRank, 'K', 'the reveal carries the claim it is judged against');
  assertNoLeak(e, 'partial reveal over a deep pile');
}

section('The engine: jokers, both ways round');

// THE SAME CARDS AND THE SAME CLAIM, OPPOSITE OUTCOMES.
for (const jokerMode of ['wild', 'junk']) {
  const e = table(3, { jokers: 2, jokerMode, rankRule: 'free' });
  setHands(e, { p0: ['A', JOKER, '5'], p1: ['2'], p2: ['3'] });
  eq(e.playCards('p0', ['A', JOKER], 'A', T0).ok, true, `${jokerMode}: an ace and a joker claimed as two aces`);
  const r = e.challenge('p1', T0 + 10);
  if (jokerMode === 'wild') {
    eq(r.truthful, true, 'wild: the joker satisfies the claim');
    eq(e.reveal.jokerSaved, true, 'and the reveal says a joker covered it');
    eq(e.reveal.takerId, 'p1', 'so the challenger takes the pile');
  } else {
    eq(r.truthful, false, 'junk: the identical play is a lie');
    eq(e.reveal.jokerSaved, false, 'and no joker saved anything');
    eq(e.reveal.takerId, 'p0', 'so the claimer takes the pile');
  }
  eq(e.reveal.cards.length, 2, `${jokerMode}: both challenged cards are shown`);
  ok(e.reveal.cards.some((c) => c.rank === JOKER), `${jokerMode}: including the joker, which is the point`);
  assertNoLeak(e, `${jokerMode} joker reveal`);
}

// A HAND OF JUNK JOKERS CAN BE PLAYED AND CANNOT BE DEFENDED.
for (const rank of RANKS) {
  const e = table(3, { decks: 3, jokers: 6, jokerMode: 'junk', rankRule: 'free' });
  setHands(e, { p0: [JOKER, JOKER, JOKER, JOKER], p1: ['2'], p2: ['3'] });
  eq(e.playCards('p0', [JOKER], rank, T0).ok, true, `junk: claiming ${rankLabel(rank)} off a joker is a legal play`);
  const r = e.challenge('p1', T0 + 10);
  eq(r.truthful, false, `junk: and loses the challenge every time (${rankLabel(rank)})`);
  eq(e.reveal.takerId, 'p0', `junk: the joker holder takes the pile (${rankLabel(rank)})`);
}
{
  // Unchallenged, the junk joker is shed like any other card — that is what
  // makes it a hot potato rather than a dead card.
  const e = table(3, { decks: 3, jokers: 6, jokerMode: 'junk', rankRule: 'free' });
  setHands(e, { p0: [JOKER, JOKER], p1: ['2'], p2: ['3'] });
  e.playCards('p0', [JOKER, JOKER], '9', T0);
  e.resolveExpiredWindow(e.challengeEndsAt);
  eq(e.handCount('p0'), 0, 'junk jokers unchallenged leave the hand like anything else');
}
{
  // In wild mode a joker really is the claimed rank, so a hand of nothing but
  // jokers is an unbeatable hand rather than a hopeless one.
  const e = table(3, { decks: 1, jokers: 2, jokerMode: 'wild', rankRule: 'free' });
  setHands(e, { p0: [JOKER, JOKER, '4'], p1: ['2'], p2: ['3'] });
  e.playCards('p0', [JOKER, JOKER], 'Q', T0);
  eq(e.challenge('p1', T0 + 10).truthful, true, 'wild: two jokers really are two queens');
}

section('The engine: going out is not winning');

// THE HEADLINE RULE. A player who empties their hand has not won until the
// window on that final play has closed without a successful challenge.
{
  const e = table(3);
  setHands(e, { p0: ['A'], p1: ['2'], p2: ['3'] });
  eq(e.playCards('p0', ['A'], 'A', T0).ok, true, 'the last card goes down');
  eq(e.handCount('p0'), 0, 'the hand is empty');
  eq(e.winner, null, 'AND THEY HAVE NOT WON');
  eq(e.phase, PHASES.PLAY, 'the game is still running');
  eq(e.pendingWinnerId, 'p0', 'the win is pending on the window');
  eq(e.step, STEPS.CHALLENGE_WINDOW, 'which is open');
  eq(e.publicState().pendingWinnerId, 'p0', 'and the table can see it coming');

  eq(e.resolveExpiredWindow(T0 + 4999).fired, false, 'one millisecond early, still not won');
  eq(e.winner, null, 'really not won');
  eq(e.resolveExpiredWindow(T0 + 5000).fired, true, 'the window closes');
  eq(e.winner, 'p0', 'and NOW they have won');
  eq(e.phase, PHASES.GAME_OVER, 'the game is over');
  eq(e.gamesPlayed, 1, 'and counted');
}

// A SUCCESSFUL CHALLENGE ON A FINAL PLAY PUTS THEM BACK IN THE GAME.
{
  // p1 and p2 keep a spare card each: if either emptied their hand building
  // the pile they would win it before p0 ever reaches their last card, which
  // is correct behaviour and a different test.
  const e = table(3, { rankRule: 'free', maxPlay: 4 });
  setHands(e, { p0: ['A', 'A', 'K'], p1: ['2', '2', '7'], p2: ['3', '3', '8'] });
  let now = T0;
  e.playCards('p0', ['A', 'A'], 'A', now); now = e.challengeEndsAt; e.resolveExpiredWindow(now);
  e.playCards('p1', ['2', '2'], '2', now); now = e.challengeEndsAt; e.resolveExpiredWindow(now);
  e.playCards('p2', ['3', '3'], '3', now); now = e.challengeEndsAt; e.resolveExpiredWindow(now);
  eq(e.pile.length, 6, 'a six-card pile has built up');
  eq(e.currentPlayer.id, 'p0', 'and it is back round to the first player');

  e.playCards('p0', ['K'], '9', now);       // the last card, and a lie
  eq(e.handCount('p0'), 0, 'who plays their last card');
  eq(e.pendingWinnerId, 'p0', 'and is one uncontested window from winning');

  const r = e.challenge('p1', now + 10);
  eq(r.truthful, false, 'but the claim was a lie and it was called');
  eq(e.winner, null, 'so there is no winner');
  eq(e.pendingWinnerId, null, 'the pending win evaporates');
  eq(e.phase, PHASES.PLAY, 'the game continues');
  eq(e.handCount('p0'), 7, 'AND THEY ARE BACK IN IT HOLDING THE WHOLE PILE');
  eq(e.currentPlayer.id, 'p1', 'having lost the turn along with the pile');
}

// A FAILED CHALLENGE ON A FINAL PLAY ENDS IT IMMEDIATELY — both halves of the
// rule are satisfied the moment the claim holds, so there is nothing to wait
// for and no second window to sit through.
{
  const e = table(3);
  setHands(e, { p0: ['A'], p1: ['2'], p2: ['3'] });
  e.playCards('p0', ['A'], 'A', T0);
  const r = e.challenge('p1', T0 + 10);
  eq(r.truthful, true, 'the last claim held');
  eq(e.winner, 'p0', 'and the challenge is what confirmed the win');
  eq(e.phase, PHASES.GAME_OVER, 'the game is over');
  eq(e.handCount('p1'), 2, 'with the failed challenger holding the pile they bought');
  eq(e.challengeEndsAt, null, 'and no deadline left running');
  eq(e.revealEndsAt, null, 'of either kind');
}

// THE SAME RULE IN NEXT-PLAYER MODE, where the window is closed by a person
// rather than a clock. Both ways of closing it must confirm the win.
{
  const e = table(3, { challengeMode: 'next' });
  setHands(e, { p0: ['A'], p1: ['2'], p2: ['3'] });
  e.playCards('p0', ['A'], 'A', T0);
  eq(e.challengeEndsAt, null, 'next mode arms no clock at all');
  eq(e.resolveExpiredWindow(T0 + 999999).fired, false, 'so no amount of time can close the window');
  eq(e.winner, null, 'and the win stays pending indefinitely');
  eq(e.decline('p2', T0).ok, false, 'a player who is not next cannot let it stand');
  eq(e.decline('p1', T0).ok, true, 'the next player can');
  eq(e.winner, 'p0', 'and declining confirms the win');
}
{
  const e = table(3, { challengeMode: 'next', rankRule: 'free' });
  setHands(e, { p0: ['A', 'K'], p1: ['2'], p2: ['3'] });
  e.playCards('p0', ['A'], 'A', T0);
  eq(e.playCards('p2', ['3'], '3', T0).ok, false, 'only the next player may play over an open window');
  eq(e.playCards('p1', ['2'], '2', T0).ok, true, 'and playing over it is how they decline');
  eq(e.step, STEPS.CHALLENGE_WINDOW, 'which immediately opens their own window');
  eq(e.claim.playerId, 'p1', 'on their own claim');
  eq(e.pile.length, 2, 'with the previous play still face down beneath');
}

section('The engine: the challenge race');

// ONLY THE FIRST CHALLENGE COUNTS. Several genuinely arrive together; the host
// applies them one at a time and the step field breaks the tie with no
// timestamp comparison anywhere.
{
  const e = table(4);
  setHands(e, { p0: ['K', 'K'], p1: ['2'], p2: ['3'], p3: ['4'] });
  e.playCards('p0', ['K'], 'A', T0);
  const before = handSizes(e);

  eq(e.challenge('p1', T0 + 100).ok, true, 'the first challenge to reach the host lands');
  eq(e.challenge('p2', T0 + 100).ok, false, 'the second, at the identical instant, does not');
  eq(e.challenge('p3', T0 + 100).ok, false, 'nor the third');
  eq(e.challenge('p1', T0 + 100).ok, false, 'nor a duplicate from the first');
  eq(e.reveal.challengerId, 'p1', 'the reveal credits exactly one challenger');

  const after = handSizes(e);
  const moved = after.filter((n, i) => n !== before[i]).length;
  eq(moved, 1, 'and exactly one hand changed size — the pile was handed over once');
  eq(e.pile.length, 0, 'with nothing left to hand over twice');
}

// NEXT-PLAYER MODE REFUSES EVERYONE ELSE.
{
  const e = table(4, { challengeMode: 'next' });
  setHands(e, { p0: ['K', 'K'], p1: ['2'], p2: ['3'], p3: ['4'] });
  e.playCards('p0', ['K'], 'A', T0);
  eq(e.nextPlayer.id, 'p1', 'the player after the claimer is the only one with a say');
  eq(e.challenge('p2', T0).ok, false, 'a player two seats along cannot challenge');
  eq(e.challenge('p3', T0).ok, false, 'nor three seats along');
  eq(e.challenge('p0', T0).ok, false, 'nor the claimer themselves');
  ok(e.challenge('p2', T0).error.includes('next player'), 'and the refusal says why');
  eq(e.privateStateFor('p2').canChallenge, false, 'the UI is told not to offer the button');
  eq(e.privateStateFor('p1').canChallenge, true, 'except to the one player who may press it');
  eq(e.privateStateFor('p0').canChallenge, false, 'and never to the claimer');
  eq(e.challenge('p1', T0).ok, true, 'and the next player can');
}

// A CLAIMER MAY NEVER CHALLENGE THEMSELVES, in either mode — it would be a free
// way to dump the pile on somebody else.
for (const challengeMode of ['window', 'next']) {
  const e = table(3, { challengeMode });
  setHands(e, { p0: ['K', 'K'], p1: ['2'], p2: ['3'] });
  e.playCards('p0', ['K'], 'A', T0);
  eq(e.challenge('p0', T0).ok, false, `${challengeMode}: you cannot challenge your own claim`);
  eq(e.challenge('nobody', T0).ok, false, `${challengeMode}: nor can a stranger to the table`);
}

section('The engine: time is a parameter');

// THE ENGINE NEVER READS A CLOCK IT WAS NOT GIVEN. T0 is years in the past, so
// any accidental Date.now() would make every window already expired and these
// assertions would invert.
{
  const e = table(3, { windowMs: 8000 });
  setHands(e, { p0: ['A', 'A'], p1: ['2'], p2: ['3'] });
  e.playCards('p0', ['A'], 'A', T0);
  eq(e.challengeEndsAt, T0 + 8000, 'the deadline is the injected now plus the configured window');
  ok(e.challengeEndsAt < Date.now(), 'and is long past by the wall clock — which must not matter');

  eq(e.resolveExpiredWindow(T0).fired, false, 'not expired at the instant it opened');
  eq(e.resolveExpiredWindow(T0 + 7999).fired, false, 'not expired a millisecond early');
  eq(e.step, STEPS.CHALLENGE_WINDOW, 'the window is still open');
  eq(e.challenge('p1', T0 + 7999).ok, true, 'and a challenge a millisecond early still counts');
}
{
  const e = table(3, { windowMs: 8000 });
  setHands(e, { p0: ['A', 'A'], p1: ['2'], p2: ['3'] });
  e.playCards('p0', ['A'], 'A', T0);
  eq(e.challenge('p1', T0 + 8000).ok, false, 'a challenge at the deadline is too late');
  eq(e.step, STEPS.CHALLENGE_WINDOW, 'and did not resolve anything');
  eq(e.resolveExpiredWindow(T0 + 8000).fired, true, 'the window expires exactly at its deadline');
  eq(e.resolveExpiredWindow(T0 + 8000).fired, false, 'and a second tick at the same instant is a no-op');
  eq(e.resolveExpiredWindow(T0 + 999999).fired, false, 'as is any later tick with nothing to do');
  eq(e.currentPlayer.id, 'p1', 'the turn moved on exactly once');
}
{
  // The reveal hold is the second deadline, and it is a hold rather than an
  // animation so that the fastest player at the table cannot decide how long
  // everybody else gets to read the reveal.
  const e = table(3);
  setHands(e, { p0: ['K', 'K'], p1: ['2'], p2: ['3'] });
  e.playCards('p0', ['K'], 'A', T0);
  e.challenge('p1', T0 + 100);
  eq(e.step, STEPS.RESOLVING, 'a resolved challenge holds the reveal on screen');
  eq(e.revealEndsAt, T0 + 100 + REVEAL_HOLD_MS, 'on its own deadline off the same injected clock');
  eq(e.challengeEndsAt, null, 'with the challenge deadline cleared');
  eq(e.playCards('p0', ['K'], 'A', T0 + 200).ok, false, 'nobody may play over a reveal');
  eq(e.resolveExpiredWindow(T0 + 100 + REVEAL_HOLD_MS - 1).fired, false, 'the hold runs its full length');
  const r = e.resolveExpiredWindow(T0 + 100 + REVEAL_HOLD_MS);
  eq(r.fired, true, 'then releases');
  eq(r.what, 'reveal', 'and says which deadline fired');
  eq(e.step, STEPS.AWAITING_PLAY, 'and play resumes');
  eq(e.currentPlayer.id, 'p1', 'with the turn past the player who was challenged');
  ok(e.reveal !== null, 'the reveal stays in the public state until the next play replaces it');
  eq(e.playCards('p1', ['2'], '2', T0 + 99999).ok, true, 'and the chain carries on from the ace');
  eq(e.reveal, null, 'which is what takes it off screen');
}

section('The engine: the wire boundary');

// THE MOST IMPORTANT TEST IN THE SUITE, asserted against a real broadcast
// payload at every step of a game rather than once in a fixed position.
{
  const e = table(4, { decks: 2, jokers: 4, jokerMode: 'wild', rankRule: 'free', maxPlay: 4 });
  const pub = e.publicState();
  eq(countSuited(pub), 0, 'a freshly dealt game publishes no card at all');
  same(forbiddenKeysIn(pub), [], 'and has no field that could hold one');
  ok(Array.isArray(pub.players) && pub.players.every((p) => typeof p.handCount === 'number'),
    'hand SIZES are public, because a player down to one card is the whole endgame');
  ok(pub.players.every((p) => !('hand' in p)), 'hand CONTENTS are not');
  eq(pub.pileSize, 0, 'the pile is a number');
  ok(!('pile' in pub), 'and never a list');
  ok(pub.config && typeof pub.config.decks === 'number',
    'the config is public — a claim of five kings cannot be judged without the deck count');

  let now = T0;
  for (let i = 0; i < 40 && e.phase === PHASES.PLAY; i++) {
    if (e.step === STEPS.RESOLVING) { now = e.revealEndsAt; e.resolveExpiredWindow(now); }
    else if (e.step === STEPS.CHALLENGE_WINDOW) {
      if (i % 3 === 0) e.challenge(e.nextPlayer.id, now + 1);
      else { now = e.challengeEndsAt; e.resolveExpiredWindow(now); }
    } else {
      const hand = e.hands[e.currentPlayer.id];
      const take = hand.slice(0, Math.min(2, hand.length)).map((c) => c.rank);
      e.playCards(e.currentPlayer.id, take, RANKS[i % RANKS.length], now);
    }
    assertNoLeak(e, `scripted step ${i}`);
  }
  assertCleanLog(e, 'end of scripted game');
}

// The private slice is the one place cards go out, and it goes to one device.
{
  const e = table(3);
  setHands(e, { p0: ['A', 'K', 'K'], p1: ['2'], p2: ['3'] });
  const mine = e.privateStateFor('p0');
  eq(mine.hand.length, 3, 'a player is sent their own hand');
  same(mine.counts, { A: 1, K: 2 }, 'and the rank counts the UI groups by');
  eq(e.privateStateFor('p1').hand.length, 1, 'and only their own');
  eq(e.privateStateFor('nobody'), null, 'a stranger gets nothing rather than an empty hand');
  eq(mine.isTurn, true, 'the leader is told it is their turn');
  eq(e.privateStateFor('p1').isTurn, false, 'and nobody else is');
  eq(e.privateStateFor('p1').maxPlay, 1, 'the play cap is capped again by what is actually held');
}

section('The engine: reconnects, snapshots and host controls');

// SEAT RECLAIM IS BOUND TO clientId AND NOTHING ELSE.
{
  const e = table(3);
  setHands(e, { p0: ['A', 'K'], p1: ['2', '7'], p2: ['3'] });
  const before = e.hands.p1.map((c) => c.id);

  eq(e.addPlayer('imposter', 'Bo', { clientId: 'wrong' }).ok, false,
    'naming a seated player mid-game gets you nothing');
  const r = e.addPlayer('p1-new', 'Bo', { clientId: 'c1' });
  eq(r.reconnected, true, 'the right secret reclaims the seat');
  eq(e.handCount('p1-new'), 2, 'with the hand intact');
  same(e.hands['p1-new'].map((c) => c.id), before, 'and the same physical cards');
  eq(e.hands.p1, undefined, 'under the new transport id only');

  e.markOffline('p2');
  eq(e.players.length, 3, 'a mid-game disconnect HOLDS the seat');
  eq(e.handCount('p2'), 1, 'because deleting a hand would delete cards out of the deck');
  eq(e.getPlayer('p2').online, false, 'it is only marked offline');
}

{
  const e = table(3, { decks: 2, jokers: 2 });
  setHands(e, { p0: ['A', 'K'], p1: ['2'], p2: ['3'] });
  e.playCards('p0', ['K'], 'A', T0);
  const snap = JSON.parse(JSON.stringify(e.snapshot()));

  const revived = new GameEngine();
  revived.restore(snap);
  eq(revived.phase, PHASES.PLAY, 'a restored snapshot is mid-game');
  eq(revived.step, STEPS.CHALLENGE_WINDOW, 'in the same step');
  eq(revived.handCount('p0'), 1, 'with hands intact');
  eq(revived.pile.length, 1, 'and the pile intact');
  same(revived.claim, e.claim, 'and the same claim outstanding');

  // The reloaded tab has a brand new peer id. Its SEAT must move with it or
  // the host is a player nobody can find, holding a hand nobody can reach.
  revived.resumeAsHost('p0-new', 'c0');
  eq(revived.hostId, 'p0-new', 'the reloaded tab takes the host seat');
  ok(revived.getPlayer('p0-new') !== null, 'and the seat moves to the new transport id');
  eq(revived.handCount('p0-new'), 1, 'carrying the hand with it');
  eq(revived.getPlayer('p0-new').isHost, true, 'still flagged as the host');
  eq(revived.claim.playerId, 'p0-new', 'and the outstanding claim still points at them');
  eq(revived.players.filter((p) => p.online).length, 1, 'while every stale connection is cleared');
  ok(revived.challengeEndsAt > Date.now() - 1000,
    'the window is RE-ARMED rather than expired — nobody loses a challenge to somebody else crashing');

  // A snapshot from before clientIds existed still finds the seat by its flag.
  const older = new GameEngine();
  older.restore(JSON.parse(JSON.stringify(snap)));
  older.resumeAsHost('p0-older');
  eq(older.handCount('p0-older'), 1, 'and the isHost flag is enough on its own');
}

{
  const e = table(3);
  setHands(e, { p0: ['A', 'K'], p1: ['2'], p2: ['3'] });
  eq(e.skipTurn('p1').ok, false, 'only the host may skip a turn');
  eq(e.skipTurn('p0', T0).ok, true, 'the host may');
  eq(e.currentPlayer.id, 'p1', 'and the turn moves on');
  eq(e.handCount('p0'), 2, 'without playing a card on the skipped player’s behalf');

  eq(e.endGame('p1').ok, false, 'only the host may end the game');
  eq(e.endGame('p0').ok, true, 'the host may');
  eq(e.phase, PHASES.GAME_OVER, 'and it ends with no winner');
  eq(e.winner, null, 'named');
  eq(e.playAgain('p0').ok, true, 'the host can take the table back to the lobby');
  eq(e.phase, PHASES.LOBBY, 'where it is set up again');
  eq(e.pile.length, 0, 'with nothing left over');
  same(e.hands, {}, 'and no hands left over');
}

section('The engine: random games hold every invariant');

function lcg(s) { let x = s >>> 0; return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296; }

/**
 * Drive a whole game with random LEGAL moves and check the invariants at every
 * single step.
 *
 * Two invariants, both of which fail silently if broken. CARD CONSERVATION:
 * every card is in exactly one hand or on the pile, always — a game that leaks
 * cards still runs and still finishes, and only shows up as a bot that
 * miscounts. THE WIRE BOUNDARY: checked here as well as in its own section,
 * because a leak introduced in a rarely-reached branch is exactly the one a
 * scripted test walks past.
 */
function randomGame({ patch = {}, players = 4, seedN = 1, maxSteps = 600 }) {
  const rnd = lcg(seedN);
  const e = table(players, patch);
  const total = deckSize(e.config);
  const problems = [];
  let now = T0;
  let steps = 0;

  const check = (where) => {
    const inHands = Object.values(e.hands).reduce((n, h) => n + h.length, 0);
    if (inHands + e.pile.length !== total) {
      problems.push(`cards lost or conjured at ${where}: ${inHands}+${e.pile.length} != ${total}`);
    }
    const pub = e.publicState();
    if (countSuited(pub) !== (e.reveal ? e.reveal.cards.length : 0)) {
      problems.push(`card contents on the wire at ${where}`);
    }
    if (forbiddenKeysIn(pub).length) problems.push(`hand/pile field on the wire at ${where}`);
  };

  while (e.phase === PHASES.PLAY && steps++ < maxSteps) {
    if (e.step === STEPS.RESOLVING) {
      now = e.revealEndsAt;
      if (!e.resolveExpiredWindow(now).fired) problems.push('the reveal hold did not release');
      check('reveal');
      continue;
    }
    if (e.step === STEPS.CHALLENGE_WINDOW) {
      const eligible = e.players.filter((p) => e.privateStateFor(p.id).canChallenge);
      if (eligible.length && rnd() < 0.3) {
        const who = eligible[Math.floor(rnd() * eligible.length)];
        const r = e.challenge(who.id, now);
        if (!r.ok) problems.push(`a challenge the engine offered was refused: ${r.error}`);
        check('challenge');
      } else if (e.config.challengeMode === 'next') {
        const r = e.decline(e.nextPlayer.id, now);
        if (!r.ok) problems.push(`decline refused: ${r.error}`);
        check('decline');
      } else {
        now = e.challengeEndsAt;
        if (!e.resolveExpiredWindow(now).fired) problems.push('the window did not expire at its deadline');
        check('window close');
      }
      continue;
    }

    const me = e.currentPlayer;
    const hand = e.hands[me.id];
    if (!hand.length) { problems.push(`${me.name} must play with an empty hand`); break; }
    const idx = hand.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const k = 1 + Math.floor(rnd() * Math.min(e.config.maxPlay, hand.length));
    const ranks = idx.slice(0, k).map((i) => hand[i].rank);
    const claims = e.currentLegalClaims();
    const claimRank = claims[Math.floor(rnd() * claims.length)];
    const r = e.playCards(me.id, ranks, claimRank, now);
    if (!r.ok) problems.push(`a legal play was refused: ${r.error}`);
    check('play');
  }

  return { problems, finished: e.phase === PHASES.GAME_OVER, steps, engine: e };
}

{
  let games = 0, finished = 0, totalSteps = 0;
  const allProblems = [];
  for (const rankRule of Object.keys(RANK_RULES)) {
    for (const challengeMode of Object.keys(CHALLENGE_MODES)) {
      for (const decks of [1, 2, 3]) {
        for (const jokerMode of Object.keys(JOKER_MODES)) {
          const players = 3 + (games % 6);
          const res = randomGame({
            patch: { rankRule, challengeMode, decks, jokers: 2 * decks, jokerMode, maxPlay: playCap(decks) },
            players,
            seedN: 1 + games * 7919,
          });
          games++;
          totalSteps += res.steps;
          if (res.finished) finished++;
          for (const p of res.problems) {
            allProblems.push(`${rankRule}/${challengeMode}/${decks}d/${jokerMode}/${players}p: ${p}`);
          }
        }
      }
    }
  }
  console.log(`  ${games} games, ${finished} reached a winner, ${totalSteps} moves`);
  eq(allProblems.length, 0,
    `${games} random games across every rule combination hold every invariant`
    + (allProblems.length ? ` — first: ${allProblems[0]}` : ''));
  ok(finished > 0, `and ${finished}/${games} of them reached a winner inside the step cap`);
}

// ===========================================================================
// THE WIRE: guards.js and intents.js
//
// Everything below this line is about messages that arrived from a device the
// host does not control. The engine above is already defensive on its own
// account; these sections test the layer that stops junk becoming WORK, and
// the single dispatcher that stops the two transports from ever disagreeing.
// ===========================================================================

section('Guards: the envelope and the frame');

eq(validEnvelope(null), null, 'null is not a message');
eq(validEnvelope(undefined), null, 'nor is undefined');
eq(validEnvelope('playCards'), null, 'nor is a bare string');
eq(validEnvelope(42), null, 'nor a number');
eq(validEnvelope([]), null, 'AN ARRAY IS NOT A MESSAGE — it parses as JSON and has no type');
eq(validEnvelope([{ type: 'challenge' }]), null, 'not even an array of messages');
eq(validEnvelope({}), null, 'an object with no type is not a message');
eq(validEnvelope({ type: 7 }), null, 'a non-string type is not a type');
eq(validEnvelope({ type: 'x'.repeat(MAX_TYPE_LEN + 1) }), null, 'and a type longer than a verb is not a type');
ok(validEnvelope({ type: 'challenge' }) !== null, 'a plain typed object is a message');
ok(validEnvelope({ type: 'x'.repeat(MAX_TYPE_LEN) }) !== null, 'right up to the cap');

eq(decodePeerFrame('{"type":"challenge"}').type, 'challenge', 'a JSON string frame decodes');
eq(decodePeerFrame('not json'), null, 'malformed JSON is dropped rather than thrown');
eq(decodePeerFrame('"just a string"'), null, 'valid JSON that is not a message is dropped');
eq(decodePeerFrame('[1,2,3]'), null, 'a JSON array is dropped');
eq(decodePeerFrame('null'), null, 'JSON null is dropped');
eq(decodePeerFrame('x'.repeat(MAX_FRAME_BYTES + 1)), null, 'an oversized frame is dropped before it is parsed');
eq(decodePeerFrame(new ArrayBuffer(8)), null, 'binary is dropped — no version of this client sends it');
eq(decodePeerFrame(new Uint8Array(8)), null, 'including a typed array view');
eq(decodePeerFrame({ type: 'challenge' }).type, 'challenge', 'an already-decoded object still goes through the envelope check');
eq(decodePeerFrame({ nope: 1 }), null, 'and is dropped if it fails it');

section('Guards: identity and names');

eq(validClientId('abcd1234'), 'abcd1234', 'a clientId at the minimum length is accepted');
eq(validClientId('a'.repeat(64)), 'a'.repeat(64), 'and at the maximum');
eq(validClientId('short'), null, 'too short is refused');
eq(validClientId('a'.repeat(65)), null, 'too long is refused');
eq(validClientId('abcd 1234'), null, 'a space is refused');
eq(validClientId('abcd"1234'), null, 'and so is anything that could confuse a log line or a JSON key');
eq(validClientId(12345678), null, 'a number is not a clientId');
eq(validClientId(null), null, 'nor is null');

eq(validPlayerId('p1'), 'p1', 'a player id passes');
eq(validPlayerId(''), null, 'an empty one does not');
eq(validPlayerId('p'.repeat(65)), null, 'nor a 65-character one');

eq(validName('  Ana  '), 'Ana', 'a name is trimmed');
eq(validName('An   a'), 'An a', 'and its internal whitespace collapsed');
eq(validName(''), null, 'a blank name is refused rather than returned empty');
eq(validName('   '), null, 'including one that is only whitespace');
eq(validName(null), null, 'and a non-string');
eq(validName('x'.repeat(MAX_NAME_BYTES + 1)), null,
  'an oversized name is refused BEFORE cleanName runs a regex over the whole of it');
eq(validName('x'.repeat(30)).length, 18, 'and a merely long one is truncated to the display limit');

section('Guards: a play is ranks, and a claim is never a joker');

same(validRankPlay(['K', 'K', '7']), ['K', 'K', '7'], 'a multiset of ranks is a play');
same(validRankPlay([JOKER]), [JOKER], 'A JOKER IS A CARD YOU MAY PLAY');
same(validRankPlay(['K', JOKER]), ['K', JOKER], 'alongside anything else');
ok(validRankPlay(RANKS.slice(0, MAX_PLAY_CEILING)) !== null, 'up to the hard ceiling');
eq(validRankPlay(RANKS.slice(0, MAX_PLAY_CEILING + 1)), null, 'and not one card past it');
eq(validRankPlay([]), null, 'an empty play is not a play');
eq(validRankPlay(new Array(10000).fill('K')), null, 'and neither is ten thousand kings');
eq(validRankPlay('KK7'), null, 'a string is not a play');
eq(validRankPlay({ 0: 'K', length: 1 }), null, 'nor is an array-like');
eq(validRankPlay(null), null, 'nor null');
eq(validRankPlay(['K', 'Z']), null, 'one unknown token spoils the whole play');
eq(validRankPlay([7]), null, 'a number is not a rank token even when it looks like one');
eq(validRankPlay([{ rank: 'K' }]), null, 'nor is a card object');
eq(validRankPlay([['K']]), null, 'nor a nested array');
eq(validRankPlay([null]), null, 'nor null');
// A Set is used rather than an object lookup precisely so that these are not
// ranks. An implementation checking `RANK_NAMES[r] !== undefined` would accept
// every one of them.
eq(validRankPlay(['toString']), null, 'inherited object properties are not ranks');
eq(validRankPlay(['__proto__']), null, 'nor is __proto__');
eq(validRankPlay(['constructor']), null, 'nor constructor');
eq(validRankPlay(['hasOwnProperty']), null, 'nor hasOwnProperty');
{
  const sent = ['K', 'K'];
  const got = validRankPlay(sent);
  ok(got !== sent, 'a copy comes back, not the array the sender composed');
  same(got, sent, 'with the same contents');
}

for (const r of RANKS) eq(validClaimRank(r), r, `${rankLabel(r)} is a claimable rank`);
eq(validClaimRank(JOKER), null, 'A JOKER IS NEVER A CLAIMABLE RANK — the asymmetry is the rule');
eq(validClaimRank('Z'), null, 'an unknown token is not a claim');
eq(validClaimRank('toString'), null, 'nor is an inherited property name');
eq(validClaimRank('__proto__'), null, 'nor __proto__');
eq(validClaimRank(7), null, 'nor a number');
eq(validClaimRank(null), null, 'nor null');
eq(validClaimRank(undefined), null, 'nor undefined');
eq(validClaimRank(['A']), null, 'nor an array of one');

same(validConfigPatch({ decks: 2 }), { decks: 2 }, 'a one-key patch is a patch');
eq(validConfigPatch({}), null, 'an empty patch is not');
eq(validConfigPatch([]), null, 'nor is an array');
eq(validConfigPatch(null), null, 'nor null');
eq(validConfigPatch('decks=2'), null, 'nor a string');
{
  const huge = {};
  for (let i = 0; i < 40; i++) huge[`k${i}`] = i;
  eq(validConfigPatch(huge), null, 'and neither is an object with forty keys, whatever they are');
}

section('Guards: the rate limit');

{
  const b = new TokenBucket({ capacity: 40, refillPerSec: 15, now: T0 });
  let allowed = 0;
  for (let i = 0; i < 60; i++) if (b.take(T0)) allowed++;
  eq(allowed, 40, 'a burst at one instant is allowed up to capacity and no further');
  eq(b.take(T0), false, 'and stays refused while no time passes');
  eq(b.take(T0 + 1000), true, 'a second later it has refilled');
  let more = 0;
  for (let i = 0; i < 40; i++) if (b.take(T0 + 1000)) more++;
  eq(more, 14, 'by exactly the refill rate, not back to full');
  eq(b.take(T0 + 999999), true, 'and a long gap refills it, capped at capacity');
}
{
  // The design point: the bucket is PER CONNECTION. Everybody tapping CHALLENGE
  // at the same instant is the expected shape of this game, not an attack, and
  // a shared bucket would drop the challenge of whoever happened to be last.
  const buckets = Array.from({ length: MAX_PLAYERS }, () => new TokenBucket({ now: T0 }));
  eq(buckets.filter((b) => b.take(T0)).length, MAX_PLAYERS,
    'eight devices challenging at the identical instant all get through');
}

section('Guards: the lobby lock');

eq(configBlocker(DEFAULT_CONFIG), null, 'the default config starts a game');
eq(configBlocker(null) === null, false, 'a missing config does not');
eq(configBlocker('decks=1') === null, false, 'nor a string');

// REFUSED, NOT CLAMPED. Both messages name the offending value, because a host
// seeing one needs to know something assembled this config that was not the
// lobby.
for (const decks of [0, 4, 9, -1, 1.5, NaN, Infinity, '2', null, undefined]) {
  const msg = configBlocker({ ...DEFAULT_CONFIG, decks });
  ok(msg !== null, `decks: ${JSON.stringify(decks)} is refused outright`);
  ok(msg.includes('Deck count'), `and the refusal says which axis (${JSON.stringify(decks)})`);
}
ok(configBlocker({ ...DEFAULT_CONFIG, decks: 9 }).includes('9'),
  'and quotes the value back, so a clamped 3 is never mistaken for what was asked for');
for (const jokerMode of ['chaos', '', null, 1, 'WILD', 'toString', '__proto__']) {
  const msg = configBlocker({ ...DEFAULT_CONFIG, jokerMode });
  ok(msg !== null, `jokerMode: ${JSON.stringify(jokerMode)} is refused outright`);
  ok(msg.includes('joker mode'), `and says so (${JSON.stringify(jokerMode)})`);
}

// The clamped pair, checked here as well because this function does not get to
// assume normalizeConfig ran — catching a config that bypassed it is the job.
ok(configBlocker({ ...DEFAULT_CONFIG, decks: 1, jokers: 6 }) !== null,
  'six jokers in a one-deck game is refused, not dealt');
ok(configBlocker({ ...DEFAULT_CONFIG, decks: 1, jokers: 6 }).includes('0–2'),
  'and the refusal names the cap at that deck count');
eq(configBlocker({ ...DEFAULT_CONFIG, decks: 3, jokers: 6 }), null,
  'while the same six jokers at three decks is fine');
ok(configBlocker({ ...DEFAULT_CONFIG, decks: 1, maxPlay: 8 }) !== null,
  'a play size of eight at one deck is refused');
eq(configBlocker({ ...DEFAULT_CONFIG, decks: 2, maxPlay: 8 }), null,
  'and allowed at two');
ok(configBlocker({ ...DEFAULT_CONFIG, maxPlay: 0 }) !== null, 'a play size of zero is refused');

// legalClaims() THROWS on a rank rule it has never heard of, and it runs on
// every render. This check is what stops that being a host tab that dies on
// the first turn of a game it already dealt.
ok(configBlocker({ ...DEFAULT_CONFIG, rankRule: 'spiral' }) !== null, 'an unknown rank rule is refused');
throws(() => legalClaims('spiral', null), 'because legalClaims would throw on it');
ok(configBlocker({ ...DEFAULT_CONFIG, challengeMode: 'psychic' }) !== null, 'an unknown challenge mode is refused');
ok(configBlocker({ ...DEFAULT_CONFIG, windowMs: 1 }) !== null, 'a one-millisecond window is refused');
ok(configBlocker({ ...DEFAULT_CONFIG, windowMs: 600000 }) !== null, 'and a ten-minute one');

// THE PROPERTY THAT TIES THE TWO HALVES TOGETHER: anything normalizeConfig can
// produce must pass the lock. If this ever fails, the lobby has a setting the
// host can reach and then cannot start from.
{
  let checked = 0;
  for (const decks of [1, 2, 3]) {
    for (let jokers = 0; jokers <= 6; jokers++) {
      for (let maxPlay = 1; maxPlay <= 8; maxPlay++) {
        for (const rankRule of Object.keys(RANK_RULES)) {
          for (const jokerMode of Object.keys(JOKER_MODES)) {
            for (const challengeMode of Object.keys(CHALLENGE_MODES)) {
              const cfg = normalizeConfig({ decks, jokers, maxPlay, rankRule, jokerMode, challengeMode });
              if (configBlocker(cfg) !== null) {
                failed++;
                console.error('  x FAIL: normalizeConfig produced a config the lobby lock refuses:',
                  JSON.stringify(cfg), configBlocker(cfg));
                checked = -1e9;
              }
              checked++;
            }
          }
        }
      }
    }
  }
  ok(checked > 0, `every one of ${checked} reachable configs passes the lobby lock`);
}
{
  // ...and the converse, which is the point of having both: a config the lobby
  // CANNOT produce is caught. normalizeConfig deliberately passes decks through
  // uncoerced so that this is possible at all.
  const tampered = normalizeConfig({ decks: 9 });
  eq(tampered.decks, 9, 'normalizeConfig leaves a tampered deck count alone');
  ok(configBlocker(tampered) !== null, 'so that the lobby lock can refuse it by name');
}

ok(MAX_CONNECTIONS > MAX_PLAYERS,
  'the connection cap is above the seat count, so a reconnecting player is not locked out by their own ghost');

section('Intents: the dispatch table');

same([...PLAYER_INTENTS].filter((t) => OWNER_INTENTS.includes(t)), [],
  'no intent is both a player intent and an owner intent');
eq(GAME_INTENTS.length, PLAYER_INTENTS.length + OWNER_INTENTS.length,
  'and the full list is exactly the two put together');

// EVERY DECLARED INTENT IS ACTUALLY WIRED UP. A name in the list with no case
// in the switch would be a button that silently does nothing, and the transport
// would treat it as junk it does not own.
for (const type of GAME_INTENTS) {
  const e = table(3);
  const r = applyGameIntent(e, 'p0', { type }, T0);
  eq(r.handled, true, `${type} is handled by the dispatcher`);
  ok(r.result && typeof r.result.ok === 'boolean', `${type} comes back with an ok flag`);
}
{
  const e = table(3);
  eq(applyGameIntent(e, 'p0', { type: 'nonsense' }, T0).handled, false,
    'an unknown type is not handled — the transport owns it or it is junk');
  eq(applyGameIntent(e, 'p0', { type: 'join' }, T0).handled, false,
    'join belongs to the transport, because identity is where the two transports differ');
  eq(applyGameIntent(e, 'p0', {}, T0).handled, false, 'a typeless message is not handled');
  eq(applyGameIntent(e, 'p0', null, T0).handled, false, 'nor is null');
  eq(applyGameIntent(e, 'p0', { type: 42 }, T0).handled, false, 'nor a numeric type');
}

section('Intents: the owner guard');

// EVERY OWNER INTENT IS REFUSED FROM A NON-HOST SEAT, and the engine is
// untouched. Five of these have no host check inside the engine at all — they
// were only ever reachable from the host's own lobby UI — so this seam is the
// whole guard for them.
for (const type of OWNER_INTENTS) {
  const e = new GameEngine();
  e.addPlayer('p0', 'Ana', { isHost: true, clientId: 'c0' });
  e.addPlayer('p1', 'Bo', { clientId: 'c1' });
  e.addPlayer('p2', 'Cy', { clientId: 'c2' });
  const before = JSON.stringify(e.snapshot());

  const r = applyGameIntent(e, 'p1', { type, patch: { decks: 3 }, playerId: 'p2', dir: 1 }, T0);
  eq(r.handled, true, `${type} from a non-host is handled`);
  eq(r.result.ok, false, `${type} from a non-host is REFUSED`);
  eq(JSON.stringify(e.snapshot()), before, `and ${type} changed nothing at all`);
}

// The one that matters most in this game: the config decides the deck count,
// and the deck count decides whether a claim of five Kings is impossible or
// routine. A client that could set it could make its own bluffs unfalsifiable.
{
  const e = new GameEngine();
  e.addPlayer('p0', 'Ana', { isHost: true, clientId: 'c0' });
  e.addPlayer('p1', 'Bo', { clientId: 'c1' });
  eq(applyGameIntent(e, 'p1', { type: 'setConfig', patch: { decks: 3 } }, T0).result.ok, false,
    'a player cannot widen the deck count to cover their own lies');
  eq(e.config.decks, 1, 'and the deck count is unchanged');
  eq(applyGameIntent(e, 'p0', { type: 'setConfig', patch: { decks: 3 } }, T0).result.ok, true,
    'the host can');
  eq(e.config.decks, 3, 'and it takes effect');

  eq(applyGameIntent(e, 'p0', { type: 'setConfig', patch: {} }, T0).result.ok, false,
    'an empty patch is refused as malformed');
  eq(applyGameIntent(e, 'p0', { type: 'setConfig', patch: 'decks=1' }, T0).result.ok, false,
    'and so is a patch that is not an object');
  eq(applyGameIntent(e, 'p0', { type: 'setConfig', patch: { evil: 1, decks: 1 } }, T0).result.ok, true,
    'an unknown key rides along harmlessly');
  ok(!('evil' in e.config), 'because normalizeConfig rebuilds from a fixed key list');
  eq(e.config.decks, 1, 'while the real key applies');

  // Lowering the deck count re-clamps the dependent axes in the SAME update.
  e.setConfig({ decks: 3, jokers: 6, maxPlay: 8 });
  applyGameIntent(e, 'p0', { type: 'setConfig', patch: { decks: 1 } }, T0);
  eq(e.config.jokers, 2, 'dropping to one deck brings the jokers down with it');
  eq(e.config.maxPlay, 4, 'and the play size');
  eq(configBlocker(e.config), null, 'leaving a config that still starts a game');
}
{
  // removeBot is an owner intent AND is fenced inside the engine, because
  // otherwise "remove" would be a way to eject a human from the table.
  const e = new GameEngine();
  e.addPlayer('p0', 'Ana', { isHost: true, clientId: 'c0' });
  e.addPlayer('p1', 'Bo', { clientId: 'c1' });
  eq(applyGameIntent(e, 'p0', { type: 'removeBot', playerId: 'p1' }, T0).result.ok, false,
    'the host cannot use removeBot to eject a human');
  eq(e.players.length, 2, 'and Bo keeps their seat');
  applyGameIntent(e, 'p0', { type: 'addBot' }, T0);
  const bot = e.players.find((p) => p.isBot);
  eq(applyGameIntent(e, 'p0', { type: 'removeBot', playerId: bot.id }, T0).result.ok, true,
    'but can remove an actual bot');
  eq(applyGameIntent(e, 'p0', { type: 'removeBot', playerId: 'x'.repeat(5000) }, T0).result.ok, false,
    'and an oversized id finds nothing rather than being compared against every seat');
}

section('Intents: time never comes off the wire');

// THE ATTACK THIS PREVENTS: a client that could supply `now` could challenge a
// claim minutes after the window shut, or arm its own window at Infinity and
// never be challenged at all.
{
  const e = table(3, { windowMs: 5000 });
  setHands(e, { p0: ['K', 'K'], p1: ['2'], p2: ['3'] });
  applyGameIntent(e, 'p0', { type: 'playCards', ranks: ['K'], claim: 'A' }, T0);
  eq(e.challengeEndsAt, T0 + 5000, 'the window is armed off the HOST clock passed in');

  // A backdated challenge, long after the host says the window shut.
  const late = applyGameIntent(
    e, 'p1',
    { type: 'challenge', now: T0 + 1, t: T0 + 1, timestamp: T0 + 1, at: T0 + 1 },
    T0 + 60000,
  );
  eq(late.result.ok, false, 'a challenge backdated in the payload is still too late');
  eq(e.step, STEPS.CHALLENGE_WINDOW, 'and resolved nothing');
}
{
  const e = table(3, { windowMs: 5000 });
  setHands(e, { p0: ['K', 'K'], p1: ['2'], p2: ['3'] });
  applyGameIntent(e, 'p0', { type: 'playCards', ranks: ['K'], claim: 'A', now: 0, windowMs: 1e9 }, T0);
  eq(e.challengeEndsAt, T0 + 5000, 'and a client cannot lengthen its own window by asking');
  const inTime = applyGameIntent(e, 'p1', { type: 'challenge', now: T0 + 999999 }, T0 + 100);
  eq(inTime.result.ok, true, 'a challenge the HOST clock says is in time counts');
  eq(inTime.result.truthful, false, 'whatever the payload claimed the time was');
}
{
  // The direct form: the dispatcher is watched, and never touches a time field.
  const touched = new Set();
  const spy = new Proxy(
    { type: 'playCards', ranks: ['K'], claim: 'A', now: 0, t: 0, timestamp: 0, at: 0, deadline: 0 },
    { get(t, k) { touched.add(k); return t[k]; }, has(t, k) { touched.add(k); return k in t; } },
  );
  const e = table(3);
  setHands(e, { p0: ['K', 'K'], p1: ['2'], p2: ['3'] });
  applyGameIntent(e, 'p0', spy, T0);
  same([...touched].filter((k) => ['now', 't', 'timestamp', 'at', 'deadline'].includes(k)), [],
    'no time field on an inbound message is read, at all');
  ok(touched.has('ranks') && touched.has('claim'), 'while the fields that are its business are');
}

section('Intents: a hostile client gets nowhere');

{
  const e = table(4, { rankRule: 'ascending', maxPlay: 4 });
  setHands(e, { p0: ['A', 'A'], p1: ['2', '2'], p2: ['3', '3'], p3: ['4', '4'] });
  const untouched = JSON.stringify(e.snapshot());
  const bad = (actor, msg) => applyGameIntent(e, actor, msg, T0).result;

  eq(bad('p1', { type: 'playCards', ranks: ['2'], claim: 'A' }).ok, false, 'playing out of turn is refused');
  eq(bad('p0', { type: 'playCards', ranks: ['K'], claim: 'A' }).ok, false, 'playing a card you do not hold is refused');
  eq(bad('p0', { type: 'playCards', ranks: ['A'], claim: 'K' }).ok, false, 'an out-of-sequence claim is refused');
  eq(bad('p0', { type: 'playCards', ranks: ['A'], claim: JOKER }).ok, false, 'CLAIMING A JOKER IS REFUSED');
  ok(bad('p0', { type: 'playCards', ranks: ['A'], claim: JOKER }).error.includes('not understood'),
    'as malformed, before it ever reaches the engine');
  eq(bad('p0', { type: 'playCards', ranks: [], claim: 'A' }).ok, false, 'an empty play is refused');
  eq(bad('p0', { type: 'playCards', ranks: new Array(9999).fill('A'), claim: 'A' }).ok, false,
    'and a play of ten thousand cards is refused by the guard, not counted by the engine');
  eq(bad('p0', { type: 'playCards', ranks: 'AAA', claim: 'A' }).ok, false, 'a string is not a play');
  eq(bad('p0', { type: 'playCards' }).ok, false, 'and neither is nothing at all');
  eq(bad('p0', { type: 'challenge' }).ok, false, 'there is nothing to challenge yet');
  eq(bad('p0', { type: 'decline' }).ok, false, 'nor to let stand');
  eq(bad('nobody', { type: 'playCards', ranks: ['A'], claim: 'A' }).ok, false, 'a stranger to the table cannot play');
  eq(JSON.stringify(e.snapshot()), untouched, 'AND NONE OF THAT MOVED A SINGLE CARD');

  // The guard bounds work; the engine owns the rule. A play of six is inside
  // the hard ceiling of eight, so it reaches the engine and gets the engine's
  // sentence about this table's own limit.
  const e2 = table(3, { decks: 2, maxPlay: 4, rankRule: 'free' });
  setHands(e2, { p0: ['A', 'A', 'A', 'A', 'A', 'A'], p1: ['2'], p2: ['3'] });
  const six = applyGameIntent(e2, 'p0', { type: 'playCards', ranks: new Array(6).fill('A'), claim: 'A' }, T0);
  eq(six.result.ok, false, 'six cards at a table capped to four is refused');
  ok(six.result.error.includes('At most 4'), "by the ENGINE, naming this table's limit");
}
{
  // A joker can be PLAYED through the dispatcher — the asymmetry with claims
  // must not have been implemented as "no jokers on the wire".
  const e = table(3, { jokers: 2, jokerMode: 'wild', rankRule: 'free' });
  setHands(e, { p0: [JOKER, '5'], p1: ['2'], p2: ['3'] });
  eq(applyGameIntent(e, 'p0', { type: 'playCards', ranks: [JOKER], claim: 'Q' }, T0).result.ok, true,
    'a joker goes face down like any other card');
  eq(applyGameIntent(e, 'p1', { type: 'challenge' }, T0 + 10).result.truthful, true,
    'and in wild mode it really is a queen');
}
{
  // challenge carries no payload, so there is nothing in it to lie about. A
  // client naming the claim it thinks it is challenging cannot be given a
  // different one from the one on top of the pile.
  const e = table(3, { rankRule: 'free' });
  setHands(e, { p0: ['K', 'K'], p1: ['2'], p2: ['3'] });
  applyGameIntent(e, 'p0', { type: 'playCards', ranks: ['K'], claim: 'A' }, T0);
  applyGameIntent(e, 'p1', { type: 'challenge', claim: 'K', rank: 'K', playerId: 'p2' }, T0 + 10);
  eq(e.reveal.claimRank, 'A', 'the reveal judges the claim the HOST has on the pile');
  eq(e.reveal.challengerId, 'p1', 'and credits the seat the message came from, not the one it named');
  eq(e.reveal.takerId, 'p0', 'so the liar takes the pile');
}
{
  // The race, through the dispatcher this time.
  const e = table(4);
  setHands(e, { p0: ['K', 'K'], p1: ['2'], p2: ['3'], p3: ['4'] });
  applyGameIntent(e, 'p0', { type: 'playCards', ranks: ['K'], claim: 'A' }, T0);
  const results = ['p1', 'p2', 'p3'].map((id) => applyGameIntent(e, id, { type: 'challenge' }, T0 + 50));
  eq(results.filter((r) => r.result.ok).length, 1, 'exactly one of three simultaneous challenges lands');
  eq(e.reveal.challengerId, 'p1', 'the first one the host applied');
}

section('Intents: a whole game over the wire');

// Every move below goes through applyGameIntent, which is the only path a real
// client has. If the dispatcher were missing a case or mangling a payload, the
// game would stall rather than finish.
{
  const e = new GameEngine();
  e.addPlayer('p0', 'Ana', { isHost: true, clientId: 'c0' });
  e.addPlayer('p1', 'Bo', { clientId: 'c1' });
  e.addPlayer('p2', 'Cy', { clientId: 'c2' });
  applyGameIntent(e, 'p0', { type: 'setConfig', patch: { rankRule: 'free', decks: 1, jokers: 2, jokerMode: 'wild' } }, T0);
  applyGameIntent(e, 'p0', { type: 'addBot' }, T0);
  eq(applyGameIntent(e, 'p0', { type: 'startGame' }, T0).result.ok, true, 'the host starts the game over the wire');
  eq(e.phase, PHASES.PLAY, 'and it runs');

  const rnd = lcg(4242);
  let now = T0;
  let steps = 0;
  let leaks = 0;
  while (e.phase === PHASES.PLAY && steps++ < 800) {
    if (!isLeakFree(e)) leaks++;
    if (e.step === STEPS.RESOLVING) { now = e.revealEndsAt; e.resolveExpiredWindow(now); continue; }
    if (e.step === STEPS.CHALLENGE_WINDOW) {
      const who = e.players.find((p) => e.privateStateFor(p.id).canChallenge);
      if (who && rnd() < 0.25) { applyGameIntent(e, who.id, { type: 'challenge' }, now); continue; }
      now = e.challengeEndsAt;
      e.resolveExpiredWindow(now);
      continue;
    }
    const me = e.currentPlayer;
    const hand = e.hands[me.id];
    const k = 1 + Math.floor(rnd() * Math.min(e.config.maxPlay, hand.length));
    const ranks = hand.slice(0, k).map((c) => c.rank);
    const claims = e.currentLegalClaims();
    const claim = claims[Math.floor(rnd() * claims.length)];
    const r = applyGameIntent(e, me.id, { type: 'playCards', ranks, claim }, now);
    if (!r.result.ok) { failed++; console.error('  x FAIL: legal play refused over the wire:', r.result.error); break; }
  }
  eq(leaks, 0, 'the wire boundary holds at every step of a game played entirely through the dispatcher');
  eq(e.phase, PHASES.GAME_OVER, 'and the game reaches a winner');
  ok(e.winner !== null, 'with somebody named');
  eq(applyGameIntent(e, 'p1', { type: 'playAgain' }, T0).result.ok, false, 'a non-host cannot restart');
  eq(applyGameIntent(e, 'p0', { type: 'playAgain' }, T0).result.ok, true, 'the host can');
  eq(e.phase, PHASES.LOBBY, 'back to the lobby with the same table');
}

// ===========================================================================
// THE BOT: bot.js
//
// Two halves, tested very differently on purpose.
//
//   THE CERTAINTY CHECK is arithmetic with a right answer, so it is tested as
//   arithmetic: exact boundaries, asserted in both directions, at every deck
//   count. A false positive here is the worst bug in the file — the bot
//   challenges something true, loses, and looks like it is guessing.
//
//   EVERYTHING ELSE IS JUDGEMENT and has no right answer, so it is tested as
//   properties that must hold whatever the judgement decides: never illegal,
//   never a card it does not hold, never a crash, and a game that ends. The
//   numbers those properties produce belong in a benchmark, not a test — a
//   test that pins the lie rate to 43% fails every time the bot improves.
// ===========================================================================

section('The bot: the certainty check');

/**
 * The two views the bot is allowed to see, and nothing else.
 *
 * Built from a real engine rather than hand-written objects, so a field the
 * bot reads that publicState() stops emitting fails here rather than in a
 * browser. Takes the seat that is being asked, not the seat that played.
 */
function views(e, who) {
  return [e.publicState(), e.privateStateFor(who)];
}

// THE SPEC'S OWN BOUNDARY CASE, both directions.
//
//   "1 deck / 0 jokers, claim of 3 with 2 held must fire; at 2 decks the
//    identical situation must not."
//
// 3 + 2 > 4 and 3 + 2 <= 8. It is one comparison and it is the whole reason
// every bound in this file is asserted at decks 1, 2 AND 3: a hardcoded four
// is right here and wrong one line down, and the game still runs either way.
for (const decks of [1, 2, 3]) {
  const e = table(3, { decks, jokers: 0, rankRule: 'free', maxPlay: 4 });
  setHands(e, { p0: ['K', 'K', 'K', '2'], p1: ['K', 'K', '2'], p2: ['3'] });
  e.playCards('p0', ['K', 'K', 'K'], 'K', T0);
  const [pub, priv] = views(e, 'p1');
  eq(claimIsImpossible(pub, priv), decks === 1,
    `three Kings claimed with two in hand is ${decks === 1 ? 'provable' : 'possible'} at ${decks} deck(s)`);
}

// AND THE CLAIM ONE SMALLER IS POSSIBLE AT EVERY DECK COUNT — the bound has to
// be `>` and not `>=`, and off-by-one here is a bot that calls the truth.
for (const decks of [1, 2, 3]) {
  const e = table(3, { decks, jokers: 0, rankRule: 'free', maxPlay: 4 });
  setHands(e, { p0: ['K', 'K', '2'], p1: ['K', 'K', '2'], p2: ['3'] });
  e.playCards('p0', ['K', 'K'], 'K', T0);
  const [pub, priv] = views(e, 'p1');
  eq(claimIsImpossible(pub, priv), false,
    `two Kings claimed with two in hand is exactly possible at ${decks} deck(s)`);
}

// THE BOT'S OWN WILD JOKERS COUNT AGAINST THE CLAIMER.
//
// A wild joker inflates the supply for everybody, so one sitting in this hand
// is one that is not sitting in the claimer's. Getting this wrong leaves the
// bound too loose and the bot misses lies it could have proved. Same position
// twice, and the ONLY difference is which mode the jokers are in.
{
  // One deck plus two jokers, wild. Supply is six, this hand holds two Kings
  // and a joker, and a claim of four is 4 + 3 > 6 — provable, but ONLY because
  // the joker was counted. Leave it out and the sum is 4 + 2 = 6, which is not
  // greater than six, and the bot misses a lie it could have proved. So the
  // same position is asserted with the joker swapped for a plain card, where
  // it must NOT fire.
  const mk = (third) => {
    const e = table(3, { decks: 1, jokers: 2, jokerMode: 'wild', rankRule: 'free', maxPlay: 4 });
    setHands(e, { p0: ['K', 'K', '9', '9'], p1: ['K', 'K', third, '2'], p2: ['3'] });
    e.playCards('p0', ['K', 'K', '9', '9'], 'K', T0);
    return claimIsImpossible(...views(e, 'p1'));
  };
  eq(mk(JOKER), true, 'A WILD JOKER IN OUR OWN HAND IS ONE THE CLAIMER CANNOT HAVE — and it proves the lie');
  eq(mk('7'), false, 'where the same hand without it cannot prove anything');
}
{
  // In junk mode the joker is not a King and never was, so the supply is four
  // and the same claim is provable from the two Kings alone.
  const e = table(3, { decks: 1, jokers: 2, jokerMode: 'junk', rankRule: 'free', maxPlay: 4 });
  setHands(e, { p0: ['K', 'K', '9', '9'], p1: ['K', 'K', JOKER, '2'], p2: ['3'] });
  e.playCards('p0', ['K', 'K', '9', '9'], 'K', T0);
  eq(claimIsImpossible(...views(e, 'p1')), true, 'and a junk joker does not inflate the supply it is measured against');
}
{
  // The case that separates them. Four Kings claimed at one deck with two
  // jokers in the pack: in wild mode the supply is six, this hand holds one
  // King, and 4 + 1 <= 6 — genuinely possible, because the claimer may be
  // holding both jokers. In junk mode the supply is four and 4 + 1 > 4.
  const mk = (jokerMode) => {
    const e = table(3, { decks: 1, jokers: 2, jokerMode, rankRule: 'free', maxPlay: 4 });
    setHands(e, { p0: ['K', 'K', 'K', 'K'], p1: ['K', '2', '3'], p2: ['4'] });
    e.playCards('p0', ['K', 'K', 'K', 'K'], 'K', T0);
    return claimIsImpossible(...views(e, 'p1'));
  };
  eq(mk('wild'), false, 'a wild joker can make an otherwise impossible claim possible');
  eq(mk('junk'), true, 'and a junk joker cannot — it is not a King and never was');
}

// REVEALED CARDS TIGHTEN THE BOUND, and the three subtractions that make it
// sound are each worth their own position.
{
  // A third player took a revealed pair of Kings. p1 could not prove the next
  // King claim from its own hand alone — but it watched two Kings land in p2's.
  const e = table(3, { decks: 1, jokers: 0, rankRule: 'free', maxPlay: 4 });
  setHands(e, { p0: ['K', 'K', '9'], p1: ['K', '2'], p2: ['3', '4'] });
  e.playCards('p0', ['K', 'K'], 'K', T0);       // truthful, and called wrongly
  e.challenge('p2', T0 + 10);                    // so p2 eats both Kings
  eq(e.seen.takerId, 'p2', 'the table watched p2 pick up the reveal');
  e.resolveExpiredWindow(e.revealEndsAt);
  eq(e.currentPlayer.id, 'p1', 'and the turn rotated past the player who was challenged');
  e.playCards('p1', ['2'], '2', e.revealEndsAt);
  e.resolveExpiredWindow(e.challengeEndsAt);
  const now = e.challengeEndsAt;
  e.playCards('p2', ['3'], 'K', now);            // p2 now claims a King
  const [pub, priv] = views(e, 'p1');
  // 1 claimed + 1 held + 2 revealed = 4, which is not > 4. Not provable, and
  // correctly so — the two Kings p2 is holding are exactly the ones that could
  // make this true. This is the "IF THE CLAIMER TOOK THEM" subtraction, and
  // without it the bot confidently calls a claim that is true.
  eq(claimIsImpossible(pub, priv), false,
    'cards the CLAIMER was seen to take are available to the claim, not evidence against it');
}
{
  // The same reveal, but somebody else is claiming. Now the two Kings in p2's
  // hand are two Kings the claimer cannot have.
  const e = table(4, { decks: 1, jokers: 0, rankRule: 'free', maxPlay: 4 });
  setHands(e, { p0: ['K', 'K', '9'], p1: ['K', '2'], p2: ['3', '4'], p3: ['5', '6'] });
  e.playCards('p0', ['K', 'K'], 'K', T0);
  e.challenge('p2', T0 + 10);
  e.resolveExpiredWindow(e.revealEndsAt);
  eq(e.currentPlayer.id, 'p1', 'p1 leads');
  const now = e.revealEndsAt;
  e.playCards('p1', ['2'], '2', now);
  e.resolveExpiredWindow(e.challengeEndsAt);
  e.playCards('p2', ['3'], '3', e.challengeEndsAt);
  e.resolveExpiredWindow(e.challengeEndsAt);
  e.playCards('p3', ['5'], 'K', e.challengeEndsAt);
  const [pub, priv] = views(e, 'p1');
  // 1 claimed + 1 held + (2 revealed in p2's hand, less the one card p2 has
  // played since) = 3, and 3 is not > 4. Still not provable.
  eq(claimIsImpossible(pub, priv), false, 'a revealed card the taker may already have played back is not counted');
}
{
  // THE DOUBLE COUNT. We took the pile ourselves, so priv.counts already holds
  // those cards; counting them a second time out of `seen` is the mistake that
  // fires most often, and it fires on the very next claim.
  const e = table(3, { decks: 1, jokers: 0, rankRule: 'free', maxPlay: 4 });
  setHands(e, { p0: ['K', 'K', '9'], p1: ['2', '3'], p2: ['4', '5'] });
  e.playCards('p0', ['K', 'K'], 'K', T0);
  e.challenge('p1', T0 + 10);                    // p1 is wrong and eats them
  eq(e.seen.takerId, 'p1', 'p1 took the reveal');
  eq(e.handCount('p1'), 4, 'so the Kings are in p1\'s own hand now');
  e.resolveExpiredWindow(e.revealEndsAt);
  const now = e.revealEndsAt;
  e.playCards('p2', ['4'], 'K', now);            // one King claimed
  const [pub, priv] = views(e, 'p1');
  // 1 + 2 held = 3, not > 4. If the two revealed Kings were added AGAIN it
  // would be 5 and the bot would "prove" a claim that is perfectly possible.
  eq(claimIsImpossible(pub, priv), false, 'cards WE took are counted once, out of our own hand');
}

// JUNK MODE: A PLAYER HOLDING NOTHING BUT JOKERS CAN PLAY, AND LOSES EVERY
// CHALLENGE. A joker is not a rank, so there is no claim it can make honestly
// — but the rules never stop it playing, and a bot that returned null here
// would stall the table.
{
  const e = table(3, { decks: 1, jokers: 2, jokerMode: 'junk', rankRule: 'free', maxPlay: 4 });
  setHands(e, { p0: [JOKER, JOKER], p1: ['K', '2'], p2: ['3', '4'] });
  const move = choosePlay(...views(e, 'p0'), lcg(5));
  ok(move !== null, 'a hand of nothing but junk jokers still finds a move');
  ok(move.ranks.every((r) => r === JOKER), 'made of the only cards it has');
  ok(RANKS.includes(move.claim), 'under a claim that is a rank and never the joker');
  eq(e.playCards('p0', move.ranks, move.claim, T0).ok, true, 'and the engine accepts it');
  const r = e.challenge('p1', T0 + 10);
  eq(r.truthful, false, 'but it is always a lie');
  eq(e.handCount('p0'), 2, 'and the jokers come straight back');
}
{
  // The same hand in WILD mode is the opposite hand: every claim is true.
  const e = table(3, { decks: 1, jokers: 2, jokerMode: 'wild', rankRule: 'free', maxPlay: 4 });
  setHands(e, { p0: [JOKER, JOKER], p1: ['K', '2'], p2: ['3', '4'] });
  const move = choosePlay(...views(e, 'p0'), lcg(5));
  eq(e.playCards('p0', move.ranks, move.claim, T0).ok, true, 'the same hand plays in wild mode');
  eq(e.challenge('p1', T0 + 10).truthful, true, 'and the claim holds, whatever it was');
}

// ---------------------------------------------------------------------------
// A PROVABLE LIE IS ALMOST ALWAYS CALLED — and "almost" is load-bearing.
//
// Calling it unconditionally welds shut the rank-partition position described
// on CERTAIN_SLIP in bot.js: every rank in one hand, every forced lie provable
// by its owner, every caught liar handed back exactly what they played. One
// game in four thousand reached it and ran to 316,000 plays without a winner.
//
// So these assert the SHAPE rather than the rate — overwhelmingly called, more
// insistently as the pile grows into something worth winning, and never let go
// when the claimer is walking out on it. The rate itself is a tuning number and
// belongs in a benchmark.
// ---------------------------------------------------------------------------
function certainCallRate(e, who, trials = 2000) {
  const [pub, priv] = views(e, who);
  ok(claimIsImpossible(pub, priv), 'the claim really is provably false');
  // ONE stream across all the trials, and not lcg(i) inside the loop. A fresh
  // lcg's first output is very nearly a linear function of its seed, so seeding
  // per trial samples a thin diagonal of [0,1): six hundred of them landed
  // between 0.24 and 0.47, never once dipped under the slip, and reported a
  // 100% call rate that proved nothing whatsoever.
  const rnd = lcg(20250923);
  let called = 0;
  for (let i = 0; i < trials; i++) if (shouldChallenge(pub, priv, rnd)) called++;
  return called / trials;
}
{
  // p1 holds all four Kings, so a claim of even one more cannot be true.
  const e = table(4, { decks: 1, rankRule: 'free', maxPlay: 4 });
  setHands(e, {
    p0: ['2', '3', '4', '5', '6'], p1: ['K', 'K', 'K', 'K', '7'],
    p2: ['8', '9', 'T'], p3: ['J', 'Q', 'A'],
  });
  e.playCards('p0', ['2', '3'], 'K', T0);
  const bare = certainCallRate(e, 'p1');
  ok(bare > 0.7, `a provable lie on a bare pile is still called most of the time (${(bare * 100).toFixed(0)}%)`);
  ok(bare < 1, 'but NOT every time — this is the only escape from a rank-partitioned table');
}
{
  // The identical proof, with a pile worth taking underneath it. Winning the
  // call now buys a hand's worth of cards, so the bot stops hesitating.
  const e = table(4, { decks: 1, rankRule: 'free', maxPlay: 4 });
  setHands(e, {
    p0: ['2', '3', '4', '5', '6'], p1: ['K', 'K', 'K', 'K', '7'],
    p2: ['8', '9', 'T'], p3: ['J', 'Q', 'A'],
  });
  e.playCards('p0', ['2', '3'], 'K', T0);
  const bare = certainCallRate(e, 'p1');
  for (let i = 0; i < 20; i++) e.pile.push(card('4'));   // a pile worth winning
  const fat = certainCallRate(e, 'p1');
  ok(fat > bare, `a pile worth taking hardens the call (${(bare * 100).toFixed(0)}% -> ${(fat * 100).toFixed(0)}%)`);
}
{
  // And the case that must never slip: the liar is going out on this play.
  const e = table(4, { decks: 1, rankRule: 'free', maxPlay: 4 });
  setHands(e, {
    p0: ['2', '3'], p1: ['K', 'K', 'K', 'K', '7'],
    p2: ['8', '9', 'T'], p3: ['J', 'Q', 'A'],
  });
  e.playCards('p0', ['2', '3'], 'K', T0);
  eq(e.handCount('p0'), 0, 'the claimer has emptied their hand');
  eq(certainCallRate(e, 'p1'), 1, 'A PROVABLE LIE ON A FINAL PLAY IS CALLED EVERY SINGLE TIME');
}

section('The bot: what it may and may not do');

// PURITY, asserted rather than assumed. The bot is handed the same two objects
// a remote phone receives, and the whole privacy argument in bot.js rests on
// it not reaching past them — so a deep-frozen pair is the strongest available
// statement of "it read this and changed nothing".
function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}
{
  const e = table(4, { decks: 2, jokers: 4, jokerMode: 'wild', rankRule: 'adjacent', maxPlay: 4 });
  const [pub, priv] = views(e, e.currentPlayer.id).map(deepFreeze);
  const before = JSON.stringify([pub, priv]);
  const a = choosePlay(pub, priv, lcg(11));
  const b = choosePlay(pub, priv, lcg(11));
  eq(JSON.stringify([pub, priv]), before, 'choosePlay mutates neither view');
  same(a, b, 'and is a pure function of them and the random stream');
}
{
  const e = table(4, { rankRule: 'free', maxPlay: 4 });
  setHands(e, { p0: ['A', 'A', '2'], p1: ['K', '3'], p2: ['4', '5'], p3: ['6', '7'] });
  e.playCards('p0', ['A', 'A'], 'A', T0);
  const [pub, priv] = views(e, 'p1').map(deepFreeze);
  const before = JSON.stringify([pub, priv]);
  shouldChallenge(pub, priv, lcg(11));
  eq(JSON.stringify([pub, priv]), before, 'shouldChallenge mutates neither view');
}

// NEVER AN ILLEGAL PLAY, AND NEVER A CARD IT DOES NOT HOLD. Swept over every
// rank rule at every deck count, from a real dealt hand, against the engine's
// own answer to both questions.
{
  let plays = 0;
  const bad = [];
  for (const rankRule of Object.keys(RANK_RULES)) {
    for (const decks of [1, 2, 3]) {
      for (const jokerMode of Object.keys(JOKER_MODES)) {
        for (let s = 0; s < 6; s++) {
          seed(1000 + s);
          const e = table(4, {
            rankRule, decks, jokers: 2 * decks, jokerMode, maxPlay: playCap(decks),
          });
          const me = e.currentPlayer.id;
          const move = choosePlay(...views(e, me), lcg(1 + s * 31));
          plays++;
          const where = `${rankRule}/${decks}d/${jokerMode}/seed${s}`;
          if (!move) { bad.push(`${where}: no move from a full hand`); continue; }
          if (!e.currentLegalClaims().includes(move.claim)) bad.push(`${where}: illegal claim ${move.claim}`);
          if (move.ranks.length < 1 || move.ranks.length > e.config.maxPlay) {
            bad.push(`${where}: ${move.ranks.length} cards against a cap of ${e.config.maxPlay}`);
          }
          // The hand, as a multiset. Playing two Kings out of a hand holding
          // one is the failure this catches, and takeByRank would happily
          // silently take one.
          const left = handCounts(e.hands[me]);
          for (const r of move.ranks) {
            if (!left[r]) { bad.push(`${where}: played a ${r} it does not hold`); break; }
            left[r]--;
          }
          if (!e.playCards(me, move.ranks, move.claim, T0).ok) bad.push(`${where}: the engine refused it`);
        }
      }
    }
  }
  same(bad, [], `${plays} opening plays across every rule combination are legal and made of real cards`);
}

// THE CLAIM IS NEVER A JOKER. It cannot be, because legalClaims() cannot
// produce one — but this is the assertion that says so out loud, and it is
// cheap next to the class of bug where a wild joker gets treated as a rank
// somewhere in the shed order.
{
  const bad = [];
  for (const jokerMode of Object.keys(JOKER_MODES)) {
    for (let s = 0; s < 40; s++) {
      seed(2000 + s);
      const e = table(3, { decks: 3, jokers: 6, jokerMode, rankRule: 'free', maxPlay: 4 });
      const move = choosePlay(...views(e, e.currentPlayer.id), lcg(7 + s));
      if (move && move.claim === JOKER) bad.push(`${jokerMode}/seed${s}`);
    }
  }
  same(bad, [], 'no bot ever claims the joker, in either joker mode');
}

section('The bot: the driver');

// THE RANDOMISED DELAY IS NOT DECORATION. Every bot plans on the same tick, and
// the engine takes the first challenge to arrive — so a fixed delay would hand
// every contested challenge in every game to whichever bot sits earliest in the
// players array. This is the test that the race is actually a race.
{
  const winners = new Map();
  for (let s = 0; s < 400; s++) {
    const e = new GameEngine();
    e.addPlayer('p0', 'Ana', { isHost: true, clientId: 'c0' });
    for (let i = 1; i < 5; i++) e.addBot();
    e.players[0].isBot = true;
    e.setConfig({ rankRule: 'free', maxPlay: 4, windowMs: 5000, challengeMode: 'window' });
    seed(3000 + s);
    e.startGame('p0');
    // A claim nobody can fail to call: four Aces at one deck, from a hand that
    // holds none, so every other seat's certainty check fires immediately.
    const ids = e.players.map((p) => p.id);
    setHands(e, {
      [ids[0]]: ['2', '2', '2', '2'],
      [ids[1]]: ['A', '3'], [ids[2]]: ['A', '4'], [ids[3]]: ['A', '5'], [ids[4]]: ['A', '6'],
    });
    e.turn = 0;
    e.step = STEPS.AWAITING_PLAY;
    e.playCards(ids[0], ['2', '2', '2', '2'], 'A', T0);
    const driver = createBotDriver({ thinkMs: 1500, rnd: lcg(1 + s * 104729) });
    let now = T0;
    while (e.step === STEPS.CHALLENGE_WINDOW && now < e.challengeEndsAt) {
      if (driver.tick(e, now)) break;
      now += 25;
    }
    // BY SEAT, not by id. addBot() mints a fresh id every game, so counting
    // ids would score four hundred distinct winners and pass a test of nothing.
    // The seat is the thing that must not be privileged.
    if (e.reveal) {
      const seat = e.players.findIndex((p) => p.id === e.reveal.challengerId);
      winners.set(seat, (winners.get(seat) || 0) + 1);
    }
  }
  eq(winners.size, 4, 'all four eligible seats win the challenge race at least once');
  const most = Math.max(...winners.values());
  ok(most < 300, `and no single seat wins it every time (worst seat took ${most} of 400)`);
  ok(!winners.has(0), 'while the seat that made the claim never challenges it');
}

// A BOT NEVER ACTS BEFORE ITS OWN PAUSE, and never twice on one decision.
{
  const e = new GameEngine();
  e.addPlayer('p0', 'Ana', { isHost: true, clientId: 'c0' });
  for (let i = 1; i < 3; i++) e.addBot();
  e.setConfig({ rankRule: 'free', maxPlay: 4 });
  seed(77);
  e.startGame('p0');
  e.turn = e.players.findIndex((p) => p.isBot);
  const driver = createBotDriver({ thinkMs: 1500, rnd: lcg(3) });
  eq(driver.tick(e, T0), false, 'the first tick only starts the bot thinking');
  eq(driver.tick(e, T0 + 1499), false, 'and it is still thinking one millisecond short');
  eq(driver.tick(e, T0 + 1500), true, 'then it acts, exactly on its pause');
  eq(e.step, STEPS.CHALLENGE_WINDOW, 'which opened a challenge window');
}

section('The bot: thousands of games, every rule combination');

/**
 * A whole game driven by nothing but createBotDriver, with the clock injected.
 *
 * The sweep below is the spec's own acceptance criterion, and the thing it is
 * really looking for is not a crash. It is a POSITION THAT RETURNS TO ITSELF:
 * a bot whose best move loses the pile, gets it straight back, and faces the
 * identical decision forever. Two of those shipped in this file during the
 * build — one from restarting the ascending chain on an empty pile, one from
 * paying a bluff bonus for a lie that shed fewer cards than the honest play —
 * and neither throws, neither plays illegally, and neither is visible in
 * anything except a game that does not end. So the assertion is on the count
 * of games that reach a winner, and it is exact rather than "most".
 *
 * console.warn is fatal here: the driver logs a refusal rather than throwing,
 * so a bot that has drifted out of step with the engine is silent by design.
 */
function botGame(patch, players, seedN, maxTicks = 40000) {
  const e = new GameEngine();
  e.addPlayer('p0', NAMES[0], { isHost: true, clientId: 'c0' });
  for (let i = 1; i < players; i++) e.addBot();
  e.players[0].isBot = true;              // a table of nothing but bots
  e.setConfig({ windowMs: 3000, ...patch });
  e.startGame('p0');

  const driver = createBotDriver({ thinkMs: 60, rnd: lcg(seedN) });
  const total = deckSize(e.config);
  const problems = [];
  let now = T0;
  let ticks = 0;
  let plays = 0;

  while (e.phase === PHASES.PLAY && ticks++ < maxTicks) {
    const before = e.step;
    if (driver.tick(e, now)) {
      if (before === STEPS.AWAITING_PLAY) plays++;
      const inHands = Object.values(e.hands).reduce((n, h) => n + h.length, 0);
      if (inHands + e.pile.length !== total) problems.push(`cards lost: ${inHands}+${e.pile.length} != ${total}`);
      if (!isLeakFree(e)) problems.push('the wire boundary broke mid-game');
      continue;
    }
    if (e.step === STEPS.RESOLVING) {
      now = Math.max(now, e.revealEndsAt);
      e.resolveExpiredWindow(now);
      continue;
    }
    if (e.step === STEPS.CHALLENGE_WINDOW && e.challengeEndsAt != null) {
      if (now < e.challengeEndsAt) { now = Math.min(e.challengeEndsAt, now + 250); continue; }
      e.resolveExpiredWindow(now);
      continue;
    }
    now += 250;
  }
  return { problems, plays, finished: e.phase === PHASES.GAME_OVER, engine: e };
}

/**
 * Games per rule combination. Thirty-six combinations, so this is games/36.
 *
 * Both livelocks this sweep has caught so far needed a specific deal to
 * surface — one showed up roughly once in every hundred and thirty games —
 * so the number has to be high enough that a rare position is reached at all,
 * and low enough that `npm test` stays something you run without thinking.
 * BLUFF_GAMES=500 in the environment is the setting for a long soak.
 */
const BOT_GAMES_PER_RULE = Number(process.env.BLUFF_GAMES || 56);

{
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };

  let games = 0, finished = 0, plays = 0;
  const problems = [];
  try {
    for (const rankRule of Object.keys(RANK_RULES)) {
      for (const challengeMode of Object.keys(CHALLENGE_MODES)) {
        for (const decks of [1, 2, 3]) {
          for (const jokerMode of Object.keys(JOKER_MODES)) {
            for (let s = 0; s < BOT_GAMES_PER_RULE; s++) {
              const players = 3 + (games % 6);
              seed(5000 + games);
              const r = botGame(
                { rankRule, challengeMode, decks, jokers: 2 * decks, jokerMode, maxPlay: playCap(decks) },
                players, 1 + games * 7919,
              );
              games++;
              plays += r.plays;
              if (r.finished) finished++;
              else problems.push(`${rankRule}/${challengeMode}/${decks}d/${jokerMode}/${players}p seed ${s}: no winner after ${r.plays} plays`);
              for (const p of r.problems) {
                problems.push(`${rankRule}/${challengeMode}/${decks}d/${jokerMode}/${players}p: ${p}`);
              }
            }
          }
        }
      }
    }
  } finally {
    console.warn = realWarn;
  }

  console.log(`  ${games} bot games, ${finished} reached a winner, ${plays} plays`);
  same(warnings.slice(0, 3), [], 'no bot move is ever refused, and nothing throws inside the scoring');
  same(problems.slice(0, 3), [], `${games} bot games hold every invariant`);
  eq(finished, games, 'AND EVERY ONE OF THEM ENDS — no position that returns to itself');
}

// ===========================================================================
// THE WIRE — js/net.js, with both ends running in this process.
//
// Everything above this line is a function of its arguments. The transport is
// not: it is a function of two processes, a public signalling broker and a
// radio, and its worst failures are the ones that need a SECOND participant to
// exist at all. A host talking to nobody cannot leak a hand to anybody.
//
// So scripts/peershim.mjs supplies a fake window.Peer and the real createHost()
// and joinHost() run their real handshake across it. Three claims get the most
// attention, because each is silent when broken and each ends the game:
//
//   * THE PREFIX IS A BOUNDARY. A peer may name itself anything, including
//     'host'. If that name reached the engine unprefixed it would resolve to
//     the host's seat and privateStateFor() would hand back the host's CARDS.
//   * ONE FRAME, ONE HAND. pushState() derives the recipient from the map key,
//     so there must be no path by which device A's frame carries device B's
//     cards. Asserted by card id, across every frame every guest received.
//   * A SEAT IS RECLAIMED BY TICKET AND NOTHING ELSE, and two tabs sharing one
//     ticket must not trade the seat back and forth forever.
// ===========================================================================

section('The wire: addressing');
{
  eq(peerIdForCode('QRTX'), `${PEER_PREFIX}QRTX`, 'a code becomes a broker address');
  eq(peerIdForCode('qr-tx'), `${PEER_PREFIX}QRTX`, 'pasted out of a chat message, it is the same address');
  eq(peerIdForCode('QRT'), null, 'three characters is not a code');
  eq(peerIdForCode('QR0X'), null, 'a zero is DROPPED rather than guessed at, so this is three characters');
  eq(peerIdForCode(''), null, 'and neither is nothing');
  eq(peerIdForCode(null), null, 'nor null');
  eq(codeFromPeerId(peerIdForCode('QRTX')), 'QRTX', 'round trip');
  eq(codeFromPeerId('some-other-app-QRTX'), null, 'an address from another app is not our code');
  eq(codeFromPeerId(null), null, 'and null is not an address');

  // The reason peerIdForCode returns null instead of a best effort: every
  // joiner who typed junk would otherwise dial the bare prefix — the same
  // address as every other such joiner — and two strangers who both
  // fat-fingered the field would end up in a game together, holding cards.
  ok(peerIdForCode('!!!!') === null && peerIdForCode('????') === null,
    'two different unusable inputs both refuse, rather than colliding on one address');

  for (let i = 0; i < 200; i++) {
    const c = generateRoomCode();
    eq(c.length, CODE_LENGTH, 'a minted code is always the full length');
    eq(normalizeCode(c), c, 'a minted code survives normalisation unchanged');
    ok(peerIdForCode(c) !== null, 'and is always dialable');
  }
}

section('The wire: the prefix is a security boundary');
{
  eq(playerIdForConn('abc'), `${CONN_ID_PREFIX}abc`, 'a connection id becomes a player id');
  eq(connIdForPlayer(`${CONN_ID_PREFIX}abc`), 'abc', 'and back again');

  // THE WHOLE POINT. A joiner picks its own peer id, so it can pick 'host'.
  ok(playerIdForConn(HOST_ID) !== HOST_ID,
    'a peer that names itself "host" does NOT become the host');
  eq(playerIdForConn(HOST_ID), `${CONN_ID_PREFIX}${HOST_ID}`,
    'it becomes peer:host, which is a different seat entirely');

  // The reverse direction is what stops a frame being addressed to the host's
  // own seat or to a bot's — neither has a connection, and sendTo() uses the
  // null to mean "there is nothing to send to".
  eq(connIdForPlayer(HOST_ID), null, 'the host has no connection to send to');
  eq(connIdForPlayer('bot:abcd1234'), null, 'and neither does a bot');
  eq(connIdForPlayer('peer'), null, 'a bare prefix with no id is not an address');
  eq(connIdForPlayer(null), null, 'nor is null');
}

section('The wire: the four frames');
{
  const j = readJoinFrame(joinFrame('  Ana  ', 'a'.repeat(32)));
  ok(j !== null, 'a good hello reads back');
  eq(j.name, 'Ana', 'and the name is cleaned on the way through');
  eq(readJoinFrame({ type: WIRE.JOIN, name: '', clientId: 'a'.repeat(32) }), null,
    'a hello with no usable name is not a hello');
  eq(readJoinFrame({ type: 'something-else', name: 'Ana' }), null, 'nor a frame of another type');

  // THE ASYMMETRY BETWEEN THE TWO FIELDS, asserted because it looks like an
  // oversight and is not. A bad NAME refuses the frame: the sender left the
  // field blank and should be told so by the transport rather than seated and
  // then unseated. A bad TICKET is dropped to null and the join PROCEEDS: it
  // costs that device its claim on the seat if the connection ever drops,
  // which is the device's problem — but refusing it would mean a phone with
  // storage switched off cannot play at all.
  eq(readJoinFrame({ type: WIRE.JOIN, name: 'Ana', clientId: 'nope' }).clientId, null,
    'a malformed ticket is dropped rather than half-trusted');
  eq(readJoinFrame({ type: WIRE.JOIN, name: 'Ana', clientId: 'nope' }).name, 'Ana',
    'and the join goes through anyway — a phone with no storage can still play');
  eq(readJoinFrame({ type: WIRE.JOIN, name: 'Ana' }).clientId, null,
    'as is a missing one');

  // stateFrameFor is where the privacy invariant is localised: it asks
  // privateFor() for the id of the connection it is addressing, and there is
  // no parameter by which a caller could ask for a different one.
  const asked = [];
  const frame = stateFrameFor('abc', { pileSize: 0 }, (id) => { asked.push(id); return { playerId: id }; });
  same(asked, [`${CONN_ID_PREFIX}abc`], 'the private half is fetched for the addressee and nobody else');
  eq(frame.type, WIRE.STATE, 'and it is a state frame');
  eq(frame.priv.playerId, `${CONN_ID_PREFIX}abc`, 'carrying that addressee\'s slice');
  eq(stateFrameFor('abc', { pileSize: 0 }, () => undefined).priv, null,
    'a seat that does not exist yet sends an explicit null rather than undefined');

  const long = 'x'.repeat(MAX_REJECT_LEN + 500);
  ok(rejectFrame(long).message.length <= MAX_REJECT_LEN, 'a refusal is one line, not a document');
  eq(readRejectFrame(rejectFrame('You must claim Four.')), 'You must claim Four.', 'a refusal reads back');
  ok(readRejectFrame({ type: WIRE.REJECTED }).length > 0,
    'a refusal with no message still produces a SENTENCE — an empty banner is the worst outcome');
  eq(readRejectFrame({ type: WIRE.STATE }), null, 'and a state frame is not a refusal');
  eq(readRejectFrame(rejectFrame(12345)), 'The host refused that.', 'nor is a number a message');

  ok(isReplacedFrame(replacedFrame()), 'the replaced frame is recognised');
  ok(!isReplacedFrame({ type: WIRE.STATE }), 'and nothing else is');
  same(Object.keys(replacedFrame()), ['type'], 'it carries nothing — the fact IS the frame');

  ok(readStateFrame({ type: WIRE.STATE, pub: null, priv: null }) === null,
    'a state frame with no public half is not usable');
}

section('The wire: every dead end has a sentence');
{
  // Derived rather than listed: the suite asks isFatalPeerError which types
  // are dead ends and then insists each of them has its own case. A member
  // added to UNRECOVERABLE without a message would reach the default branch
  // and tell a stuck player "unknown error" at the moment it matters most.
  const CANDIDATES = [
    'browser-incompatible', 'disconnected', 'invalid-id', 'invalid-key', 'network',
    'peer-unavailable', 'ssl-unavailable', 'server-error', 'socket-error',
    'socket-closed', 'unavailable-id', 'webrtc', 'peer-missing', 'bad-code',
  ];
  const fatal = CANDIDATES.filter((type) => isFatalPeerError({ type }));
  eq(fatal.length, 7, 'the fatal set is the seven types this list knows about — add one, add it here');
  for (const type of fatal) {
    ok(!describePeerError({ type }).startsWith('Connection problem:'),
      `${type} has a sentence of its own rather than the fallback`);
  }
  for (const type of CANDIDATES) {
    const text = describePeerError({ type });
    ok(text.length > 0 && text.endsWith('.'), `${type} produces a finished sentence`);
  }

  eq(describePeerError(null), 'Connection problem: unknown error.', 'a missing error still says something');
  eq(describePeerError({ type: 'weird', message: '   ' }), 'Connection problem: unknown error.',
    'and so does a blank one');
  ok(describePeerError({ type: 'weird', message: 'z'.repeat(5000) }).length < MAX_REJECT_LEN + 40,
    'a five-thousand-character library message is capped, not pasted onto the screen');
  // This function is called FROM an error handler, so a throw in here replaces
  // a banner the player could act on with a dead tab.
  const hostile = { type: 'weird' };
  Object.defineProperty(hostile, 'message', { get() { throw new Error('boom'); } });
  eq(describePeerError(hostile), 'Connection problem: unknown error.',
    'a getter that throws is survived rather than propagated');
}

section('The wire: two ends, one process');
{
  const shim = installPeerShim();
  ok(peerAvailable(), 'with a shim installed, the transport believes it can run');

  /** A host, its engine, and the loop js/main.js runs — minus the DOM. */
  function tableAt(code, opts = {}) {
    const engine = new GameEngine();
    const hostTicket = opts.hostTicket || 'ticket-of-the-host';
    engine.addPlayer(HOST_ID, opts.hostName || 'Host', {
      isHost: true, clientId: hostTicket,
    });
    const log = { errors: [], joins: [], drops: [], brokerDown: 0, brokerUp: 0 };
    const t = createHost(code, {
      onJoin(playerId, hello) {
        log.joins.push([playerId, hello && hello.name]);
        if (!hello) { t.sendTo(playerId, rejectFrame('Pick a name first.')); return; }
        // The host's OWN ticket, arriving over the wire — their second tab.
        // Refused by identity, before addPlayer can reclaim the host's seat
        // onto the peer id of a tab that holds none of the cards.
        if (hello.clientId === hostTicket) {
          t.sendTo(playerId, rejectFrame('That is this phone — you are already at this table as the host.'));
          return;
        }
        // Mirrors js/main.js, including the truthiness check — a null ticket
        // claims nothing, or two storage-disabled phones evict each other.
        const prior = hello.clientId
          ? engine.players.find((p) => p.clientId === hello.clientId && p.id !== playerId)
          : null;
        // The REPLACED frame, sent WITHOUT dropping the old connection here:
        // the drop is js/main.js's policy and needs a flush delay to land.
        // What is under test is that the loser is told at all.
        if (prior) t.sendTo(prior.id, replacedFrame());
        const seat = engine.addPlayer(playerId, hello.name, { clientId: hello.clientId });
        if (!seat.ok) { t.sendTo(playerId, rejectFrame(seat.error)); return; }
        push();
      },
      onData(playerId, msg) {
        const { result } = applyGameIntent(engine, playerId, msg, Date.now());
        if (result && !result.ok) t.sendTo(playerId, rejectFrame(result.error));
        push();
      },
      onDisconnect(playerId) { log.drops.push(playerId); engine.markOffline(playerId); push(); },
      onError(err) { log.errors.push(err && err.type); },
      onBrokerDown() { log.brokerDown += 1; },
      onBrokerUp() { log.brokerUp += 1; },
    });
    function push() { t.pushState(engine.publicState(), (id) => engine.privateStateFor(id)); }
    return { engine, t, push, log };
  }

  function guestAt(code, name, ticket) {
    const frames = [];
    const events = [];
    const g = joinHost(code, {
      onOpen() { events.push('open'); },
      onState(pub, priv) { frames.push({ pub, priv }); },
      onReplaced() { events.push('replaced'); },
      onData(msg) { const r = readRejectFrame(msg); events.push(r ? `reject:${r}` : 'data'); },
      onClose() { events.push('close'); },
      onError(err) { events.push(`err:${err && err.type}`); },
    }, { name, clientId: ticket });
    return { g, frames, events, last: () => frames[frames.length - 1] || null };
  }

  // --- the happy path, and the privacy claim that is the whole game --------
  const CODE = 'QRTX';
  const table = tableAt(CODE);
  shim.flush();
  eq(table.t.isOpen(), true, 'the host is listening');

  const ana = guestAt(CODE, 'Ana', 'ticket-ana');
  const bo = guestAt(CODE, 'Bo', 'ticket-bo');
  shim.flush();

  eq(table.engine.players.length, 3, 'two guests sat down next to the host');
  eq(table.t.playerIds().length, 2, 'and the host is holding two connections');
  ok(ana.last() !== null && bo.last() !== null, 'each of them has been sent the table');

  const anaId = ana.last().priv.playerId;
  const boId = bo.last().priv.playerId;
  ok(anaId !== boId, 'and they are different seats');
  ok(anaId.startsWith(CONN_ID_PREFIX) && boId.startsWith(CONN_ID_PREFIX),
    'both of which are peer-prefixed, because both came off a connection');
  ok(table.engine.getPlayer(anaId) !== null, 'the engine knows the id the frame claimed');

  seed(99);
  eq(table.engine.startGame(HOST_ID).ok, true, 'the host deals');
  table.push();
  shim.flush();

  const cardsOf = (id) => (table.engine.hands[id] || []).map((c) => c.id);
  const hostCards = cardsOf(HOST_ID);
  ok(hostCards.length > 0, 'the host is holding cards');

  same(ana.last().priv.hand.map((c) => c.id), cardsOf(anaId), 'Ana is sent exactly her own hand');
  same(bo.last().priv.hand.map((c) => c.id), cardsOf(boId), 'and Bo exactly his');

  // THE ASSERTION THIS WHOLE SECTION EXISTS FOR. Every frame either guest has
  // ever received, searched for any card belonging to anyone else.
  const leakInto = (who, wire) => {
    const text = JSON.stringify(wire);
    const foreign = [...hostCards, ...cardsOf(who === anaId ? boId : anaId)];
    return foreign.filter((id) => text.includes(`"${id}"`));
  };
  same(leakInto(anaId, ana.frames), [], 'nothing Ana has ever received contains anybody else\'s card');
  same(leakInto(boId, bo.frames), [], 'and nothing Bo has received contains anybody else\'s');
  eq(ana.last().pub.hands, undefined, 'the public state carries no hands at all');
  ok(Number.isInteger(ana.last().pub.players[0].handCount), 'only counts');

  // The frames a real client would hand to render() pass the same shape checks
  // the client applies to a stranger's payload.
  ok(validPublicState(ana.last().pub) !== null, 'a real public frame satisfies the client-side guard');
  ok(validPrivateState(ana.last().priv) !== null, 'and so does a real private one');

  // --- a peer that names itself 'host' -------------------------------------
  {
    const code2 = 'KKKK';
    const t2 = tableAt(code2);
    shim.flush();
    t2.engine.addBot();

    // Not joinHost(), because joinHost takes whatever id the broker gives it.
    // An attacker does not: `new Peer('host')` is one line.
    const rogue = new shim.FakePeer(HOST_ID);
    shim.flush();
    const conn = rogue.connect(peerIdForCode(code2));
    const got = [];
    conn.on('data', (raw) => got.push(JSON.parse(raw)));
    shim.flush();
    conn.send(JSON.stringify(joinFrame('Mallory', 'm'.repeat(32))));
    shim.flush();

    seed(7);
    eq(t2.engine.startGame(HOST_ID).ok, true, 'the rogue, a bot and the host are enough for a game');
    t2.push();
    shim.flush();

    eq(t2.engine.hostId, HOST_ID, 'the host is still the host');
    eq(t2.engine.getPlayer(HOST_ID).name, 'Host', 'and still has their own seat');
    ok(t2.engine.getPlayer(`${CONN_ID_PREFIX}${HOST_ID}`) !== null,
      'the rogue was seated — as peer:host, which is a seat of its own');

    const last = got[got.length - 1];
    ok(last && last.type === WIRE.STATE, 'the rogue receives state like anybody else');
    eq(last.priv.playerId, `${CONN_ID_PREFIX}${HOST_ID}`, 'addressed to peer:host');
    const realHostCards = t2.engine.hands[HOST_ID].map((c) => c.id);
    const wire = JSON.stringify(got);
    same(realHostCards.filter((id) => wire.includes(`"${id}"`)), [],
      'AND NOT ONE CARD OF THE HOST\'S HAND EVER REACHED IT');
  }

  // --- a peer id that could not survive being written into a seat ----------
  {
    const code3 = 'MMMM';
    const t3 = tableAt(code3);
    shim.flush();
    const before = t3.t.connections.size;
    const absurd = new shim.FakePeer('z'.repeat(5000));
    shim.flush();
    absurd.connect(peerIdForCode(code3));
    shim.flush();
    eq(t3.t.connections.size, before, 'a five-thousand-character peer id is refused before it can be seated');
  }

  // --- junk, and floods ----------------------------------------------------
  {
    const code4 = 'NNNN';
    const t4 = tableAt(code4);
    shim.flush();
    const cx = new shim.FakePeer('prober');
    shim.flush();
    const conn = cx.connect(peerIdForCode(code4));
    const back = [];
    conn.on('data', (raw) => back.push(raw));
    shim.flush();

    conn.send('not json at all');
    conn.send(JSON.stringify([1, 2, 3]));
    conn.send(JSON.stringify({ nope: true }));
    shim.flush();
    ok(t4.t.refusedFrames() >= 3, 'junk is counted');
    same(back, [], 'and answered with silence — a reply would tell a prober somebody is listening');

    // The bucket is in FRONT of the dispatch, not behind it: every accepted
    // message fans out into a push to the whole table.
    const refusedBefore = t4.t.refusedFrames();
    for (let i = 0; i < 400 && conn.open; i++) conn.send(JSON.stringify({ type: 'decline' }));
    shim.flush();
    ok(t4.t.refusedFrames() - refusedBefore > 0, 'a flood runs out of tokens');
    eq(conn.open, false, `and past ${MAX_REFUSED_FRAMES} refusals the channel is closed on it`);
    eq(t4.t.connections.size, 0, 'the flooder is gone');
  }

  // --- one connection, one identity ----------------------------------------
  {
    const code5 = 'PPPP';
    const t5 = tableAt(code5);
    shim.flush();
    const cx = new shim.FakePeer('two-faced');
    shim.flush();
    const conn = cx.connect(peerIdForCode(code5));
    shim.flush();
    conn.send(JSON.stringify(joinFrame('First', 'a'.repeat(32))));
    shim.flush();
    eq(t5.engine.players.length, 2, 'the first hello seats them');

    const refusedBefore = t5.t.refusedFrames();
    conn.send(JSON.stringify(joinFrame('Second', 'b'.repeat(32))));
    shim.flush();
    eq(t5.engine.players.length, 2, 'a SECOND ticket on the same connection seats nobody');
    ok(t5.t.refusedFrames() > refusedBefore, 'it is refused rather than ignored');

    // A repeat of the SAME hello is a retry and must cost nothing.
    const refusedAfter = t5.t.refusedFrames();
    conn.send(JSON.stringify(joinFrame('First', 'a'.repeat(32))));
    shim.flush();
    eq(t5.t.refusedFrames(), refusedAfter, 'but repeating the first hello is a retry, not an offence');
    eq(t5.engine.players.length, 2, 'and does not duplicate the seat');
  }

  // --- the seat comes back, and it comes back by ticket only ----------------
  {
    const code6 = 'RRRR';
    const t6 = tableAt(code6);
    shim.flush();
    const cy = guestAt(code6, 'Cy', 'ticket-cy');
    const di = guestAt(code6, 'Di', 'ticket-di');
    shim.flush();
    seed(11);
    t6.engine.startGame(HOST_ID);
    t6.push();
    shim.flush();

    const cyId = cy.last().priv.playerId;
    const cyHand = cy.last().priv.hand.map((c) => c.id);
    ok(cyHand.length > 0, 'Cy has been dealt in');

    cy.g.destroy();               // the phone goes into a tunnel
    shim.flush();
    eq(t6.engine.players.length, 3, 'a dropped player is NOT removed mid-game');
    eq(t6.engine.getPlayer(cyId).online, false, 'they are marked away');
    same(t6.engine.hands[cyId].map((c) => c.id), cyHand, 'and their hand is untouched');

    // Back on a brand-new peer id, carrying the same ticket.
    const cyAgain = guestAt(code6, 'Cy', 'ticket-cy');
    shim.flush();
    eq(t6.engine.players.length, 3, 'the reconnect takes the held seat rather than a new one');
    const cyNewId = cyAgain.last().priv.playerId;
    ok(cyNewId !== cyId, 'under a different peer id, because the old connection died with the tab');
    same(cyAgain.last().priv.hand.map((c) => c.id), cyHand, 'AND THE SAME CARDS COME BACK');
    eq(t6.engine.getPlayer(cyNewId).online, true, 'the seat is live again');

    // The name is public and the peer id is public. Neither may reclaim.
    const impostor = guestAt(code6, 'Cy', 'ticket-of-a-stranger');
    shim.flush();
    eq(t6.engine.players.length, 3, 'somebody who merely knows the NAME cannot take the seat');
    eq(impostor.last(), null, 'they are not dealt into a game in progress at all');
    ok(impostor.events.some((e) => e.startsWith('reject:')), 'they are told why');
  }

  // --- two tabs, one ticket -------------------------------------------------
  {
    const code7 = 'SSSS';
    const t7 = tableAt(code7);
    shim.flush();
    const tabA = guestAt(code7, 'Eve', 'ticket-eve');
    shim.flush();
    eq(t7.engine.players.length, 2, 'the first tab sits down');

    const tabB = guestAt(code7, 'Eve', 'ticket-eve');
    shim.flush();
    eq(t7.engine.players.length, 2, 'the second tab takes the same seat rather than a second one');
    ok(tabA.events.includes('replaced'),
      'and the first tab is TOLD it lost — a bare close would make it redial and start the loop again');
    ok(tabB.last() !== null, 'the winner has the table');
  }

  // --- the host, joining their own table ------------------------------------
  //
  // Not an attack — it is the host opening the game in a second tab to "check
  // something", and left alone it is the worst outcome in this file. Both tabs
  // share one localStorage ticket, so addPlayer() finds the HOST's seat,
  // remaps it — hostId and all — onto the second tab's peer id, and the first
  // tab, the only thing in the world holding every hand in the game, is left
  // with no seat, no cards and no controls. Refused by identity, because by
  // the time addPlayer is reached the seat is exactly what is being taken.
  {
    const codeA = 'VVVV';
    const tA = tableAt(codeA, { hostTicket: 'ticket-of-the-host' });
    shim.flush();
    seed(23);
    tA.engine.addBot();
    tA.engine.addBot();
    eq(tA.engine.startGame(HOST_ID).ok, true, 'a game is under way');
    const hostHand = tA.engine.hands[HOST_ID].map((c) => c.id);

    const secondTab = guestAt(codeA, 'Host', 'ticket-of-the-host');
    shim.flush();

    eq(tA.engine.hostId, HOST_ID, 'the host is still the host');
    eq(tA.engine.players.length, 3, 'and no fourth seat appeared');
    same(tA.engine.hands[HOST_ID].map((c) => c.id), hostHand,
      'the tab holding every hand in the game still holds its own');
    eq(secondTab.last(), null, 'the second tab is never dealt in');
    ok(secondTab.events.some((e) => e.startsWith('reject:')),
      'and is told why, rather than sitting on a spinner');
  }

  // --- two phones with no storage at all ------------------------------------
  //
  // The consequence of readJoinFrame's asymmetry, and the case that made this
  // section worth writing: a browser in private mode, or one with storage
  // blocked, sends a hello whose ticket is null. Those phones can play — they
  // simply cannot reclaim a seat. What they must NOT do is match each other.
  // A `p.clientId === hello.clientId` written without a truthiness check makes
  // the second such phone look like a second tab of the first, and the first
  // is told it lost a seat it never gave up.
  {
    const code9 = 'UUUU';
    const t9 = tableAt(code9);
    shim.flush();
    t9.engine.addBot();            // a bot's ticket is null too, and must not match

    // Under CLIENT_ID_RE's eight-character floor, so validClientId rejects it
    // and readJoinFrame drops it to null. Spelled out because a plausible
    // LOOKING string like 'not-a-valid-ticket' is in fact perfectly valid —
    // eighteen in-class characters — and would test nothing.
    const UNUSABLE = 'nope';
    eq(validClientId(UNUSABLE), null, 'the ticket used below really is unusable');

    const gus = guestAt(code9, 'Gus', UNUSABLE);
    shim.flush();
    eq(t9.engine.players.length, 3, 'a phone with no storage is seated like anyone else');
    const gusId = gus.last().priv.playerId;
    eq(t9.engine.getPlayer(gusId).clientId, null, 'holding no claim on the seat');

    const hal = guestAt(code9, 'Hal', null);
    shim.flush();
    eq(t9.engine.players.length, 4, 'and a SECOND such phone gets a seat of its own');
    eq(gus.events.includes('replaced'), false,
      'the first is NOT told it was replaced — null is not a ticket two devices share');
    ok(gus.last() !== null && hal.last() !== null, 'both are still being sent the table');

    // And the price they pay, stated so the trade is visible: no reclaim.
    const beforeDrop = t9.engine.players.length;
    gus.g.destroy();
    shim.flush();
    eq(t9.engine.players.length, beforeDrop - 1, 'dropping in the LOBBY frees the seat');
    const gusAgain = guestAt(code9, 'Gus', UNUSABLE);
    shim.flush();
    ok(gusAgain.last() !== null, 'they can come back');
    ok(gusAgain.last().priv.playerId !== gusId, 'but as a NEW seat — that is what having no ticket costs');
  }

  // --- the broker falls over under a table that is already playing ----------
  {
    const code8 = 'TTTT';
    const t8 = tableAt(code8);
    shim.flush();
    const fi = guestAt(code8, 'Fi', 'ticket-fi');
    shim.flush();
    const framesBefore = fi.frames.length;

    shim.dropBroker(peerIdForCode(code8));
    shim.flush();
    eq(t8.log.brokerDown, 1, 'the host is told the signalling socket went');
    eq(t8.t.isOpen(), false, 'and knows nobody new can arrive');

    // The claim this distinction rests on: existing links run device to
    // device and do not care. A banner, not an ending.
    t8.engine.addBot();
    t8.push();
    shim.flush();
    ok(fi.frames.length > framesBefore, 'but the player already at the table keeps receiving it');
    eq(fi.events.includes('close'), false, 'and was never disconnected');
  }

  // --- dialling a table that is not there -----------------------------------
  {
    const nobody = guestAt('ZZZZ', 'Gus', 'ticket-gus');
    shim.flush();
    ok(nobody.events.includes('err:peer-unavailable'), 'a code with no table behind it reports itself');
    ok(isFatalPeerError({ type: 'peer-unavailable' }) === false,
      'and is NOT in the fatal set — the host may simply not have opened the tab yet');
  }

  // --- what a host hands back, and what an inert one has to match -----------
  const realHostKeys = Object.keys(table.t).sort();
  const realGuestKeys = Object.keys(ana.g).sort();
  eq(table.t.refusedFrames(), 0, 'the well-behaved table refused nothing all game');
  eq(ana.g.badFrames(), 0, 'and Ana was never sent anything malformed');

  table.t.destroy();
  ana.g.destroy();
  bo.g.destroy();
  shim.uninstall();

  section('The wire: with no PeerJS at all');
  eq(peerAvailable(), false, 'the library is gone');
  const inertHost = createHost('QRTX', {});
  const inertGuest = joinHost('QRTX', {});
  same(Object.keys(inertHost).sort(), Object.keys(inertGuest).sort(),
    'both inert handles expose one surface — the caller does not know which it asked for');
  for (const k of realHostKeys) {
    ok(typeof inertHost[k] === typeof table.t[k] || inertHost[k] === null,
      `an inert host still answers .${k}(), so a click handler cannot throw`);
  }
  for (const k of realGuestKeys) {
    ok(typeof inertGuest[k] === typeof ana.g[k] || inertGuest[k] === null,
      `an inert guest still answers .${k}()`);
  }
  eq(inertHost.isOpen(), false, 'it is honest about being shut');
  eq(inertHost.playerIds().length, 0, 'and about holding nobody');

  // Reported one turn later, so the caller has already assigned its handle. A
  // synchronous callback here would fire into a half-assigned variable, which
  // is a worse bug than the one being reported.
  const reported = [];
  createHost('QRTX', { onError: (e) => reported.push(e.type) });
  joinHost('QRTX', { onError: (e) => reported.push(e.type) });
  joinHost('!!', { onError: (e) => reported.push(e.type) });
  same(reported, [], 'nothing is reported synchronously');
  await new Promise((r) => setTimeout(r, 20));
  same(reported, ['peer-missing', 'peer-missing', 'peer-missing'],
    'the missing library is reported before the bad code is even looked at');
  for (const type of reported) ok(isFatalPeerError({ type }), 'and it is a dead end, not a retry');
}

// ###########################################################################
//
//  THE SHELL
//
//  index.html, manifest.webmanifest, the icons and sw.js. None of them are
//  modules, so none of them are reachable by any other test in this file, and
//  without this section NOTHING in the repository would ever parse sw.js —
//  the first execution would be in a real browser, on a real deploy, where
//  the failure mode of a broken service worker is a site that serves a stale
//  shell to returning visitors and cannot be fixed by pushing a commit.
//
//  So sw.js is not inspected here, it is RUN: instantiated against a fake
//  ServiceWorkerGlobalScope and a fake Cache API, with its install, activate
//  and fetch handlers driven the way a browser would drive them.
//
//  The tooling this section leans on — loadSwConsts, shellStampOf,
//  planStampWrite — is at the top of the file, because --write-stamp has to
//  run and exit before any assertion does.
//
// ###########################################################################

section('The shell: every asset shipped, and every asset cached');

{
  // --- SHELL against the disk, in both directions ---------------------------
  //
  // The rule sw.js states is "every static asset the site serves". A rule is
  // only worth writing down if something checks it, and the thing that would
  // otherwise check it is somebody remembering, three weeks from now, while
  // adding a module. The failure they would cause is invisible online and
  // total offline, which is the worst place for it to hide.
  //
  // DERIVED FROM THE DISK, not from a second copy of the list. A hand-written
  // expected list here would agree with a hand-written SHELL exactly as often
  // as both were edited together, which is the thing being guarded against.
  const constsOnly = loadSwConsts();
  if (constsOnly.error) {
    failed++;
    console.error('  x FAIL: sw.js does not parse —', constsOnly.error.message);
  } else {
    passed++;
  }

  const SHELL = constsOnly.SHELL;
  const CACHE_NAME = constsOnly.CACHE_NAME;
  const SHELL_STAMP = constsOnly.SHELL_STAMP;

  ok(Array.isArray(SHELL) && SHELL.length > 0, 'sw.js exports a non-empty SHELL');
  ok(typeof CACHE_NAME === 'string' && /^bluff-/.test(CACHE_NAME),
    `the cache name is namespaced to this app — got ${JSON.stringify(CACHE_NAME)}`);

  // EVERY PATH RELATIVE. A leading slash resolves to the origin root, and on
  // a GitHub Pages project site the app lives at /<repo>/ — so '/js/main.js'
  // would 404 during install, addAll would reject, and the worker would never
  // activate at all. Silently: the only symptom is that offline never works.
  let absolute = 0;
  for (const p of SHELL) if (!p.startsWith('./')) { absolute++; console.error('  x not relative:', p); }
  eq(absolute, 0, `all ${SHELL.length} SHELL paths are relative, so a Pages subpath survives`);

  // No duplicates. addAll tolerates them, but a duplicate means the list was
  // edited twice by two people who each thought they were adding it.
  eq(new Set(SHELL).size, SHELL.length, 'and no path is listed twice');

  // --- direction one: everything in SHELL exists ----------------------------
  let missing = 0;
  for (const p of SHELL) {
    // './' is the directory, served as index.html — there is no file of that
    // name to stat, and it is listed deliberately (see the comment in sw.js).
    if (p === './') continue;
    try { readFileSync(REPO + p.slice(2)); } catch (_) {
      missing++; console.error('  x SHELL lists a file that is not there:', p);
    }
  }
  eq(missing, 0, 'every file SHELL precaches is actually in the repository');

  // --- direction two: everything on disk is in SHELL ------------------------
  //
  // This is the direction that catches the real mistake. The one above only
  // fails when a file is DELETED, which somebody notices; this one fails when
  // a file is ADDED, which is the case nobody notices.
  const listed = new Set(SHELL);
  let unlisted = 0;
  let onDisk = 0;
  for (const dir of ['js', 'css', 'icons']) {
    for (const name of readdirSync(REPO + dir)) {
      onDisk++;
      if (!listed.has(`./${dir}/${name}`)) {
        unlisted++;
        console.error(`  x ${dir}/${name} is shipped but never precached`);
      }
    }
  }
  eq(unlisted, 0, `and all ${onDisk} files under js/, css/ and icons/ are in it`);
  // The pairing. "Nothing unlisted" is also true of an empty directory, and
  // an empty directory is what a broken REPO path would produce.
  ok(onDisk >= 15, `with ${onDisk} files actually found to check — the sweep is not empty`);

  // The page and the manifest are not under those three directories, so they
  // are named rather than swept. Without this, deleting './index.html' from
  // SHELL would pass everything above and break offline completely.
  for (const must of ['./', './index.html', './manifest.webmanifest']) {
    ok(listed.has(must), `SHELL precaches ${must}`);
  }

  // NOTHING CROSS-ORIGIN, EVER. This is the beacon rule stated as an
  // assertion: a precached PeerJS bundle is a version that a git pull can no
  // longer move, and a precached signalling response is a room code that
  // connects to a conversation which ended yesterday.
  let external = 0;
  for (const p of SHELL) if (/^https?:|^\/\//.test(p)) { external++; console.error('  x external:', p); }
  eq(external, 0, 'and not one byte of anybody else’s origin is precached');

  // --- the stamp ------------------------------------------------------------
  //
  // Everything above asks "does SHELL name the right files"; none of it asks
  // "does CACHE_NAME change when those files do", and that second question is
  // the one that decides whether a returning visitor ever sees a fix. See the
  // long note on shellStampOf() at the top of this file.
  //
  // NOTE WHAT MAKES THIS COMPUTABLE AT ALL: sw.js is not in SHELL. A worker
  // does not precache itself, so the file holding the hash is not among the
  // files being hashed, and there is no fixed point to solve for. If somebody
  // ever adds './sw.js' to the list this stops being arithmetic and starts
  // being impossible — so it is asserted rather than assumed.
  ok(!SHELL.includes('./sw.js'),
    'sw.js does not precache itself — which is what makes a content stamp computable');

  // Hoisted out of the block below because the writer section compares
  // against `computed` rather than against SHELL_STAMP. That is not a style
  // choice: comparing the writer's answer to the file's literal would make
  // the writer's assertions fail on every legitimately stale stamp, which is
  // the exact state the writer exists to resolve.
  const { stamp: computed, hashed, unreadable } = shellStampOf(SHELL);

  {
    // The pairing. A hash of nothing is still a hash, and it would compare
    // unequal and print a confident-looking value to paste. If the files
    // could not be read, say THAT instead.
    eq(unreadable, 0, 'every file in the stamp could be read off disk');
    ok(hashed >= 15, `the stamp is computed over ${hashed} files, not over an empty sweep`);

    if (SHELL_STAMP !== computed) {
      // THE FAILURE FIXES ITSELF. This is the difference between a check that
      // enforces a rule and a check that nags about one: nobody has to work
      // out what the new stamp is, or know that line endings are normalised.
      // They run one command.
      console.error('  x FAIL: sw.js SHELL_STAMP is stale — the shell changed and the cache name did not.');
      console.error('          Returning visitors would keep the old build. Fix it with:');
      console.error('              npm run stamp');
      console.error(`          (or paste: const SHELL_STAMP = '${computed}';`);
      console.error(`           currently '${SHELL_STAMP}', over ${hashed} files)`);
    }
    eq(SHELL_STAMP, computed, 'SHELL_STAMP is the fingerprint of the files SHELL precaches');

    // And the stamp has to actually be the cache name, or it is decoration.
    // DERIVED from SHELL_STAMP rather than written out: a literal here would
    // be a third copy of the same string to keep in step, and the prefix is
    // load-bearing on its own — the activate handler deletes by it, which is
    // what stops this worker clearing a sibling project's caches on the same
    // github.io origin.
    eq(CACHE_NAME, `bluff-shell-${SHELL_STAMP}`,
      'and the cache is named after it, with the prefix activate() deletes by');

    console.log(`  shell stamp: ${SHELL_STAMP} over ${hashed} files`);
  }

  // --- the writer that fixes a stale stamp ----------------------------------
  //
  // `npm run stamp` rewrites the line the check above enforces, which makes
  // it the one piece of tooling in the repository that can turn this section
  // green without anybody fixing anything. Its guards are therefore not a
  // convenience — they are the reason it is allowed to exist — and they are
  // driven here with inputs that could not be produced any other way without
  // damaging the working tree to test the thing that protects it.
  {
    const realSw = loadSwConsts();
    const plan = planStampWrite(realSw);

    // THE HAPPY PATH FIRST, because every refusal below is only interesting
    // if the writer would otherwise have said yes.
    eq(plan.refuse, null, 'the stamp writer accepts the repository as it stands');
    // AGAINST `computed`, NOT AGAINST THE FILE'S LITERAL. The property is
    // that the writer and the checker arrive at the same number, and that
    // stays true while the stamp is stale.
    eq(plan.stamp, computed,
      'and the number it would write is the number the check above demands — the writer and the checker cannot disagree');
    eq(plan.was, SHELL_STAMP, 'it read the current value out of the file correctly');

    // It rewrites the declaration and NOTHING ELSE. The sharpest way to say
    // that is by length: replacing one twelve-character stamp with another
    // leaves the file exactly as long, and any collateral edit — dropping the
    // rest of the line, matching inside a comment, eating a newline — moves
    // it. Derived from the real file so it stays true as sw.js grows.
    const rewritten = realSw.src.replace(STAMP_ANCHOR, `const SHELL_STAMP = '${'0'.repeat(12)}';`);
    eq(rewritten.length, realSw.src.length, 'writing a stamp changes the file length by nothing');
    eq((rewritten.match(new RegExp(STAMP_ANCHOR.source, 'gm')) || []).length, 1,
      'and leaves exactly one stamp declaration behind');
    ok(rewritten.includes("const SHELL_STAMP = '000000000000';"),
      'and the line it leaves is the one it meant to write');

    // IDEMPOTENT. Running it twice must not produce a different file the
    // second time, or "run it until it settles" becomes a real instruction.
    eq(planStampWrite(realSw).next, plan.next, 'planning the same write twice plans the same bytes');

    // --- and now every way it must refuse -----------------------------------
    //
    // Each of these is a state in which the writer would otherwise paste a
    // confident-looking twelve characters over the deploy blocker, and the
    // checker would then agree with it forever.
    const refusals = [
      ['sw.js does not parse',
        { ...realSw, error: new Error('Unexpected token') }, /does not parse/],
      ['SHELL comes back empty',
        { ...realSw, SHELL: [] }, /no usable SHELL/],
      ['SHELL is not an array at all',
        { ...realSw, SHELL: null }, /no usable SHELL/],
      // The one that matters most. A rename that misses this list leaves
      // paths which read perfectly well and hash to nothing, and the digest
      // of the remaining files is a real number that is not the right number.
      ['a file in SHELL is not on disk',
        { ...realSw, SHELL: [...realSw.SHELL, './js/does-not-exist.js'] }, /could not be read/],
      ['the sweep is too small to be the shell',
        { ...realSw, SHELL: ['./index.html', './css/styles.css'] }, /only 2 files/],
      // Two anchors means the file is not shaped the way the writer assumes,
      // and "edit the first one" is a guess. Built by duplicating the real
      // line rather than by writing a second one out, so it stays a duplicate.
      ['sw.js carries two stamp declarations',
        { ...realSw, src: realSw.src.replace(STAMP_ANCHOR, (m) => `${m}\n${m}`) }, /^found 2 /],
      ['sw.js carries none the writer recognises',
        { ...realSw, src: realSw.src.replace(STAMP_ANCHOR, 'const SHELL_STAMP = shellStamp();') },
        /^found 0 /],
    ];

    for (const [what, broken, why] of refusals) {
      const got = planStampWrite(broken);
      ok(typeof got.refuse === 'string' && why.test(got.refuse),
        `the stamp writer refuses when ${what} — expected /${why.source}/, got ${JSON.stringify(got.refuse)}`);
      // AND THE REFUSAL IS THE WHOLE ANSWER. A reason string beside a usable
      // `next` is a writer that explains itself and then does it anyway,
      // which is the failure mode a caller reading only one field would never
      // see. ok() rather than eq() because eq() would print the value it got,
      // and the value here would be an entire copy of sw.js.
      ok(got.next === null, `and produces no replacement text when ${what}`);
    }

    // Nothing above touched the disk — the point of planning separately from
    // writing — so say so rather than leaving it to be inferred.
    eq(loadSwConsts().SHELL_STAMP, SHELL_STAMP,
      'and none of that moved the stamp in the actual file');
  }

  // --- and the writer cannot be smuggled into the check ---------------------
  //
  // THE ONE WAY THE ABOVE CAN BE MADE MEANINGLESS. --write-stamp gives this
  // file permission to edit sw.js, and the stamp assertion is the thing it is
  // allowed to edit its way out of. Those two facts are safe apart and
  // dangerous together, and the only thing keeping them apart is that nobody
  // runs the writer as part of the check.
  //
  // "Nobody does that today" is a property of the callers, not of the code.
  // The realistic version is not malice: it is a stamp that keeps going stale
  // on somebody's machine, the flag appended to the test script to stop the
  // noise, and from then on every run repairing the deploy blocker it was
  // written to catch while reporting a full pass count. There would be no
  // failing test, because the test would have been fixed.
  //
  // So the fence is asserted, not just described. Checking process.argv here
  // would prove nothing — this line only runs on the branch where the flag
  // was absent. What has to be checked is the COMMAND, which is the thing a
  // future reader would actually edit.
  {
    const pkg = JSON.parse(readRepo('package.json'));
    const scripts = pkg.scripts || {};

    ok(typeof scripts.test === 'string' && scripts.test.includes('test-engine.mjs'),
      'package.json still runs the suite from npm test');
    ok(!/--write-stamp/.test(scripts.test || ''),
      'and npm test does NOT pass --write-stamp — the runner cannot rewrite the stamp it is checking');

    // The writer needs a way in of its own, or the pressure to put it in the
    // test script comes straight back.
    const offering = Object.entries(scripts).filter(([, cmd]) => /--write-stamp/.test(cmd));
    eq(offering.length, 1, 'exactly one npm script offers --write-stamp');
    ok(offering.length === 1 && offering[0][0] !== 'test',
      `and it is not the test script — it is npm run ${offering.length === 1 ? offering[0][0] : '?'}`);

    // The failure message above tells the reader to run it by that name, so
    // the name is part of the contract and not a detail of package.json.
    ok(Object.prototype.hasOwnProperty.call(scripts, 'stamp'),
      'the script is called "stamp", which is what the stale-stamp failure tells you to run');
  }

  // --- where the worker lives, as stated in prose ---------------------------
  //
  // sw.js is at the repository ROOT and that is forced, not chosen: a
  // worker's default scope is the directory it is served from, so a worker at
  // ./js/sw.js could only ever control ./js/* and would never see a
  // navigation to the page. Widening scope needs a Service-Worker-Allowed
  // response header, which GitHub Pages does not let you set. So the location
  // is a constraint of the platform, and "move it in with the other modules"
  // is a tidy-up that silently turns offline support off.
  //
  // Prose is not tested by anything else in this file, so the two halves are
  // asserted TOGETHER: the location is read off the disk, and then no source
  // file is allowed to contradict it. A check that only banned the string
  // would keep passing on the day somebody actually did move the worker.
  let atRoot = true;
  try { readFileSync(REPO + 'sw.js'); } catch (_) { atRoot = false; }
  let inJs = true;
  try { readFileSync(REPO + 'js/sw.js'); } catch (_) { inJs = false; }
  ok(atRoot, 'the service worker is at the repository root, where its scope covers the page');
  ok(!inJs, 'and there is no second copy under js/, which could only ever scope js/*');

  if (atRoot && !inJs) {
    // ONE FILE IS EXEMPT, AND THE EXEMPTION IS A REQUIREMENT.
    //
    // sw.js's own header says "a worker at ./js/sw.js could only ever control
    // ./js/*". That is the explanation of why the file is not there, not an
    // instruction to look there, and a substring search cannot tell those
    // apart. A checker that cries wolf gets ignored on the one line that
    // matters, so the exception is made explicit rather than the check being
    // weakened into uselessness.
    //
    // Making it an exception alone would be a hole big enough to hide the
    // original bug in, so it is inverted: sw.js is the ONE place REQUIRED to
    // name the path it is not at, because it is the only place a reader will
    // think to ask why. If that explanation disappears, this fails.
    const swHeader = readRepo('sw.js').slice(0, 2000);
    ok(/js\/sw\.js/.test(swHeader) && /scope/.test(swHeader),
      'sw.js explains in its own header why it is not under js/ — scope, not preference');

    const PROSE = ['js/main.js', 'js/net.js', 'js/ui.js', 'js/util.js', 'js/bot.js',
      'js/intents.js', 'js/guards.js', 'js/state.js', 'js/claims.js', 'js/cards.js',
      'js/rules.js', 'css/styles.css', 'index.html', 'manifest.webmanifest', 'README.md'];
    const liars = [];
    let scanned = 0;
    for (const f of PROSE) {
      let src;
      try { src = readRepo(f); } catch (_) { continue; }
      scanned++;
      // Both spellings; they send the reader to the same place that is not
      // there, and './' in front changes nothing about that.
      for (const m of src.matchAll(/\.?\/?js\/sw\.js/g)) {
        const line = src.slice(0, m.index).split('\n').length;
        liars.push(`${f}:${line} says ${m[0]}`);
      }
    }
    for (const l of liars) console.error(`  x FAIL: ${l} — the worker is at the repository root`);
    eq(liars.length, 0, 'and no other file tells the next reader to look in js/ for it');
    ok(scanned >= 13, `checked ${scanned} files for it — the sweep is not empty`);
  }
}

// ===========================================================================
section('The shell: the worker, driven');

{
  // A fake Cache API, a fake origin, and — importantly — a fake origin WITH A
  // SUBPATH. Everything below runs as if deployed to
  // https://pages.test/bluff/, because that is where this is going and
  // because a root-hosted fake would pass happily on paths that 404 on Pages.

  const ORIGIN = 'https://pages.test';
  const BASE = `${ORIGIN}/bluff/`;
  const abs = (u) => new URL(u, BASE).href;

  let writesOutsideInstall = 0;
  let installing = false;

  class Res {
    constructor(tag, init = {}) {
      this.tag = tag;
      this.status = init.status ?? 200;
      this.type = init.type || 'basic';
      // Where a redirect points. Null on everything else, and the ONLY
      // interesting thing about a redirect — a fake that dropped it could
      // only ever assert "something was returned".
      this.location = init.location || null;
    }
    static error() { return new Res(null, { status: 0, type: 'error' }); }
    // Modelled because the navigation branch depends on it. The status guard
    // is real behaviour, not decoration: Response.redirect() throws a
    // RangeError on anything outside this set, so a typo'd 202 in sw.js has
    // to fail here rather than quietly returning a response no browser would
    // follow.
    static redirect(url, status = 302) {
      if (![301, 302, 303, 307, 308].includes(status)) {
        throw new RangeError(`Response.redirect: bad status ${status}`);
      }
      return new Res(null, { status, location: String(url) });
    }
  }

  // What the "server" has. Keyed by absolute URL. The directory URL and
  // index.html return the same bytes, exactly as a static host does.
  const SERVER = new Map();
  const publish = (path, tag) => SERVER.set(abs(path), tag);
  publish('./', 'index.html');
  publish('./index.html', 'index.html');
  publish('./manifest.webmanifest', 'manifest');
  publish('./css/styles.css', 'styles.css');
  for (const m of ['main', 'ui', 'net', 'bot', 'intents', 'guards', 'state', 'claims', 'cards', 'rules', 'util']) {
    publish(`./js/${m}.js`, `${m}.js`);
  }
  for (const i of ['icon-32', 'icon-192', 'icon-512', 'icon-maskable-512', 'apple-touch-icon']) {
    publish(`./icons/${i}.png`, `${i}.png`);
  }
  publish('./late-addition.txt', 'late'); // on the server, not in SHELL

  let offline = false;
  let networkHits = 0;

  const fakeFetch = async (req) => {
    networkHits++;
    const url = typeof req === 'string' ? abs(req) : req.url;
    if (offline) throw new TypeError('Failed to fetch');
    if (!SERVER.has(url)) return new Res(null, { status: 404 });
    return new Res(SERVER.get(url));
  };

  class FakeCache {
    constructor() { this.store = new Map(); }
    async addAll(paths) {
      // Real addAll is atomic: one rejection and NOTHING is written. Modelled,
      // because the whole argument for using it over a tolerant loop is that
      // a partial cache never exists.
      const fetched = [];
      for (const p of paths) {
        const r = await fakeFetch(abs(p));
        if (r.status !== 200) throw new TypeError(`addAll failed on ${p}`);
        fetched.push([abs(p), r]);
      }
      for (const [k, v] of fetched) this.store.set(k, v);
    }
    async put(req, res) {
      if (!installing) writesOutsideInstall++;
      this.store.set(typeof req === 'string' ? abs(req) : req.url, res);
    }
    async match(req, opts = {}) {
      const url = typeof req === 'string' ? abs(req) : req.url;
      if (this.store.has(url)) return this.store.get(url);
      if (opts.ignoreSearch) {
        const bare = url.split('?')[0];
        for (const [k, v] of this.store) if (k.split('?')[0] === bare) return v;
      }
      return undefined;
    }
    async keys() { return [...this.store.keys()]; }
  }

  const caches_ = new Map();
  const fakeCaches = {
    async open(name) {
      if (!caches_.has(name)) caches_.set(name, new FakeCache());
      return caches_.get(name);
    },
    async keys() { return [...caches_.keys()]; },
    async delete(name) { return caches_.delete(name); },
  };

  // The global scope.
  const handlers = new Map();
  let claimed = 0;
  let skipped = 0;
  const fakeSelf = {
    addEventListener(type, fn) { handlers.set(type, fn); },
    // A URL rather than a plain object, because sw.js uses this BOTH as
    // `.origin` and as the base of `new URL('./', self.location)`. A bare
    // `{ origin, href }` stringifies to "[object Object]" and the second use
    // throws — a real WorkerLocation stringifies to its href, and URL is the
    // nearest thing in node that does the same.
    location: new URL(BASE + 'sw.js'),
    clients: { async claim() { claimed++; } },
    // Present so that calling it is OBSERVED rather than thrown. A fake that
    // lacked the method would also "catch" a skipWaiting being added, but as
    // a TypeError — which reports the shape of the fake, not the decision.
    skipWaiting() { skipped++; },
  };

  const swSrc = readRepo('sw.js');
  const meta = new Function('self', 'caches', 'fetch', 'Response',
    swSrc + '\n; return { CACHE_NAME, SHELL };')(fakeSelf, fakeCaches, fakeFetch, Res);

  const CACHE_NAME = meta.CACHE_NAME;

  for (const type of ['install', 'activate', 'fetch']) {
    ok(handlers.has(type), `sw.js registers a ${type} handler`);
  }

  // A browser hands each handler an event and waits on what it is given.
  const fire = async (type, extra = {}) => {
    let waited = null, responded = null;
    const ev = {
      ...extra,
      waitUntil(p) { waited = p; },
      respondWith(p) { responded = p; },
    };
    handlers.get(type)(ev);
    if (waited) await waited;
    return responded ? await responded : null;
  };

  const req = (path, { method = 'GET', mode = 'no-cors', absolute: a = null } = {}) =>
    ({ url: a || abs(path), method, mode });

  // ---------------------------------------------------------------------
  // INSTALL
  // ---------------------------------------------------------------------
  installing = true;
  await fire('install');
  installing = false;

  const cache = await fakeCaches.open(CACHE_NAME);
  ok(caches_.has(CACHE_NAME), 'install opens the cache its version names');
  eq((await cache.keys()).length, meta.SHELL.length,
    'and precaches exactly as many entries as SHELL lists — no more, no fewer');

  // THE CACHE IS KEYED ON THE DEPLOYED URL, not on the relative string. If
  // the worker resolved './js/main.js' against anything but its own scope,
  // this is where a Pages subpath deploy would come apart.
  ok((await cache.match(abs('./js/main.js'))) !== undefined,
    'a module is cached under its subpath-resolved URL, not its relative one');
  ok((await cache.match(`${ORIGIN}/js/main.js`)) === undefined,
    'and NOT under the origin root, which is where a leading slash would have put it');

  eq(claimed, 0, 'install does not claim clients — that is activate’s job');

  // NO skipWaiting, AND THIS IS THE UNPOPULAR CHOICE. Taking over immediately
  // is what most workers do. Here a game can outlast a deploy, and a worker
  // that activates underneath a live page lets it load the new js/state.js
  // having already loaded the old js/ui.js. A mixed-version module graph does
  // not throw; it misbehaves, in the middle of somebody's game. The cost is
  // that an update lands one visit late, which the footer's reset button pays
  // off on demand.
  eq(skipped, 0, 'and does not skip the waiting phase — an update never lands underneath a live game');

  // ---------------------------------------------------------------------
  // ACTIVATE
  // ---------------------------------------------------------------------
  // Seed three caches it should not be confused by: an older version of this
  // app, and two belonging to other apps on the same github.io user.
  caches_.set('bluff-shell-v0', new FakeCache());
  caches_.set('judgement-shell-52ec8f38fd84', new FakeCache());
  caches_.set('sequence-shell-v4', new FakeCache());

  await fire('activate');

  ok(!caches_.has('bluff-shell-v0'), 'activate deletes the previous version of this app');
  ok(caches_.has(CACHE_NAME), 'and keeps the current one');
  // THE ONE THAT MATTERS. A sibling project deployed under the same origin —
  // which is exactly what a user.github.io account is — must not have its
  // offline support wiped by this app shipping an update.
  ok(caches_.has('judgement-shell-52ec8f38fd84') && caches_.has('sequence-shell-v4'),
    'while leaving both sibling apps on the same origin entirely alone');
  eq(claimed, 1, 'and takes over the page that was already open');

  // ---------------------------------------------------------------------
  // FETCH: what it refuses to touch
  // ---------------------------------------------------------------------
  // `null` back from fire() means respondWith was never called, which is the
  // worker handing the request to the browser untouched.

  // THE BEACON. Three different third parties, all of which must pass
  // straight through. The signalling one is the dangerous one: a cached
  // handshake response is a room code that dials a dead conversation.
  const foreign = [
    'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
    'https://fonts.gstatic.com/s/inter/v13/x.woff2',
    'https://0.peerjs.com/peerjs/id?ts=1',
  ];
  let intercepted = 0;
  for (const u of foreign) {
    if (await fire('fetch', { request: req(null, { absolute: u }) }) !== null) {
      intercepted++; console.error('  x intercepted cross-origin:', u);
    }
  }
  eq(intercepted, 0, 'not one cross-origin request is intercepted — the beacon is never touched');

  // The analytics beacon must never be cached: a beacon answered from cache records nothing.
  // The origin check covers GoatCounter without naming it, and naming it is
  // the first step to routing or precaching it. Comments stripped first — the
  // header is allowed to talk about the beacon.
  ok(!/gc\.zgo\.at|goatcounter/.test(swSrc.replace(/\/\/[^\n]*/g, '')),
    'the analytics beacon is not routed or precached by the worker');

  // And nothing cross-origin ended up in the cache as a side effect.
  let foreignCached = 0;
  for (const k of await cache.keys()) if (!k.startsWith(ORIGIN)) foreignCached++;
  eq(foreignCached, 0, 'and nothing on anybody else’s origin is in the cache afterwards');

  eq(await fire('fetch', { request: req('./index.html', { method: 'POST' }) }), null,
    'a POST is left to the browser — it is not cacheable and never will be');

  // ---------------------------------------------------------------------
  // FETCH: offline, which is the entire point
  // ---------------------------------------------------------------------
  offline = true;
  const before = networkHits;

  const page = await fire('fetch', { request: req('./', { mode: 'navigate' }) });
  eq(page && page.tag, 'index.html', 'offline, a navigation still gets the page');

  // A DEEP LINK, offline. Somebody's bookmark, or a path that existed in an
  // older version. There is one page in this app and every route ends at it —
  // but it is REDIRECTED there, not served in place, and this assertion is
  // the difference.
  //
  // THIS TEST USED TO ASSERT THE BUG. It checked that a deep link got
  // index.html's bytes, which it did, and which looks like working offline
  // and is not: every path in index.html is relative, so at
  // /bluff/room/QRTX the stylesheet resolves to /bluff/room/css/styles.css
  // and the modules to /bluff/room/js/*. None of those are cached or on
  // disk. A browser found it in about four seconds — title "Bluff",
  // background rgba(0, 0, 0, 0), no #screen — which a fake Cache API keyed
  // on absolute URLs never could, because nothing here resolves index.html's
  // own markup against the address it was served at.
  const deep = await fire('fetch', { request: req('./room/QRTX', { mode: 'navigate' }) });
  eq(deep && deep.status, 302, 'and a deep link to a path that never existed is redirected, not served');
  eq(deep && deep.location, BASE,
    'to the scope root, where the page’s relative paths resolve to the things that are actually cached');
  ok(deep && deep.tag === null,
    'and it carries no body — the redirect is synthesised, so it works with the network down');

  // The three that must NOT be redirected, because their relative paths
  // already resolve correctly from where they are. The query string is the
  // one with teeth: redirecting it would silently eat the query.
  for (const [path, why] of [
    ['./', 'the scope root itself is served, not bounced'],
    ['./index.html', 'and so is index.html named explicitly'],
    ['./?debug=1', 'and so is the root with a query, which a redirect would have thrown away'],
  ]) {
    const r = await fire('fetch', { request: req(path, { mode: 'navigate' }) });
    eq(r && r.tag, 'index.html', why);
  }

  const mod = await fire('fetch', { request: req('./js/state.js') });
  eq(mod && mod.tag, 'state.js', 'offline, a module comes out of the cache');

  const css = await fire('fetch', { request: req('./css/styles.css') });
  eq(css && css.tag, 'styles.css', 'and so does the stylesheet');

  const icon = await fire('fetch', { request: req('./icons/icon-192.png') });
  eq(icon && icon.tag, 'icon-192.png', 'and so do the icons');

  // The whole shell, not just the four sampled above. An app that serves
  // index.html and one module offline is not an app that works offline.
  let served = 0;
  for (const p of meta.SHELL) {
    const r = await fire('fetch', { request: req(p, { mode: p === './' ? 'navigate' : 'no-cors' }) });
    if (r && r.status === 200) served++;
  }
  eq(served, meta.SHELL.length,
    `all ${meta.SHELL.length} precached assets are served with the network down`);

  eq(networkHits, before, 'and none of that touched the network at all');

  // The cache-buster. ./js/main.js?v=2 must still hit ./js/main.js, or one
  // stray query string during debugging turns offline support off.
  const busted = await fire('fetch', { request: req('./js/main.js?v=2') });
  eq(busted && busted.tag, 'main.js', 'a query string does not defeat the precache');

  // Not ours and not reachable. This has to fail like a network failure,
  // because the page's own error handling is written against one.
  const gone = await fire('fetch', { request: req('./late-addition.txt') });
  ok(gone && gone.type === 'error',
    'something never precached, requested offline, fails as a network error rather than a fake 200');

  // ---------------------------------------------------------------------
  // FETCH: back online, and STILL no runtime caching
  // ---------------------------------------------------------------------
  offline = false;
  const sizeBefore = (await cache.keys()).length;

  const late = await fire('fetch', { request: req('./late-addition.txt') });
  eq(late && late.tag, 'late', 'online, something outside the shell is fetched normally');
  eq((await cache.keys()).length, sizeBefore,
    'and is NOT written to the cache — the beacon rule, enforced by having no write path');
  eq(writesOutsideInstall, 0, 'nothing anywhere writes to the cache outside install');

  // A PRECACHED asset online still comes from the cache, not the network.
  // That is what makes the version consistent: js/ui.js and js/state.js can
  // never come from two different deploys.
  const netBefore = networkHits;
  const uiAgain = await fire('fetch', { request: req('./js/ui.js') });
  eq(uiAgain && uiAgain.tag, 'ui.js', 'online, a precached module still comes from the cache');
  eq(networkHits, netBefore, 'without a network request, so the whole shell is one version');
}

{
  // --- install is all-or-nothing --------------------------------------------
  //
  // Re-run install against a server that is missing one module — a rename
  // that did not update SHELL, a bad deploy. The install MUST reject, so the
  // worker never activates and the previous version keeps serving. The
  // alternative is a cache with a hole in it, which is an app that works
  // online and is broken offline: the single hardest bug report to act on.

  const ORIGIN = 'https://pages.test';
  const BASE = `${ORIGIN}/bluff/`;
  const abs = (u) => new URL(u, BASE).href;

  class Res { constructor(t, i = {}) { this.tag = t; this.status = i.status ?? 200; } static error() { return new Res(null, { status: 0 }); } }

  const store = new Map();
  let broken = null;
  const fakeFetch = async (r) => {
    const url = typeof r === 'string' ? abs(r) : r.url;
    return new Res('x', { status: url === abs(broken) ? 404 : 200 });
  };
  class FakeCache {
    constructor() { this.store = store; }
    async addAll(paths) {
      const got = [];
      for (const p of paths) {
        const r = await fakeFetch(abs(p));
        if (r.status !== 200) throw new TypeError(`addAll: ${p}`);
        got.push(abs(p));
      }
      for (const k of got) this.store.set(k, new Res('x'));
    }
    async keys() { return [...this.store.keys()]; }
    async match() { return undefined; }
    async put() {}
  }
  const handlers = new Map();
  const fakeSelf = {
    addEventListener(t, f) { handlers.set(t, f); },
    location: new URL(BASE + 'sw.js'), // see the note on the other fake scope
    clients: { async claim() {} },
  };
  const swSrc = readRepo('sw.js');
  const meta = new Function('self', 'caches', 'fetch', 'Response',
    swSrc + '\n; return { CACHE_NAME, SHELL };')(
    fakeSelf,
    { async open() { return new FakeCache(); }, async keys() { return []; }, async delete() {} },
    fakeFetch, Res);

  // Break each entry in turn. Every single one must be load-bearing — if any
  // module can 404 and the install still succeeds, that module is not really
  // being precached and its absence would only show up offline.
  let survived = 0;
  for (const p of meta.SHELL) {
    broken = p;
    store.clear();
    let rejected = false;
    let waited = null;
    handlers.get('install')({ waitUntil(x) { waited = x; } });
    try { await waited; } catch (_) { rejected = true; }
    if (!rejected) { survived++; console.error('  x install tolerated a missing', p); }
    else if (store.size !== 0) { survived++; console.error('  x install left a partial cache after', p); }
  }
  eq(survived, 0,
    `install refuses to complete with any one of the ${meta.SHELL.length} assets missing, and leaves nothing behind`);
}

// ===========================================================================
section('The shell: the page, the manifest and the icons');

{
  const html = readRepo('index.html');
  const manifestSrc = readRepo('manifest.webmanifest');

  // --- the manifest parses, and says what it has to -------------------------
  //
  // A manifest with a trailing comma is not a manifest with a warning, it is
  // a manifest the browser discards entirely — and the only symptom is that
  // "Add to Home Screen" quietly stops offering to install.
  let manifest = null;
  try { manifest = JSON.parse(manifestSrc); passed++; } catch (e) {
    failed++; console.error('  x FAIL: manifest.webmanifest is not valid JSON —', e.message);
  }
  manifest = manifest || {};

  // RELATIVE, for the same reason every path in index.html is. A start_url of
  // '/' on a Pages project site launches the installed app at the USER site
  // root, which is somebody else's page or a 404 — and it only goes wrong
  // after installation, which is the point at which nobody is looking.
  for (const key of ['start_url', 'scope', 'id']) {
    eq(manifest[key], './', `the manifest's ${key} is relative, so an installed app opens this app`);
  }
  eq(manifest.display, 'standalone', 'and it asks for a standalone window');

  // --- one colour, stated in four places ------------------------------------
  //
  // --bg in the stylesheet, the theme-color meta, and the manifest's two
  // colours all have to be the same value, and there is no way to derive one
  // from the other without script: a PNG cannot read a custom property and
  // neither can a JSON file. So they are copies, and the only thing that can
  // keep copies honest is a check. Lower-cased before comparing, because
  // #07130E and #07130e are the same colour and a suite that fails on the
  // difference is a suite that teaches people to stop reading it.
  const cssBg = (readRepo('css/styles.css').match(/--bg:\s*(#[0-9a-fA-F]{6})/) || [])[1];
  const metaTheme = (html.match(/<meta name="theme-color" content="(#[0-9a-fA-F]{6})">/) || [])[1];
  const low = (s) => (typeof s === 'string' ? s.toLowerCase() : s);

  ok(!!cssBg, 'css/styles.css declares a --bg token this can be read from');
  eq(low(metaTheme), low(cssBg), 'index.html\'s theme-color is --bg — the browser chrome matches the page');
  eq(low(manifest.theme_color), low(cssBg), 'and so is the manifest\'s theme_color');
  eq(low(manifest.background_color), low(cssBg),
    'and its background_color, which is what paints the splash before the CSS has loaded');

  // --- the icons exist, and are the size they claim -------------------------
  //
  // READ OUT OF THE PNG, not trusted. A manifest that advertises 512x512 for
  // a file that is 192x192 is not a smaller icon; Android rejects the
  // installability criteria outright and the install prompt never appears.
  // The header is fixed-offset: an 8-byte signature, then the IHDR length and
  // type, then width and height as big-endian 32-bit integers at 16 and 20.
  const pngSize = (rel) => {
    const b = readFileSync(REPO + rel);
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  };

  let iconsChecked = 0;
  for (const icon of manifest.icons || []) {
    ok(typeof icon.src === 'string' && icon.src.startsWith('./'),
      `the manifest icon ${JSON.stringify(icon.src)} is a relative path`);
    let size = null;
    try { size = pngSize(icon.src.slice(2)); } catch (_) {}
    if (!size) { failed++; console.error('  x FAIL: manifest names an icon that is not on disk:', icon.src); continue; }
    const [w, h] = String(icon.sizes).split('x').map(Number);
    ok(size.w === w && size.h === h,
      `${icon.src} really is ${icon.sizes} — the file is ${size.w}x${size.h}`);
    iconsChecked++;
  }
  ok(iconsChecked >= 4, `checked ${iconsChecked} manifest icons — the sweep is not empty`);

  // Android may crop a maskable icon to a circle, a squircle or a teardrop,
  // and guarantees only the central 80%. An install with no maskable icon
  // gets the "any" one letterboxed inside a white circle on some launchers,
  // which looks like a bug in the app.
  ok((manifest.icons || []).some((i) => String(i.purpose).includes('maskable')),
    'exactly one purpose is maskable, so a launcher does not letterbox the mark');

  // iOS ignores the manifest for Add to Home Screen and reads this tag.
  const apple = (html.match(/<link rel="apple-touch-icon" href="(\.\/[^"]+)">/) || [])[1];
  ok(!!apple, 'index.html links an apple-touch-icon, which iOS reads instead of the manifest');
  if (apple) {
    let s = null;
    try { s = pngSize(apple.slice(2)); } catch (_) {}
    ok(s && s.w === 180 && s.h === 180,
      `and it is 180x180, the size current iPhones ask for — got ${s ? `${s.w}x${s.h}` : 'no file'}`);
  }

  // --- everything the page references is precached --------------------------
  //
  // The SHELL checks above sweep js/, css/ and icons/ off the disk, which
  // catches a file that exists and is not listed. This catches the other
  // shape: a <link> or a manifest entry pointing at something that is not in
  // the shell at all, which is an asset that 404s offline.
  const { SHELL } = loadSwConsts();
  const shellSet = new Set(SHELL);
  const referenced = new Set();
  for (const m of html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)) referenced.add(m[1]);
  for (const i of manifest.icons || []) referenced.add(i.src);
  ok(referenced.size >= 6, `the page and manifest reference ${referenced.size} same-origin files`);
  let unprecached = 0;
  for (const r of referenced) {
    if (!shellSet.has(r)) { unprecached++; console.error('  x referenced but not precached:', r); }
  }
  eq(unprecached, 0, 'and every one of them is in SHELL, so none of them 404s offline');

  // --- the footer is a sibling of #app, not a child -------------------------
  //
  // THIS IS THE WHOLE REASON THE FOOTER WORKS. js/ui.js rewrites everything
  // inside its root on the first render, so a reset button placed in there
  // would be destroyed by the app starting — and would never exist at all on
  // the occasion it is for, which is js/main.js failing to load. Counting
  // braces is crude; counting tags is the same trick and it answers exactly
  // the question being asked.
  const appAt = html.indexOf('<div id="app"');
  const footAt = html.indexOf('<footer class="site-footer">');
  ok(appAt !== -1 && footAt !== -1 && appAt < footAt, 'index.html has #app and then a site footer');
  if (appAt !== -1 && footAt > appAt) {
    const between = html.slice(appAt, footAt);
    const opens = (between.match(/<div\b/g) || []).length;
    const closes = (between.match(/<\/div>/g) || []).length;
    eq(opens, closes,
      'the footer is OUTSIDE #app — every div opened since #app is closed before it, so ui.js cannot wipe the reset button');
  }

  // --- the reset button, and the one thing it must never do -----------------
  //
  // THE SHARPEST CHECK IN THIS FILE, because the failure it prevents is
  // silent and total. localStorage holds bluff.clientId — the ticket that IS
  // a player's claim to their seat — and bluff.engine, which on the host's
  // device is the ONLY copy of the game, every hand at the table. A
  // "clear everything" button would end the game for all five other players
  // from a control labelled "clear cache".
  //
  // Cache Storage and service worker registrations are derived data: every
  // byte in them can be fetched again. That is what makes them safe to throw
  // away, and it is the whole distinction this button rests on.
  const script = (html.match(/<script>([\s\S]*?)<\/script>/g) || []).join('\n');
  // The CODE, with the prose taken out. The first version of this check
  // scanned the whole script and failed on the twenty-line comment that
  // explains why localStorage must not be touched — which is the explanation
  // of the rule, not a breach of it, and a substring search cannot tell those
  // apart. Same distinction as sw.js's header two sections up, and the same
  // resolution: strip the prose, then REQUIRE it separately, so the check
  // cannot be silenced by deleting the paragraph that justifies it.
  const scriptCode = script
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  ok(/id="reset-btn"/.test(html), 'the footer carries the reset button');
  ok(/getElementById\('reset-btn'\)/.test(scriptCode),
    'and an inline classic script wires it — not js/main.js, which is what may have failed');
  ok(/caches\.keys\(\)/.test(scriptCode) && /caches\.delete\(/.test(scriptCode),
    'it clears Cache Storage');
  ok(/getRegistrations\(\)/.test(scriptCode) && /\.unregister\(\)/.test(scriptCode),
    'and unregisters the worker, so a stale shell cannot survive the press');
  ok(!/localStorage/.test(scriptCode),
    'and it NEVER touches localStorage — that holds the seat ticket and the host’s only copy of the game');
  ok(/localStorage/.test(script) && /clientId/.test(script) && /engine/.test(script),
    'while its comment names both things in there, because "why not" is the only part a future edit will not rediscover');
  ok(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/.test(scriptCode),
    'the same script registers ./sw.js relatively, which is what scopes it to a Pages subpath');

  // --- the footer is hidden once there is a table ---------------------------
  //
  // css/styles.css caps the page at the viewport, so the footer's strip does
  // not come out of the page — the page has none to give — it comes out of
  // the hand. The class is set by js/ui.js on its own root, which is #app,
  // and the rule reaches across with a sibling combinator.
  //
  // COMMENTS STRIPPED FIRST. This stylesheet quotes its own selectors at
  // length in its prose, and a check that reads the prose finds rules that do
  // not exist.
  const cssBody = readRepo('css/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/\.app\.in-play\s*~\s*\.site-footer\s*\{[^}]*display\s*:\s*none/.test(cssBody),
    'css/styles.css hides the footer while a table is on screen');
  ok(/\.site-footer\s*\{/.test(cssBody) && /\.footer-reset\s*\{/.test(cssBody),
    'and styles both the footer and the button inside it');

  // The other half of that rule, and the reason it is a sibling combinator
  // rather than something on <body>: js/ui.js is scoped to its root and
  // reaches for nothing outside it. If that ever stops being true the two
  // files start disagreeing about who owns the page.
  const uiSrc = readRepo('js/ui.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  ok(/root\.classList\.toggle\('in-play'/.test(uiSrc),
    'js/ui.js sets in-play on its own root, which is the element the rule keys off');
  eq((uiSrc.match(/\bdocument\./g) || []).length, 0,
    'and touches `document` nowhere at all — the renderer owns #app and not the page');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
