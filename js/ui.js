// ============================================================================
// ui.js — every pixel, and nothing else.
//
// WHAT THIS MODULE IS ALLOWED TO KNOW
//   Two objects: the public state every device receives, and the one private
//   state belonging to this device. It never touches a GameEngine, never
//   imports state.js for anything but two frozen enums, and never decides
//   whether a move is legal — it asks, renders the answer, and sends the
//   intent. A UI that computed legality would be a second rulebook, and the
//   two would disagree on the turn that mattered.
//
//   `send` is the one way out. It takes the same wire message a remote phone
//   would send, so the host's own taps and a guest's taps travel the identical
//   path through intents.js. On the host's phone main.js hands it to the
//   engine; on a guest's it goes down a DataConnection first. Neither this file
//   nor the markup it produces can tell the difference, which is the point —
//   grep this file for `net.mode` and the only hits are on screens that exist
//   BEFORE a game does. Once there is a hand on the table, the interface has
//   forgotten how the state reached it.
//
// THE FOUR LIFECYCLE CALLBACKS
//   onHost / onJoin / onSolo / onLeave. These are not game intents and they are
//   deliberately not routed through `send`: intents.js dispatches on an actor
//   who already has a seat, and every one of these four is about not having one
//   yet. Identity and transport are the two things each mode does differently,
//   so they stay out of the message vocabulary entirely.
//
// WHAT setNet() IS FOR
//   The controller owns the connection and this file owns the sentence about
//   it. setNet() is how the one tells the other, and it is a merge rather than
//   a replace so a status change cannot silently drop the room code.
//
// THE RENDER MODEL
//   Full re-render into a string, then one innerHTML write — but only when the
//   string actually changed. No virtual DOM, no keys, no diffing library, and
//   no stale-node class of bug. The skipped write is what keeps focus and text
//   selection alive through a re-render that changed nothing, which on the
//   join screen is the difference between typing a name and typing one letter
//   of a name fourteen times.
//
//   The countdown is the sole exception. It moves ten times a second and must
//   not rebuild the screen underneath a thumb that is reaching for CHALLENGE,
//   so tick() writes two properties on two nodes and touches nothing else.
// ============================================================================

import {
  RANKS, JOKER, MIN_DECKS, MAX_DECKS, MIN_PLAYERS, MAX_PLAYERS, MAX_NAME_LEN,
  MIN_WINDOW_MS, MAX_WINDOW_MS,
  RANK_RULES, JOKER_MODES, CHALLENGE_MODES, PRESETS,
  rankLabel, rankName, plural, presetMatching, jokerCap, playCap,
  describeConfig, describeDeal,
} from './rules.js';
import { PHASES, STEPS } from './state.js';
// Two things, both of them pixels. copyText is the clipboard behind the room
// code chip; CODE_LENGTH is the maxlength on the code field, taken from the
// module that mints the codes rather than typed as a 4 here, so a longer
// alphabet later cannot leave this input silently truncating them.
import { copyText, CODE_LENGTH } from './util.js';

/**
 * ESCAPE EVERYTHING THAT CAME FROM A PERSON.
 *
 * Names are the only free text in this game and they arrive over the wire from
 * a stranger who typed a four-character room code. cleanName() bounds the
 * LENGTH and collapses whitespace; it does not and should not strip angle
 * brackets, because "<3" is a name somebody will pick. So the escaping belongs
 * here, at the one boundary where a string becomes markup, and every
 * interpolation of a name, a log line or an engine error goes through it.
 *
 * Grep rule for review: every `${` inside a template literal in this file
 * either wraps esc(), or its argument is a number, or it is a token this
 * module chose itself from a frozen list.
 */
