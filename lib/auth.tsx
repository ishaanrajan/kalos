import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import type { Session } from '@supabase/supabase-js';
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { readPersistedSession, supabase } from './supabase';
import { registerForPushNotificationsAsync, unregisterPushTokenAsync } from './push';
import type { Profile } from './types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reads the persisted session at boot without ever mistaking "offline" for
 * "signed out".
 *
 * getSession() refreshes the access token if it's expired, and a network
 * failure there does NOT throw -- auth-js 2.112 catches it and returns
 * `{ session: null, error: AuthRetryableFetchError }`, keeping the stored
 * session on disk because the refresh token is still perfectly good. Two
 * earlier versions of this code got that wrong in opposite directions: one
 * treated every failure as signed-out (booted people to sign-in whenever
 * the network hiccuped at launch; the 30s refresh ticker then bounced them
 * back to the feed), the other spun forever on a truly corrupted session.
 *
 * So: retry retryable errors with a short backoff; if the server still
 * can't be reached, fall back to whatever auth-js left in storage and let
 * the app come up in its offline state -- the ticker emits TOKEN_REFRESHED
 * (or SIGNED_OUT, if the refresh token really is dead) as soon as it can.
 * A non-retryable error is a genuinely dead session and resolves to null.
 */
async function loadSession(): Promise<Session | null> {
  const delays = [0, 1500, 4000];
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try {
      const { data, error } = await supabase.auth.getSession();
      if (!error) return data.session;
      if (!isAuthRetryableFetchError(error)) return null;
    } catch {
      // A thrown error here is a storage or runtime failure; treat it like
      // a transient one and try again.
    }
  }
  return readPersistedSession();
}

interface AuthValue {
  session: Session | null;
  profile: Profile | null;
  /** True until the persisted session has been read back from storage. */
  loading: boolean;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, username: string): Promise<void>;
  signOut(): Promise<void>;
  refreshProfile(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();
  // The username the sign-up form asked for. handle_new_user()
  // (0010_onboarding.sql) resolves a collision by appending _1, _2, ... and
  // the app used to land you in onboarding as @alex_1 without a word about
  // it. Anonymous users can't read profiles to check up front (RLS), so the
  // honest moment is right after the row comes back.
  const requestedUsername = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadSession()
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      // loadSession() owns the initial answer. INITIAL_SESSION carries null
      // on the same offline-refresh failure it handles, and would undo the
      // persisted-session fallback the moment it fired.
      if (event === 'INITIAL_SESSION') return;
      if (event === 'SIGNED_OUT') {
        // Everything cached belongs to the account that just left. With the
        // default 5-minute gcTime, signing into a second account on the same
        // device otherwise showed the previous account's inbox, comments,
        // and likers while the refetch was in flight.
        queryClient.clear();
      }
      setSession(next);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [queryClient]);

  const userId = session?.user.id ?? null;

  // The own-profile row drives the onboarding redirect, the Profile tab, and
  // the Explore lock, so a failed fetch here can't be allowed to stick: it
  // used to be one attempt, and an offline cold start left the Profile tab
  // spinning forever with no path back except something else happening to
  // call refreshProfile(). Retry with backoff, and re-run whenever
  // connectivity returns or the app comes back to the foreground while the
  // profile is still missing.
  useEffect(() => {
    if (!userId) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    let loaded = false;

    const attempt = async () => {
      const delays = [0, 2000, 5000];
      for (const delay of delays) {
        if (cancelled || loaded) return;
        if (delay) await sleep(delay);
        const p = await loadProfile(userId).catch(() => null);
        if (cancelled) return;
        if (p) {
          loaded = true;
          setProfile(p);
          const requested = requestedUsername.current;
          if (requested && p.username !== requested) {
            Alert.alert(
              'Username taken',
              `@${requested} was already in use, so you’re @${p.username} for now. You can change it any time from Edit profile.`
            );
          }
          requestedUsername.current = null;
          return;
        }
      }
    };

    void attempt();
    const unsubOnline = onlineManager.subscribe((online) => {
      if (online && !loaded) void attempt();
    });
    const appState = AppState.addEventListener('change', (status) => {
      if (status === 'active' && !loaded) void attempt();
    });
    return () => {
      cancelled = true;
      unsubOnline();
      appState.remove();
    };
  }, [userId]);

  // Not the instant a session appears: for a brand-new account that put the
  // OS notification dialog on screen at the same moment the onboarding
  // redirect was asking for photo access, and iOS only ever asks once.
  // Wait until onboarding is done (or was never required -- an existing
  // account, or the column absent pre-migration, both read as "not false").
  const onboarded = profile ? profile.onboarded !== false : false;
  useEffect(() => {
    if (userId && onboarded) void registerForPushNotificationsAsync(userId);
  }, [userId, onboarded]);

  const value = useMemo<AuthValue>(
    () => ({
      session,
      profile,
      loading,
      async signIn(email, password) {
        // A signUp() that didn't return a session (email confirmation
        // pending, or the address turned out to already be registered)
        // leaves this ref set for next time -- without clearing it here, an
        // unrelated later sign-in (a different account entirely, possibly on
        // a shared device) could get told its own real username was "taken".
        requestedUsername.current = null;
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      },
      async signUp(email, password, username) {
        const normalized = username.trim().toLowerCase();
        // The DB trigger reads username out of user metadata to bootstrap the
        // profiles row, so it has to be set at sign-up time.
        // Set before the call, not after: SIGNED_IN fires from inside
        // signUp(), and the profile load it triggers can win the race.
        requestedUsername.current = normalized;
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { username: normalized } },
        });
        if (error) {
          requestedUsername.current = null;
          throw error;
        }
        // Sign-up can succeed without signing you in, and the form used to
        // just un-busy and sit there when it did. Two cases: the project
        // requires email confirmation (user, no session), or the address is
        // already registered -- Supabase obfuscates that as a success with
        // a user carrying no identities.
        if (!data.session) {
          if (data.user && (data.user.identities?.length ?? 0) === 0) {
            throw new Error('An account with that email already exists. Try signing in instead.');
          }
          throw new Error('Check your email for a confirmation link, then sign in.');
        }
      },
      async signOut() {
        // Token row first: its RLS needs the session that signOut() drops.
        await unregisterPushTokenAsync();
        await supabase.auth.signOut();
      },
      async refreshProfile() {
        if (!userId) return;
        setProfile(await loadProfile(userId));
      },
    }),
    [session, profile, loading, userId]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

async function loadProfile(id: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle();
  if (error) {
    console.warn('Failed to load profile', error.message);
    return null;
  }
  return data as Profile | null;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The signed-in user's id, or null. Convenience for query keys. */
export function useUserId(): string | null {
  return useAuth().session?.user.id ?? null;
}
