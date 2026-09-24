// ============================================================================
// scripts/gen-icons.js — writes icons/*.png. Run with `npm run icons`.
//
// WHY THIS FILE EXISTS AT ALL, rather than five binaries checked in.
//
// The brief is zero dependencies and no build step, and both still hold: this
// script is not a dependency (nothing imports it, the app never runs it) and
// not a build step (its output is committed; the site is served exactly as it
// sits on disk). It is a one-shot generator, kept in the repository so that
// the next person can change the accent in one place and re-run, instead of
// opening a design tool to discover what shade of green a PNG happens to hold.
//
// It is also the only honest way to keep the icons and css/styles.css
// agreeing. The palette below is copied from the token block with the copy
// called out; there is no way for a PNG to read a CSS custom property.
//
// ---------------------------------------------------------------------------
// NO IMAGE LIBRARY, AND THEREFORE A PNG ENCODER
// ---------------------------------------------------------------------------
// PNG is a small enough format to write by hand when you need exactly one
// flavour of it: 8-bit truecolour, no interlacing, no palette, one filter type.
// That is a signature, three chunks and a CRC. node's zlib does the only
// genuinely hard part (DEFLATE) and it is in the standard library.
//
// Everything is drawn analytically — signed distance functions, not a raster
// library — and supersampled, because an icon with jagged edges looks broken in
// a way that an icon with the wrong colours does not.
// ============================================================================

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

// ###########################################################################
//
//  PNG
//
// ###########################################################################

// CRC-32, the one PNG specifies. Table built once; the naive bit-by-bit loop
// would run three million times over the 512px icon and is measurably slow.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** One PNG chunk: length, type, payload, CRC of (type + payload). */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Encode a W*H*3 RGB buffer as a PNG.
 *
 * Filter byte 0 ("None") on every scanline. Real encoders try all five filters
 * per row and keep the smallest; these images are flat colour and gradients
 * where None already compresses well, and the largest file this produces is a
 * few tens of kilobytes. Not worth the code.
 */
