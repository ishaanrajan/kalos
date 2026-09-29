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
 * Reference recipes: the CSSgram / instagram.css projects, tempered where the
 * raw CSS values blow out on a real photo (their `brightness(1.75)`-style
 * values assume a browser's per-step clamping, which a single composed matrix
 * does not reproduce).
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
  {
    // Punchy and cold: crushed contrast, boosted saturation, icy highlights
    // from the pale-blue overlay. The default-looking "make it pop".
    name: 'Oslo',
    matrix: compose(sepia(0.1), contrast(1.22), brightness(1.05), saturate(1.4), hueRotate(6)),
    overlay: solid('#5FA8D3FF', 'overlay', 0.22),
  },
  {
    // Washed-out and milky. Lowered contrast, lifted blacks, a green-ward hue
    // nudge and a near-white soft-light veil that drains the colour.
    //
    // Retired from the picker (see PICKER_FILTERS below) -- kept here, not
    // deleted, purely so a post shot under this name still renders correctly.
    name: 'Copenhagen',
    matrix: compose(brightness(1.05), hueRotate(-10), contrast(0.9), saturate(0.85), fade(0.04)),
    overlay: solid('#E6E6E6FF', 'softLight', 0.5),
    legacy: true,
  },
  {
    // Loud and warm: reds and oranges pushed hot, a coral overlay instead of
    // Oslo's blue one so the two don't read as the same recipe re-tinted.
    name: 'Manila',
    matrix: compose(sepia(0.25), contrast(1.12), brightness(1.05), saturate(1.5), hueRotate(10)),
    overlay: solid('#FF8B6BFF', 'overlay', 0.16),
  },
  {
    // Bright, cool and clean. No sepia base at all (unlike most of this
    // roster), a touch less saturated than real life, no overlay — the
    // "minimal, barely-there" option rather than another warm/punchy variant.
    name: 'Wellington',
    matrix: compose(contrast(1.05), brightness(1.18), saturate(1.05), temperature(-0.06)),
  },
  {
    // Muted, brown-vintage. Contrast and saturation both pulled *down* (most
    // of this roster pushes them up), with a visible multiplied brown wash —
    // reads as an old print rather than a boosted photo.
    name: 'Vienna',
    matrix: compose(sepia(0.35), contrast(0.95), brightness(1.02), saturate(0.8), fade(0.08)),
    overlay: solid('#8B5E34FF', 'multiply', 0.15),
  },
  {
    // Pastel. Hue-rotated toward pink, desaturated, brightened, blacks lifted —
    // the flattest, most "faded polaroid" of the set.
    //
    // Retired from the picker -- kept for existing posts, see Copenhagen above.
    name: 'Muscat',
    matrix: compose(hueRotate(-20), contrast(0.9), saturate(0.85), brightness(1.15), fade(0.06)),
    overlay: solid('#7D6918FF', 'multiply', 0.08),
    legacy: true,
  },
  {
    // Even golden-warm glow with lifted shadows — a screened gold wash across
    // the whole frame, distinct from Cairo's centre-weighted radial bloom.
    //
    // Retired from the picker -- kept for existing posts, see Copenhagen above.
    name: 'Nairobi',
    matrix: compose(sepia(0.22), contrast(1.0), brightness(1.15), saturate(1.1), fade(0.12)),
    overlay: solid('#F2C879FF', 'screen', 0.18),
    legacy: true,
  },
  {
    // Warm pink centre glow falling off to a dark edge. Most of this filter's
    // character is the radial overlay, not the matrix.
    name: 'Valletta',
    matrix: compose(contrast(1.1), saturate(1.15), brightness(1.03), temperature(0.03)),
    overlay: radial(['#FFFFFF8C', '#FFC8C899', '#111111D9'], 'overlay', 0.4),
  },
  {
    // Golden-hour haze: warm, slightly desaturated, with a soft amber bloom
    // screened over the middle of the frame.
    //
    // Retired from the picker -- kept for existing posts, see Copenhagen above.
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
    // Sun-bleached: heavy fade lifts the blacks hard, contrast pulled *below*
    // 1, a sandy overlay in soft-light rather than screen -- a genuinely
    // washed-out look, not just Nairobi's glow with a different tint.
    //
    // Retired from the picker -- kept for existing posts, see Copenhagen above.
    name: 'Lima',
    matrix: compose(sepia(0.3), contrast(0.92), brightness(1.05), saturate(0.95), fade(0.18)),
    overlay: solid('#E8B65CFF', 'softLight', 0.3),
    legacy: true,
  },
  {
    // The loudest filter here: hard contrast, cyan-blue shift, and a heavy
    // multiplied vignette that goes almost black in the corners.
    //
    // Retired from the picker -- kept for existing posts, see Copenhagen above.
    name: 'Reykjavik',
    matrix: compose(sepia(0.28), contrast(1.3), brightness(1.05), saturate(1.35), hueRotate(-5)),
    overlay: radial(['#E6E7E033', '#005B9A59', '#000000A6'], 'multiply', 0.6),
    legacy: true,
  },
  {
    // Saturated, very high contrast, and a tight dark vignette. No colour cast
    // at all — this one is about density.
    name: 'Ulaanbaatar',
    matrix: compose(saturate(1.15), contrast(1.5), brightness(0.98)),
    overlay: radial(['#22222200', '#22222259', '#222222E6'], 'multiply', 0.7),
  },
  {
    // Warm pink highlights over teal-lifted shadows — hence the uneven
    // `fade` triple, pushed further than the rest for a genuine duotone split.
    // The multiplied salmon does the highlight tinting.
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
  },
  {
    // Faded, magenta-washed 70s print stock. The screened pink is the whole
    // look; the matrix just softens the blacks and warms it a touch.
    name: 'Bangkok',
    matrix: compose(sepia(0.15), contrast(1.1), brightness(1.1), saturate(1.3), fade(0.06)),
    overlay: solid('#F36ABCFF', 'screen', 0.32),
  },
  {
    // Burnt orange centre, purple-black edges, hard contrast — pushed until
    // it looks like a light leak.
    name: 'Santiago',
    matrix: compose(contrast(1.4), brightness(0.95), saturate(1.1), temperature(0.05)),
    overlay: radial(['#804E0FFF', '#5A1E3CE6', '#3B003BCC'], 'screen', 0.45),
  },
  {
    // Soft monochrome with a mauve cast — not a true B&W, which is exactly why
    // this reads as "old photograph" rather than "greyscale".
    name: 'Budapest',
    matrix: compose(saturate(0.05), sepia(0.2), contrast(0.9), brightness(1.12), fade(0.05)),
    overlay: solid('#C9B6BEFF', 'softLight', 0.2),
  },
  {
    // Straight, contrasty black and white. Fully desaturated, no overlay.
    name: 'Berlin',
    matrix: compose(grayscale(1), brightness(1.05), contrast(1.15)),
  },
];

/**
 * What the picker (FilterStrip, the composer) actually offers: Normal plus
 * the 11 filters carrying their own weight, in roster order. The other six --
 * Copenhagen, Muscat, Nairobi, Cairo, Lima, Reykjavik -- had the least (in
 * two cases zero) real usage and stay in `FILTERS` only so `getFilter` can
 * still resolve a post that already used one of them; see each entry's
 * `legacy` flag above.
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
