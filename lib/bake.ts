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
import type { CropRect, Filter, FilterOverlay, ImageSize } from './types';

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
  /**
   * The region of the source image to bake, in the source's own pixel
   * space (from CropAdjust's getCropRect()). Defaults to the whole image --
   * every caller before the crop-adjust step existed relied on that default,
   * and still can.
   *
   * The composer no longer uses this: it crops once up front via
   * prepareSource() so that the preview and the bake are the same pixels.
   * It stays supported for anything that only has an original plus a rect.
   */
  crop?: CropRect;
  /**
   * Set when `uri` already came out of `prepareSource()` (or another
   * ImageManipulator save), so the EXIF-normalising pass below can be
   * skipped. It is not a correctness flag -- normalising twice is harmless,
   * just a wasted full-size decode/re-encode on the post path, which is the
   * one place we're trying hardest not to spend memory.
   */
  preNormalized?: boolean;
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

/**
 * Longest edge of the image the composer works from, and of the JPEG we
 * upload. Everything downstream of prepareSource() is bounded by this, which
 * is the whole reason a 48MP source never has to exist as pixels on the JS
 * side: at 2560 the worst case is ~26MB of RGBA rather than ~190MB.
 */
export const SOURCE_MAX_EDGE = 2560;

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
  srcRect: CropRect,
): void {
  canvas.clear(Skia.Color('#00000000'));

  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setColorFilter(Skia.ColorFilter.MakeMatrix(lerpMatrix(filter.matrix, strength)));

  canvas.drawImageRectCubic(
    image,
    Skia.XYWHRect(srcRect.x, srcRect.y, srcRect.width, srcRect.height),
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

/**
 * Runs the image through `expo-image-manipulator`'s native codec and back out
 * as a JPEG. This exists for two reasons, and both of them are about Skia
 * seeing the same picture everything else in the app sees:
 *
 * 1. Skia's built-in codecs don't include HEIC/HEIF -- Apple's default
 *    capture format since iOS 11 -- so a photo picked straight from the
 *    library with no edit step (see new.tsx: allowsEditing is now false) can
 *    hand Skia a file it simply can't decode. The native codec (CoreImage on
 *    iOS) does understand HEIC.
 * 2. `Skia.Image.MakeImageFromEncoded` ignores the codec's EXIF origin, while
 *    every other surface in the app -- expo-image in the library grid and
 *    CropAdjust, ImageManipulator in downscaleForPreview -- applies it. A
 *    JPEG shot in portrait on an Android camera, or one that arrived over
 *    AirDrop, carries orientation 6/8 rather than baked-in rotation, so Skia
 *    alone would draw it on its side. Worse, a crop rect picked in the
 *    upright space the user actually saw would then be applied to un-rotated
 *    pixels and clampCropRect would silently shrink it to fit, cropping a
 *    region nobody chose.
 *
 * This used to be gated on a `.heic`/`.heif` filename test, which caught (1)
 * and missed (2) entirely -- orientation metadata is not a HEIC thing, and
 * the extension is unknowable for content:// and ph:// URIs anyway. Rendering
 * unconditionally costs one native re-encode of an already-small image on the
 * paths that reach here, which is the cheaper mistake by a wide margin.
 */
async function normalizeForSkia(uri: string): Promise<string> {
  const rendered = await ImageManipulator.manipulate(uri).renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 1 });
  return saved.uri;
}

/**
 * Keeps a crop rect (computed against whatever dimensions CropAdjust was
 * told the source was) from ever landing fractionally out of the actual
 * decoded image's bounds -- rounding along the way is normal, trusting it
 * blindly as a source rect for Skia isn't.
 *
 * The result is whole pixels: ImageManipulator's native crop takes integers
 * and the v57 docs say nothing about how it treats fractions, so we decide
 * that here rather than letting two platforms each round their own way.
 */
function clampCropRect(rect: CropRect, bounds: ImageSize): CropRect {
  const width = Math.max(1, Math.min(Math.round(rect.width), bounds.width));
  const height = Math.max(1, Math.min(Math.round(rect.height), bounds.height));
  return {
    width,
    height,
    x: Math.max(0, Math.min(Math.round(rect.x), bounds.width - width)),
    y: Math.max(0, Math.min(Math.round(rect.y), bounds.height - height)),
  };
}

let bakeCounter = 0;

/**
 * Applies a filter to a region of the source and writes a JPEG into the
 * cache directory. Returns the written file plus its baked dimensions.
 */
