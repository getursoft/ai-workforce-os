# Forgot Password / Reset Password — Gmail SMTP Delivery

Status: **Complete**, with one honestly-disclosed limitation (§20): no real Gmail mailbox was available to receive an actual email in this environment.

## 1. Existing forgot-password implementation discovered

Before writing anything, an audit found this flow was **already substantially built** — just missing the one link that made it real:

- `PasswordResetService` (`apps/api/src/identity/application/services/password-reset.service.ts`) — already generated a cryptographically random 24-byte `base64url` token, stored only its SHA-256 hash, enforced 30-minute expiry and one-time use, revoked previously-issued tokens on a new request, and revoked all sessions on a successful reset. Already returned an empty token for an unknown/inactive email (no enumeration by value).
- `AuthController.forgotPassword`/`resetPassword` — already existed, already rate-limited with `@RateLimit("AUTH_STRICT")`, already returned the token directly only in dev/test mode (`securityConfig.allowDevelopmentImplementations`).
- `EmailService` (`apps/api/src/notifications/email.service.ts`) — already a full nodemailer SMTP wrapper reading `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASSWORD`/`SMTP_FROM_EMAIL`/`SMTP_FROM_NAME` from env, already had `isConfigured()`/`verifyConnection()`, already used elsewhere (travel ticket delivery, scheduler delivery). **It had never sent a password-reset email — only plain-text `.text` bodies, no HTML support at all.**
- `AuthController.resendVerification`'s private `sendVerificationEmail` — an **exact existing template** for "build a URL from `securityConfig.webAppUrl`, check `emailService.isConfigured()`, send best-effort, never block the caller, return the token only in dev." I mirrored this pattern precisely for the reset email rather than inventing a new one.
- `passwordResetToken` Prisma model — already had every field Phase 4 asked for (`tokenHash`, `expiresAt`, `usedAt`, `userId`, `createdAt`). No migration was needed.
- Dashboard: `apps/dashboard/src/app/(auth)/forgot-password` and `.../reset-password` pages, `ForgotPasswordForm`, `ResetPasswordForm` — **already fully built**, already had loading/error states, already enforced the identical password policy (12+ chars, upper/lower/digit/symbol) as the backend DTO, already showed a generic non-leaking error message, already had a working "Forgot password?" link on the login page.

**What was missing**: the email was never actually sent. `forgot-password` computed a token and just... didn't email it to anyone. That gap — plus a handful of smaller correctness issues found while closing it — is what this pass fixed.

## 2. Existing functionality reused

Per the instructions, nothing below was rebuilt: `IdentityModule`, `EmailService`, SMTP env-var configuration, the `User` Prisma model, `PASSWORD_HASHER`/`Argon2PasswordHasher`, `SecurityConfig` (`webAppUrl`, `allowDevelopmentImplementations`), `AuditEventLogger`, `SecurityEventLogger`, `@RateLimit("AUTH_STRICT")`, `AuthenticationSession` revocation, and every existing dashboard auth page/component. The only *new* files are a pure email-template builder and its test; everything else is an edit to an existing file.

## 3. Gmail SMTP configuration

