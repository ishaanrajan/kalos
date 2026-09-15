/**
 * Posting, off the screen that started it.
 *
 * Share used to run bake -> thumbnail -> two uploads -> insert inline in the
 * composer, with a 20pt spinner in the header as the only feedback and the
 * whole screen held hostage until the insert landed -- on cellular, several
 * seconds of staring at your own caption. 2015 Instagram handed you back to
 * the feed the moment you tapped Share and showed the upload as a progress
 * bar over the top of it; the post *felt* instant. This module is what makes
 * that possible: the composer builds a job, hands it here, resets itself and
 * navigates away, and the feed renders the job's state (see PostingBanner)
 * until it's done.
 *
 * One slot, not a queue. Two posts in flight at once is a friend-group app's
 * edge case, and a second job would need its own banner row and its own
 * retry -- the composer refuses to start one while this slot is busy.
 *
 * The pipeline itself is unchanged from the inline version: the post lives
 * or dies on the insert; anything uploaded before a failure is removed so a
 * retry doesn't strand objects in the bucket; the failure names the stage
 * so "could not post" is never the whole message.
 */

import { useSyncExternalStore } from 'react';
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';

import { bakeFilteredImage, downscaleForPreview } from './bake';
import { PHOTOS_BUCKET, supabase } from './supabase';
import { setUpdatePromptSuppressed } from './updates';
import type { Filter, PostMusic } from './types';

export interface PostJob {
  userId: string;
  /** The prepared (cropped, upright, size-capped) source the bake reads. */
  sourceUri: string;
  /** What the banner shows while the job runs. */
  previewUri: string;
  filter: Filter;
  caption: string | null;
  music: PostMusic | null;
  /**
   * Cache files that belong to this post's composer session. Deleted once
   * the job is finished with them -- success or discard -- so a post doesn't
   * leave ~10MB of intermediates behind for the OS to get around to.
   */
  tempFiles: string[];
  /** Cache invalidation + profile refresh; owned by the caller. */
  onSuccess: () => Promise<void> | void;
}

export type PostUploadState =
  | { status: 'idle' }
  | { status: 'posting'; job: PostJob }
  | { status: 'error'; job: PostJob; stage: string; message: string };

export type PostResult = { ok: true } | { ok: false; stage: string; message: string };

let state: PostUploadState = { status: 'idle' };
const listeners = new Set<() => void>();

