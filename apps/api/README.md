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

Refresh tokens are opaque, single-use credentials. A successful refresh creates
a replacement session in the same family and revokes the old session. Reuse of
an old token revokes every active session in that family. Logout is idempotent:
malformed, unknown, and already-revoked tokens all return success so session
existence is not disclosed.

Authentication endpoints are structured so rate limiting can be added at the
HTTP boundary, but rate limiting is not implemented in Sprint 1.
