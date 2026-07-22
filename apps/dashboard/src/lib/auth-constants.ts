const publicEnvironment = process.env.NEXT_PUBLIC_APP_ENV;
const configuredApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();

if (
  (publicEnvironment === "production" || publicEnvironment === "staging") &&
  (!configuredApiBaseUrl || !configuredApiBaseUrl.startsWith("https://"))
) {
  throw new Error("NEXT_PUBLIC_API_BASE_URL must be an HTTPS URL outside development and test.");
}

export const API_BASE_URL = configuredApiBaseUrl ?? "http://localhost:4000/api/v1";
export const REFRESH_TOKEN_COOKIE_NAME = "aiwos_refresh_token";
export const AUTH_LOADING_KEY = "aiwos-auth-loading";
