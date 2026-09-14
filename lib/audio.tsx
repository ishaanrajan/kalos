/**
 * Feed music playback.
 *
 * One player for the whole app, not one per post. A feed holds a dozen mounted
 * PostCards; a useAudioPlayer in each would be a dozen native players competing
 * for the same output. Instead this provider owns a single AudioPlayer and the
 * feed tells it which post is currently on screen.
 *
 * Three things here are deliberate and easy to undo by accident:
 *
 *  - playsInSilentMode is true. A post's music is content the poster chose
 *    on purpose (unlike, say, a system sound effect), and the product call
 *    here is that it should play regardless of the hardware silent switch --
 *    the mute toggle in the feed (see toggleMuted below) is the actual
 *    silence control. This was previously false specifically to respect the
 *    switch; if that's ever revisited, it's a one-word change back.
 *
 *  - The playbackStatusUpdate listener never touches React state. It fires four
 *    times a second; routing it through useState would re-render the entire
 *    tree under this provider at 4Hz while scrolling. Only activePostId and
 *    muted are state, and both change at human speed.
 *
 *  - Looping is manual. player.loop repeats the whole 30-second preview, but a
 *    post plays a MUSIC_CLIP_SECONDS window chosen by its author, so the
 *    listener seeks back to the window start itself.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { MUSIC_CLIP_SECONDS, type PostMusic } from './types';

const MUTED_STORAGE_KEY = 'kalos.music.muted';

/**
 * How often the player reports position. The clip loop can only be as tight as
 * this interval, so it trades a little overshoot at the end of a clip against
 * how often the JS thread is woken mid-scroll.
 */
const STATUS_INTERVAL_MS = 250;

interface MusicContextValue {
  /** The post whose track is loaded, playing or not. Null when nothing is. */
  activePostId: string | null;
  muted: boolean;
  toggleMuted: () => void;
  /** Make this post the active one. A no-op if it already is. */
  requestPlay: (postId: string, music: PostMusic) => void;
  /** Stop and unload. Safe to call when nothing is playing. */
  stop: () => void;
  /**
   * Move the playing clip's window and jump to its new start. This is for the
   * composer's trim scrubber -- a post's window is fixed once it's posted.
   */
  setClipStart: (startMs: number) => void;
}

const MusicContext = createContext<MusicContextValue | null>(null);

export function MusicProvider({ children }: { children: ReactNode }) {
  const [activePostId, setActivePostId] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  // The player is created once and lives for the life of the app. A ref rather
  // than state because replacing it should never re-render anything.
  const playerRef = useRef<AudioPlayer | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const clipStartRef = useRef(0);
  const mutedRef = useRef(false);

  if (playerRef.current === null) {
    playerRef.current = createAudioPlayer(null, { updateInterval: STATUS_INTERVAL_MS });
  }

  // Audio session + persisted mute preference. Both are fire-and-forget: a
  // failure here should degrade playback, never block the app from starting.
  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      // Take over the output the way Instagram does, rather than layering a
      // preview on top of whatever the user already had playing.
      interruptionMode: 'doNotMix',
    }).catch(() => undefined);

    AsyncStorage.getItem(MUTED_STORAGE_KEY)
      .then((stored) => {
        if (stored === 'true') {
          mutedRef.current = true;
          setMuted(true);
          const player = playerRef.current;
          if (player) player.muted = true;
        }
      })
      .catch(() => undefined);
  }, []);

  // Windowed loop. The post's clip is [start, start + MUSIC_CLIP_SECONDS) inside
  // a 30s preview, so playback is walked back by hand each time it runs out.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;

    const subscription = player.addListener('playbackStatusUpdate', (status) => {
      if (!status.isLoaded) return;
      const start = clipStartRef.current;
      const end = start + MUSIC_CLIP_SECONDS;
      // didJustFinish covers clips whose window runs past the end of the
      // preview, where currentTime stops before it ever reaches `end`.
      if (status.didJustFinish || status.currentTime >= end) {
        player.seekTo(start);
        player.play();
      }
    });

    return () => subscription.remove();
  }, []);

  const stop = useCallback(() => {
    const player = playerRef.current;
    activeIdRef.current = null;
    setActivePostId(null);
    if (!player) return;
    try {
      player.pause();
      // Drop the source so a stopped post isn't holding a network stream open.
      player.replace(null);
    } catch {
      // The player can already be torn down during unmount; nothing to do.
    }
  }, []);

  const requestPlay = useCallback((postId: string, music: PostMusic) => {
    const player = playerRef.current;
    if (!player || activeIdRef.current === postId) return;

    activeIdRef.current = postId;
    setActivePostId(postId);

    const start = Math.max(0, music.start_ms / 1000);
    clipStartRef.current = start;

    try {
      player.replace({ uri: music.preview_url });
      player.muted = mutedRef.current;
      if (start > 0) player.seekTo(start);
      player.play();
    } catch {
      // A track that won't load shouldn't take the feed down with it. The pill
      // stays on the card; it just doesn't make noise.
    }
  }, []);

  const setClipStart = useCallback((startMs: number) => {
    const player = playerRef.current;
    const start = Math.max(0, startMs / 1000);
    clipStartRef.current = start;
    if (!player) return;
    try {
      player.seekTo(start);
      player.play();
    } catch {
      // Nothing loaded to seek in.
    }
  }, []);

  const toggleMuted = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    const player = playerRef.current;
    if (player) player.muted = next;
    AsyncStorage.setItem(MUTED_STORAGE_KEY, String(next)).catch(() => undefined);
  }, []);

  // Feed audio does not survive backgrounding -- shouldPlayInBackground is off,
  // and without this the player would come back silent-but-"playing" on return.
  // app/_layout.tsx has its own AppState subscription for react-query focus;
  // this is intentionally separate rather than tangled into it.
  useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      const player = playerRef.current;
      if (!player || !activeIdRef.current) return;
      if (state === 'active') {
        player.play();
      } else {
        player.pause();
      }
    };
    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    return () => {
      const player = playerRef.current;
      playerRef.current = null;
      // SDK 57 names this remove(), not release().
      try {
        player?.remove();
      } catch {
        // Already gone.
      }
    };
  }, []);

  const value = useMemo(
    () => ({ activePostId, muted, toggleMuted, requestPlay, stop, setClipStart }),
    [activePostId, muted, toggleMuted, requestPlay, stop, setClipStart],
  );

  return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>;
}

export function useMusic(): MusicContextValue {
  const context = useContext(MusicContext);
  if (!context) {
    throw new Error('useMusic must be used inside a MusicProvider');
  }
  return context;
}
