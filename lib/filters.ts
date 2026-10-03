/**
 * Kalos filter engine — the 2015 Instagram roster.
 *
 * Every filter is a single 4x5 row-major colour matrix (Skia `ColorMatrix`
 * layout, offsets in column 5 expressed in 0–1 space) plus an optional blended
 * overlay layer. The matrices are built by composing the canonical SVG/CSS
 * filter primitives (`sepia`, `contrast`, `brightness`, `saturate`,
 * `hue-rotate`, `grayscale`) in the same order the CSS recreations apply them,
 * so each recipe below reads like the stylesheet it descends from.
 *
 * The ten filters the picker offers are ported verbatim from instagram.css
 * (picturepan2) -- its `filter:` chain becomes the compose() call, its
 * `::before` background and mix-blend-mode become the overlay. They are not
 * tempered: for these recipes every step moves in the same direction, so a
 * browser's per-step clamping and our single composed matrix agree, and the
 * only value that overshoots is pure white (which clips to white either way).
 * Temper only against scripts/verify-filters.ts, never by eye.
 *
 * What this engine cannot reproduce: Instagram's real filters were GLSL plus
 * LUTs plus *texture* assets -- one open-source reimplementation had to extend
 * GPUImage from 2 to 5 textures per filter, and Hudson's texture is a
 * photograph of its author's chalkboard. Grain, scratches, light leaks and
 * linear gradients are all out of reach of matrix-plus-one-overlay.
 *
 * Matrix layout:
 *
 *   [ m0  m1  m2  m3  m4      out.r = m0*r + m1*g + m2*b + m3*a + m4
 *     m5  m6  m7  m8  m9      out.g = m5*r + ...
 *     m10 m11 m12 m13 m14     out.b = ...
 *     m15 m16 m17 m18 m19 ]   out.a = ...
 */

import type { Filter, FilterOverlay } from './types';

/** A 4x5 row-major colour matrix: exactly 20 numbers. */
export type ColorMatrix = number[];

/** Rec. 709 luminance weights, shared by `saturate`, `grayscale` and `hueRotate`. */
const LUM_R = 0.2126;
const LUM_G = 0.7152;
const LUM_B = 0.0722;

const IDENTITY: ColorMatrix = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

const clamp01 = (value: number): number => clamp(value, 0, 1);

// ---------------------------------------------------------------------------
// Matrix algebra
// ---------------------------------------------------------------------------

/** A fresh identity matrix. Never returns a shared reference. */
export function identity(): ColorMatrix {
  return IDENTITY.slice();
}

/**
 * Matrix product `a · b`, i.e. the single matrix equivalent to applying `b`
 * first and then `a` — standard function composition, `a(b(colour))`.
 *
 * The 4x5 form is treated as a 5x5 affine matrix whose implicit last row is
 * `[0, 0, 0, 0, 1]`, which is what makes the translation column (col 5) fall
 * out correctly: it is carried through `a`'s colour terms and then offset by
 * `a`'s own translation.
 */
export function multiply(a: ColorMatrix, b: ColorMatrix): ColorMatrix {
  const out: ColorMatrix = new Array<number>(20);
  for (let row = 0; row < 4; row++) {
    const ar = row * 5;
    for (let col = 0; col < 4; col++) {
      out[ar + col] =
        (a[ar] ?? 0) * (b[col] ?? 0) +
        (a[ar + 1] ?? 0) * (b[5 + col] ?? 0) +
        (a[ar + 2] ?? 0) * (b[10 + col] ?? 0) +
        (a[ar + 3] ?? 0) * (b[15 + col] ?? 0);
    }
    // Translation column: a's colour terms applied to b's offsets, plus a's own.
    out[ar + 4] =
      (a[ar] ?? 0) * (b[4] ?? 0) +
      (a[ar + 1] ?? 0) * (b[9] ?? 0) +
      (a[ar + 2] ?? 0) * (b[14] ?? 0) +
      (a[ar + 3] ?? 0) * (b[19] ?? 0) +
      (a[ar + 4] ?? 0);
  }
  return out;
}

