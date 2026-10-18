/**
 * Fails if any two filters in the picker look too much alike.
 *
 * This exists because "the filters all look the same" came up repeatedly and
 * kept getting answered by eye, which doesn't converge: renaming them doesn't
 * change how they look, and porting published recipes made it worse, because
 * instagram.css's recreations of the October-2015 batch are near-duplicates of
 * each other (eight of ten share one recipe shape, six share one overlay
 * colour). The only way out was to make the property measurable.
 *
 * Each filter is applied to realistic probe colours -- skin at three
 * lightnesses, sky, foliage, grey, denim, a warm wall, white, shadow -- matrix
 * first, then its overlay composited in the right blend mode. The results are
 * converted to CIELAB and compared. Mean dE across the probes is the distance
 * between two filters.
 *
 * Rough reading of dE: under 2.3 is indistinguishable to most people, under 5
 * is "basically the same look", 10+ is comfortably different.
 *
 *   npx tsx scripts/verify-filter-distinctness.ts
 */
import { PICKER_FILTERS } from '../lib/filters';
import type { Filter } from '../lib/types';

/**
 * A floor, not a target. Current worst pair sits just above it; if you change
 * a recipe and trip this, the fix is to move that filter onto an axis nothing
 * else is using, not to lower the number.
 */
const MIN_DELTA_E = 9.5;

/**
 * Normal is exempt as a comparison target: it's the no-op baseline, and the
 * lightest-touch filter in the set is *supposed* to sit near it.
 */
const BASELINE = 'Normal';

type RGB = [number, number, number];

const PROBES: Array<[string, RGB]> = [
  ['skin light', [0.91, 0.78, 0.69]],
  ['skin mid', [0.76, 0.57, 0.44]],
  ['skin deep', [0.4, 0.26, 0.19]],
  ['sky', [0.35, 0.6, 0.85]],
  ['foliage', [0.28, 0.45, 0.18]],
  ['mid grey', [0.5, 0.5, 0.5]],
  ['warm wall', [0.8, 0.7, 0.55]],
  ['denim', [0.22, 0.3, 0.48]],
  ['white', [0.96, 0.96, 0.96]],
  ['shadow', [0.1, 0.1, 0.12]],
];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function applyMatrix(m: number[], [r, g, b]: RGB): RGB {
  return [
    clamp01(m[0] * r + m[1] * g + m[2] * b + m[4]),
    clamp01(m[5] * r + m[6] * g + m[7] * b + m[9]),
    clamp01(m[10] * r + m[11] * g + m[12] * b + m[14]),
  ];
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** The CSS/Skia separable blend functions, per channel. */
function blendChannel(mode: string, cb: number, cs: number): number {
  switch (mode) {
    case 'multiply':
      return cb * cs;
    case 'screen':
      return cb + cs - cb * cs;
    case 'darken':
      return Math.min(cb, cs);
    case 'lighten':
      return Math.max(cb, cs);
    case 'overlay':
      return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case 'softLight': {
      if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
      const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
      return cb + (2 * cs - 1) * (d - cb);
    }
    default:
      return cs;
  }
}

/**
 * Solid overlays only. A radial overlay's contribution depends on where in
 * the frame you sample, so there's no single colour to composite -- the
 * picker's own filters are all solid-or-none, and the legacy ones that use
 * radials aren't offered any more, so this never has to guess.
 */
function applyOverlay(f: Filter, c: RGB): RGB {
  const o = f.overlay;
  if (!o || o.kind !== 'solid') return c;
  const cs = hexToRgb(o.colors[0] ?? '#00000000');
  const a = o.opacity;
  return c.map((cb, i) =>
    clamp01((1 - a) * cb + a * blendChannel(o.blend, cb, cs[i] ?? 0)),
  ) as RGB;
}

const render = (f: Filter, probe: RGB): RGB => applyOverlay(f, applyMatrix(f.matrix, probe));

/** sRGB -> CIELAB, D65. */
function toLab([r, g, b]: RGB): [number, number, number] {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(a: RGB, b: RGB): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

function distance(f1: Filter, f2: Filter): number {
  let sum = 0;
  for (const [, probe] of PROBES) sum += deltaE(render(f1, probe), render(f2, probe));
  return sum / PROBES.length;
}

const filters = PICKER_FILTERS.filter((f) => f.name !== BASELINE);
const pairs: Array<[string, string, number]> = [];
for (let i = 0; i < filters.length; i++) {
  for (let j = i + 1; j < filters.length; j++) {
    pairs.push([filters[i].name, filters[j].name, distance(filters[i], filters[j])]);
  }
}
pairs.sort((a, b) => a[2] - b[2]);

console.log(`\n${filters.length} filters (excluding ${BASELINE}), ${pairs.length} pairs.`);
console.log(`Floor: mean dE >= ${MIN_DELTA_E}\n`);

console.log('Closest pairs:');
for (const [a, b, d] of pairs.slice(0, 8)) {
  console.log(`  ${d.toFixed(1).padStart(5)}  ${a} / ${b}${d < MIN_DELTA_E ? '   <-- TOO CLOSE' : ''}`);
}

const width = Math.max(...filters.map((f) => f.name.length));
console.log('\nNearest neighbour per filter:');
for (const f of filters) {
  const near = pairs.find(([a, b]) => a === f.name || b === f.name)!;
  const other = near[0] === f.name ? near[1] : near[0];
  console.log(`  ${f.name.padEnd(width)}  ${near[2].toFixed(1).padStart(5)}  (${other})`);
}

const failures = pairs.filter(([, , d]) => d < MIN_DELTA_E);
if (failures.length > 0) {
  console.log(`\n${failures.length} pair(s) below the floor:`);
  for (const [a, b, d] of failures) console.log(`  FAIL  ${a} / ${b} at ${d.toFixed(1)}`);
  console.log();
  process.exit(1);
}
console.log(`\nAll pairs clear the floor. Worst: ${pairs[0][2].toFixed(1)} (${pairs[0][0]} / ${pairs[0][1]}).\n`);
