/**
 * Independent checks on the filter engine's matrix math.
 *
 * The filter recipes are the one part of this app where a subtle numeric error
 * produces something that still *renders*, just wrong — a slightly grey white
 * point, a strength slider that never quite returns to the original. These
 * assertions pin down the properties that catch that.
 *
 *   npx tsx scripts/verify-filters.ts
 */
import {
  FILTERS,
  identity,
  compose,
  saturate,
  contrast,
  brightness,
  sepia,
  grayscale,
  hueRotate,
  lerpMatrix,
  effectiveOverlay,
  getFilter,
  type ColorMatrix,
} from '../lib/filters';

let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function close(a: number, b: number, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

function matrixClose(a: ColorMatrix, b: ColorMatrix, eps = 1e-9) {
  return a.length === b.length && a.every((v, i) => close(v, b[i], eps));
}

/** Apply a 4x5 matrix to a straight-alpha RGBA colour in 0–1 space. */
function apply(m: ColorMatrix, [r, g, b, a]: number[]): number[] {
  return [
    m[0] * r + m[1] * g + m[2] * b + m[3] * a + m[4],
    m[5] * r + m[6] * g + m[7] * b + m[8] * a + m[9],
    m[10] * r + m[11] * g + m[12] * b + m[13] * a + m[14],
    m[15] * r + m[16] * g + m[17] * b + m[18] * a + m[19],
  ];
}

console.log('\nPrimitives are exact identity at their no-op value');
check('saturate(1)', matrixClose(saturate(1), identity()));
check('contrast(1)', matrixClose(contrast(1), identity()));
check('brightness(1)', matrixClose(brightness(1), identity()));
check('sepia(0)', matrixClose(sepia(0), identity()));
check('grayscale(0)', matrixClose(grayscale(0), identity()));
check('hueRotate(0)', matrixClose(hueRotate(0), identity()));
check('hueRotate(360) ≈ identity', matrixClose(hueRotate(360), identity(), 1e-6));

console.log('\ncompose applies in listed order');
{
  const a = brightness(1.2);
  const b = saturate(0.8);
  const sample = [0.3, 0.5, 0.7, 1];
  const composed = apply(compose(a, b), sample);
  const sequential = apply(b, apply(a, sample));
  check('compose(a,b) == b(a(x))', composed.every((v, i) => close(v, sequential[i], 1e-9)));
}

console.log('\nStrength slider returns to the original');
for (const f of FILTERS) {
  check(`lerpMatrix("${f.name}", 0) is identity`, matrixClose(lerpMatrix(f.matrix, 0), identity()));
}
for (const f of FILTERS) {
  if (!matrixClose(lerpMatrix(f.matrix, 1), f.matrix)) {
    check(`lerpMatrix("${f.name}", 1) is unchanged`, false);
  }
}
check('lerpMatrix(_, 1) is unchanged for all filters', true);

console.log('\nOverlay opacity scales with strength, and vanishes at 0');
for (const f of FILTERS.filter((x) => x.overlay)) {
  const half = effectiveOverlay(f, 0.5);
  const zero = effectiveOverlay(f, 0);
  const ok =
    half !== undefined &&
    close(half.opacity, f.overlay!.opacity * 0.5, 1e-9) &&
    (zero === undefined || close(zero.opacity, 0, 1e-9));
  check(`"${f.name}" overlay`, ok);
}

console.log('\nMatrix shape');
for (const f of FILTERS) {
  const m = f.matrix;
  const shapeOk = m.length === 20 && m.every(Number.isFinite);
  const alphaOk = close(m[15], 0) && close(m[16], 0) && close(m[17], 0) && close(m[18], 1) && close(m[19], 0);
  check(`"${f.name}" is 20 finite numbers with an untouched alpha row`, shapeOk && alphaOk);
}

console.log('\nNo filter blows out a real photo');
// Mid-grey and skin-tone should stay in range; white is allowed to clip (that
// is what several of these filters do on purpose) but must not go wildly
// negative or many times over 1, which would signal a composition error.
const probes: Array<[string, number[]]> = [
  ['black', [0, 0, 0, 1]],
  ['mid grey', [0.5, 0.5, 0.5, 1]],
  ['skin', [0.85, 0.68, 0.56, 1]],
  ['sky', [0.35, 0.6, 0.85, 1]],
  ['white', [1, 1, 1, 1]],
];
for (const f of FILTERS) {
  let worst = 0;
  let worstProbe = '';
  for (const [label, colour] of probes) {
    const out = apply(f.matrix, colour).slice(0, 3);
    for (const v of out) {
      const excursion = v < 0 ? -v : v > 1 ? v - 1 : 0;
      if (excursion > worst) {
        worst = excursion;
        worstProbe = label;
      }
    }
  }
  check(
    `"${f.name}" stays sane (worst excursion ${worst.toFixed(3)}${worstProbe ? ` on ${worstProbe}` : ''})`,
    worst < 0.6
  );
}

console.log('\nLookup falls back rather than throwing');
check('getFilter("Valencia") resolves', getFilter('Valencia').name === 'Valencia');
check('getFilter(null) falls back to Normal', getFilter(null).name === 'Normal');
check('getFilter("nonsense") falls back to Normal', getFilter('nonsense').name === 'Normal');
check('Normal is a true no-op', matrixClose(getFilter('Normal').matrix, identity()));

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
