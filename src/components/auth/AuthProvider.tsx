import React, { createContext, useEffect, useState, useCallback } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { externalAuthClient } from '@/integrations/external-auth/client';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  console.log('[AuthProvider] Initial render, isLoading:', isLoading);

  useEffect(() => {
    console.log('[AuthProvider] useEffect starting...');
    
    let subscription: { unsubscribe: () => void } | null = null;
    
    try {
      // Set up auth state listener FIRST
      const result = externalAuthClient.auth.onAuthStateChange(
        async (event, currentSession) => {
          console.log('[AuthProvider] onAuthStateChange:', event, currentSession ? 'has session' : 'no session');
          setSession(currentSession);
          setUser(currentSession?.user ?? null);
          setIsLoading(false);

          // Store session in Electron's secure storage if available
          if (window.electronAPI?.storeSession && currentSession) {
            window.electronAPI.storeSession(JSON.stringify({
              access_token: currentSession.access_token,
              refresh_token: currentSession.refresh_token,
            }));
          } else if (window.electronAPI?.clearSession && !currentSession) {
            window.electronAPI.clearSession();
          }
        }
      );
      subscription = result.data.subscription;
      console.log('[AuthProvider] Auth state listener set up');
    } catch (error) {
      console.error('[AuthProvider] Error setting up auth listener:', error);
      setIsLoading(false);
    }

    // THEN check for existing session
    const initializeAuth = async () => {
      console.log('[AuthProvider] initializeAuth starting...');
      try {
        // Try to restore session from Electron's secure storage first
        if (window.electronAPI?.getStoredSession) {
          console.log('[AuthProvider] Checking Electron stored session...');
          const storedSession = await window.electronAPI.getStoredSession();
          if (storedSession) {
            try {
              const parsed = JSON.parse(storedSession);
              if (parsed.refresh_token) {
                console.log('[AuthProvider] Found stored session, restoring...');
                const { data, error } = await externalAuthClient.auth.setSession({
                  access_token: parsed.access_token,
                  refresh_token: parsed.refresh_token,
                });
                if (!error && data.session) {
                  console.log('[AuthProvider] Session restored successfully');
                  setSession(data.session);
                  setUser(data.session.user);
                  setIsLoading(false);
                  return;
                }
              }
            } catch (e) {
              console.error('[AuthProvider] Failed to restore session:', e);
            }
          }
        }

        // Fall back to checking Supabase's session
        console.log('[AuthProvider] Checking Supabase session...');
        const { data: { session: currentSession } } = await externalAuthClient.auth.getSession();
        console.log('[AuthProvider] Supabase session:', currentSession ? 'exists' : 'null');
        setSession(currentSession);
        setUser(currentSession?.user ?? null);
      } catch (error) {
        console.error('[AuthProvider] Error initializing auth:', error);
      } finally {
        console.log('[AuthProvider] Setting isLoading to false');
        setIsLoading(false);
      }
    };

    initializeAuth();

    return () => {
      console.log('[AuthProvider] Cleanup - unsubscribing');
      subscription?.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    try {
      const { error } = await externalAuthClient.auth.signInWithPassword({
        email,
        password,
      });
      return { error: error as Error | null };
    } catch (error) {
      return { error: error as Error };
    }
  }, []);

  const signOut = useCallback(async () => {
    await externalAuthClient.auth.signOut();
    if (window.electronAPI?.clearSession) {
      window.electronAPI.clearSession();
    }
  }, []);

  const value = {
    user,
    session,
    isLoading,
    signIn,
    signOut,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
