/**
 * OTA update checking, and the rules about when it's allowed to interrupt.
 *
 * expo-updates' default "check on load" only fires once per cold JS start --
 * backgrounding and reopening from the app switcher (as opposed to a real
 * force-quit) never re-triggers it, so someone who never fully force-quits
 * can be stuck running a stale bundle indefinitely. That's what let several
 * people keep hitting an already-fixed HEIC posting bug days after the fix
 * shipped. Checking on every foreground closes that gap.
 *
 * But "every foreground" is a lot of foregrounds. The first version of this
 * only guarded against *concurrent* checks, which meant that after tapping
 * "Later" the very next `inactive -> active` transition -- pulling down
 * Control Center, glancing at a notification, taking a call -- re-ran the
 * check, re-downloaded the same bundle over cellular, and re-showed the same
 * alert. Three things fix that: remember the update the user already
 * declined, don't re-download something already sitting on disk, and put a
 * floor under how often we're willing to ask at all.
 */

import { Alert } from 'react-native';
import * as Updates from 'expo-updates';

/** Don't check more than once in this window, however many foregrounds happen. */
const MIN_CHECK_INTERVAL_MS = 30 * 60 * 1000;

let checking = false;
let lastCheckAt = 0;
/** Id of an update the user has already said "Later" to. Never re-prompt for it. */
let declinedUpdateId: string | null = null;
/** Id of an update already fetched to disk, so we never download it twice. */
let fetchedUpdateId: string | null = null;
/**
 * Set while something is happening that a reload would destroy -- a post
 * mid-upload, most importantly. `Updates.reloadAsync()` tears down the JS
 * context immediately, so offering "Restart now" to someone who has just
 * spent a minute framing a photo and typing a caption is offering to throw
 * it away.
 */
let suppressed = false;

/**
 * Call with `true` around work that must not be interrupted by a reload
 * prompt, and `false` in a `finally` when it's done.
 */
export function setUpdatePromptSuppressed(value: boolean): void {
  suppressed = value;
}

function updateIdOf(manifest: unknown): string | null {
  return typeof manifest === 'object' && manifest !== null && 'id' in manifest
    ? String((manifest as { id: unknown }).id)
    : null;
}

export async function checkForUpdateOnForeground(): Promise<void> {
  if (__DEV__ || checking || suppressed) return;
  if (Date.now() - lastCheckAt < MIN_CHECK_INTERVAL_MS) return;

  checking = true;
  lastCheckAt = Date.now();
  try {
    const result = await Updates.checkForUpdateAsync();
    if (!result.isAvailable) return;

    const id = updateIdOf(result.manifest);
    if (id && id === declinedUpdateId) return;

    // Only pay for the download once. If we already have this exact update
    // on disk from an earlier foreground, go straight to asking.
    if (!id || id !== fetchedUpdateId) {
      await Updates.fetchUpdateAsync();
      fetchedUpdateId = id;
    }

    // Re-check: the user may have started a post during the download.
    if (suppressed) return;

    Alert.alert('Update available', 'A new version of Kalos is ready.', [
      {
        text: 'Later',
        style: 'cancel',
        onPress: () => {
          declinedUpdateId = id;
        },
      },
      { text: 'Restart now', onPress: () => Updates.reloadAsync() },
    ]);
  } catch {
    // Best-effort -- a failed check should never block using the app.
  } finally {
    checking = false;
  }
}
