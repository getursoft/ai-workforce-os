import { API_BASE_URL } from "./auth-constants";
import { normalizeApiError, normalizeServerError } from "./api-error";
import type { ApiError } from "./api-error";
import type {
  AuthenticationResult,
  CurrentUserResult,
  PublicOrganization,
  PublicUser
} from "../types/auth";

type RequestOptions = Readonly<{
  authorize?: boolean;
  retryOnUnauthorized?: boolean;
  credentials?: RequestCredentials;
}>;

type SessionState = Readonly<{
  user: PublicUser;
  organization: PublicOrganization;
  accessToken: string;
}>;

type SessionCallbacks = Readonly<{
  setSession(session: SessionState): void;
  clearSession(): void;
  getAccessToken(): string | null;
}>;

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest extends LoginRequest {
  organizationName: string;
  firstName: string;
  lastName?: string;
}

export interface LogoutResult {
  success: true;
}

export class ApiClient {
  private refreshPromise: Promise<boolean> | null = null;

  constructor(
    private readonly callbacks: SessionCallbacks,
    private readonly baseUrl: string = API_BASE_URL,
    private readonly timeoutMs: number = 15_000
  ) {}

  async register(command: RegisterRequest): Promise<AuthenticationResult> {
    const result = await this.request<AuthenticationResult>("/auth/register", {
      method: "POST",
      body: JSON.stringify(command),
      headers: { "content-type": "application/json" }
    }, { authorize: false, retryOnUnauthorized: false, credentials: "include" });
    this.callbacks.setSession({
      user: result.user,
      organization: result.organization,
      accessToken: result.tokens.accessToken
    });
    return result;
  }

  async login(command: LoginRequest): Promise<AuthenticationResult> {
    const result = await this.request<AuthenticationResult>("/auth/login", {
      method: "POST",
      body: JSON.stringify(command),
      headers: { "content-type": "application/json" }
    }, { authorize: false, retryOnUnauthorized: false, credentials: "include" });
    this.callbacks.setSession({
      user: result.user,
      organization: result.organization,
      accessToken: result.tokens.accessToken
    });
    return result;
  }

  async refresh(): Promise<AuthenticationResult> {
    const result = await this.request<AuthenticationResult>(
      "/auth/refresh",
      {
        method: "POST",
        body: JSON.stringify({})
      },
      { authorize: false, retryOnUnauthorized: false, credentials: "include" }
    );
    this.callbacks.setSession({
      user: result.user,
      organization: result.organization,
      accessToken: result.tokens.accessToken
    });
    return result;
  }

  async me(): Promise<CurrentUserResult> {
    return this.request<CurrentUserResult>("/auth/me", { method: "GET" });
  }

  async logout(): Promise<LogoutResult> {
    try {
      return await this.request<LogoutResult>(
        "/auth/logout",
        {
          method: "POST",
          body: JSON.stringify({})
        },
        { authorize: false, retryOnUnauthorized: false, credentials: "include" }
      );
    } finally {
      this.callbacks.clearSession();
    }
  }

  async request<T>(
    path: string,
    init: RequestInit = {},
    options: RequestOptions = {}
  ): Promise<T> {
    const authorize = options.authorize ?? true;
    const retryOnUnauthorized = options.retryOnUnauthorized ?? true;
    const headers = new Headers(init.headers);
    if (!headers.has("content-type") && init.body) {
      headers.set("content-type", "application/json");
    }
    if (authorize) {
      const accessToken = this.callbacks.getAccessToken();
      if (accessToken) {
        headers.set("authorization", `Bearer ${accessToken}`);
      }
    }

    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        credentials: options.credentials ?? "include",
        signal: controller.signal
      });
      if (response.status === 401 && authorize && retryOnUnauthorized) {
        const refreshed = await this.ensureRefreshed();
        if (refreshed) {
          return this.request<T>(path, init, {
            ...options,
            retryOnUnauthorized: false
          });
        }
      }
      if (!response.ok) {
        throw await this.readError(response);
      }
      return (await this.readData<T>(response)) ?? (undefined as T);
    } catch (error: unknown) {
      throw normalizeApiError(error);
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  private async ensureRefreshed(): Promise<boolean> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh().then(
        () => true,
        () => false
      );
      this.refreshPromise.finally(() => {
        this.refreshPromise = null;
      });
    }
    const refreshed = await this.refreshPromise;
    if (!refreshed) {
      this.callbacks.clearSession();
    }
    return refreshed;
  }

  private async readData<T>(response: Response): Promise<T | undefined> {
    if (response.status === 204) {
      return undefined;
    }
    const body = (await response.json()) as { data?: T } | T;
    if (typeof body === "object" && body !== null && "data" in body) {
      return body.data;
    }
    return body as T;
  }

  private async readError(response: Response): Promise<ApiError> {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return normalizeServerError(response, body);
  }
}

export function createApiClient(callbacks: SessionCallbacks): ApiClient {
  return new ApiClient(callbacks);
}