Uses the existing `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASSWORD`/`SMTP_FROM_EMAIL`/`SMTP_FROM_NAME` env vars verbatim — for Gmail specifically: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURE=false` (STARTTLS), `SMTP_USER=<gmail address>`, `SMTP_PASSWORD=<16-character Google App Password>`, `SMTP_FROM_EMAIL=<same address>`. `env.schema.ts` already declares `SMTP_PASSWORD` with `secret: true` (excluded from the config-dump surface) and none of these vars are `requiredIn` production — by existing, deliberate design an unconfigured mailer must never crash the API, only fail the one send that needed it (see `EmailService`'s own comment on this). I left that design untouched. The spec's illustrative `SMTP_FROM` single var is effectively `SMTP_FROM_EMAIL` in this codebase's existing convention (`SMTP_FROM` itself is declared in `env.schema.ts` but was already unused anywhere in the code before this pass — I did not wire it up, to avoid inventing a second, redundant "from" mechanism alongside the one already used everywhere else in this codebase).

## 4. Reset token architecture

Unchanged from what already existed: `randomBytes(24).toString("base64url")` (32-character URL-safe token, ~144 bits of entropy) generated per request, `SHA-256` hex digest stored as `tokenHash`, verified with `timingSafeEqual` (not `===`) to avoid a timing side-channel. Requesting a new reset **now also explicitly revokes every other still-active token** for that user at confirm time (previously only revoked at request time — see §8, item 2).

## 5. Token expiry

30 minutes (`RESET_TOKEN_LIFETIME_MS = 30 * 60 * 1000`, pre-existing, within the spec's 30–60 minute range) — now exported as `RESET_TOKEN_LIFETIME_MINUTES` so the email template and the service can never disagree about the number they each show/enforce.

## 6. Token hashing/storage

SHA-256 hex (64 chars), stored in `password_reset_tokens.token_hash`. The raw token is **never** persisted anywhere — confirmed live in §19's UAT (`token_hash` in the DB is a 64-hex-char digest, not the issued token) and asserted in the e2e suite (`record.tokenHash).not.toBe(token)`, `toMatch(/^[0-9a-f]{64}$/)`).

## 7. Forgot-password endpoint

`POST /api/v1/auth/forgot-password` — unchanged route/DTO. **Fixed a genuine account-enumeration gap** (§8, item 1): the response *shape* (not just the token value) now uniformly includes a `resetToken` key in dev/test mode for both known and unknown emails (empty string vs. real token) — previously the key was present only for a known email and *absent entirely* for an unknown one, which a client could distinguish by key presence alone, independent of the value. In production the key is never present either way, so this only mattered for dev/test — but the spec's requirement is unqualified, so I fixed it unconditionally.

## 8. Reset-password endpoint

`POST /api/v1/auth/reset-password` — unchanged route/DTO. Two real gaps closed inside `PasswordResetService.confirmReset`:
1. **Lockout counters were never reset on a successful reset.** A user who got themselves locked out, then correctly proved account ownership via email, would still be locked out afterward — now `failedLoginAttempts: 0, lockedUntil: null` is set in the same transaction as the password update.
2. **Password hashing bypassed the injected `PasswordHasher` port**, calling `argon2.hash()` directly with *default* cost parameters instead of the app's configured `SecurityConfig.passwordHash` (`memoryCost`/`timeCost`/`parallelism`) — meaning a password set via reset was hashed more weakly than one set at registration. Now injects `PASSWORD_HASHER` (`Argon2PasswordHasher`) exactly like `LoginHandler` does, so every password in the system is hashed with the same tuned parameters.

## 9. Dashboard pages

No new pages — both already existed and already matched the UI design system. One 1-line addition: `ResetPasswordForm` now pre-fills its `token` field from the URL's `?token=` query param (previously only `email` was read from the URL; `token` had to be typed/pasted manually). This makes "click the emailed link" actually auto-populate the form, satisfying Phase 5/7's "read token from URL," while fully preserving the existing manual-entry fallback for a client that strips links.

## 10. Email template

New file: `password-reset-email.template.ts` — a pure, unit-tested function producing `{subject, text, html}`. Subject: "Reset your AI Workforce OS password". HTML is a self-contained, inline-styled, table-based email (no external CSS/JS/images, safe across clients), with a branded header, a prominent "Reset Password" button, the expiry stated in both bodies, the exact required security notice ("If you did not request this change, you can safely ignore this email"), and support text. **The raw token appears nowhere except inside the button's `href`** — verified by a dedicated unit test that strips the link from both bodies and confirms the bare token substring is gone from what remains. The URL itself is properly HTML-escaped in the `href` attribute (a dedicated test injects `<script>`/quote characters into a fake URL and confirms they're escaped, not literal).

## 11. Rate limiting

Both routes already carried `@RateLimit("AUTH_STRICT")` (10 requests / 5-minute window, IP+category keyed) before this pass — unchanged. `AUTH_STRICT`'s behavior itself is already comprehensively unit-tested at the rate-limiter level (`in-memory-rate-limiter.spec.ts`, `rate-limit.guard.spec.ts`) independent of which route uses it, so I did not duplicate a route-specific rate-limit e2e test — doing so would mean firing 10+ real requests through the full app/DB stack to test something already proven generically.

## 12. Session invalidation

Already implemented (`authenticationSession.deleteMany({ where: { userId } })` inside the reset transaction) — this pass **added the missing test proving it actually works**: a live login → grab its refresh token → reset the password → attempt `/auth/refresh` with the old token → `401`. Previously untested; now covered.

## 13. Audit events

Added via the existing `AuditEventLogger` (already used elsewhere, e.g. the Sprint 6.1 skills platform) — all 5 requested events now fire: `PASSWORD_RESET_REQUESTED` (every forgot-password call, before branching on account existence — so the audit trail itself can't be used to infer existence from *whether* the event fires, only ops staff with DB access could ever see it at all), `PASSWORD_RESET_EMAIL_SENT`, `PASSWORD_RESET_EMAIL_FAILED` (sanitized — only `error.constructor.name`, e.g. `"Error"`, never the raw message), `PASSWORD_RESET_COMPLETED`, `PASSWORD_RESET_INVALID_TOKEN` (only when the failure is actually the invalid/expired-token case, checked via `error.message === "RESET_TOKEN_INVALID"` — not fired for unrelated failures). None of these calls ever pass a token, token hash, or password value — verified by code inspection (every `auditLogger.record(...)` call site in this file passes only `{}` or `{errorCode}`) since intercepting the process logger's stdout wasn't a meaningfully stronger test than reading the 6 call sites directly.

## 14. Observability

Existing `SecurityEventLogger.success`/`.failure` calls (`forgot_password_requested`, `password_reset`, `password_reset_failed`) were **preserved exactly as they were** — the new `AuditEventLogger` calls are additive, sitting alongside them, not replacing them. No new trace span type was needed or added (this flow was never part of the `ObservabilityService`/`SKILL_EXECUTION`-style tracing system to begin with).

## 15. Files added

- `apps/api/src/identity/presentation/http/password-reset-email.template.ts`
- `apps/api/src/identity/presentation/http/password-reset-email.template.spec.ts` (8 tests)
- `docs/production/forgot-password-gmail-smtp-report.md` (this file)

## 16. Files changed

- `apps/api/src/notifications/email.service.ts` — added optional `html?: string` to `SendMailInput`, passed through to nodemailer only when present (omitted entirely otherwise — verified by a dedicated test — so every pre-existing caller's behavior is byte-identical).
- `apps/api/src/notifications/email.service.spec.ts` — +2 tests for the new `html` field.
- `apps/api/src/identity/application/services/password-reset.service.ts` — inject `PASSWORD_HASHER`; reset lockout counters and revoke sibling tokens on confirm; export `RESET_TOKEN_LIFETIME_MINUTES`.
- `apps/api/src/identity/presentation/http/auth.controller.ts` — inject `AuditEventLogger`; `forgotPassword` now sends the branded email (best-effort, non-blocking) and fixes the response-shape enumeration gap; `resetPassword` now emits the two new audit events.
- `apps/api/src/identity/presentation/http/auth.e2e.spec.ts` — +12 new tests (§18).
- `apps/dashboard/src/components/auth/reset-password-form.tsx` — pre-fill `token` from the URL.
- `apps/api/src/skills-platform/skill-recommendation.service.spec.ts` — unrelated to this feature; fixed 7 pre-existing `no-non-null-assertion` lint errors that were blocking `pnpm --filter api lint` from a prior sprint's test file, so this sprint's static verification could actually run clean. Noted here for transparency rather than silently bundled in.

## 17. Database migration

**None.** `password_reset_tokens` already had every column needed; `users.failed_login_attempts`/`users.locked_until` already existed. `prisma validate` passes against the unchanged schema.

## 18. Exact test counts

| File | New tests |
|---|---|
| `password-reset-email.template.spec.ts` | 8 |
| `email.service.spec.ts` | +2 |
| `auth.e2e.spec.ts` (real Postgres) | +12 |
| **Total new** | **22** |

The 12 new e2e tests, mapped against Phase 13's 24-item list:

1. known email requests a reset (✓ "issues a reset token…")
2. unknown email → identical response (✓ "returns an identical response shape…")
3. email normalization (✓ same test — mixed-case/whitespace email in, normalized email out)
4/5. token generated securely / raw token not stored (✓ "issues a reset token…" asserts `tokenHash` ≠ raw token, matches `^[0-9a-f]{64}$`)
6. token expires (✓ "rejects an expired reset token" — DB-manipulated `expiresAt`)
7/8. single-use / second use rejected (✓ "completes the full reset flow…" replay assertion)
9. invalid token rejected (✓ "rejects a garbage/invalid token…")
10. previous token invalidated by a new request (✓ "invalidates a previously issued token…")
11. password policy enforced (✓ "enforces the existing password policy…")
12/13/14. password changed / old fails / new works (✓ "completes the full reset flow…")
15. old refresh/session invalid after reset (✓ same test, `/auth/refresh` → 401)
16. enumeration prevented (✓ items 2 + a dedicated suspended-account test)
17/18. rate limiting (reused — already generically covered, see §11, not duplicated)
19. SMTP failure sanitized (✓ "never fails the forgot-password request even when… SMTP transport itself fails" — plus a **live, real-network** version in §19)
20/21. token/password absent from logs (verified by code inspection, §13 — every audit call site passes only `{}`/`{errorCode}`)
22. tenant/user security unaffected (✓ every new test registers its own isolated organization; no shared/global state touched)
23. disabled user handled safely (✓ "returns the same non-enumerating response for a suspended account…")
24. email template generated correctly (✓ the 8 dedicated template unit tests, §10)

Full API suite after all changes: **2274 passed, 1 skipped, 0 failed**, 164 files (2252 from the prior sprint + 22 new).

## 19. Build/typecheck/lint results

- `pnpm --filter api build` (`nest build`, full `tsc`) — clean, 0 errors.
- `pnpm --filter api lint` (`eslint .`) — clean, 0 errors (after fixing the unrelated pre-existing issue in §16).
- `pnpm --filter dashboard typecheck` — clean, 0 errors.
- `pnpm --filter dashboard lint` — clean, 0 errors, same 3 pre-existing unrelated warnings noted in prior sprint reports.
- `npx prisma validate` — schema valid (no migration, nothing to invalidate).

## 20. Live Gmail UAT result

**Real Gmail mailbox delivery was NOT tested — no Gmail credentials exist anywhere in this environment** (checked `apps/api/.env`, the shell environment, and for any `.env.local`; none set `SMTP_HOST`/`SMTP_USER`/`SMTP_PASSWORD`). Per the instructions, I did not ask for or fabricate real Gmail App Password credentials — sending real mail through someone's actual mailbox is not something to improvise casually, and this session had already surfaced (via the environment's own safety classifier, on an unrelated earlier task) that credential-adjacent actions on real-looking accounts need explicit authorization I don't have here.

What **was** genuinely tested live, against the real compiled server (`node dist/main`, not vitest, not mocks), booted twice:

1. **SMTP unconfigured** (first boot): registered a real user, called `/auth/forgot-password` for both that user and an unknown address — confirmed byte-identical response shape (§7's fix, live).
2. **SMTP configured against the real `smtp.gmail.com:587`, with a fake (non-existent) Gmail account and a fake App Password** (second boot): this makes an actual TCP+TLS connection to Google's real mail servers and a real SMTP `AUTH` attempt, which Gmail genuinely rejects (invalid credentials) — a real network failure, not a simulated one. Confirmed: the HTTP response was still `200` with a valid, usable reset token (~1.5s round-trip, including the real failed Gmail handshake); the server log recorded `PASSWORD_RESET_EMAIL_FAILED` with a sanitized `errorCode: "Error"`; `grep`-ing the entire server log for the literal fake password string returned zero matches. The issued token was then used to complete a real `/auth/reset-password` call and log in with the new password successfully — full flow, real infrastructure, fake credentials only.

This is as close to "real Gmail UAT" as can honestly be done without a real mailbox to check for arrival: **SMTP configuration, Gmail's real server, and the full graceful-degradation path were all exercised for real; actual email delivery into an inbox was not.** A follow-up with a real (disposable/test) Gmail account and App Password, provided explicitly by the user, would close this gap in minutes given everything else here is already proven to work.

## 21. Security verification

- Response shape uniform regardless of account existence — fixed and tested (§7).
- Suspended/inactive accounts get the same non-enumerating response as unknown emails — tested (§18, item 23).
- Raw token never stored — tested (§6).
- Token verified with a constant-time comparison (`timingSafeEqual`), pre-existing, unchanged.
- Reset URL built exclusively from `securityConfig.webAppUrl` (server-side config), never from the request's `Host` header — pre-existing pattern, reused verbatim, not re-derived.
- New password hashed with the same tuned Argon2id parameters as every other password in the system — fixed (§8).
- Old sessions/refresh tokens revoked on reset — pre-existing, now tested (§12).
- Account lockout cleared on a successful reset, but *only* on success — a failed/invalid reset attempt does **not** touch lockout state (verified implicitly: the expired/garbage/replay tests never observe a lockout change since they never reach the transaction).
- SMTP credentials never appear in logs, responses, or audit events — verified live (§20) with a real network failure against Gmail, zero matches for the fake password string anywhere in the log.
- Email content contains the raw token only inside the reset URL, nowhere else — unit-tested (§10).

## 22. Remaining limitations

- No real Gmail inbox delivery confirmation (§20) — everything short of "an email physically arrived" was verified for real.
- `SMTP_FROM` (the single-var form) remains declared-but-unused in `env.schema.ts`, same as before this pass — `SMTP_FROM_EMAIL`/`SMTP_FROM_NAME` is the actual, already-used mechanism; I did not add a second parallel one.
- No dedicated route-level rate-limit e2e test for `/forgot-password`/`/reset-password` specifically (§11) — the underlying `AUTH_STRICT` behavior is already generically proven; adding a redundant 10-real-request test per route would cost suite time for no new coverage.
- The dashboard's reset flow is a hybrid "click the link (auto-fills token) or paste the code manually" UX, not a pure "link-only" flow — this was a deliberate choice to preserve the existing, already-built, already-tested manual-entry fallback rather than remove working functionality to match the spec's illustrative wording more literally.