function encodePNG(width, height, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type 2 = truecolour RGB
  ihdr[10] = 0;  // compression: deflate, the only legal value
  ihdr[11] = 0;  // filter method: adaptive, the only legal value
  ihdr[12] = 0;  // interlace: none

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ###########################################################################
//
//  THE PALETTE
//
// ###########################################################################

// COPIED FROM css/styles.css's :root, and this is a copy with no way to avoid
// being one — a PNG cannot read a custom property. If the accent changes
// there, change it here and re-run. The two are checked against each other by
// eye and nothing else.
const BG_DEEP = [0x07, 0x13, 0x0E]; // --bg
const BG_GLOW = [0x0D, 0x2A, 0x1D]; // --bg-glow
const CARD_FG = [0xED, 0xE6, 0xD6]; // --card
const CARD_BK = [0xC2, 0xBA, 0xA6]; // --card-2, darkened: the face-down card
                                    // has to recede or the two read as one
                                    // pale blob at 32px
const ACCENT  = [0xA8, 0xCC, 0x3C]; // --accent
const EDGE    = [0x08, 0x18, 0x11]; // a dark lip, so a pale card never bleeds
                                    // into the card behind it

// ###########################################################################
//
//  SHAPES
//
// ###########################################################################

/**
 * Signed distance to a rotated rounded rectangle. Negative inside.
 *
 * Returning a DISTANCE rather than a boolean is what makes the antialiasing
 * below possible: a boolean can only say in or out, and the edge pixels of an
 * icon are the ones that decide whether it looks drawn or rendered.
 */
function sdRoundRect(px, py, cx, cy, w, h, r, angle) {
  const ca = Math.cos(-angle), sa = Math.sin(-angle);
  const dx = px - cx, dy = py - cy;
  const x = dx * ca - dy * sa;
  const y = dx * sa + dy * ca;
  const qx = Math.abs(x) - (w / 2 - r);
  const qy = Math.abs(y) - (h / 2 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

/** Signed distance to a rotated ellipse, scaled back to roughly pixel units. */
function sdEllipse(px, py, cx, cy, a, b, angle) {
  const ca = Math.cos(-angle), sa = Math.sin(-angle);
  const dx = px - cx, dy = py - cy;
  const x = dx * ca - dy * sa;
  const y = dx * sa + dy * ca;
  return (Math.hypot(x / a, y / b) - 1) * Math.min(a, b);
}

// ###########################################################################
//
//  THE MARK
//
// ###########################################################################

/**
 * WHAT THE ICON IS OF, and why it is not the same two cards as the siblings.
 *
 * Sequence and Judgement both draw a fanned pair with a pip on the front one,
 * because in those games the card you play is the card you have. This game is
 * the opposite: the whole of Bluff is the gap between the card on the table
 * and the claim made about it. So the front card here is FACE DOWN — a blank
 * back with the accent as a single bold slash across it — and the card behind
 * it shows a corner of a real face. You can see that something is being held
 * back, which is the only idea in the game worth thirty-two pixels.
 *
 * It also survives the size floor, which the alternatives did not. A pile with
 * a question mark needs legible glyph curves; two cards and a slash are three
 * straight-edged shapes.
 *
 * ---------------------------------------------------------------------------
 * THE FAVICON IS A DIFFERENT DRAWING, NOT THE SAME ONE SHRUNK.
 * ---------------------------------------------------------------------------
 * The first version of this file rendered the pair at 32 and the result was a
 * pale blob: at that size the two cards are four pixels apart, the slash is
 * under two pixels wide, and the corner pip lands on one. Antialiasing then
 * averages all of it into porridge — the mark was legible at 192 and carried
 * no information at all at 32.
 *
 * So `small` drops to ONE card, face down, bigger in the tile, with a slash
 * wide enough to survive. It gives up the idea (a card held back BEHIND one
 * you can see) and keeps the identity (a lime slash on a card, in this
 * family's colours), which is the right trade at a size where a browser is
 * only ever answering "which tab is this".
 */

/**
 * Colour of one sample point, in the unit square [0,1]x[0,1].
 *
 * Painter's algorithm, back to front, each layer compositing over the last
 * with a coverage derived from its signed distance. `scale` shrinks the
 * foreground about the centre without touching the background, which is how
 * the maskable variant gets its safe zone.
 */
function sample(u, v, scale, small) {
  // --- background: the app's own radial glow, flattened to two stops.
  // radial-gradient(120% 80% at 50% -10%, --bg-glow, --bg 55%)
  const gx = (u - 0.5) / 1.2;
  const gy = (v + 0.1) / 0.8;
  const t = Math.min(1, Math.hypot(gx, gy) / 0.55);
  const ease = t * t * (3 - 2 * t); // smoothstep: a linear ramp bands visibly
  let out = [
    BG_GLOW[0] + (BG_DEEP[0] - BG_GLOW[0]) * ease,
    BG_GLOW[1] + (BG_DEEP[1] - BG_GLOW[1]) * ease,
    BG_GLOW[2] + (BG_DEEP[2] - BG_GLOW[2]) * ease,
  ];

  // Work in "unit" coordinates about the centre so `scale` is one multiply.
  const x = 0.5 + (u - 0.5) / scale;
  const y = 0.5 + (v - 0.5) / scale;

  // Edge softness, in the same units. One sample wide at the supersampled
  // resolution would alias; this is deliberately a touch wider than a pixel.
  const AA = 0.004 / scale;

  const over = (dist, colour) => {
    // Coverage: 1 well inside, 0 well outside, a smooth ramp across the edge.
    const cov = Math.min(1, Math.max(0, 0.5 - dist / (2 * AA)));
    if (cov <= 0) return;
    out = [
      out[0] + (colour[0] - out[0]) * cov,
      out[1] + (colour[1] - out[1]) * cov,
      out[2] + (colour[2] - out[2]) * cov,
    ];
  };

  // --- THE 32px DRAWING. One card, bigger, with a slash that is still a
  // slash after the box filter. See the note above the function.
  if (small) {
    const sA = 0.16, scx = 0.5, scy = 0.5;
    const SW = 0.58, SH = 0.78, SR = 0.085, SLIP = 0.022;
    over(sdRoundRect(x, y, scx, scy, SW + SLIP * 2, SH + SLIP * 2, SR + SLIP, sA), EDGE);
    over(sdRoundRect(x, y, scx, scy, SW, SH, SR, sA), CARD_FG);
    const insideSmall = sdRoundRect(x, y, scx, scy, SW - 0.10, SH - 0.10, SR, sA);
    if (insideSmall < 0) {
      over(sdRoundRect(x, y, scx, scy, 0.135, 0.90, 0.06, sA + 0.86), ACCENT);
    }
    return out;
  }

  const W = 0.40, H = 0.55, R = 0.055;
  const LIP = 0.011;

  // --- the card behind: tilted left, face up, only a corner of it showing.
  const backA = -0.30, bcx = 0.5 - 0.085, bcy = 0.5 - 0.010;
  over(sdRoundRect(x, y, bcx, bcy, W + LIP * 2, H + LIP * 2, R + LIP, backA), EDGE);
  over(sdRoundRect(x, y, bcx, bcy, W, H, R, backA), CARD_FG);

  // Its pip, pushed up into the exposed top-left corner rather than centred —
  // the middle of this card is about to be covered. Rotated with the card, so
  // the offset is applied in the card's own frame.
  const pca = Math.cos(backA), psa = Math.sin(backA);
  const pox = -0.105, poy = -0.150;
  over(sdEllipse(x, y,
    bcx + pox * pca - poy * psa,
    bcy + pox * psa + poy * pca,
    0.052, 0.062, backA), ACCENT);

  // --- the card in front: tilted right, FACE DOWN, over the top of it.
  const frontA = 0.155, fcx = 0.5 + 0.075, fcy = 0.5 + 0.025;
  over(sdRoundRect(x, y, fcx, fcy, W + LIP * 2, H + LIP * 2, R + LIP, frontA), EDGE);
  over(sdRoundRect(x, y, fcx, fcy, W, H, R, frontA), CARD_BK);

  // The slash across the back. A rounded rect rotated 45 degrees relative to
  // the card is a bar; clipping it to the card is what makes it read as
  // printed on rather than lying across, and the clip is the same distance
  // function evaluated twice.
  const insideFront = sdRoundRect(x, y, fcx, fcy, W - 0.075, H - 0.075, R, frontA);
  if (insideFront < 0) {
    over(sdRoundRect(x, y, fcx, fcy, 0.052, 0.60, 0.026, frontA + 0.86), ACCENT);
  }

  return out;
}

/**
 * Render at size*SS and box-average down.
 *
 * SS=4 means sixteen samples a pixel. Cheap here — the 512 icon is four
 * million samples and takes well under a second — and it is the difference
 * between an icon whose tilted card edges are smooth and one where they are a
 * staircase.
 */
const SS = 4;

function renderIcon(size, scale, small = false) {
  const big = size * SS;
  const rgb = Buffer.alloc(size * size * 3);

  // One row of supersamples at a time, so the 2048-wide intermediate never
  // exists as a whole image.
  const rowAcc = new Float64Array(size * 3);

  for (let py = 0; py < size; py++) {
    rowAcc.fill(0);
    for (let sy = 0; sy < SS; sy++) {
      const v = (py * SS + sy + 0.5) / big;
      for (let px = 0; px < size; px++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px * SS + sx + 0.5) / big;
          const c = sample(u, v, scale, small);
          rowAcc[px * 3] += c[0];
          rowAcc[px * 3 + 1] += c[1];
          rowAcc[px * 3 + 2] += c[2];
        }
      }
    }
    const n = SS * SS;
    for (let i = 0; i < size * 3; i++) {
      rgb[py * size * 3 + i] = Math.max(0, Math.min(255, Math.round(rowAcc[i] / n)));
    }
  }

  return encodePNG(size, size, rgb);
}

// ###########################################################################
//
//  WRITE
//
// ###########################################################################

mkdirSync(OUT_DIR, { recursive: true });

const JOBS = [
  // scale 1 = the mark fills its usual amount of the tile.
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],

  // Favicon. Drawn at 32 rather than downscaled from 512, so the edge ramp is
  // computed at the size it will actually be seen at — and drawn with the
  // SIMPLIFIED mark, which is the fourth argument. See sample().
  ['icon-32.png', 32, 1, true],

  // iOS applies its own rounded-rectangle mask and does NOT composite over a
  // background, so this one must be opaque edge to edge — which it is, because
  // every icon here paints the gradient across the whole tile. 180 is the size
  // current iPhones ask for.
  ['apple-touch-icon.png', 180, 1],

  // MASKABLE. Android may crop this to a circle, a squircle or a teardrop, and
  // guarantees only the central 80% circle. 0.72 rather than 0.8 because the
  // mark is a pair of tilted rectangles whose corners reach further from the
  // centre than their width suggests — measured, not guessed: the far corner
  // of the front card sits at ~0.43 of the tile, and 0.43 * 0.72 / 0.5 lands
  // comfortably inside.
  ['icon-maskable-512.png', 512, 0.72],
];

for (const [name, size, scale, small = false] of JOBS) {
  const png = renderIcon(size, scale, small);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`${name.padEnd(26)} ${String(size).padStart(3)}px  ${String(png.length).padStart(6)} bytes`);
}

console.log(`\nwrote ${JOBS.length} icons to icons/`);
