"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type AuthTier = "spotify" | "playlist_import";

export type AuthState = {
  userId: string;
  displayName: string;
  authType: AuthTier;
  isGuest: boolean;
  loading: boolean;
};

const AuthContext = createContext<AuthState>({
  userId: "",
  displayName: "",
  authType: "spotify",
  isGuest: false,
  loading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    userId: "",
    displayName: "",
    authType: "spotify",
    isGuest: false,
    loading: true,
  });

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        const authType: AuthTier = d.authType === "playlist_import" ? "playlist_import" : "spotify";
        setState({
          userId: d.userId ?? "",
          displayName: d.displayName ?? "Listener",
          authType,
          isGuest: authType === "playlist_import",
          loading: false,
        });
      })
      .catch(() => {
        setState((prev) => ({ ...prev, loading: false }));
      });
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