const esc = (s) => String(s == null ? '' : s).replace(
  /[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
);

/** Suit glyphs, and which two are red. Display only. */
const SUIT_GLYPH = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED_SUITS = new Set(['H', 'D']);

/** Every rank a hand can hold, in the order the dock lays them out. The joker
 *  goes last because it is not part of the sequence and never a claim. */
const HAND_ORDER = [...RANKS, JOKER];

/** Two cards or fewer is the loud state on the seat list. */
const LOW_CARDS = 2;

export function createUI({
  root, send, onHost, onJoin, onSolo, onLeave, savedName = '', savedCode = '',
}) {
  // ---------------------------------------------------------------------
  // The shell. Built once, so `screen` can be rewritten without disturbing
  // the flash — which is fixed-position, outlives any single render, and
  // must not be wiped by the re-render that a refused move triggers.
  // ---------------------------------------------------------------------
  root.innerHTML = '<a class="skip-link" href="#hand">Skip to your hand</a>'
    + '<div id="screen"></div>'
    + '<div id="flash-host" role="status" aria-live="polite"></div>';
  const screen = root.querySelector('#screen');
  const flashHost = root.querySelector('#flash-host');

  // ---------------------------------------------------------------------
  // LOCAL STATE — what this device is in the middle of doing.
  //
  // Strictly the half-finished move: which cards are picked, which rank tile
  // has the picker open, what is being claimed. None of it is authoritative,
  // none of it is sent until PLAY, and all of it is thrown away the moment
  // the position changes underneath it (see posKey). A selection that
  // survived somebody else's challenge would be a player about to commit
  // three Kings into a game that has moved on.
  // ---------------------------------------------------------------------
  const ui = {
    sel: Object.create(null),  // rank -> count chosen for this play
    active: null,              // rank whose count picker is open
    claim: null,               // rank being claimed, once chosen
    pos: '',                   // fingerprint of the position sel belongs to

    // The two text fields, held OUTSIDE the DOM. See restoreFields().
    // The name arrives already filled in on a second visit, which is most of
    // them: the one question this app asks is one it has already been told.
    name: savedName,
    // Likewise the code of the table this device was last at. A group that
    // plays three games in an evening types it once. It is cleared by
    // resetEntry() on the way home from a table that ENDED, so the prefill is
    // only ever the code of a room that was working when we left it.
    code: savedCode,
    focusId: null,             // which field had the caret when we last looked
    copied: false,             // the room-code chip's "copied" beat
  };

  // -----------------------------------------------------------------------
  // WHAT THE CONTROLLER KNOWS AND THIS FILE ONLY DISPLAYS.
  //
  // `mode` is the only thing here that changes which screen is drawn; the rest
  // is a status line. Defaults are the cold-start state — no table, nothing
  // dialled, nothing wrong — so the first render with no setNet() call at all
  // is the home screen, which is exactly what a first visit should see.
  // -----------------------------------------------------------------------
  const net = {
    mode: 'home',    // 'home' | 'solo' | 'host' | 'client'
    code: null,      // the room code, once the broker has confirmed it
    status: 'idle',  // 'idle' | 'connecting' | 'live' | 'retrying' | 'lost'
    message: null,   // one sentence, already written for a player to act on
    detail: null,    // what we are waiting for, on the connecting screen
  };

  let lastHtml = null;
  let lastPub = null;
  let flashTimer = null;
  let copyTimer = null;

  function resetSelection() {
    ui.sel = Object.create(null);
    ui.active = null;
    ui.claim = null;
  }

  const selTotal = () => Object.values(ui.sel).reduce((a, b) => a + b, 0);

  // -----------------------------------------------------------------------
  // Events. One listener, delegated, for the whole app — the screen is
  // replaced wholesale on most renders, so a listener bound to a button is a
  // listener bound to a node that is about to stop existing.
  // -----------------------------------------------------------------------
  root.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    ev.preventDefault();
    handle(el.dataset.act, el.dataset);
  });

  // The home screen carries two forms — name+HOST, and code+JOIN — because a
  // phone keyboard's go key has to mean one thing, and which thing depends on
  // which field it was pressed from. Nesting them was never an option and a
  // single form with two submit buttons makes Enter ambiguous, which on the
  // one screen where somebody is typing a code read aloud across a table is
  // the wrong place to be clever.
  root.addEventListener('submit', (ev) => {
    ev.preventDefault();
    readFields();
    if (ev.target.dataset.form === 'join') return onJoin(ui.name, ui.code);
    return onHost(ui.name);
  });

  // -----------------------------------------------------------------------
  // THE TWO TEXT FIELDS LIVE OUTSIDE THE DOM, and this is not an optimisation.
  //
  // render() skips the innerHTML write when the string is unchanged, which is
  // what lets somebody type a whole name without the input being rebuilt under
  // them. That holds right up until something else moves — a guest arriving, a
  // reconnect banner appearing, the host's clock ticking a countdown into the
  // markup — at which point the write happens anyway and takes the half-typed
  // value and the caret with it. On the join screen that is somebody's name
  // vanishing as the fourth player sits down.
  //
  // Putting `value="${...}"` in the markup does not fix it, it inverts it: the
  // string would then change on every keystroke, so the write would happen on
  // every keystroke, and the field would be rebuilt mid-word every time.
  //
  // So the value is held here, mirrored into the DOM after each write, and the
  // caret is put back where it was. The markup stays constant while typing,
  // which means the write stays skipped, which means the restore below is only
  // ever exercised by a render somebody else caused.
  // -----------------------------------------------------------------------
  root.addEventListener('input', (ev) => {
    if (ev.target.id === 'name-input' || ev.target.id === 'code-input') readFields();
  });
  root.addEventListener('focusin', (ev) => {
    if (ev.target.id === 'name-input' || ev.target.id === 'code-input') ui.focusId = ev.target.id;
  });
  root.addEventListener('focusout', (ev) => {
    if (ev.target.id === ui.focusId) ui.focusId = null;
  });

  function readFields() {
    const n = root.querySelector('#name-input');
    const c = root.querySelector('#code-input');
    if (n) ui.name = n.value;
    // Upper-cased here so the field shows what will actually be dialled.
    // normalizeCode() in the controller is still the authority — this is a
    // courtesy for the eye, not a validation, and it deliberately does not
    // strip anything: a player who typed an O should SEE the O they typed and
    // get told it is not a code, rather than watch the character disappear.
    if (c) ui.code = c.value.toUpperCase();
  }

  /** DOM ← ui, immediately after an innerHTML write. `hadFocus` is read by the
   *  caller BEFORE the write, because removing a focused node blurs it. */
  function restoreFields(hadFocus) {
    const n = root.querySelector('#name-input');
    const c = root.querySelector('#code-input');
    if (n && n.value !== ui.name) n.value = ui.name;
    if (c && c.value !== ui.code) c.value = ui.code;
    if (!hadFocus) return;
    const back = root.querySelector(`#${hadFocus}`);
    // No refocus when the field is simply gone — the screen changed, and
    // yanking the keyboard back up on a screen with nothing to type into is
    // worse than losing the caret.
    if (!back) return;
    back.focus();
    try { back.setSelectionRange(back.value.length, back.value.length); } catch (_) {}
  }

  function handle(act, data) {
    switch (act) {
      // --- before there is a game --------------------------------------
      //
      // HOST and JOIN are deliberately NOT here. They are submit buttons, so
      // a tap on one would arrive twice — once as a click with a data-act,
      // once as the form submission it also triggers. Cancelling the click
      // suppresses the submit and would work, but it makes the keyboard's go
      // key and the button travel two different code paths for the same
      // decision. One path: they carry no data-act, and the submit handler
      // above is the only way either of them fires.
      case 'solo':  readFields(); return onSolo(ui.name);
      case 'leave': return onLeave();

      case 'copyCode': {
        if (!net.code) return undefined;
        // Fire and forget. copyText() already falls back to the old
        // execCommand path and resolves false rather than throwing, and a
        // clipboard that refused is not worth a banner — the code is on
        // screen in 34px mono two inches above the thumb that just tried.
        copyText(net.code).then((ok) => {
          if (!ok) return;
          ui.copied = true;
          paint();
          clearTimeout(copyTimer);
          copyTimer = setTimeout(() => { ui.copied = false; paint(); }, 1600);
        });
        return undefined;
      }

      // --- building a play ---------------------------------------------
      case 'tile':
        // Tapping the open tile closes it. Tapping a different one moves the
        // picker rather than stacking a second copy of it.
        ui.active = ui.active === data.rank ? null : data.rank;
        return paint();

      case 'count': {
        const rank = data.rank;
        const n = Number(data.n);
        if (ui.sel[rank] === n) delete ui.sel[rank];   // tap the lit count to undo
        else ui.sel[rank] = n;
        ui.active = null;
        return paint();
      }

      case 'claim':
        ui.claim = data.rank;
        return paint();

      case 'clear':
        resetSelection();
        return paint();

      case 'play': {
        // The multiset the engine wants: ['K','K','7'], not card ids. See
        // takeByRank() in cards.js for why ids never leave the host.
        const ranks = [];
        for (const [rank, n] of Object.entries(ui.sel)) {
          for (let i = 0; i < n; i++) ranks.push(rank);
        }
        const claim = data.claim;
        resetSelection();
        return send({ type: 'playCards', ranks, claim });
      }

      // --- the window ----------------------------------------------------
      case 'challenge': return send({ type: 'challenge' });
      case 'decline':   return send({ type: 'decline' });

      // --- lobby ---------------------------------------------------------
      case 'preset': {
        const preset = PRESETS.find((p) => p.id === data.id);
        return preset && send({ type: 'setConfig', patch: preset.patch });
      }
      case 'config': {
        // Numeric axes arrive as strings from the dataset; the string ones
        // (rankRule, jokerMode, challengeMode) must stay strings. The engine
        // re-normalises whatever this sends, so a wrong guess here is refused
        // rather than stored — but getting it right means the lobby reads
        // back what the host just pressed.
        const raw = data.value;
        const value = data.numeric === '1' ? Number(raw) : raw;
        return send({ type: 'setConfig', patch: { [data.key]: value } });
      }
      case 'addBot':    return send({ type: 'addBot' });
      case 'removeBot': return send({ type: 'removeBot', playerId: data.id });
      case 'move':      return send({ type: 'movePlayer', playerId: data.id, dir: Number(data.dir) });
      case 'shuffle':   return send({ type: 'randomizeOrder' });
      case 'start':     return send({ type: 'startGame' });

      // --- host controls in play ------------------------------------------
      case 'skip':      return send({ type: 'skipTurn' });
      case 'endGame':   return send({ type: 'endGame' });
      case 'again':     resetSelection(); return send({ type: 'playAgain' });

      default: return undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Painting
  // -----------------------------------------------------------------------

  /** Re-render from the last state we were given. For local-only changes —
   *  opening a picker, choosing a count — where the game has not moved. */
  function paint() { render(lastPub, lastPriv); }

  let lastPriv = null;

  function render(pub, priv) {
    lastPub = pub;
    lastPriv = priv;

    // pub is null for the whole of a client's first dial and for every second
    // of a reconnect — there is no table yet, and the screen for that is one
    // of the two below. The old early return here predated there being
    // anything to draw without state; keeping it would blank the reconnect.
    if (pub) {
      // The half-finished move belongs to one position and no other.
      const pos = [pub.phase, pub.step, pub.turnPlayerId, pub.pileSize, pub.claim && pub.claim.rank].join('|');
      if (pos !== ui.pos) { ui.pos = pos; resetSelection(); }
    }

    // THE ONE THING THIS FILE SAYS ABOUT THE PAGE, and it says it by putting a
    // class on its own root rather than by reaching for document or body.
    //
    // index.html's footer is a SIBLING of root, because it has to survive
    // js/main.js failing to load — that is the state its "Clear cache &
    // reload" button exists for, and a control rendered by the thing it
    // recovers from is not a control. Being a sibling, it also takes height
    // from a column that has none spare: css/styles.css caps the page at the
    // viewport, so on the lobby and the play screens the footer's strip would
    // come out of the hand rather than out of the page. It is hidden there,
    // via `.app.in-play ~ .site-footer`.
    //
    // The condition is "is there a table", which is the same question
    // screenFor() answers on its first two lines — so it is asked the same
    // way. A separate predicate here would be a second copy of the rule, and
    // the day waitingScreen() stopped being a full-bleed screen the two would
    // disagree with no test able to see it.
    root.classList.toggle('in-play', net.mode !== 'home' && !!pub && !!priv);

    const html = screenFor(pub, priv);
    // The write that is skipped is the feature. See the header note.
    if (html !== lastHtml) {
      // Read before the write: removing a focused node blurs it, and the
      // focusout handler above would have cleared this by the time we looked.
      const hadFocus = ui.focusId;
      lastHtml = html;
      screen.innerHTML = html;
      restoreFields(hadFocus);
    }
    // Immediately, so the bar is never briefly full on the frame it appears.
    tick(Date.now());
  }

  /**
   * Tell this file what the connection is doing. Merge, never replace — a
   * caller reporting `{status:'retrying'}` must not have to remember to resend
   * the room code it set four events ago.
   */
  function setNet(patch) {
    Object.assign(net, patch);
    paint();
  }

  function screenFor(pub, priv) {
    // The only two places in this file that branch on the transport, and both
    // of them are screens that exist because there is no game yet.
    if (net.mode === 'home') return homeScreen();
    // THIS LINE IS WHY waitingScreen() CAN SAY WHAT IT SAYS. A state frame
    // that has arrived once is kept by render() until the home screen, so
    // "no pub" means "never been dealt in" and not "dealt in, connection
    // poor" — that second player is below, holding their cards under a
    // banner. Change the retention and the copy on both screens is wrong.
    if (!pub || !priv) return waitingScreen();

    const banner = netBanner();
    if (pub.phase === PHASES.LOBBY) return banner + lobbyScreen(pub, priv);
    if (pub.phase === PHASES.GAME_OVER) return banner + overScreen(pub, priv);
    return banner + playScreen(pub, priv);
  }

  // =======================================================================
  // HOME — the screen before there is a table
  // =======================================================================

  /**
   * Three ways in, and the order they are in is the order they are wanted.
   *
   * HOST is the primary button because somebody has to press it first and
   * everyone else is waiting on them. JOIN is second and needs the code that
   * host just read out. PLAY ALONE is last, quiet, and exists for two
   * different people: somebody learning the rules, and somebody on a train
   * with no signal — which is also the only one of the three that works when
   * the PeerJS bundle did not load.
   */
  function homeScreen() {
    return `
      <section class="join home">
        <p class="brand-sub">Cheat &middot; I Doubt It</p>
        <h1 class="brand">Bluff</h1>
        <p>
          Everyone plays on their own phone. Nothing is installed, nothing is
          signed up for, and no card ever leaves the device holding it.
        </p>

        ${net.message ? `<div class="net-note">${esc(net.message)}</div>` : ''}

        <form class="field" data-form="host">
          <label class="label" for="name-input">Your name</label>
          <input id="name-input" name="name" type="text" autocomplete="nickname"
                 maxlength="${MAX_NAME_LEN}" placeholder="e.g. Ana" enterkeyhint="go"
                 autocapitalize="words" spellcheck="false">
          <button class="btn" type="submit">HOST A TABLE</button>
        </form>

        <div class="or"><span>or join one</span></div>

        <form class="field row" data-form="join">
          <label class="label sr-only" for="code-input">Room code</label>
          <input id="code-input" name="code" type="text" inputmode="text"
                 maxlength="${CODE_LENGTH}" placeholder="CODE" enterkeyhint="go"
                 autocomplete="off" autocapitalize="characters" spellcheck="false"
                 autocorrect="off">
          <button class="btn" type="submit">JOIN</button>
        </form>

        <button class="btn ghost" data-act="solo">PLAY ALONE AGAINST BOTS</button>
      </section>`;
  }

  /**
   * Dialling, or redialling.
   *
   * Says which code it is dialling, because the commonest reason this screen
   * lasts longer than a second is that the code was misheard — a player
   * looking at their own typo works it out faster than any message this file
   * could write. LEAVE is always here: a dial that is never going to land
   * must not be a dead end, and on a phone there is no address bar to fall
   * back on once the app is installed.
   *
   * NOBODY WHO HAS EVER BEEN DEALT IN SEES THIS SCREEN, which is what lets
   * both sentences below be blunt. screenFor() reaches here only while
   * `pub`/`priv` are null, and render() keeps the last pair until
   * resetEntry() clears them on the way to the home screen — so a player
   * whose host walks into a lift keeps their hand on screen with
   * netBanner()'s "Reconnecting…" over it, and never arrives here.
   *
   * That invariant is the whole reason 'retrying' is phrased the way it is. A
   * retry on THIS screen is a dial that has never once been answered, and the
   * likeliest reading of it by far is a code typed wrong. An earlier version
   * said the connection had dropped and the player's cards were still held
   * for them, which sounds reassuring and was false every single time it
   * rendered: there is no seat to hold, and it invites someone to wait out a
   * ladder that ends on the home screen either way.
   */
  function waitingScreen() {
    const retrying = net.status === 'retrying';
    return `
      <section class="join waiting">
        <p class="brand-sub">${retrying ? 'Still trying' : 'Joining'}</p>
        <h1 class="brand">${net.code ? esc(net.code) : 'Bluff'}</h1>
        <p>${esc(net.detail || (retrying
          ? 'No answer yet. Dialling that code again — worth checking the four characters while we do.'
          : 'Looking for the table. The host needs the game open on their phone.'))}</p>
        ${net.message ? `<div class="net-note">${esc(net.message)}</div>` : ''}
        <div class="dots" aria-hidden="true"><i></i><i></i><i></i></div>
        <button class="btn ghost" data-act="leave">LEAVE</button>
      </section>`;
  }

  /**
   * The one line about the connection that sits above a live game.
   *
   * Nothing at all while the connection is fine, which is almost always — a
   * permanent "connected" badge is a thing nobody reads and everybody's eye
   * has to skip over on the way to their hand. It appears only when something
   * is wrong, which is the only time it carries information.
   */
  function netBanner() {
    if (net.status !== 'retrying' && net.status !== 'lost') return '';
    const lost = net.status === 'lost';
    return `
      <div class="net-bar ${lost ? 'lost' : ''}" role="status">
        <span>${esc(net.message || (lost
          ? 'Not connected. Your seat is held.'
          : 'Reconnecting…'))}</span>
        ${lost ? '<button data-act="leave">LEAVE</button>' : ''}
      </div>`;
  }

  /**
   * The room code, at the top of the lobby, big enough to read across a table.
   *
   * Mono and letter-spaced because it is going to be read ALOUD — the whole
   * job of the alphabet in util.js is that no two characters sound or look
   * alike, and a proportional face undoes half of that. The copy button is
   * for the other way people share it, which is a message.
   */
  function roomStrip() {
    if (!net.code) return '';
    // Until the broker has confirmed the address, this is a code we HOPE to be
    // reachable at — a collision swaps it for another. Four characters read
    // out and then silently changed is worse than a second of waiting, so the
    // digits are held back rather than shown and retracted.
    const opening = net.status === 'connecting';
    return `
      <div class="room ${opening ? 'pending' : ''}">
        <div class="room-left">
          <span class="label">${opening ? 'Opening the table' : 'Room code'}</span>
          <div class="room-code">${opening ? '&middot;&middot;&middot;&middot;' : esc(net.code)}</div>
        </div>
        <button class="btn ghost room-copy" data-act="copyCode" ${opening ? 'disabled' : ''}>
          ${ui.copied ? 'COPIED' : 'COPY'}
        </button>
      </div>`;
  }

  // =======================================================================
  // LOBBY
  // =======================================================================

  function lobbyScreen(pub, priv) {
    const isHost = pub.hostId === priv.playerId;
    const cfg = pub.config;
    const preset = presetMatching(cfg);

    return `
      <section class="lobby">
        <div class="lobby-head">
          <h1>Bluff</h1>
          <span class="label">${pub.players.length} of ${MAX_PLAYERS} seated</span>
        </div>

        ${roomStrip()}
        ${seatPanel(pub, priv, isHost)}
        ${isHost ? configPanel(cfg, preset, pub) : readOnlyConfig(cfg)}

        <div class="deal-line">${esc(describeDeal(cfg, pub.players.length))}</div>
        ${pub.startBlocker ? `<div class="blocker">${esc(pub.startBlocker)}</div>` : ''}

        ${isHost
          ? `<button class="btn" data-act="start" ${pub.startBlocker ? 'disabled' : ''}>DEAL</button>`
          : `<p class="blurb">Waiting for the host to deal.</p>`}

        <button class="btn ghost" data-act="leave">${isHost
          ? 'CLOSE THIS TABLE'
          : 'LEAVE THE TABLE'}</button>
      </section>`;
  }

  function seatPanel(pub, priv, isHost) {
    const last = pub.players.length - 1;
    const rows = pub.players.map((p, i) => `
      <li class="seat-row">
        <span class="num">${i + 1}</span>
        <span class="who">${esc(p.name)}</span>
        ${p.isHost ? '<span class="tag">host</span>' : ''}
        ${p.isBot ? '<span class="tag">bot</span>' : ''}
        ${p.online ? '' : '<span class="tag off">away</span>'}
        ${isHost ? `
          <button class="icon-btn" data-act="move" data-id="${esc(p.id)}" data-dir="-1"
                  aria-label="Move ${esc(p.name)} up" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
          <button class="icon-btn" data-act="move" data-id="${esc(p.id)}" data-dir="1"
                  aria-label="Move ${esc(p.name)} down" ${i === last ? 'disabled' : ''}>&darr;</button>
          ${p.isBot ? `<button class="icon-btn" data-act="removeBot" data-id="${esc(p.id)}"
                  aria-label="Remove ${esc(p.name)}">&times;</button>` : ''}
        ` : ''}
      </li>`).join('');

    const full = pub.players.length >= MAX_PLAYERS;
    return `
      <div class="panel">
        <h2>At the table</h2>
        <ul class="seat-list" style="list-style:none;margin:0;padding:0">${rows}</ul>
        ${isHost ? `
          <div class="btn-row">
            <button class="btn ghost" data-act="addBot" ${full ? 'disabled' : ''}>ADD A BOT</button>
            <button class="btn ghost" data-act="shuffle">SHUFFLE SEATS</button>
          </div>` : ''}
      </div>`;
  }

  function configPanel(cfg, preset, pub) {
    return `
      <div class="panel">
        <h2>How it plays</h2>
        <div class="presets">
          ${PRESETS.map((p) => `
            <button class="preset ${preset === p.id ? 'on' : ''}" data-act="preset" data-id="${esc(p.id)}">
              ${esc(p.label)}
            </button>`).join('')}
        </div>
        <p class="blurb">${esc(preset
          ? (PRESETS.find((p) => p.id === preset) || {}).blurb
          : 'Your own mix of the settings below.')}</p>

        ${segment('The rank you claim', 'rankRule', RANK_RULES, cfg.rankRule)}
        ${segment('Who may call it', 'challengeMode', CHALLENGE_MODES, cfg.challengeMode)}
        ${cfg.challengeMode === 'window' ? stepper({
            title: 'Seconds to call it',
            key: 'windowMs',
            value: cfg.windowMs,
            step: 1000, min: MIN_WINDOW_MS, max: MAX_WINDOW_MS,
            read: `${Math.round(cfg.windowMs / 1000)}s`,
          }) : ''}
      </div>

      <div class="panel">
        <h2>The deck</h2>
        ${stepper({
          title: 'Decks', key: 'decks', value: cfg.decks,
          step: 1, min: MIN_DECKS, max: MAX_DECKS, read: plural(cfg.decks, 'deck'),
        })}
        ${stepper({
          title: 'Jokers', key: 'jokers', value: cfg.jokers,
          step: 1, min: 0, max: jokerCap(cfg.decks),
          read: cfg.jokers ? plural(cfg.jokers, 'joker') : 'none',
        })}
        ${cfg.jokers > 0 ? segment('What a joker is worth', 'jokerMode', JOKER_MODES, cfg.jokerMode) : ''}
        ${stepper({
          title: 'Most cards in one turn', key: 'maxPlay', value: cfg.maxPlay,
          step: 1, min: 1, max: playCap(cfg.decks), read: plural(cfg.maxPlay, 'card'),
        })}
      </div>`;
  }

  /** The non-host's view of the same settings. Everyone needs to read them —
   *  nobody can judge whether "five Kings" is absurd without the deck count —
   *  but only the host may move them. */
  function readOnlyConfig(cfg) {
    return `
      <div class="panel">
        <h2>How it plays</h2>
        <p class="blurb">${esc(describeConfig(cfg))}</p>
        <p class="blurb">${esc(RANK_RULES[cfg.rankRule].blurb)}</p>
        <p class="blurb">${esc(CHALLENGE_MODES[cfg.challengeMode].blurb)}</p>
      </div>`;
  }

  function segment(title, key, table, current) {
    return `
      <div class="opt">
        <div class="opt-head"><span class="label">${esc(title)}</span></div>
        <div class="seg">
          ${Object.entries(table).map(([value, meta]) => `
            <button class="${value === current ? 'on' : ''}"
                    data-act="config" data-key="${esc(key)}" data-value="${esc(value)}">
              ${esc(meta.label)}
            </button>`).join('')}
        </div>
        <p class="blurb">${esc(table[current] ? table[current].blurb : '')}</p>
      </div>`;
  }

  function stepper({ title, key, value, step, min, max, read }) {
    const down = Math.max(min, value - step);
    const up = Math.min(max, value + step);
    return `
      <div class="opt">
        <div class="opt-head"><span class="label">${esc(title)}</span></div>
        <div class="stepper">
          <button data-act="config" data-key="${esc(key)}" data-numeric="1" data-value="${down}"
                  aria-label="Fewer" ${value <= min ? 'disabled' : ''}>&minus;</button>
          <span class="read">${esc(read)}</span>
          <button data-act="config" data-key="${esc(key)}" data-numeric="1" data-value="${up}"
                  aria-label="More" ${value >= max ? 'disabled' : ''}>+</button>
        </div>
      </div>`;
  }

  // =======================================================================
  // PLAY
  // =======================================================================

  function playScreen(pub, priv) {
    const inWindow = pub.step === STEPS.CHALLENGE_WINDOW;
    const resolving = pub.step === STEPS.RESOLVING;
    const isHost = pub.hostId === priv.playerId;

    return `
      <section class="play">
        ${turnStrip(pub, priv)}
        <div class="board">
          ${inWindow ? windowPanel(pub, priv) : ''}
          ${priv.isTurn ? forcedBanner(pub) : ''}
          ${seatList(pub, priv)}
          ${historyList(pub, priv)}
          ${isHost ? hostRow() : ''}
        </div>
        ${priv.isTurn ? handDock(pub, priv) : ''}
      </section>
      ${resolving && pub.reveal ? revealLayer(pub, priv) : ''}`;
  }

  /**
   * Who the table is waiting on.
   *
   * During a challenge window that is NOT `turnPlayerId`. The turn does not
   * advance until the window closes — correctly, since a caught liar's play is
   * about to be undone — so reading the seat straight off would announce "Ana
   * to play" in the two seconds after Ana played, which is the sentence most
   * likely to make somebody tap something they did not mean to.
   */
  function turnStrip(pub, priv) {
    const inWindow = pub.step === STEPS.CHALLENGE_WINDOW && pub.claim;
    const who = pub.players.find((p) => p.id === (inWindow ? pub.claim.playerId : pub.turnPlayerId));
    const mine = priv.isTurn;
    const label = inWindow
      ? (who && who.id === priv.playerId ? 'You played' : `${esc(who ? who.name : '—')} played`)
      : (mine ? 'Your turn' : `${esc(who ? who.name : '—')} to play`);
    return `
      <header class="turn-strip ${mine ? 'mine' : ''}">
        <span class="strip-name">${label}</span>
        <span class="strip-right">
          <span class="pile-count">PILE <b>${pub.pileSize}</b></span>
          <span class="strip-state">${esc(shortConfig(pub.config))}</span>
        </span>
      </header>`;
  }

  /** The config, short enough for a 390px strip. The long form is in the
   *  lobby; what has to survive onto the play screen is the deck and joker
   *  count, because they are the numbers a claim is judged against. */
  function shortConfig(cfg) {
    return `${cfg.decks}d · ${cfg.jokers}j`;
  }

  function forcedBanner(pub) {
    const legal = pub.legalClaims || [];
    if (legal.length !== 1) return '';
    return `
      <div class="forced">
        <div>
          <div class="forced-label">You must claim</div>
          <div class="strip-state" style="margin-top:3px">${esc(RANK_RULES[pub.config.rankRule].label.toLowerCase())} &mdash; next in sequence</div>
        </div>
        <div class="forced-rank">${esc(rankLabel(legal[0]))}</div>
      </div>`;
  }

  function seatList(pub, priv) {
    return `
      <div class="seats">
        ${pub.players.map((p) => {
          const cls = [
            'seat',
            p.id === pub.turnPlayerId ? 'is-turn' : '',
            p.id === priv.playerId ? 'is-me' : '',
            p.handCount <= LOW_CARDS && p.handCount > 0 ? 'is-low' : '',
            p.online ? '' : 'is-offline',
          ].filter(Boolean).join(' ');
          return `
            <div class="${cls}">
              <span class="seat-name">${esc(p.id === priv.playerId ? 'You' : p.name)}${p.isBot ? '<span class="seat-bot">bot</span>' : ''}</span>
              <span class="seat-cards" aria-label="${p.handCount} cards">${p.handCount}</span>
            </div>`;
        }).join('')}
      </div>`;
  }

  /**
   * The last few claims, newest last.
   *
   * Deliberately the CLAIM history and not the log: "Cy said three Kings" is
   * the thing a player reasons with, and it reads in one line. The log carries
   * outcomes too and runs to a paragraph, which on a phone pushes the hand off
   * the screen to say something nobody is going to read mid-turn.
   */
  function historyList(pub, priv) {
    const recent = (pub.claimHistory || []).slice(-4);
    if (!recent.length) return '';
    return `
      <div class="history">
        ${recent.map((c) => {
          const who = pub.players.find((p) => p.id === c.playerId);
          return `<div class="h-row">
            <span class="h-who">${c.playerId === priv.playerId
              ? 'You' : esc(who ? who.name : '—')}</span>
            <b>${c.count} &times; ${esc(rankName(c.rank, c.count))}</b>
          </div>`;
        }).join('')}
      </div>`;
  }

  /** A dropped player's turn is the host's to nudge. Deliberately cannot play
   *  a card for them — the host choosing somebody else's claim is not a thing
   *  this game can allow. */
  function hostRow() {
    return `
      <div class="host-row">
        <button class="btn ghost" data-act="skip">SKIP THIS TURN</button>
        <button class="btn ghost" data-act="endGame">END GAME</button>
      </div>`;
  }

  // -----------------------------------------------------------------------
  // The hand
  // -----------------------------------------------------------------------

  function handDock(pub, priv) {
    const counts = priv.counts || {};
    const held = HAND_ORDER.filter((r) => counts[r]);
    const total = priv.hand.length;
    const claim = effectiveClaim(pub);

    return `
      <div class="dock" id="hand">
        <div class="dock-head">
          <span class="dock-title">Your hand</span>
          <span class="dock-total"><b>${total}</b> cards &middot; ${held.length} ranks</span>
        </div>
        <div class="hand" role="group" aria-label="Your hand, grouped by rank">
          ${held.map((r) => tile(r, counts[r], priv)).join('')}
        </div>
        ${ui.active ? picker(ui.active, counts[ui.active] || 0, pub, priv) : ''}
        ${claimPicker(pub, claim)}
        ${commitBar(pub, priv, claim)}
      </div>`;
  }

  function tile(rank, n, priv) {
    const picked = ui.sel[rank] || 0;
    const room = priv.maxPlay - selTotal();
    // Greyed only when tapping it could not possibly do anything: nothing of
    // this rank is chosen and there is no room left in the play.
    const dead = room <= 0 && !picked;
    const cls = [
      'tile',
      n === 1 ? 'single' : '',
      rank === JOKER ? 'joker' : '',
      ui.active === rank ? 'sel' : '',
    ].filter(Boolean).join(' ');

    return `
      <button class="${cls}" data-act="tile" data-rank="${esc(rank)}" ${dead ? 'disabled' : ''}
              aria-label="${esc(rankName(rank, n))}, ${n} in hand${picked ? `, ${picked} chosen` : ''}">
        ${esc(rankLabel(rank))}
        <span class="tile-badge">${n}</span>
        ${picked ? `<span class="tile-picked">${picked} chosen</span>` : ''}
      </button>`;
  }

  function picker(rank, held, pub, priv) {
    const others = selTotal() - (ui.sel[rank] || 0);
    const room = priv.maxPlay - others;
    const ceiling = Math.min(held, room);
    const offered = pub.config.maxPlay;

    return `
      <div class="picker">
        <div class="picker-q">
          How many <b>${esc(rankName(rank, 2))}</b>? &mdash;
          you hold ${held}, room for ${Math.max(0, ceiling)}
        </div>
        <div class="counts">
          ${Array.from({ length: offered }, (_, i) => i + 1).map((n) => `
            <button class="count-btn ${ui.sel[rank] === n ? 'on' : ''}"
                    data-act="count" data-rank="${esc(rank)}" data-n="${n}"
                    ${n > ceiling ? 'disabled' : ''}>${n}</button>`).join('')}
        </div>
      </div>`;
  }

  /**
   * What the player is claiming, which is a separate question from what they
   * are playing, and that gap is the entire game.
   *
   * Defaulted rather than demanded: with one legal claim there is nothing to
   * ask, and when every chosen card is the same legal rank the honest claim is
   * overwhelmingly the intended one. An explicit tap still overrides it, and
   * the commit bar always spells out which it ended up being.
   */
  function effectiveClaim(pub) {
    const legal = pub.legalClaims || [];
    if (ui.claim && legal.includes(ui.claim)) return ui.claim;
    if (legal.length === 1) return legal[0];
    const chosen = Object.keys(ui.sel).filter((r) => ui.sel[r] > 0);
    if (chosen.length === 1 && legal.includes(chosen[0])) return chosen[0];
    return null;
  }

  /**
   * Only once there is something to claim.
   *
   * Under the `free` rank rule every rank is legal, so this is thirteen chips.
   * Rendered unconditionally they sit there inert above an empty hand-choice —
   * "Claim them as" with no "them" yet — and they cost real dock height on a
   * screen where that was measured down to the pixel. Gated on a selection the
   * dock reads as three beats instead: choose cards, say what they are, play.
   */
  function claimPicker(pub, claim) {
    const legal = pub.legalClaims || [];
    if (legal.length <= 1 || selTotal() === 0) return '';
    return `
      <div class="claim-pick">
        <span class="label">Claim them as</span>
        <div class="claim-chips">
          ${legal.map((r) => `
            <button class="chip ${claim === r ? 'on' : ''}" data-act="claim" data-rank="${esc(r)}"
                    aria-label="${esc(rankName(r, 2))}">${esc(rankLabel(r))}</button>`).join('')}
        </div>
      </div>`;
  }

  function commitBar(pub, priv, claim) {
    const total = selTotal();

    if (total === 0) {
      return `
        <div class="commit">
          <div class="commit-read">Tap a rank to choose cards &mdash; up to <b>${priv.maxPlay}</b></div>
          <button class="btn" disabled>PLAY</button>
        </div>`;
    }
    if (!claim) {
      return `
        <div class="commit">
          <div class="commit-read">${total} chosen &mdash; now say what you are claiming</div>
          <button class="btn" disabled>PLAY</button>
          <button class="btn ghost" data-act="clear">Clear selection</button>
        </div>`;
    }

    // In wild mode a joker really does satisfy the claim, so it is not one of
    // the lies. In junk mode it satisfies nothing and always is.
    const wild = pub.config.jokerMode === 'wild';
    let lies = 0;
    const parts = [];
    for (const [rank, n] of Object.entries(ui.sel)) {
      if (!n) continue;
      parts.push(`<b>${n}&times;${esc(rankLabel(rank))}</b>`);
      if (rank !== claim && !(wild && rank === JOKER)) lies += n;
    }
    const verdict = lies === 0
      ? '<span class="true">all true</span>'
      : `<span class="lie">${lies === 1 ? 'one is a lie' : `${lies} are lies`}</span>`;

    return `
      <div class="commit">
        <div class="commit-read">
          Playing ${parts.join(' + ')} as <b>${total} ${esc(rankName(claim, total))}</b> &mdash; ${verdict}
        </div>
        <button class="btn" data-act="play" data-claim="${esc(claim)}">
          PLAY ${total} AS ${esc(rankName(claim, total).toUpperCase())}
        </button>
        <button class="btn ghost" data-act="clear">Clear selection</button>
      </div>`;
  }

  // -----------------------------------------------------------------------
  // The challenge window
  // -----------------------------------------------------------------------

  function windowPanel(pub, priv) {
    const claim = pub.claim;
    if (!claim) return '';
    const claimer = pub.players.find((p) => p.id === claim.playerId);
    const mine = claim.playerId === priv.playerId;
    const pending = pub.pendingWinnerId === claim.playerId;
    const timed = pub.challengeEndsAt != null;
    const nextPlayer = pub.players.find((p) => p.id === pub.nextPlayerId);

    return `
      <div class="window-wrap">
        <div class="claim-card">
          <div class="claim-who">${mine ? 'You claim' : `${esc(claimer ? claimer.name : 'Somebody')} claims`}</div>
          <div class="claim-what">${claim.count} ${esc(rankName(claim.rank, claim.count))}</div>
          <div class="claim-sub ${pending ? 'pending' : ''}">
            ${pending
              ? `out of cards — if this stands, ${mine ? 'you win' : 'they win'}`
              : `leaving ${mine ? 'you' : 'them'} ${plural(claimer ? claimer.handCount : 0, 'card')}`}
          </div>
          <div class="facedown">${'<span class="fd"></span>'.repeat(Math.min(claim.count, 8))}</div>
        </div>

        ${timed ? `
          <div class="countdown">
            <div class="cd-bar"><div class="cd-fill js-cd-fill"></div></div>
            <div class="cd-num js-cd-num">&nbsp;</div>
          </div>` : ''}

        ${priv.canChallenge
          ? `<button class="btn warnish btn-challenge" data-act="challenge">CHALLENGE</button>`
          : `<div class="watching">${mine
              ? 'Waiting to see if anyone calls it'
              : timed
                ? 'You have already played — the table decides'
                : `Only ${esc(nextPlayer ? nextPlayer.name : 'the next player')} may call it`}</div>`}

        ${priv.canDecline
          ? `<button class="btn ghost" data-act="decline">LET IT STAND</button>`
          : ''}
      </div>`;
  }

  // -----------------------------------------------------------------------
  // The reveal
  // -----------------------------------------------------------------------

  function revealLayer(pub, priv) {
    const rv = pub.reveal;
    const wild = pub.config.jokerMode === 'wild';
    const claimed = rankName(rv.claimRank, rv.claimCount);

    // Second person, here as everywhere else. This is the one screen that was
    // built out of the engine's own record rather than out of the player list,
    // and the engine has no idea which device it is being read on — so left
    // alone it says "Yash takes the pile" to Yash, while the seat list two
    // inches above says "You". The reveal is the loudest moment in the game;
    // it is the last place that should be talking about you in the third
    // person.
    const mine = (id) => id === priv.playerId;
    const you = (id, name, caps) => (mine(id) ? (caps ? 'You' : 'you') : esc(name));

    const cards = rv.cards.map((c) => {
      const bad = !(c.rank === rv.claimRank || (wild && c.rank === JOKER));
      const cls = [
        'rv-card',
        RED_SUITS.has(c.suit) ? 'red' : '',
        c.rank === JOKER ? 'joker' : '',
        bad ? 'bad' : '',
      ].filter(Boolean).join(' ');
      const why = c.rank === JOKER && !wild
        ? 'JOKERS ARE JUNK'
        : `NOT ${esc(rankName(rv.claimRank, 1).toUpperCase())}`;
      return `<div class="${cls}" ${bad ? `data-why="${why}"` : ''}>
        ${esc(rankLabel(c.rank))}${c.rank === JOKER ? '' : `<span class="suit">${SUIT_GLYPH[c.suit] || ''}</span>`}
      </div>`;
    }).join('');

    return `
      <div class="reveal-scrim" role="alertdialog" aria-live="assertive"
           aria-label="Challenge resolved">
        <div class="rv-said">
          ${you(rv.challengerId, rv.challengerName, true)}
          called ${you(rv.playerId, rv.playerName)} &mdash;
          ${mine(rv.playerId) ? 'you said' : 'they said'}
          <b>${rv.claimCount} ${esc(claimed)}</b>
        </div>
        <div class="rv-verdict ${rv.truthful ? 'true' : ''}">
          ${rv.truthful ? 'THE TRUTH' : 'A LIE'}
        </div>
        <div class="rv-cards">${cards}</div>
        ${rv.jokerSaved ? '<div class="rv-foot">a joker covered it</div>' : ''}
        <div class="rv-outcome ${rv.truthful ? 'true' : ''}">
          <b>${you(rv.takerId, rv.takerName, true)}</b>
          ${mine(rv.takerId) ? 'take' : 'takes'} the pile &mdash; ${plural(rv.pileSize, 'card')}
        </div>
        <div class="rv-foot">${rv.cards.length === 1
          ? 'only the card played is shown'
          : `only the ${rv.cards.length} cards played are shown`}</div>
      </div>`;
  }

  // =======================================================================
  // GAME OVER
  // =======================================================================

  function overScreen(pub, priv) {
    const isHost = pub.hostId === priv.playerId;
    const winner = pub.players.find((p) => p.id === pub.winner);
    const meWon = pub.winner === priv.playerId;

    return `
      <section class="over">
        <p class="brand-sub">${pub.winner ? 'That is the game' : 'Ended by the host'}</p>
        <h1 class="over-verdict">
          ${pub.winner
            ? (meWon ? 'You win.' : `<span class="who">${esc(winner ? winner.name : 'Somebody')}</span> wins.`)
            : 'Called off.'}
        </h1>
        <div class="final">
          ${pub.players.map((p) => `
            <div class="final-row ${p.id === pub.winner ? 'won' : ''}">
              <span class="who">${esc(p.id === priv.playerId ? 'You' : p.name)}</span>
              <span class="seat-cards">${p.handCount}</span>
            </div>`).join('')}
        </div>
        <p class="blurb">${esc(describeConfig(pub.config))}</p>
        ${isHost
          ? '<button class="btn" data-act="again">PLAY AGAIN</button>'
          : '<p class="blurb">Waiting for the host to start another.</p>'}
        <button class="btn ghost" data-act="leave">BACK TO THE START</button>
      </section>`;
  }

  // =======================================================================
  // The countdown, and the flash
  // =======================================================================

  /**
   * Move the clock without rebuilding the screen.
   *
   * Called from the same interval the host already runs. It reads the
   * BROADCAST DEADLINE rather than counting down locally, so a device on a
   * slow connection shows the time that is actually left rather than the time
   * that was left when the packet was sent — and a device whose clock is wrong
   * shows a wrong bar rather than getting a wrong answer, because it never
   * decides anything. Expiry is the host's call and arrives as a new state.
   */
  function tick(now = Date.now()) {
    const fill = screen.querySelector('.js-cd-fill');
    if (!fill || !lastPub || lastPub.challengeEndsAt == null) return;
    const span = lastPub.windowMs || 1;
    const left = Math.max(0, lastPub.challengeEndsAt - now);
    fill.style.width = `${Math.max(0, Math.min(100, (left / span) * 100))}%`;
    const num = screen.querySelector('.js-cd-num');
    if (num) num.textContent = `${(left / 1000).toFixed(1)}s`;
    // The control stays put and goes visibly spent. See .btn-challenge.shut.
    if (left <= 0) {
      const wrap = screen.querySelector('.window-wrap');
      if (wrap) wrap.classList.add('spent');
      const btn = screen.querySelector('.btn-challenge');
      if (btn) { btn.classList.add('shut'); btn.textContent = 'WINDOW CLOSED'; btn.disabled = true; }
    }
  }

  /**
   * An engine refusal, in the words the engine chose.
   *
   * Every one of them is a sentence written to be read by the player it
   * refused — "You must claim Four." — so it goes somewhere fixed and fades,
   * rather than into an alert that has to be dismissed before the player can
   * act on what it said.
   */
  function flash(text) {
    if (!text) return;
    flashHost.innerHTML = `<div class="flash">${esc(text)}</div>`;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashHost.innerHTML = ''; }, 3400);
  }

  /** Wipe the half-finished move and the typed code. Called by the controller
   *  on the way back to the home screen, so the next table does not open with
   *  the last one's room code still sitting in the field. The NAME is
   *  deliberately kept — it is the same person. */
  function resetEntry() {
    resetSelection();
    ui.code = '';
    ui.copied = false;
    lastPub = null;
    lastPriv = null;
    lastHtml = null;
  }

  return { render, tick, flash, setNet, resetEntry };
}
