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

  useEffect(() => {
    // Set up auth state listener FIRST
    const { data: { subscription } } = externalAuthClient.auth.onAuthStateChange(
      async (event, currentSession) => {
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

    // THEN check for existing session
    const initializeAuth = async () => {
      try {
        // Try to restore session from Electron's secure storage first
        if (window.electronAPI?.getStoredSession) {
          const storedSession = await window.electronAPI.getStoredSession();
          if (storedSession) {
            try {
              const parsed = JSON.parse(storedSession);
              if (parsed.refresh_token) {
                const { data, error } = await externalAuthClient.auth.setSession({
                  access_token: parsed.access_token,
                  refresh_token: parsed.refresh_token,
                });
                if (!error && data.session) {
                  setSession(data.session);
                  setUser(data.session.user);
                  setIsLoading(false);
                  return;
                }
              }
            } catch (e) {
              console.error('Failed to restore session:', e);
            }
          }
        }

        // Fall back to checking Supabase's session
        const { data: { session: currentSession } } = await externalAuthClient.auth.getSession();
        setSession(currentSession);
        setUser(currentSession?.user ?? null);
      } catch (error) {
        console.error('Error initializing auth:', error);
      } finally {
        setIsLoading(false);
      }
    };

    initializeAuth();

    return () => {
      subscription.unsubscribe();
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
