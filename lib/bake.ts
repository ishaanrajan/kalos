/**
 * Offscreen filter baking.
 *
 * `FilterPreview` renders the filter live for the composer; this module burns
 * the exact same recipe into a real JPEG at capture resolution so the bytes we
 * upload match what the user saw.
 *
 * Pipeline: decode with Skia → draw into an offscreen surface through a
 * colour-matrix paint → draw the overlay with its blend mode → snapshot →
 * `encodeToBytes(JPEG)` → write the raw bytes to a cache file with the modern
 * `expo-file-system` `File` API.
 */

import {
  BlendMode,
  ImageFormat,
  Skia,
  TileMode,
  type SkCanvas,
  type SkData,
  type SkImage,
  type SkSurface,
} from '@shopify/react-native-skia';
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { effectiveOverlay, lerpMatrix } from './filters';
import type { Filter, FilterOverlay, ImageSize } from './types';

export interface BakedImage extends ImageSize {
  /** `file://` URI of the written JPEG, inside the cache directory. */
  uri: string;
}

export interface BakeOptions {
  uri: string;
  filter: Filter;
  /** 0–1 slider value. 0 bakes an unmodified copy. */
  strength: number;
  /** Longest edge of the output. The image is never upscaled. */
  maxEdge?: number;
  /** JPEG quality, 0–100. */
  quality?: number;
}

/** Blend modes exposed by `FilterOverlay`, mapped onto Skia's enum. */
const BLEND_MODES: Record<FilterOverlay['blend'], BlendMode> = {
  overlay: BlendMode.Overlay,
  softLight: BlendMode.SoftLight,
  multiply: BlendMode.Multiply,
  screen: BlendMode.Screen,
  color: BlendMode.Color,
  luminosity: BlendMode.Luminosity,
};

/** Mitchell cubic resampling — the good downscale kernel. */
const MITCHELL_B = 1 / 3;
const MITCHELL_C = 1 / 3;

