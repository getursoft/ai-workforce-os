# AI Workforce OS

Enterprise knowledge and grounded AI employee responses are documented in
[`docs/enterprise-knowledge.md`](docs/enterprise-knowledge.md).

AI Workforce OS is an enterprise platform foundation for operating AI-enabled workforces. Sprint 1.1 adds the real browser dashboard, login flow, protected routes, and secure browser-auth integration on top of the identity backend.

## Project Vision

The platform is designed to support long-term enterprise development with clear ownership boundaries, strict TypeScript, repeatable local setup, and production-grade repository hygiene from the first sprint.

## Architecture

The repository is a pnpm workspace managed by Turborepo. It contains a Next.js dashboard, a NestJS API, shared TypeScript packages, a reserved plugin workspace, Docker-based PostgreSQL for local development, and Prisma configuration for the identity domain.

## Folder Structure

```text
apps/
  api/
  dashboard/
packages/
  kernel/
  domain/
  plugin-sdk/
  shared/
plugins/
  dummy/
database/
docs/
tests/
scripts/
```

## Requirements

- Node.js 22 or newer
- pnpm 9.15.4 or newer
- Docker with Docker Compose

## Installation

```bash
pnpm install
```

Copy environment defaults when local database tooling is needed:

```bash
cp .env.example .env
```

The root `.env` is shared by the Prisma CLI and the NestJS API. It is ignored by
Git; `.env.example` contains the local Docker Compose defaults plus the validated
browser-auth settings.

## Development

Start application development processes:

```bash
pnpm dev
```

Start local PostgreSQL:

```bash
docker compose up
```

The local development machine currently exposes PostgreSQL on
`127.0.0.1:5432`. If your machine differs, update only the ignored local
`.env` files.

Apply and inspect migrations:

```bash
pnpm exec prisma migrate dev --schema=database/prisma/schema.prisma
pnpm exec prisma migrate status --schema=database/prisma/schema.prisma
```

The guarded PostgreSQL integration and HTTP E2E tests require a dedicated
`ai_workforce_os_test` database through `TEST_DATABASE_URL`. They refuse to run
against any other database. Development data is never used or cleared by tests.

The dashboard reads `NEXT_PUBLIC_API_BASE_URL` from `apps/dashboard/.env.example`
or your local environment. Access tokens remain in memory only; refresh tokens
stay in the backend-managed HttpOnly cookie.

## Identity demo

Start the API, then register an organization owner:

```bash
curl -sS http://localhost:4000/api/v1/auth/register \
  -H 'content-type: application/json' \
  -H 'x-request-id: local-demo-register' \
  -d '{"organizationName":"Getursoft","firstName":"Krishna","lastName":"Pandey","email":"admin@getursoft.com","password":"StrongPassword@123"}'
```

Use the returned access token for the current-user endpoint:

```bash
curl -sS http://localhost:4000/api/v1/auth/me \
  -H "authorization: Bearer $ACCESS_TOKEN"
```

Rotate or revoke a refresh token:

```bash
curl -sS http://localhost:4000/api/v1/auth/refresh \
  -H 'content-type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"

curl -sS http://localhost:4000/api/v1/auth/logout \
  -H 'content-type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"
```

Each successful response uses `{ "data": ... }`. Errors contain a stable code,
safe message, details, request ID, and timestamp. Never place real JWT secrets or
refresh-token peppers in tracked files; `.env.example` contains placeholders.

For browser testing, start the dashboard and visit `http://localhost:3000`.
The login page is `/login`, the main dashboard is `/dashboard`, and the
placeholder session page is `/dashboard/settings/sessions`.

## Commands

```bash
pnpm build
pnpm check
pnpm clean
pnpm dev
pnpm format
pnpm format:check
pnpm health
pnpm lint
pnpm test
pnpm typecheck
```

## Coding Standards

- TypeScript is strict across the workspace.
- Formatting is handled by Prettier.
- Linting is handled by ESLint.
- Prisma remains configuration-only until domain models are intentionally introduced.
- Sprint 0 contains no authentication, APIs, AI runtime, business logic, or plugin runtime.

## Git Workflow

Commits are checked with Commitlint using the conventional commit format. Husky runs the commit message hook locally after dependencies are installed.

# ai-workforce-os
