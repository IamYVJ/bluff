// ============================================================================
// sw.js — the service worker. Offline support, and nothing else.
//
// AT THE REPOSITORY ROOT, NOT IN js/, and that is forced rather than chosen. A
// worker's default scope is the directory it is served from, so a worker at
// ./js/sw.js could only ever control ./js/* — it would never see a navigation
// to the page. Widening the scope needs a `Service-Worker-Allowed` response
// header, and GitHub Pages does not let you set headers. So: root.
//
// It is also NOT a module. `type: 'module'` workers are supported now, but the
// registration in index.html does not ask for one, and importing js/util.js in
// here would be a mistake anyway — see the next paragraph.
//
// ---------------------------------------------------------------------------
// THE ONE RULE THAT MATTERS: THIS WORKER NEVER WRITES TO THE CACHE
// EXCEPT DURING install.
// ---------------------------------------------------------------------------
// There is no runtime caching, no stale-while-revalidate, no "cache it if the
// fetch succeeded". The precache is written once per version and read from
// thereafter. That single decision is what makes three separate hazards
// impossible rather than merely unlikely:
//
//   1. THE BEACON. Nothing cross-origin is ever stored — not the PeerJS bundle
//      from unpkg, not the fonts, and above all not one byte of signalling
//      traffic. A cached signalling response is a peer that dials a
//      conversation which ended yesterday, and the symptom is a room code that
//      "works" and then sits there forever. The origin check in the fetch
//      handler below refuses to respond to those at all, and with no write
//      path there is nothing left to disable.
//
//   2. THE HALF-STALE SHELL. Every byte the app runs comes from one cache
//      written by one install, so js/ui.js can never be the new version while
//      js/state.js is the old one. Mixed-version module graphs fail in ways
//      that look like logic bugs, and they are the reason the "Clear cache &
//      reload" button in the footer exists at all.
//
//   3. THE HOST'S SNAPSHOT. js/util.js keeps the whole engine — every hand in
//      the game — in localStorage so a host who reloads does not end the
//      table. Cache Storage is a different store and this worker never touches
//      localStorage, which is what makes the footer's reset button safe to
//      press mid-game. Stated here because the two stores are easy to conflate
//      and exactly one of them is disposable.
//
// ============================================================================

// ###########################################################################
//
//  VERSION
//
// ###########################################################################

// THE NAME IS THE VERSION, and there is nothing else in a service worker that
// can carry one. caches.addAll() is a no-op against a cache that already
// exists under this name, so a redeploy which keeps the name keeps serving the
// old bytes forever. The browser re-fetches this file on navigation and
// reinstalls when its bytes differ, so changing this string is also what
// triggers the update.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A CONTENT HASH AND NOT 'v1', 'v2', 'v3'
// ---------------------------------------------------------------------------
// A hand-written version number cannot be checked. No test can know whether
// you MEANT the bytes to change, so the only thing standing between a fix and
// the people it is for would be somebody remembering to edit this line — and
// the failure is silent, permanent, and invisible from inside the repository:
// the suite is green, the bug is fixed on disk, and every returning visitor
// keeps the broken build indefinitely.
//
// A fingerprint of the bytes CAN be checked. This is the sha256 of every path
// in SHELL, in sorted order, with line endings normalised so a checkout on
// Windows and a checkout on Linux agree.
//
// scripts/test-engine.mjs recomputes it and fails if it does not match, and
// `npm run stamp` rewrites this one line with the answer. So the rule is no
// longer "remember to bump this" — it is "the suite tells you, and one command
// does it". DO NOT EDIT THE TWELVE CHARACTERS BY HAND to turn a red suite
// green: the number is a claim about the bytes of nineteen other files, and
// typing one that happens to match is the same as deleting the check.
//
// Note what is NOT in SHELL and therefore not in the hash: sw.js itself. A
// worker does not precache itself, which is also the only reason this can be
// computed at all — and the only reason `npm run stamp` can write to this file
// without moving the target it just measured.
const SHELL_STAMP = 'dfe45ac3c090';

// Keeping the 'bluff-shell-' prefix matters: the activate handler deletes
// caches by it, and deleting by prefix is what stops this worker from throwing
// away a sibling project's caches on the same github.io origin.
const CACHE_NAME = `bluff-shell-${SHELL_STAMP}`;

// ###########################################################################
//
//  THE SHELL
//
// ###########################################################################

