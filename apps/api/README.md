# API

The NestJS API exposes the Sprint 1 identity endpoints under `/api/v1/auth`:

- `POST /register`
- `POST /login`
- `POST /refresh`
- `POST /logout`
- `GET /me`

Run from the repository root with `pnpm --filter @ai-workforce-os/api dev`. The
API listens on port 4000 and loads the ignored root `.env` file. Request bodies
are strictly validated and unknown properties are rejected.

Browser clients use secure HttpOnly refresh cookies. The API still returns the
access token and refresh token in JSON for compatibility, but the dashboard only
relies on the cookie-backed refresh path. `WEB_APP_URL` controls the allowed
frontend origin for CORS, and the cookie attributes are driven by the validated
security configuration.

Refresh tokens are opaque, single-use credentials. A successful refresh creates
a replacement session in the same family and revokes the old session. Reuse of
an old token revokes every active session in that family. Logout is idempotent:
malformed, unknown, and already-revoked tokens all return success so session
existence is not disclosed.

Authentication endpoints are structured so rate limiting can be added at the
HTTP boundary, but rate limiting is not implemented in Sprint 1.

## Local development

```bash
pnpm --filter @ai-workforce-os/api dev
```

The root `.env` file must include the validated browser-auth variables:

- `WEB_APP_URL`
- `COOKIE_SECURE`
- `COOKIE_SAME_SITE`
- `COOKIE_DOMAIN`

See `.env.example` for safe defaults.
