/**
 * Live filter preview.
 *
 * A Skia canvas that draws one image through a filter's colour matrix and then
 * composites the filter's overlay on top in the right blend mode. Used both
 * full-size in the composer and at thumbnail size in `FilterStrip`.
 *
 * Everything here is declarative: the only thing that changes while the
 * strength slider is dragged is the 20-number matrix and the overlay opacity,
 * both memoised. The decoded `SkImage` is never rebuilt, so dragging is a pure
 * paint update.
 */

import {
  Canvas,
  ColorMatrix,
  Group,
  Image as SkiaImage,
  RadialGradient,
  Rect,
  useImage,
  vec,
  type Fit,
  type SkImage,
} from '@shopify/react-native-skia';
import React, { useCallback, useEffect, useMemo } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import { effectiveOverlay, lerpMatrix } from '../lib/filters';
import type { Filter, ImageSize } from '../lib/types';

/** Either an already-decoded Skia image or a URI we should decode ourselves. */
export type FilterPreviewSource = SkImage | string | null | undefined;

/** A square edge length, or explicit dimensions. */
export type PreviewSize = ImageSize | number;

export interface FilterPreviewProps {
  /** An `SkImage` (preferred — decode once, reuse everywhere) or a URI. */
  image?: FilterPreviewSource;
  /** Convenience alias for `image` when all you have is a URI. */
  uri?: string | null;
  filter: Filter;
  /** 0–1. 0 renders the untouched original. Defaults to 1. */
  strength?: number;
  /** Canvas size in points. A bare number means a square. */
  size: PreviewSize;
  style?: StyleProp<ViewStyle>;
  /** How the photo fills the canvas. Defaults to `cover`. */
  fit?: Fit;
  /** Called once the image is available. */
  onImageLoad?: (image: SkImage) => void;
}

export function resolvePreviewSize(size: PreviewSize): ImageSize {
  return typeof size === 'number' ? { width: size, height: size } : size;
}

function FilterPreviewComponent({
  image,
  uri,
  filter,
  strength = 1,
  size,
  style,
  fit = 'cover',
  onImageLoad,
}: FilterPreviewProps): React.JSX.Element {
  const source: FilterPreviewSource = image ?? uri ?? null;

  // `useImage` must be called unconditionally; passing null is a no-op, so an
  // already-decoded SkImage short-circuits the loader without breaking rules.
  const sourceUri = typeof source === 'string' ? source : null;
  const loaded = useImage(sourceUri);
  const skImage: SkImage | null = typeof source === 'string' ? loaded : source ?? null;

  const matrix = useMemo(() => lerpMatrix(filter.matrix, strength), [filter, strength]);
  const overlay = useMemo(() => effectiveOverlay(filter, strength), [filter, strength]);

  const { width, height } = resolvePreviewSize(size);
  const canvasStyle = useMemo<StyleProp<ViewStyle>>(
    () => [{ width, height }, style],
    [width, height, style],
  );

  const notifyLoad = useCallback(() => {
    if (skImage && onImageLoad) onImageLoad(skImage);
  }, [skImage, onImageLoad]);

  useEffect(notifyLoad, [notifyLoad]);

  return (
    <Canvas style={canvasStyle}>
      {skImage ? (
        // `layer` isolates the group into its own offscreen buffer so the
        // overlay's blend mode composites against the photo only — the same
        // isolation a CSS stacking context gives `mix-blend-mode`.
        <Group layer>
          <SkiaImage image={skImage} x={0} y={0} width={width} height={height} fit={fit}>
            <ColorMatrix matrix={matrix} />
          </SkiaImage>

          {overlay ? (
            overlay.kind === 'solid' ? (
              <Rect
                x={0}
                y={0}
                width={width}
                height={height}
                color={overlay.colors[0] ?? '#00000000'}
                opacity={overlay.opacity}
                blendMode={overlay.blend}
              />
            ) : (
              <Rect
                x={0}
                y={0}
                width={width}
                height={height}
                opacity={overlay.opacity}
                blendMode={overlay.blend}
              >
                <RadialGradient
                  c={vec(width / 2, height / 2)}
                  // Overshoot the frame so the outermost stop lands past the
                  // corners, matching CSS `radial-gradient(circle, …)` falloff.
                  r={Math.max(width, height) * 0.75}
                  colors={overlay.colors}
                />
              </Rect>
            )
          ) : null}
        </Group>
      ) : null}
    </Canvas>
  );
}

export const FilterPreview = React.memo(FilterPreviewComponent);
FilterPreview.displayName = 'FilterPreview';

export default FilterPreview;
