# AI Workforce OS

AI Workforce OS is an enterprise platform foundation for operating AI-enabled workforces. Sprint 0 establishes the monorepo, tooling, application shells, package boundaries, and local infrastructure needed for future product development.

## Project Vision

The platform is designed to support long-term enterprise development with clear ownership boundaries, strict TypeScript, repeatable local setup, and production-grade repository hygiene from the first sprint.

## Architecture

The repository is a pnpm workspace managed by Turborepo. It contains a Next.js dashboard, a NestJS API shell, shared TypeScript packages, a reserved plugin workspace, Docker-based PostgreSQL for local development, and Prisma configuration without application models.

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
Git; `.env.example` contains only the local Docker Compose defaults.

## Development

Start application development processes:

```bash
pnpm dev
```

Start local PostgreSQL:

```bash
docker compose up
```

If `localhost:5432` is already occupied by another PostgreSQL installation, use
the host address bound by Docker in the ignored `DATABASE_URL`. On the current
development machine Docker PostgreSQL is reachable at `192.168.1.3:5432`, while
Homebrew PostgreSQL owns the loopback address.

Apply and inspect migrations:

```bash
pnpm exec prisma migrate dev --schema=database/prisma/schema.prisma
pnpm exec prisma migrate status --schema=database/prisma/schema.prisma
```

The guarded PostgreSQL integration and HTTP E2E tests require a dedicated
`ai_workforce_os_test` database through `TEST_DATABASE_URL`. They refuse to run
against any other database. Development data is never used or cleared by tests.

## Identity API demo

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
