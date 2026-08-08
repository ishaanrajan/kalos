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
    // from the pale-blue overlay. The 2015 default-looking "make it pop".
    name: 'Clarendon',
    matrix: compose(sepia(0.12), contrast(1.2), brightness(1.06), saturate(1.35), hueRotate(4)),
    overlay: solid('#7FBBE3FF', 'overlay', 0.22),
  },
  {
    // Washed-out and milky. Lowered contrast, lifted blacks, a green-ward hue
    // nudge and a near-white soft-light veil that drains the colour.
    name: 'Gingham',
    matrix: compose(brightness(1.05), hueRotate(-10), contrast(0.9), saturate(0.85), fade(0.04)),
    overlay: solid('#E6E6E6FF', 'softLight', 0.5),
  },
  {
    // Heavy saturation over a warm sepia base, then cooled back at the top end
    // by the blue overlay — reds stay hot, skies go teal.
    name: 'Juno',
    matrix: compose(sepia(0.3), contrast(1.15), brightness(1.08), saturate(1.5)),
    overlay: solid('#7FBBE3FF', 'overlay', 0.2),
  },
  {
    // Bright and airy, cooled slightly. Lark lifts everything and desaturates
    // nothing; no overlay, so it stays clean.
    name: 'Lark',
    matrix: compose(sepia(0.18), contrast(1.1), brightness(1.14), saturate(1.2), temperature(-0.04)),
  },
  {
    // Gentle hand, very high saturation. A whisper of olive over the top keeps
    // it from looking digital.
    name: 'Ludwig',
    matrix: compose(sepia(0.22), contrast(1.05), brightness(1.05), saturate(1.6)),
    overlay: solid('#7D6918FF', 'overlay', 0.1),
  },
  {
    // Pastel. Hue-rotated toward pink, desaturated, brightened, blacks lifted —
    // the flattest, most "faded polaroid" of the set.
    name: 'Aden',
    matrix: compose(hueRotate(-20), contrast(0.9), saturate(0.85), brightness(1.15), fade(0.06)),
    overlay: solid('#7D6918FF', 'multiply', 0.08),
  },
  {
    // Bright with lifted shadows and a warm cast — Lark's warmer sibling.
    name: 'Amaro',
    matrix: compose(sepia(0.3), contrast(1.1), brightness(1.12), saturate(1.3), fade(0.08)),
    overlay: solid('#7D6918FF', 'overlay', 0.18),
  },
  {
    // Warm pink centre glow falling off to a dark edge. Most of Mayfair's
    // character is the radial overlay, not the matrix.
    name: 'Mayfair',
    matrix: compose(contrast(1.1), saturate(1.15), brightness(1.03), temperature(0.03)),
    overlay: radial(['#FFFFFF8C', '#FFC8C899', '#111111D9'], 'overlay', 0.4),
  },
  {
    // Golden-hour haze: warm, slightly desaturated, with a soft amber bloom
    // screened over the middle of the frame.
    name: 'Rise',
    matrix: compose(
      sepia(0.2),
      contrast(1.05),
      brightness(1.1),
      saturate(0.95),
      temperature(0.04),
      fade(0.05),
    ),
    overlay: radial(['#E6C13D73', '#E6C13D33', '#00000000'], 'screen', 0.4),
  },
  {
    // Warm, faded, yellow-brown. The screened gold lifts the whole image
    // rather than just the centre, which is what makes it look sun-bleached.
    name: 'Valencia',
    matrix: compose(sepia(0.22), contrast(1.08), brightness(1.08), saturate(1.1), fade(0.06)),
    overlay: solid('#E6C13DFF', 'screen', 0.12),
  },
  {
    // The loudest filter here: hard contrast, cyan-blue shift, and a heavy
    // multiplied vignette that goes almost black in the corners.
    name: 'X-Pro II',
    matrix: compose(sepia(0.28), contrast(1.3), brightness(1.05), saturate(1.35), hueRotate(-5)),
    overlay: radial(['#E6E7E033', '#005B9A59', '#000000A6'], 'multiply', 0.6),
  },
  {
    // Saturated, very high contrast, and a tight dark vignette. No colour cast
    // at all — Lo-Fi is about density.
    name: 'Lo-Fi',
    matrix: compose(saturate(1.15), contrast(1.5), brightness(0.98)),
    overlay: radial(['#22222200', '#22222259', '#222222E6'], 'multiply', 0.7),
  },
  {
    // Warm pink highlights over teal-lifted shadows — hence the uneven
    // `fade` triple. The multiplied salmon does the highlight tinting.
    name: 'Nashville',
    matrix: compose(
      sepia(0.2),
      contrast(1.2),
      brightness(1.05),
      saturate(1.2),
      temperature(0.05),
      fade([0.02, 0.03, 0.07]),
    ),
    overlay: solid('#F7B099FF', 'multiply', 0.35),
  },
  {
    // Faded, magenta-washed 70s print stock. The screened pink is the whole
    // look; the matrix just softens the blacks and warms it a touch.
    name: '1977',
    matrix: compose(sepia(0.15), contrast(1.1), brightness(1.1), saturate(1.3), fade(0.06)),
    overlay: solid('#F36ABCFF', 'screen', 0.28),
  },
  {
    // Burnt orange centre, purple-black edges, hard contrast. Toaster is
    // Nashville pushed until it looks like a light leak.
    name: 'Toaster',
    matrix: compose(contrast(1.4), brightness(0.95), saturate(1.1), temperature(0.05)),
    overlay: radial(['#804E0FFF', '#5A1E3CE6', '#3B003BCC'], 'screen', 0.45),
  },
  {
    // Soft monochrome with a mauve cast — not a true B&W, which is exactly why
    // Willow reads as "old photograph" rather than "greyscale".
    name: 'Willow',
    matrix: compose(saturate(0.05), sepia(0.2), contrast(0.9), brightness(1.12), fade(0.05)),
    overlay: solid('#C9B6BEFF', 'softLight', 0.2),
  },
  {
    // Straight, contrasty black and white. Fully desaturated, no overlay.
    name: 'Inkwell',
    matrix: compose(grayscale(1), brightness(1.05), contrast(1.15)),
  },
];

/** Every filter name, in strip order. */
export const FILTER_NAMES: string[] = FILTERS.map((f) => f.name);

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
