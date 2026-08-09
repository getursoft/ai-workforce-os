# Security

Sprint 5.0 Phase 8/9/19/20/24/28. What's actually in place, not aspirational.

## Transport / headers

HSTS, CSP (`default-src 'none'`), X-Frame-Options `DENY`, X-Content-Type-Options `nosniff`,
Referrer-Policy `no-referrer`, restrictive Permissions-Policy — set unconditionally in `main.ts`; HSTS only
in production. `x-powered-by` disabled. Strict CORS from `CORS_ALLOWED_ORIGINS` (falls back to
`WEB_APP_URL`).

## Sessions, cookies, CSRF

Access tokens: short-lived JWTs (`JWT_ACCESS_EXPIRES_IN_SECONDS`, default 900s/15min), sent as a Bearer
header — **never** stored in a cookie, so they carry no CSRF exposure at all (a cross-site request can't
read or attach an `Authorization` header). Refresh tokens: HMAC-based with rotation and reuse detection,
delivered solely via the `aiwos_refresh_token` cookie (`browser-cookie.ts`) — `HttpOnly` (unreadable by
page JS, no XSS-exfiltration path), `Secure` in production, `SameSite=lax` by default (configurable to
`strict`/`none` via `COOKIE_SAME_SITE`, with `COOKIE_SECURE` required if `none`). Session lifetime is
bounded by `REFRESH_TOKEN_EXPIRES_IN_SECONDS` (default 30 days) with reuse detection revoking the whole
token family on replay.

No separate CSRF token is issued, and none is needed given this shape: `SameSite=lax` already blocks the
refresh cookie from being sent on cross-site XHR/fetch, CORS restricts cross-origin calls to
`CORS_ALLOWED_ORIGINS` in the first place, and every state-changing request that actually matters
(everything but `/auth/refresh`/`/auth/logout`) is authorized by the Bearer access token, not the cookie —
so a forged cross-site request has no credential to attach even if it reached the API. Worst case for
`/auth/refresh`/`/auth/logout` under a same-site-lax bypass is an unwanted token rotation/logout, not
account takeover (the attacker's page can't read the response — CORS blocks that).

## Authentication

Argon2 password hashing (tunable cost via `PASSWORD_HASH_*`), JWT access tokens + HMAC refresh tokens with
rotation/reuse detection (`hmac-refresh-token-service.ts`).

**Account lockout (Sprint 5.0A)**: `LoginHandler` locks an account for `ACCOUNT_LOCKOUT_DURATION_SECONDS`
(default 900s / 15 min) after `ACCOUNT_LOCKOUT_MAX_ATTEMPTS` (default 5) consecutive failed password
attempts, tracked per-user via `User.failedLoginAttempts`/`lockedUntil`. A locked account gets a distinct
`ACCOUNT_LOCKED` (HTTP 429) error rather than the generic `AUTHENTICATION_FAILED`, so legitimate users get
actionable feedback while an attacker still can't distinguish "wrong password" from "account doesn't
exist" on the first N attempts. A successful login always clears the counter. This is in addition to the
existing IP-based `AUTH_STRICT` rate limit (10 req/5min) on `/auth/login` — the two are independent
layers (IP-based stops broad spraying, per-account stops targeted credential stuffing against one user
from many IPs). Verified via `apps/api/src/identity/domain/user/user.spec.ts` (unit) and
`apps/api/src/identity/application/handlers/identity-handlers.spec.ts` (handler-level, in-memory) — both
passing. End-to-end HTTP verification lives in `auth.e2e.spec.ts` but requires a reachable
`TEST_DATABASE_URL` to actually run (see Known gaps below for current status).

**Email verification (Sprint 5.0A)**: `EmailVerificationService` issues a 24h token on registration (and
via `POST /auth/resend-verification`, JWT-authenticated) and confirms it via `POST /auth/verify-email`.
Tracked on `User.emailVerifiedAt`. **Deliberately non-blocking**: nothing in login/register/refresh checks
verification status — the sprint spec explicitly forbids changing authentication APIs, so this ships as
an additive signal a future feature-gate could read, not an enforced gate today. When SMTP is configured
(`SMTP_HOST`), a real email is sent via the existing `EmailService`; in development/test
(`ALLOW_DEVELOPMENT_IMPLEMENTATIONS=true`) the token is also returned directly in the API response,
mirroring the existing forgot-password pattern, so the flow is testable without a mail server.

## Authorization

`JwtAccessGuard` + `PermissionGuard`, applied per-controller (not global — a new controller must remember
to apply them; confirmed as convention across 30+ controllers during the Phase 1 audit, but there is no
structural guarantee against a forgotten decorator). `PlatformOwnerGuard` for the platform-admin surface
(single-owner-email model, no multi-admin roles yet).

## Rate limiting (Phase 9)

