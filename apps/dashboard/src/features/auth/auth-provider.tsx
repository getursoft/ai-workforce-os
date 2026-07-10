"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createApiClient, type ApiClient, type LoginRequest, type RegisterRequest } from "../../lib/api-client";
import type {
  AuthState,
  AuthenticationResult,
  CurrentUserResult,
  PublicOrganization,
  PublicUser
} from "../../types/auth";

type SessionPayload = Readonly<{
  organization: PublicOrganization;
  user: PublicUser;
  accessToken: string;
}>;

type AuthContextValue = Readonly<{
  state: AuthState;
  login(command: LoginRequest): Promise<AuthenticationResult>;
  register(command: RegisterRequest): Promise<AuthenticationResult>;
  logout(): Promise<void>;
  refresh(): Promise<AuthenticationResult>;
  initialize(): Promise<void>;
  client: ApiClient;
}>;

const initialState: AuthState = {
  user: null,
  organization: null,
  accessToken: null,
  isAuthenticated: false,
  isInitializing: true
};

const AuthContext = createContext<AuthContextValue | null>(null);

function sessionStateFrom(result: AuthenticationResult | CurrentUserResult, accessToken: string): SessionPayload {
  return {
    organization: result.organization,
    user: result.user,
    accessToken
  };
}

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [state, setState] = useState<AuthState>(initialState);
  const stateRef = useRef(state);
  const initializedRef = useRef(false);
  const clientRef = useRef<ApiClient | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const applySession = useCallback((session: SessionPayload) => {
    setState({
      user: session.user,
      organization: session.organization,
      accessToken: session.accessToken,
      isAuthenticated: true,
      isInitializing: false
    });
  }, []);

  const clearSession = useCallback(() => {
    setState({
      user: null,
      organization: null,
      accessToken: null,
      isAuthenticated: false,
      isInitializing: false
    });
  }, []);

  const getAccessToken = useCallback(() => stateRef.current.accessToken, []);

  if (!clientRef.current) {
    clientRef.current = createApiClient({
      setSession: (session) => {
        applySession(session);
      },
      clearSession,
      getAccessToken
    });
  }

  const initialize = useCallback(async (): Promise<void> => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;
    setState((current) => ({ ...current, isInitializing: true }));
    const client = clientRef.current;
    if (!client) {
      clearSession();
      return;
    }
    try {
      if (stateRef.current.accessToken) {
        const current = await client.me();
        applySession(sessionStateFrom(current, stateRef.current.accessToken));
        return;
      }
      const refreshed = await client.refresh();
      applySession(sessionStateFrom(refreshed, refreshed.tokens.accessToken));
    } catch {
      clearSession();
    }
  }, [applySession, clearSession]);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const context = useMemo<AuthContextValue>(
    () => ({
      state,
      login: (command) => {
        const client = clientRef.current;
        if (!client) {
          throw new Error("API client is unavailable");
        }
        return client.login(command);
      },
      register: (command) => {
        const client = clientRef.current;
        if (!client) {
          throw new Error("API client is unavailable");
        }
        return client.register(command);
      },
      logout: () => {
        const client = clientRef.current;
        if (!client) {
          throw new Error("API client is unavailable");
        }
        return client.logout().then(() => undefined);
      },
      refresh: () => {
        const client = clientRef.current;
        if (!client) {
          throw new Error("API client is unavailable");
        }
        return client.refresh();
      },
      initialize,
      client: clientRef.current ?? createApiClient({
        setSession: (session) => {
          applySession(session);
        },
        clearSession,
        getAccessToken
      })
    }),
    [initialize, state]
  );

  return <AuthContext.Provider value={context}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("AuthProvider is missing");
  }
  return context;
}

export function useLogin(): AuthContextValue["login"] {
  return useAuth().login;
}

export function useRegister(): AuthContextValue["register"] {
  return useAuth().register;
}

export function useLogout(): AuthContextValue["logout"] {
  return useAuth().logout;
}

export function useCurrentUser(): {
  user: PublicUser | null;
  organization: PublicOrganization | null;
  isAuthenticated: boolean;
  isInitializing: boolean;
} {
  const {
    state: { user, organization, isAuthenticated, isInitializing }
  } = useAuth();
  return { user, organization, isAuthenticated, isInitializing };
}

export function useSessions(): Readonly<{
  supported: false;
  sessions: readonly never[];
}> {
  return {
    supported: false,
    sessions: []
  };
}