/**
 * Collapses a chain of primitives into one matrix, applied **in the order
 * listed** — `compose(sepia(0.3), contrast(1.2))` sepia-tones first, then adds
 * contrast, exactly like the CSS `filter: sepia(.3) contrast(1.2)` shorthand.
 */
export function compose(...steps: ColorMatrix[]): ColorMatrix {
  let acc = identity();
  for (const step of steps) {
    acc = multiply(step, acc);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Filter primitives (SVG `feColorMatrix` / CSS filter equivalents)
// ---------------------------------------------------------------------------

/** `saturate(amount)` — 0 collapses to luminance, 1 is a no-op, >1 boosts. */
export function saturate(amount: number): ColorMatrix {
  const s = Math.max(0, amount);
  const inv = 1 - s;
  const r = LUM_R * inv;
  const g = LUM_G * inv;
  const b = LUM_B * inv;
  return [
    r + s, g, b, 0, 0,
    r, g + s, b, 0, 0,
    r, g, b + s, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/** `grayscale(amount)` — the complement of `saturate`. 1 is fully monochrome. */
export function grayscale(amount: number): ColorMatrix {
  return saturate(1 - clamp01(amount));
}

/** `contrast(amount)` — scales around the 0.5 mid-grey pivot. */
export function contrast(amount: number): ColorMatrix {
  const c = Math.max(0, amount);
  const offset = 0.5 * (1 - c);
  return [
    c, 0, 0, 0, offset,
    0, c, 0, 0, offset,
    0, 0, c, 0, offset,
    0, 0, 0, 1, 0,
  ];
}

/** `brightness(amount)` — a straight linear gain on all three channels. */
export function brightness(amount: number): ColorMatrix {
  const b = Math.max(0, amount);
  return [
    b, 0, 0, 0, 0,
    0, b, 0, 0, 0,
    0, 0, b, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/** `sepia(amount)` — interpolates identity toward the canonical sepia matrix. */
export function sepia(amount: number): ColorMatrix {
  const a = clamp01(amount);
  const i = 1 - a;
  return [
    0.393 * a + i, 0.769 * a, 0.189 * a, 0, 0,
    0.349 * a, 0.686 * a + i, 0.168 * a, 0, 0,
    0.272 * a, 0.534 * a, 0.131 * a + i, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/**
 * `hue-rotate(deg)` — the luma-preserving rotation from the SVG filter spec.
 * The 0.143 / 0.140 / -0.283 terms are the spec's fixed green-row constants.
 */
export function hueRotate(deg: number): ColorMatrix {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [
    LUM_R + c * (1 - LUM_R) - s * LUM_R,
    LUM_G - c * LUM_G - s * LUM_G,
    LUM_B - c * LUM_B + s * (1 - LUM_B),
    0, 0,

    LUM_R - c * LUM_R + s * 0.143,
    LUM_G + c * (1 - LUM_G) + s * 0.14,
    LUM_B - c * LUM_B - s * 0.283,
    0, 0,

    LUM_R - c * LUM_R - s * (1 - LUM_R),
    LUM_G - c * LUM_G + s * LUM_G,
    LUM_B + c * (1 - LUM_B) + s * LUM_B,
    0, 0,

    0, 0, 0, 1, 0,
  ];
}

/**
 * White-balance nudge. `shift` runs -1 (cool/blue) to 1 (warm/amber); the
 * useful range for these recipes is roughly ±0.08. Red and blue move in
 * opposite directions, green barely at all — the classic Kelvin approximation.
 */
export function temperature(shift: number): ColorMatrix {
  const t = clamp(shift, -1, 1);
  return [
    1 + t, 0, 0, 0, 0,
    0, 1 + t * 0.15, 0, 0, 0,
    0, 0, 1 - t, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/**
 * Lifts the black point — the faded-film / matte look that most of the warm
 * 2015 filters lean on. Maps 0 → `amount` and leaves 1 alone. Pass a
 * `[r, g, b]` triple to lift channels unevenly (e.g. teal shadows).
 */
export function fade(amount: number | readonly [number, number, number]): ColorMatrix {
  const [ar, ag, ab] = typeof amount === 'number' ? [amount, amount, amount] : amount;
  const r = clamp01(ar);
  const g = clamp01(ag);
  const b = clamp01(ab);
  return [
    1 - r, 0, 0, 0, r,
    0, 1 - g, 0, 0, g,
    0, 0, 1 - b, 0, b,
    0, 0, 0, 1, 0,
  ];
}

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

const solid = (color: string, blend: FilterOverlay['blend'], opacity: number): FilterOverlay => ({
  kind: 'solid',
  colors: [color],
  blend,
  opacity,
});

const radial = (
  colors: string[],
  blend: FilterOverlay['blend'],
  opacity: number,
): FilterOverlay => ({ kind: 'radial', colors, blend, opacity });

export const FILTERS: Filter[] = [
  {
    // The untouched frame. Must stay a literal identity so "Normal" is a no-op.
    name: 'Normal',
    matrix: identity(),
  },

  // -------------------------------------------------------------------------
  // The roster the picker offers: Instagram's place-named batch from October
  // 2015, which is the era this app rebuilds. Values are ported from
  // instagram.css (picturepan2), which is the only published recreation that
  // covers this batch -- CSSgram and pilgram both stop at the older set. Each
  // recipe below is that project's `filter:` chain in the same order, plus its
  // `::before` overlay colour and mix-blend-mode.
  // -------------------------------------------------------------------------
  {
    // Bright and clean, the lightest touch here. No overlay.
    name: 'Skyline',
    matrix: compose(sepia(0.15), contrast(1.25), brightness(1.25), saturate(1.2)),
  },
  {
    // Bright with a cool blue veil -- the only cool-cast filter in the batch.
    name: 'Brooklyn',
    matrix: compose(sepia(0.25), contrast(1.25), brightness(1.25), hueRotate(5)),
    overlay: solid('#7FBBE3FF', 'overlay', 0.2),
  },
  {
    // Warm and bright, olive held back by a light `darken` pass so the
    // highlights don't go chalky.
    name: 'Ginza',
    matrix: compose(
      sepia(0.25),
      contrast(1.15),
      brightness(1.2),
      saturate(1.35),
      hueRotate(-5),
    ),
    overlay: solid('#7D6918FF', 'darken', 0.15),
  },
  {
    // Ginza's heavier sibling: more sepia in the base, and the olive goes on
    // in `overlay` rather than `darken`, so it tints mid-tones instead of
    // only pulling the brights down.
    name: 'Vesper',
    matrix: compose(sepia(0.35), contrast(1.15), brightness(1.2), saturate(1.3)),
    overlay: solid('#7D6918FF', 'overlay', 0.25),
  },
  {
    // The most saturated of the bright ones, with the olive darkened harder.
    name: 'Charmes',
    matrix: compose(
      sepia(0.25),
      contrast(1.25),
      brightness(1.25),
      saturate(1.35),
      hueRotate(-5),
    ),
    overlay: solid('#7D6918FF', 'darken', 0.25),
  },
  {
    // `lighten` at 0.45 is the strongest overlay in the batch -- it lifts
    // anything darker than the olive toward it, which is what gives this its
    // hazy, washed-up-film look rather than a tint.
    name: 'Stinson',
    matrix: compose(sepia(0.35), contrast(1.25), brightness(1.1), saturate(1.25)),
    overlay: solid('#7D6918FF', 'lighten', 0.45),
  },
  {
    // Very high saturation over a gentle tone curve, then a yellow-green
    // `darken`. The loudest colour in the set.
    name: 'Maven',
    matrix: compose(sepia(0.35), contrast(1.05), brightness(1.05), saturate(1.75)),
    overlay: solid('#9EAF1EFF', 'darken', 0.25),
  },
  {
    // Heavy sepia base, soft contrast, same yellow-green as Maven but blended
    // as `overlay` -- warmer and flatter, less acid.
    name: 'Helena',
    matrix: compose(sepia(0.5), contrast(1.05), brightness(1.05), saturate(1.35)),
    overlay: solid('#9EAF1EFF', 'overlay', 0.25),
  },
  {
    // Heaviest sepia and the highest saturation, with no brightness lift at
    // all -- dense and golden.
    name: 'Ashby',
    matrix: compose(sepia(0.5), contrast(1.2), saturate(1.8)),
    overlay: solid('#7D6918FF', 'lighten', 0.35),
  },
  {
    // Hard contrast, no brightness lift, no overlay. The one filter here that
    // works by crushing rather than lifting.
    name: 'Dogpatch',
    matrix: compose(sepia(0.35), saturate(1.1), contrast(1.5)),
  },

  // -------------------------------------------------------------------------
  // Retired, and kept only so already-posted photos keep rendering the way
  // they did the day they were posted. `getFilter` still resolves these;
  // PICKER_FILTERS does not offer them. Do not delete one while any post
  // still carries its name -- `filter_name` is free text with no FK, and an
  // unrecognised name silently falls back to Normal.
  //
  // These are the capital-city roster that preceded the October-2015 batch
  // above. Two of them (Nairobi, Lima) were dropped outright rather than kept,
  // because no post had ever used either.
  // -------------------------------------------------------------------------
  {
    name: 'Oslo',
    matrix: compose(sepia(0.1), contrast(1.22), brightness(1.05), saturate(1.4), hueRotate(6)),
    overlay: solid('#5FA8D3FF', 'overlay', 0.22),
    legacy: true,
  },
  {
    name: 'Copenhagen',
    matrix: compose(brightness(1.05), hueRotate(-10), contrast(0.9), saturate(0.85), fade(0.04)),
    overlay: solid('#E6E6E6FF', 'softLight', 0.5),
    legacy: true,
  },
  {
    name: 'Manila',
    matrix: compose(sepia(0.25), contrast(1.12), brightness(1.05), saturate(1.5), hueRotate(10)),
    overlay: solid('#FF8B6BFF', 'overlay', 0.16),
    legacy: true,
  },
  {
    name: 'Wellington',
    matrix: compose(contrast(1.05), brightness(1.18), saturate(1.05), temperature(-0.06)),
    legacy: true,
  },
  {
    name: 'Vienna',
    matrix: compose(sepia(0.35), contrast(0.95), brightness(1.02), saturate(0.8), fade(0.08)),
    overlay: solid('#8B5E34FF', 'multiply', 0.15),
    legacy: true,
  },
  {
    name: 'Muscat',
    matrix: compose(hueRotate(-20), contrast(0.9), saturate(0.85), brightness(1.15), fade(0.06)),
    overlay: solid('#7D6918FF', 'multiply', 0.08),
    legacy: true,
  },
  {
    name: 'Valletta',
    matrix: compose(contrast(1.1), saturate(1.15), brightness(1.03), temperature(0.03)),
    overlay: radial(['#FFFFFF8C', '#FFC8C899', '#111111D9'], 'overlay', 0.4),
    legacy: true,
  },
  {
    name: 'Cairo',
    matrix: compose(
      sepia(0.2),
      contrast(1.05),
      brightness(1.1),
      saturate(0.95),
      temperature(0.04),
      fade(0.05),
    ),
    overlay: radial(['#E6C13D73', '#E6C13D33', '#00000000'], 'screen', 0.4),
    legacy: true,
  },
  {
    name: 'Reykjavik',
    matrix: compose(sepia(0.28), contrast(1.3), brightness(1.05), saturate(1.35), hueRotate(-5)),
    overlay: radial(['#E6E7E033', '#005B9A59', '#000000A6'], 'multiply', 0.6),
    legacy: true,
  },
  {
    name: 'Ulaanbaatar',
    matrix: compose(saturate(1.15), contrast(1.5), brightness(0.98)),
    overlay: radial(['#22222200', '#22222259', '#222222E6'], 'multiply', 0.7),
    legacy: true,
  },
  {
    name: 'Havana',
    matrix: compose(
      sepia(0.15),
      contrast(1.15),
      brightness(1.05),
      saturate(1.15),
      temperature(0.05),
      fade([0.02, 0.04, 0.12]),
    ),
    overlay: solid('#FF9E85FF', 'multiply', 0.3),
    legacy: true,
  },
  {
    name: 'Bangkok',
    matrix: compose(sepia(0.15), contrast(1.1), brightness(1.1), saturate(1.3), fade(0.06)),
    overlay: solid('#F36ABCFF', 'screen', 0.32),
    legacy: true,
  },
  {
    name: 'Santiago',
    matrix: compose(contrast(1.4), brightness(0.95), saturate(1.1), temperature(0.05)),
    overlay: radial(['#804E0FFF', '#5A1E3CE6', '#3B003BCC'], 'screen', 0.45),
    legacy: true,
  },
  {
    name: 'Budapest',
    matrix: compose(saturate(0.05), sepia(0.2), contrast(0.9), brightness(1.12), fade(0.05)),
    overlay: solid('#C9B6BEFF', 'softLight', 0.2),
    legacy: true,
  },
  {
    name: 'Berlin',
    matrix: compose(grayscale(1), brightness(1.05), contrast(1.15)),
    legacy: true,
  },
];

/**
 * What the picker (FilterStrip, the composer) actually offers: Normal plus the
 * ten October-2015 filters. Everything flagged `legacy` is excluded -- those
 * exist only so `getFilter` can still resolve a post that was captured under
 * one of them.
 */
export const PICKER_FILTERS: Filter[] = FILTERS.filter((f) => !f.legacy);

/** Every picker-visible filter name, in strip order. */
export const FILTER_NAMES: string[] = PICKER_FILTERS.map((f) => f.name);

const BY_NAME: ReadonlyMap<string, Filter> = new Map(FILTERS.map((f) => [f.name, f]));

/** The identity filter. Used as the fallback for unknown/`null` names. */
export const NORMAL_FILTER: Filter = FILTERS[0] ?? {
  name: 'Normal',
  matrix: identity(),
};

/**
 * Looks a filter up by display name. Unknown, `null` or `undefined` names fall
 * back to `Normal` so feed rendering never has to null-check
 * `Post.filter_name`. Use `hasFilter` if you need to detect a bad name.
 */
export function getFilter(name: string | null | undefined): Filter {
  if (!name) return NORMAL_FILTER;
  return BY_NAME.get(name) ?? NORMAL_FILTER;
}

/** True if `name` is a filter in the roster. */
export function hasFilter(name: string | null | undefined): boolean {
  return !!name && BY_NAME.has(name);
}

// ---------------------------------------------------------------------------
// Strength
// ---------------------------------------------------------------------------

/**
 * Interpolates a filter matrix toward identity for the strength slider.
 *
 * `strength` 0 returns an exact identity matrix — pixel-identical to the
 * untouched original — and 1 returns the filter unchanged. Values in between
 * blend linearly, which is well-behaved here because every primitive above is
 * affine.
 */
export function lerpMatrix(filterMatrix: ColorMatrix, strength: number): ColorMatrix {
  const t = clamp01(strength);
  if (t <= 0) return identity();
  if (t >= 1) return filterMatrix.slice();
  const out: ColorMatrix = new Array<number>(20);
  for (let i = 0; i < 20; i++) {
    const id = IDENTITY[i] ?? 0;
    out[i] = id + ((filterMatrix[i] ?? id) - id) * t;
  }
  return out;
}

/**
 * The overlay to actually draw at a given strength: the filter's overlay with
 * its opacity scaled, or `undefined` when the filter has none or the slider is
 * at zero.
 */
export function effectiveOverlay(filter: Filter, strength: number): FilterOverlay | undefined {
  const t = clamp01(strength);
  const overlay = filter.overlay;
  if (!overlay || t <= 0) return undefined;
  if (t >= 1) return overlay;
  return { ...overlay, colors: overlay.colors, opacity: overlay.opacity * t };
}
