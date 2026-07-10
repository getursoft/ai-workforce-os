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

## Development

Start application development processes:

```bash
pnpm dev
```

Start local PostgreSQL:

```bash
docker compose up
```

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