// EVERY STATIC ASSET THE SITE SERVES. Not "every module in the import graph" —
// every asset, which is a strictly larger and much easier set to check. The
// import graph is something you have to trace; the contents of js/ and css/
// and icons/ are something you can list. scripts/test-engine.mjs asserts this
// list against what is actually on disk IN BOTH DIRECTIONS, so a new module
// that is added and not listed fails the suite rather than failing offline
// three weeks later on somebody's train.
//
// All paths relative, so the worker's scope — and therefore a GitHub Pages
// project subpath — is picked up automatically.
const SHELL = [
  // The page. BOTH spellings, deliberately: a navigation to the bare directory
  // matches './' and a navigation to the file matches './index.html', and
  // although the server returns the same bytes for each, the Cache API matches
  // on the request URL and does not know that.
  './',
  './index.html',

  './manifest.webmanifest',
  './css/styles.css',

  // The modules. In rough dependency order for readability only; addAll does
  // not care and neither does the module loader.
  './js/main.js',
  './js/ui.js',
  './js/net.js',
  './js/bot.js',
  './js/intents.js',
  './js/guards.js',
  './js/state.js',
  './js/claims.js',
  './js/cards.js',
  './js/rules.js',
  './js/util.js',

  './icons/icon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// ###########################################################################
//
//  INSTALL
//
// ###########################################################################

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // addAll IS ALL-OR-NOTHING, and that is why it is used instead of a loop
    // of put()s that tolerate failures. If one module 404s — a rename that
    // missed this list, a bad deploy — the install rejects, this worker never
    // activates, and the previous version keeps serving. The alternative is a
    // cache missing js/state.js and an app that is broken offline and fine
    // online, which is the hardest kind of report to act on.
    await cache.addAll(SHELL);
  })());

  // NO self.skipWaiting(). A new worker waits until every tab running the old
  // one has gone.
  //
  // Taking over immediately is the popular choice and it is wrong here. A game
  // of Bluff can outlast a deploy, and skipWaiting would let a page that
  // already loaded the old js/ui.js start fetching the new js/state.js from an
  // activation that happened underneath it. Waiting means an update lands one
  // visit late, which is a cost the "Clear cache & reload" button exists to
  // pay off on demand.
});

// ###########################################################################
//
//  ACTIVATE
//
// ###########################################################################

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop every cache that is not this version's. Filtered by name rather
    // than deleting everything, because another app on the same origin — a
    // sibling project under the same github.io user — has its caches here too,
    // and this worker has no business touching them.
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('bluff-') && n !== CACHE_NAME)
        .map((n) => caches.delete(n))
    );

    // Take control of pages that were already open. With no skipWaiting above
    // this only ever matters for the FIRST install — the visit where the page
    // loaded before any worker existed — and it means that visit gets offline
    // support without needing a reload first.
    await self.clients.claim();
  })());
});

// ###########################################################################
//
//  FETCH
//
// ###########################################################################

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Not calling event.respondWith() at all hands the request back to the
  // browser untouched, which is the right answer for everything below and is
  // both cheaper and safer than proxying it.

  // Only GET. A POST is never cacheable and the Cache API will not store one.
  if (req.method !== 'GET') return;

  // CROSS-ORIGIN GOES STRAIGHT TO THE NETWORK, ALWAYS. The PeerJS bundle, the
  // fonts, the STUN servers and every byte of signalling traffic are somebody
  // else's origin. See the header: this is the beacon rule, and it is enforced
  // by an origin check rather than by an allowlist because an allowlist is a
  // list of the third parties you thought of.
  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return; // Not a URL this worker can reason about; leave it alone.
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    // A NAVIGATION ALWAYS ENDS UP AT index.html. Any URL under the scope — a
    // shared link with a stale path, a bookmark to something that no longer
    // exists — resolves to the one page this app has. Cache first, because the
    // whole point is that it works on a train.
    if (req.mode === 'navigate') {
      // ------------------------------------------------------------------
      // A DEEPER PATH IS REDIRECTED, NOT SERVED, AND THE DIFFERENCE IS THE
      // WHOLE FIX.
      //
      // Serving index.html's bytes at /bluff/room/QRTX looks like it works
      // and does not. EVERY PATH IN THAT FILE IS RELATIVE — deliberately, so
      // the app runs at a domain root and under a GitHub Pages subpath alike
      // — so at that address "./css/styles.css" resolves to
      // /bluff/room/css/styles.css, which is in no cache and on no disk. The
      // result is the raw markup with no stylesheet and no modules: a blank
      // dark page that reloads straight back into itself, because the URL
      // that caused it is still in the bar. Verified in a browser, not
      // theorised: title "Bluff", background rgba(0,0,0,0), no #screen.
      //
      // <base href> cannot fix it. "./" is what is already broken, and a
      // root-relative "/" would hard-code a deployment that the relative-path
      // rule exists to avoid.
      //
      // So the address itself has to change. A redirect fixes the bar as well
      // as the page, which means the reload works, the bookmark self-heals,
      // and the next navigation is an ordinary root one. It is synthesised
      // here rather than fetched, so it still works on the train.
      //
      // The test is the DIRECTORY, not the path, so that "/bluff/",
      // "/bluff/index.html" and "/bluff/?debug=1" are all served in place —
      // their relative paths already resolve correctly, and redirecting the
      // last of those would silently eat the query.
      // ------------------------------------------------------------------
      const here = new URL('./', url).href;
      const root = new URL('./', self.location).href;
      if (here !== root) return Response.redirect(root, 302);

      const page = await cache.match('./index.html');
      if (page) return page;
      return fetch(req);
    }

    // ignoreSearch, so that ./js/main.js?v=2 — a cache-buster somebody appends
    // while debugging, or a query a tool adds — still matches the precached
    // ./js/main.js rather than silently falling through to the network and
    // breaking offline.
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;

    // Not ours. Fetch it and, per the rule at the top of this file, do NOT
    // store the result.
    try {
      return await fetch(req);
    } catch (_) {
      // Offline and not precached. Response.error() reproduces what the
      // browser would have done on its own, so the page's own error handling
      // sees a normal network failure rather than a 200 with a body it cannot
      // parse — which is what returning a synthesised Response here would do.
      return Response.error();
    }
  })());
});