export async function bakeFilteredImage({
  uri,
  filter,
  strength,
  maxEdge = SOURCE_MAX_EDGE,
  quality = 100,
  crop,
  preNormalized = false,
}: BakeOptions): Promise<BakedImage> {
  const { image: source, data } = await decode(
    preNormalized ? uri : await normalizeForSkia(uri)
  );
  const srcRect = clampCropRect(
    crop ?? { x: 0, y: 0, width: source.width(), height: source.height() },
    { width: source.width(), height: source.height() }
  );
  const size = fitWithin({ width: srcRect.width, height: srcRect.height }, maxEdge);

  let surface: SkSurface | undefined;
  let snapshot: SkImage | undefined;
  let bytes: Uint8Array;

  try {
    surface = makeSurface(size);
    drawFiltered(surface.getCanvas(), source, filter, strength, size, srcRect);
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
 * Turns the photo the user picked plus the region they framed into the one
 * image the rest of the composer works from: EXIF-upright, already cropped,
 * and capped at `maxEdge`.
 *
 * This runs once, when the crop is confirmed, and it is what makes the
 * composer honest. Before it existed the crop rect was carried around as a
 * number and only applied at the very end, so the filter step, the filter
 * strip and the caption thumbnail all rendered the *whole* photo (centre-
 * cropped by the preview's own layout) -- you chose a filter against a
 * composition that was not the one you framed, and then posted a third thing
 * again. Collapsing all of it into a single file up front means preview and
 * upload are the same pixels by construction, not by two code paths agreeing.
 *
 * It is also where the full-resolution decode stops being the JS thread's
 * problem. The crop and the downscale both happen inside ImageManipulator's
 * native pipeline; Skia only ever sees the ≤2560px result, so baking no
 * longer allocates a 190MB bitmap through JSI on a phone that was already
 * close to being jettisoned.
 *
 * The dimensions come back measured, not predicted -- callers need them for
 * the preview's aspect ratio and for the posted row's width/height, and after
 * an orientation fix plus a crop plus a resize, guessing is how you get a
 * feed row whose height doesn't match its image.
 */
export async function prepareSource(
  uri: string,
  crop: CropRect | undefined,
  natural: ImageSize,
  previewMaxEdge: number,
  maxEdge: number = SOURCE_MAX_EDGE,
): Promise<{ source: BakedImage; preview: BakedImage }> {
  // `natural` rather than a probe render. The crop rect was computed by
  // CropAdjust against exactly these dimensions (new.tsx passes rawPicked's
  // width/height into it as `natural`), so clamping against them is
  // consistent by construction -- and a probe here meant decoding the
  // full-resolution original twice, once to read two integers we already
  // had and once to actually do the work. On a 48MP photo that decode is
  // the single most expensive thing in the composer.
  const rect = clampCropRect(crop ?? { x: 0, y: 0, ...natural }, natural);
  const target = fitWithin({ width: rect.width, height: rect.height }, maxEdge);

  let chain = ImageManipulator.manipulate(uri).crop({
    originX: rect.x,
    originY: rect.y,
    width: rect.width,
    height: rect.height,
  });

  if (target.width !== rect.width || target.height !== rect.height) {
    // One axis only -- ImageManipulator derives the other from the source
    // ratio, which keeps it from stretching by a rounded pixel.
    chain = chain.resize(
      target.width >= target.height ? { width: target.width } : { height: target.height },
    );
  }

  const rendered = await chain.renderAsync();
  // compress 1, not the 0.85 the preview copy uses: this file is the input to
  // the filter bake, and generation loss added here would be baked into the
  // upload permanently.
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 1 });
  const source: BakedImage = { uri: saved.uri, width: saved.width, height: saved.height };

  // The preview comes off the same decoded ref rather than re-reading the
  // file we just wrote. Previously the caller followed this with a separate
  // downscaleForPreview(source.uri, ...), which decoded that 2560px JPEG
  // twice more -- so a single crop confirmation cost four full decodes. Now
  // it costs one.
  const previewTarget = fitWithin(source, previewMaxEdge);
  const previewRendered =
    previewTarget.width === source.width && previewTarget.height === source.height
      ? rendered
      : await ImageManipulator.manipulate(rendered)
          .resize(
            previewTarget.width >= previewTarget.height
              ? { width: previewTarget.width }
              : { height: previewTarget.height },
          )
          .renderAsync();

  const previewSaved = await previewRendered.saveAsync({
    format: SaveFormat.JPEG,
    compress: 0.9,
  });

  return {
    source,
    preview: { uri: previewSaved.uri, width: previewSaved.width, height: previewSaved.height },
  };
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
  // One decode, then everything else works from the decoded ref.
  //
  // This used to render a throwaway "probe" purely to read the dimensions and
  // then call .reset(), which re-decodes from the URI -- so every call paid
  // for two full decodes of the same image. renderAsync() already hands back
  // an ImageRef carrying width/height, and manipulate() accepts a
  // SharedRef<'image'> as its source, so the second pass can chain off the
  // pixels already in memory instead of going back to disk.
  const decoded = await ImageManipulator.manipulate(uri).renderAsync();
  const original: ImageSize = { width: decoded.width, height: decoded.height };
  const target = fitWithin(original, maxEdge);

  // Already small enough: the render above has *also* normalised orientation
  // (which is why the old explicit normalizeForSkia call on this path is
  // gone), so saving the decoded ref straight out is both correct and one
  // fewer native round trip.
  const rendered =
    target.width === original.width && target.height === original.height
      ? decoded
      : await ImageManipulator.manipulate(decoded)
          .resize(
            original.width >= original.height ? { width: target.width } : { height: target.height },
          )
          .renderAsync();

  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
  return { uri: saved.uri, width: saved.width, height: saved.height };
}
