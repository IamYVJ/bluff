// ============================================================================
// peershim.mjs — a fake `window.Peer`, so the transport can be tested without
// a browser, a broker, or a second device.
//
// WHY THIS EXISTS AT ALL
//   js/net.js is the one module whose bugs are invisible on the machine that
//   writes them. Everything else in this project is a function of its
//   arguments; the transport is a function of two processes, a public
//   signalling server and a radio. The parts that matter most — the
//   impersonation boundary, the privacy invariant, the reclaim loop the
//   REPLACED frame exists to break — are precisely the parts that need a
//   SECOND participant to exercise at all. A host talking to nobody proves
//   nothing about what it sends to somebody.
//
//   So both ends run in one process, wired to each other, and the suite drives
//   them. Nothing here is mocked at the net.js boundary: createHost() and
//   joinHost() are the real functions, running their real handshake, over an
//   object that satisfies the parts of the PeerJS surface they touch.
//
// DETERMINISM IS THE WHOLE POINT
//   Every callback is QUEUED rather than called, and flush() drains the queue.
//   A test therefore runs to completion synchronously and in one order, which
//   is what makes a failure reproducible — a shim built on real timers turns
//   "the reaper fired before the open" into a bug that appears on a loaded CI
//   box once a fortnight and never on a laptop.
//
//   The queue also reproduces the one ordering that matters and that a
//   synchronous shim would get wrong: in PeerJS the host's 'connection' event
//   arrives with a DataConnection that is NOT yet open, and js/net.js registers
//   conn.on('open') inside that handler. Deliver the two in the same tick and
//   the open is missed; that is a real class of bug and the queue preserves it.
//
// WHAT IS DELIBERATELY NOT MODELLED
//   Latency, packet loss, reordering, ICE, TURN, and serialisation. net.js
//   sends JSON text and this shim hands the same string to the other end, so a
//   test cannot accidentally pass by sharing an object reference across the
//   wire — but it also cannot catch a value that survives structuredClone and
//   not JSON.stringify, because both ends here agree on JSON by construction.
//   That is the right trade: the transport's job is not to be a network, it is
//   to be correct about identity and privacy while a network misbehaves, and
//   the misbehaviour is injected explicitly through the control surface below
//   rather than sampled from a random number generator.
// ============================================================================

/** Bumped for the random ids handed to peers that did not ask for one, so a
 *  joiner's id is stable within a run and unique across it. */
let serial = 0;

/**
 * Install the shim onto globalThis.window and hand back the controls.
 *
 * Returns everything a test needs to be unkind to the transport: flush to
 * advance, and four different ways for a connection to end, because net.js
 * treats them differently and the differences are where the bugs are.
 */
