import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Profile } from './types';

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

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (!userId) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    loadProfile(userId).then((p) => {
      if (!cancelled) setProfile(p);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const value = useMemo<AuthValue>(
    () => ({
      session,
      profile,
      loading,
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      },
      async signUp(email, password, username) {
        const normalized = username.trim().toLowerCase();
        // The DB trigger reads username out of user metadata to bootstrap the
        // profiles row, so it has to be set at sign-up time.
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { username: normalized } },
        });
        if (error) throw error;
      },
      async signOut() {
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