function setState(next: PostUploadState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The upload slot's current state, for whatever wants to render it. */
export function usePostUploadState(): PostUploadState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function getPostUploadState(): PostUploadState {
  return state;
}

function describeError(e: unknown): string {
  if (e && typeof e === 'object') {
    const err = e as { message?: string; code?: string; details?: string; hint?: string };
    return [err.message, err.code && `code ${err.code}`, err.details, err.hint]
      .filter(Boolean)
      .join('\n');
  }
  return String(e);
}

function deleteQuietly(uris: string[]) {
  for (const uri of uris) {
    try {
      new File(uri).delete();
    } catch {
      // Already gone, or never a file we own. Nothing to do.
    }
  }
}

async function runPipeline(job: PostJob): Promise<PostResult> {
  // Paths written to storage so far. If the post fails after an upload has
  // landed, these are removed -- otherwise every retry mints a fresh UUID
  // and abandons the previous pair in the bucket, billed forever, with no
  // post to show for them and nothing that ever sweeps them up.
  let uploaded: string[] = [];
  // Which step we're on, so a failure can say so instead of just "could not post".
  let stage = 'preparing';

  try {
    // No `crop` and no re-normalising: sourceUri is already the cropped,
    // upright, size-capped file prepareSource() wrote at confirmCrop time,
    // so Skia decodes at most SOURCE_MAX_EDGE here instead of pulling a
    // 48MP original into native memory through JSI while the user waits.
    // Real Instagram exports feed photos around 1080-1440px -- no phone
    // screen renders a post wider than that. The previous 2560/quality-100
    // default made every post a multi-MB near-lossless JPEG, which is what
    // was making posting itself slow (and, on a flaky connection, more
    // likely to drop mid-upload and surface as "something went wrong").
    stage = 'filtering';
    const baked = await bakeFilteredImage({
      uri: job.sourceUri,
      filter: job.filter,
      strength: 1,
      preNormalized: true,
      maxEdge: 1440,
      quality: 90,
    });
    job.tempFiles.push(baked.uri);

    const id = randomUUID();
    const path = `${job.userId}/${id}.jpg`;
    const thumbPath = `${job.userId}/${id}_thumb.jpg`;
    uploaded = [];

    // A small derivative for grid contexts (Explore, profile grids) --
    // generated from the already-filtered bake output so it matches what
    // actually got posted, not the unfiltered original.
    stage = 'thumbnail';
    const thumb = await downscaleForPreview(baked.uri, 400);
    job.tempFiles.push(thumb.uri);
    const [bytes, thumbBytes] = await Promise.all([
      new File(baked.uri).bytes(),
      new File(thumb.uri).bytes(),
    ]);

    // Both uploads at once. They're independent objects in the same folder
    // and the full-size one is by far the longer wait.
    stage = 'upload';
    const [main, thumbUpload] = await Promise.all([
      supabase.storage
        .from(PHOTOS_BUCKET)
        .upload(path, bytes, { contentType: 'image/jpeg', upsert: false })
        .then((r) => {
          if (!r.error) uploaded.push(path);
          return r;
        }),
      supabase.storage
        .from(PHOTOS_BUCKET)
        .upload(thumbPath, thumbBytes, { contentType: 'image/jpeg', upsert: false })
        .then((r) => {
          if (!r.error) uploaded.push(thumbPath);
          return r;
        }),
    ]);
    if (main.error) throw main.error;
    if (thumbUpload.error) throw thumbUpload.error;

    stage = 'saving';
    const { error: insertError } = await supabase.from('posts').insert({
      author_id: job.userId,
      image_path: path,
      thumb_path: thumbPath,
      width: baked.width,
      height: baked.height,
      caption: job.caption,
      filter_name: job.filter.name === 'Normal' ? null : job.filter.name,
      music: job.music,
    });
    if (insertError) throw insertError;
    return { ok: true };
  } catch (e) {
    if (uploaded.length) {
      await supabase.storage
        .from(PHOTOS_BUCKET)
        .remove(uploaded)
        .catch(() => undefined);
    }
    return { ok: false, stage, message: describeError(e) || 'Something went wrong.' };
  }
}

/**
 * Runs a post to completion, publishing its progress to usePostUploadState.
 * Resolves with the outcome rather than throwing, so a caller that wants to
 * block on it (the forced first post) can alert on failure while a caller
 * that's already navigated away can leave the banner to handle it.
 *
 * Refuses (`ok: false`, stage 'busy') while another job holds the slot.
 */
export async function startPost(
  job: PostJob,
  options: {
    /**
     * A caller that stays on the composer and awaits the result handles a
     * failure itself (alert, keep the photo, let the user tap Share again),
     * so the slot is released instead of parked in the error state -- and
     * the temp files stay put, since the composer still needs them.
     */
    blocking?: boolean;
  } = {}
): Promise<PostResult> {
  if (state.status !== 'idle') {
    return { ok: false, stage: 'busy', message: 'Another post is still in progress.' };
  }
  return run(job, options.blocking ?? false);
}

async function run(job: PostJob, blocking: boolean): Promise<PostResult> {
  setState({ status: 'posting', job });
  // An OTA update prompt landing mid-upload would offer "Restart now", and
  // reloadAsync() tears down the JS context immediately -- throwing away
  // the photo right at the moment the user has the most invested in it.
  setUpdatePromptSuppressed(true);
  let result: PostResult;
  try {
    result = await runPipeline(job);
  } finally {
    setUpdatePromptSuppressed(false);
  }

  if (result.ok) {
    // The post is real from here. A failure in the caller's cache refresh
    // must never read as "could not post" -- a user told that will retry,
    // and retrying uploads a second copy and inserts a second row.
    try {
      await job.onSuccess();
    } catch (e) {
      console.warn('post succeeded but the follow-up refresh failed', e);
    }
    deleteQuietly(job.tempFiles);
    setState({ status: 'idle' });
  } else if (blocking) {
    setState({ status: 'idle' });
  } else {
    setState({ status: 'error', job, stage: result.stage, message: result.message });
  }
  return result;
}

/** Re-runs the failed job in the slot. No-op unless the slot is in error. */
export function retryPost(): Promise<PostResult> | undefined {
  if (state.status !== 'error') return undefined;
  return run(state.job, false);
}

/** Gives up on the failed job and frees the slot (and its temp files). */
export function discardFailedPost(): void {
  if (state.status !== 'error') return;
  deleteQuietly(state.job.tempFiles);
  setState({ status: 'idle' });
}