function fitWithin(size: ImageSize, maxEdge: number): ImageSize {
  const longest = Math.max(size.width, size.height);
  if (longest <= maxEdge || longest === 0) {
    return { width: size.width, height: size.height };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** Evenly spaced stops for an n-colour radial gradient. */
function evenStops(count: number): number[] {
  if (count <= 1) return [0];
  return Array.from({ length: count }, (_, i) => i / (count - 1));
}

function drawOverlay(canvas: SkCanvas, overlay: FilterOverlay, size: ImageSize): void {
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setBlendMode(BLEND_MODES[overlay.blend]);

  if (overlay.kind === 'radial') {
    const colors = overlay.colors.map((c) => Skia.Color(c));
    if (colors.length === 0) return;
    paint.setShader(
      Skia.Shader.MakeRadialGradient(
        { x: size.width / 2, y: size.height / 2 },
        // Reach past the corners so the outermost stop actually lands outside
        // the frame, matching the CSS `radial-gradient(circle, …)` falloff.
        Math.max(size.width, size.height) * 0.75,
        colors,
        evenStops(colors.length),
        TileMode.Clamp,
      ),
    );
  } else {
    paint.setColor(Skia.Color(overlay.colors[0] ?? '#00000000'));
  }

  // setAlphaf must come after setColor — setColor rewrites the alpha channel.
  paint.setAlphaf(Math.max(0, Math.min(1, overlay.opacity)));
  canvas.drawRect(Skia.XYWHRect(0, 0, size.width, size.height), paint);
}

/**
 * Draws `image` filtered into `canvas` at `size`. Shared by the baker so the
 * offscreen result matches `FilterPreview` exactly.
 */
function drawFiltered(
  canvas: SkCanvas,
  image: SkImage,
  filter: Filter,
  strength: number,
  size: ImageSize,
): void {
  canvas.clear(Skia.Color('#00000000'));

  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setColorFilter(Skia.ColorFilter.MakeMatrix(lerpMatrix(filter.matrix, strength)));

  canvas.drawImageRectCubic(
    image,
    Skia.XYWHRect(0, 0, image.width(), image.height()),
    Skia.XYWHRect(0, 0, size.width, size.height),
    MITCHELL_B,
    MITCHELL_C,
    paint,
  );

  const overlay = effectiveOverlay(filter, strength);
  if (overlay) {
    drawOverlay(canvas, overlay, size);
  }
}

function makeSurface(size: ImageSize): SkSurface {
  let surface: SkSurface | null = null;
  try {
    surface = Skia.Surface.MakeOffscreen(size.width, size.height);
  } catch {
    surface = null;
  }
  // Fall back to a CPU-backed surface if no GPU context is available.
  surface = surface ?? Skia.Surface.Make(size.width, size.height);
  if (!surface) {
    throw new Error(`bakeFilteredImage: could not allocate a ${size.width}x${size.height} surface`);
  }
  return surface;
}

/**
 * `MakeImageFromEncoded` defers decoding until the image is drawn, so the
 * backing `SkData` has to outlive the draw — both are returned and released
 * together once the snapshot has been taken.
 */
async function decode(uri: string): Promise<{ image: SkImage; data: SkData }> {
  const data = await Skia.Data.fromURI(uri);
  const image = Skia.Image.MakeImageFromEncoded(data);
  if (!image) {
    data.dispose();
    throw new Error(`bakeFilteredImage: could not decode image at ${uri}`);
  }
  return { image, data };
}

let bakeCounter = 0;

/**
 * Applies a filter to the full-resolution source and writes a JPEG into the
 * cache directory. Returns the written file plus its baked dimensions.
 */
export async function bakeFilteredImage({
  uri,
  filter,
  strength,
  maxEdge = 1440,
  quality = 90,
}: BakeOptions): Promise<BakedImage> {
  const { image: source, data } = await decode(uri);
  const size = fitWithin({ width: source.width(), height: source.height() }, maxEdge);

  let surface: SkSurface | undefined;
  let snapshot: SkImage | undefined;
  let bytes: Uint8Array;

  try {
    surface = makeSurface(size);
    drawFiltered(surface.getCanvas(), source, filter, strength, size);
    surface.flush();

    snapshot = surface.makeImageSnapshot();
    bytes = snapshot.encodeToBytes(ImageFormat.JPEG, quality);
    if (!bytes || bytes.length === 0) {
      throw new Error('bakeFilteredImage: JPEG encoding produced no bytes');
    }
  } finally {
    snapshot?.dispose();
    surface?.dispose();
    source.dispose();
    data.dispose();
  }

  bakeCounter += 1;
  const file = new File(Paths.cache, `kalos-${Date.now()}-${bakeCounter}.jpg`);
  file.create({ overwrite: true, intermediates: true });
  file.write(bytes);

  return { uri: file.uri, width: size.width, height: size.height };
}

/**
 * Cheap downscaled copy of a photo, used for the composer preview and for the
 * filter strip thumbnails so we never hand 18 canvases a full-res bitmap.
 *
 * Uses the contextual `expo-image-manipulator` API (`manipulateAsync` is
 * deprecated). The first `renderAsync` is a no-op probe just to read the
 * source dimensions so we can constrain the *longest* edge regardless of
 * orientation.
 */
export async function downscaleForPreview(uri: string, maxEdge: number): Promise<BakedImage> {
  const context = ImageManipulator.manipulate(uri);

  const probe = await context.renderAsync();
  const original: ImageSize = { width: probe.width, height: probe.height };

  if (Math.max(original.width, original.height) <= maxEdge) {
    return { uri, width: original.width, height: original.height };
  }

  const rendered = await context
    .reset()
    .resize(
      original.width >= original.height ? { width: maxEdge } : { height: maxEdge },
    )
    .renderAsync();

  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
  return { uri: saved.uri, width: saved.width, height: saved.height };
}
