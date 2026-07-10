# Dashboard

The `apps/dashboard` workspace package is the Sprint 1.1 Next.js App Router
frontend for AI Workforce OS.

## Development

```bash
pnpm --filter @ai-workforce-os/dashboard dev
```

The app runs on port `3000` and talks to the API through
`NEXT_PUBLIC_API_BASE_URL`:

```bash
NEXT_PUBLIC_API_BASE_URL="http://localhost:4000/api/v1"
```

The frontend keeps access tokens only in memory. Refresh tokens stay in the
backend-managed HttpOnly cookie. That means a browser refresh on a protected
route will rehydrate auth by calling `/auth/refresh`, then `/auth/me`.

## Protected routes

- `/login`
- `/dashboard`
- `/dashboard/profile`
- `/dashboard/settings`
- `/dashboard/settings/sessions`

Unauthenticated users are redirected away from dashboard routes. Logged-in users
are redirected away from `/login`.

## Session management

Sprint 1.1 does not expose session-list or session-revocation APIs yet, so
`/dashboard/settings/sessions` is a safe placeholder.

## Verification

```bash
pnpm --filter @ai-workforce-os/dashboard lint
pnpm --filter @ai-workforce-os/dashboard typecheck
pnpm --filter @ai-workforce-os/dashboard test
pnpm --filter @ai-workforce-os/dashboard build
```