Category-based (`AUTH_STRICT`, `AI_EXECUTION`, `FILE_UPLOAD`, `PUBLIC_APPROVAL_STRICT`, `ADMIN_API`,
`WEBHOOK`, `GENERAL_API`), registered globally so every route has at least the default, with per-route
overrides via `@RateLimit(...)`. In-memory, single-process — **not safe across multiple API replicas
without a shared backing store**; a Redis-backed implementation can be added behind the same `RateLimiter`
interface without touching call sites. Disabled under `NODE_ENV=test`.

`PublicApprovalController` (approve/reject via an unauthenticated token — the token IS the credential) was
found during this pass to have neither auth nor rate limiting; it now has `PUBLIC_APPROVAL_STRICT`.

## Billing/abuse (Phase 10)

`BillingEnforcementService` gates every AI execution on subscription status + credit allowance + grace
period + spending cap — closes the "run up the AI bill" attack surface. Disableable via
`BILLING_ENFORCEMENT_ENABLED=false` (kill switch, not a security boundary).

## Entitlements (Phase 11)

`EntitlementService` enforces plan-tier limits (employee/user/channel/scheduled-job counts, feature flags)
resolved from `SubscriptionPlan.metadataJson` + per-organization `FeatureFlag` overrides. Wired into plugin
installation as of this pass; other entitled surfaces (user invites, channel connections, scheduled job
creation) are not yet gated — the service supports it, the call sites aren't wired.

## Secrets (Phase 7)

AES-256-GCM (`PluginSecretsEncryptionService`) for connector/plugin/payment credentials. Never returned in
API responses (confirmed: list/detail endpoints return `credentialMetadata`/`secretKeys`, never plaintext
or ciphertext). Key rotation window supported as of this pass
(`PLUGIN_SECRETS_ENCRYPTION_KEY_PREVIOUS`/`SECRET_KEY_VERSION_PREVIOUS`) — see
`docs/operations/runbooks/credential-rotation.md`.

## Tenant isolation

Organization scoping comes from the JWT-derived principal, not client-supplied parameters — confirmed on
spot-checked controllers (Travel Booking, Knowledge) during the Phase 1 audit; a prior IDOR in Travel
Booking (client-supplied `?organizationId=`) predates this sprint and was already fixed before it began.

## Webhooks

Signature verification + idempotency exist for Meta/Twilio webhook controllers (pre-existing). Tenancy is
resolved from the registered channel connection, never from webhook payload fields.

## Dependency vulnerabilities (Phase 24 finding)

`pnpm audit --audit-level high` — already a required CI step — currently reports **14-22 high-severity
findings**, all `brace-expansion` (DoS via unbounded intermediate arrays) pulled in transitively by
dev-only tooling (`eslint`, `@nestjs/cli` → `glob`/`minimatch`). Not a production runtime risk (these
packages are never bundled into `Dockerfile.api`/`Dockerfile.dashboard`'s runtime stage), but it does mean
**this CI gate is currently red on `main`**, independent of anything in this Sprint 5.0 pass.

While investigating a fix, found a second, more consequential issue: `package.json`'s `pnpm.overrides`
block (5 existing pins — glob/lodash/multer/picomatch/tmp) has been **silently non-functional** — pnpm 9's
workspace mode stopped reading that field (confirmed via pnpm's own source:
`MIGRATED_PNPM_FIELD_KEYS` in `config/reader/lib/index.js` explicitly lists `overrides` as migrated to
`pnpm-workspace.yaml`). Moved the block there (now the technically-correct location per pnpm's own code)
and added `brace-expansion` pins, but even after `pnpm install --force`, `pnpm why glob` still resolves
the un-overridden version — meaning something beyond just "wrong file" is preventing overrides from taking
effect in this specific pnpm 9.15.4 setup. Left the corrected `pnpm-workspace.yaml` in place (strictly
better than the dead `package.json` config, and the config a pnpm upgrade or deeper fix would need anyway)
but did **not** falsely claim the vulnerabilities are resolved. This needs dedicated follow-up — likely a
pnpm version bump or a full lockfile regeneration, both of which carry their own blast radius and were
judged too risky to attempt blind under this pass's time constraints.

## Known gaps (do not claim otherwise)

- Rate limiting is not distributed (single-process only).
- `AppConfig` and the legacy `SecurityConfig` are two separate, not-yet-consolidated validation systems.
- No automated SAST/dependency-vulnerability gate beyond `pnpm audit` + the new Trivy container scan
  (Phase 16) — no SSRF/prompt-injection/IDOR fuzzing harness exists (Phase 24 load/security testing was not
  built this pass).
- Dashboard `typecheck`/`lint` currently fail on `main` for unrelated, pre-existing reasons (channel
  configuration forms, a reset-password form) — found during this pass, not fixed (out of scope, not part
  of Sprint 5.0, and touching them risked unrelated regressions under time constraints).
