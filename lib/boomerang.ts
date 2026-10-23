/**
 * Boomerang geometry and timing.
 *
 * Deliberately free of Skia and of anything that touches a file: the capture
 * screen, the sprite-sheet stitcher in bake.ts and the playback component in
 * the feed all need this arithmetic, and the feed must not have to pull in the
 * baking path to draw a frame.
 *
 * A boomerang is one JPEG holding `frames` square frames in a `cols` x `rows`
 * grid, row-major from the top left (see 0046_post_boomerang.sql). Playback
 * walks the frames forward, then back, forever.
 */

import type { PostBoomerang } from './types';

/**
 * Twelve frames at 15fps: ~0.8s of capture, and a forward-and-back loop of
 * about 1.5s. Instagram's original was ten frames over roughly a second, so
 * this is the same register -- fast enough to read as motion, short enough
 * that the whole loop is legible before it repeats.
 */
export const BOOMERANG_FRAMES = 12;
export const BOOMERANG_FPS = 15;

/**
 * 4x3 holds exactly twelve, and keeps the sheet's longest edge (4 x 540 =
 * 2160) under bake.ts's SOURCE_MAX_EDGE of 2560, so the sheet survives the
 * normal upload path without being downscaled and quietly resampling every
 * frame.
 */
export const BOOMERANG_COLS = 4;
export const BOOMERANG_ROWS = 3;

/**
 * Per-frame edge, in pixels. Frames are square: the composer can crop a still
 * to its original shape or to a square, but a boomerang is captured rather
 * than cropped, and fixing the shape here is what lets the grid be a constant
 * instead of something every reader has to derive.
 */
export const BOOMERANG_FRAME_EDGE = 540;

/** The layout a freshly captured boomerang is stitched into. */
export const BOOMERANG_LAYOUT: PostBoomerang = {
  frames: BOOMERANG_FRAMES,
  cols: BOOMERANG_COLS,
  rows: BOOMERANG_ROWS,
  fps: BOOMERANG_FPS,
};

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Pixel rect of one frame inside the sheet.
 *
 * `sheet` is the decoded image's real size rather than a computed one, because
 * a sheet that has been through a re-encode may be a pixel or two off the
 * nominal cols*edge -- deriving the frame size by division keeps the slices
 * aligned to whatever actually arrived.
 */
export function frameRect(index: number, b: PostBoomerang, sheet: { width: number; height: number }): FrameRect {
  const frameW = sheet.width / b.cols;
  const frameH = sheet.height / b.rows;
  const clamped = Math.min(Math.max(index, 0), b.frames - 1);
  return {
    x: (clamped % b.cols) * frameW,
    y: Math.floor(clamped / b.cols) * frameH,
    width: frameW,
    height: frameH,
  };
}

/**
 * Length of one full forward-and-back cycle, in frames.
 *
 * `2n - 2`, not `2n`: the first and last frames are the turning points, and
 * holding either for two ticks is visible as a stutter at each end of the
 * loop. For 12 frames the cycle is 22 ticks, so at 15fps a loop is ~1.47s.
 */
export function loopLength(frames: number): number {
  return Math.max(2 * frames - 2, 1);
}

/**
 * Which frame to show on a given tick of the loop. Walks 0..n-1 and back down
 * to 1, then repeats.
 */
export function pingPongFrame(tick: number, frames: number): number {
  if (frames <= 1) return 0;
  const cycle = loopLength(frames);
  const t = ((tick % cycle) + cycle) % cycle;
  return t < frames ? t : cycle - t;
}

/** Whether a post's metadata says its image is a sprite sheet. */
export function isBoomerang(b: PostBoomerang | null | undefined): b is PostBoomerang {
  return !!b && b.frames > 1 && b.cols >= 1 && b.rows >= 1;
}