export function installPeerShim() {
  const peers = new Map();       // peer id -> FakePeer, the "broker"
  const queue = [];              // pending deliveries, in order
  let brokerUp = true;           // false: registrations and reconnects fail
  let delivered = 0;             // every callback ever run, for leak checks

  const enqueue = (fn) => { queue.push(fn); };

  /**
   * Run everything queued, including whatever running it queues.
   *
   * The cap is a deadlock detector rather than a resource limit: two handlers
   * that answer each other produce an infinite queue, and a test that hangs
   * forever is much harder to diagnose than one that throws with a count. Ten
   * thousand is far beyond any legitimate exchange here — a full eight-seat
   * push is a few dozen deliveries.
   */
  function flush(limit = 10000) {
    let n = 0;
    while (queue.length) {
      if (++n > limit) throw new Error('peershim: flush did not settle — handlers are answering each other');
      const fn = queue.shift();
      delivered += 1;
      fn();
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // The event surface both fakes share.
  //
  // MULTIPLE LISTENERS PER EVENT IS NOT OPTIONAL. net.js registers
  // peer.on('open') twice — once in attachBrokerRecovery for the retry ladder,
  // once in createHost for the room code — and a shim that kept one callback
  // per event would silently drop the broker recovery, which is exactly the
  // code least likely to be noticed missing.
  // -------------------------------------------------------------------------
  class Emitter {
    constructor() { this._on = new Map(); }
    on(ev, fn) {
      if (!this._on.has(ev)) this._on.set(ev, []);
      this._on.get(ev).push(fn);
      return this;
    }
    off(ev, fn) {
      const list = this._on.get(ev);
      if (list) this._on.set(ev, list.filter((f) => f !== fn));
      return this;
    }
    /** Queued, never immediate. See the header. */
    emit(ev, ...args) {
      const list = this._on.get(ev);
      if (!list || !list.length) return;
      for (const fn of [...list]) enqueue(() => fn(...args));
    }
  }

  // -------------------------------------------------------------------------
  // One end of a link.
  //
  // `peer` is the id of the OTHER end, which is PeerJS's convention and the
  // single most important thing for this shim to get right: js/net.js derives
  // every player id from `conn.peer`, so an end that reported its own id would
  // make the host seat itself once per guest and the tests would all pass.
  // -------------------------------------------------------------------------
  class FakeConn extends Emitter {
    constructor(localPeer, remotePeerId, meta) {
      super();
      this._local = localPeer;
      this.peer = remotePeerId;
      this.open = false;
      this.other = null;          // the paired FakeConn, set by link()
      this.metadata = meta;
      this.reliable = true;
      this.sent = [];             // every raw string this end put on the wire
    }

    send(data) {
      // Real PeerJS throws InvalidStateError on a closed channel, and net.js's
      // trySend() wraps every send in a try/catch for exactly that. Throwing
      // here is what proves the wrapper is load-bearing rather than decorative.
      if (!this.open) throw new Error('InvalidStateError: connection is not open');
      this.sent.push(data);
      const far = this.other;
      if (!far || !far.open) return;
      enqueue(() => { if (far.open) far.emit('data', data); });
    }

    close() {
      if (!this.open && !this.other) return;
      const far = this.other;
      this.open = false;
      this.emit('close');
      if (far && far.open) { far.open = false; far.emit('close'); }
    }

    /** A phone in a tunnel. The channel stops carrying traffic and NEITHER end
     *  is told — which is the case the handshake reaper and the reclaim path
     *  exist for, and the one a polite close() never reaches. */
    silence() { this._silent = true; this.open = false; if (this.other) this.other._silent = true; }
  }

  // -------------------------------------------------------------------------
  // A peer, and its relationship with the broker.
  // -------------------------------------------------------------------------
  class FakePeer extends Emitter {
    constructor(idOrOpts, maybeOpts) {
      super();
      const wantsId = typeof idOrOpts === 'string';
      this.id = wantsId ? idOrOpts : `shim-anon-${++serial}`;
      this.options = (wantsId ? maybeOpts : idOrOpts) || {};
      this.open = false;
      this.destroyed = false;
      this.disconnected = false;
      this.connections = new Set();

      // Registration is asynchronous in reality — it is a websocket round trip
      // — and net.js depends on that: createHost() attaches peer.on('open')
      // AFTER the constructor returns. Firing 'open' synchronously here would
      // make a passing test out of code that never sees its own room code.
      enqueue(() => {
        if (this.destroyed) return;
        if (!brokerUp) {
          this.emit('error', { type: 'network', message: 'shim: broker is down' });
          return;
        }
        // A collision on an id somebody else already holds. The whole reason
        // js/main.js has a rehost path.
        if (wantsId && peers.has(this.id)) {
          this.emit('error', { type: 'unavailable-id', message: `shim: ${this.id} is taken` });
          return;
        }
        peers.set(this.id, this);
        this.open = true;
        this.disconnected = false;
        this.emit('open', this.id);
      });
    }

    connect(targetId, opts = {}) {
      const near = new FakeConn(this, targetId, opts.metadata);
      this.connections.add(near);

      enqueue(() => {
        if (this.destroyed) return;
        const host = peers.get(targetId);
        if (!host || host.destroyed) {
          // No such table. Fatal, and the commonest real cause is a mistyped
          // room code.
          this.emit('error', { type: 'peer-unavailable', message: `shim: could not connect to ${targetId}` });
          return;
        }
        const far = new FakeConn(host, this.id, opts.metadata);
        host.connections.add(far);
        near.other = far;
        far.other = near;

        // THE ORDER BELOW IS THE POINT OF THE QUEUE. The host is handed a
        // connection that is not yet open, registers its handlers, and only
        // then do the two ends open. Collapse these three into one tick and
        // js/net.js's conn.on('open') is attached after the event it wanted.
        host.emit('connection', far);
        enqueue(() => {
          if (this.destroyed || host.destroyed) return;
          near.open = true;
          far.open = true;
          far.emit('open');
          near.emit('open');
        });
      });

      return near;
    }

    /** The broker socket drops. EXISTING LINKS SURVIVE — they run device to
     *  device — which is the fact js/net.js's whole "a banner, not an ending"
     *  distinction rests on, so the shim had better honour it. */
    disconnect() {
      if (this.destroyed || this.disconnected) return;
      this.open = false;
      this.disconnected = true;
      peers.delete(this.id);
      this.emit('disconnected', this.id);
    }

    reconnect() {
      if (this.destroyed) throw new Error('shim: cannot reconnect a destroyed peer');
      if (!this.disconnected) return;
      enqueue(() => {
        if (this.destroyed || !this.disconnected) return;
        if (!brokerUp) { this.emit('error', { type: 'network', message: 'shim: broker is still down' }); return; }
        // The SAME id, which is what keeps a room code valid across a blip.
        peers.set(this.id, this);
        this.open = true;
        this.disconnected = false;
        this.emit('open', this.id);
      });
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.open = false;
      peers.delete(this.id);
      for (const c of this.connections) c.close();
      this.connections.clear();
    }
  }

  const previous = globalThis.window;
  globalThis.window = { ...(previous || {}), Peer: FakePeer };

  return {
    FakePeer,
    flush,
    peers,

    /** How many callbacks have run. A cheap way to assert that a torn-down
     *  transport has genuinely gone quiet rather than merely looking quiet. */
    delivered: () => delivered,

    /** Registrations and reconnects start failing. Existing links are
     *  untouched, matching disconnect(). */
    setBroker(up) { brokerUp = !!up; },

    /** The signalling socket drops under a peer that is otherwise fine. */
    dropBroker(peerId) { const p = peers.get(peerId); if (p) p.disconnect(); },

    /** A phone whose battery died: everything closes, politely. */
    killPeer(peerId) { const p = peers.get(peerId); if (p) p.destroy(); },

    uninstall() {
      queue.length = 0;
      peers.clear();
      if (previous === undefined) delete globalThis.window;
      else globalThis.window = previous;
    },
  };
}
