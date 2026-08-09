# Deployment

Sprint 5.0 Phase 18/28. Reference architecture — the platform is provider-neutral (no cloud-specific SDKs
in the application code beyond the S3-compatible object storage client, which speaks the same protocol
across AWS/R2/MinIO), but you need to pick one to actually deploy.

## Reference target: managed container platform + managed Postgres + S3-compatible storage

Any of these work with zero application code changes — only environment variables and container
orchestration differ:

| Component | AWS | Azure | Generic |
|---|---|---|---|
| Container runtime | ECS/Fargate | Container Apps | Kubernetes |
| Managed Postgres | RDS | Azure Database for PostgreSQL | Any PITR-capable provider (Neon, Supabase, Crunchy) |
| Object storage | S3 | Blob Storage (needs an S3-compatible gateway, or swap the adapter) | R2 / MinIO |
| Secrets | Secrets Manager | Key Vault | HashiCorp Vault |
| Load balancer / TLS | ALB + ACM | Application Gateway | Any HTTPS-terminating LB |
| CDN (dashboard) | CloudFront | Front Door | Any |

**No reference deployment manifests (Terraform/Bicep/Helm) are included in this repository as of Sprint
5.0** — this document describes the shape, not a turnkey IaC template. `docker-compose.production-like.yml`
simulates the same service topology locally for UAT; it is explicitly not the deployment target itself.

## Process topology

Deploy the images built by `Dockerfile.api` (5 separate deployments, one per `PROCESS_ROLE`: `api`,
`scheduler`, `workforce-worker`, `channel-worker`, `maintenance`) and `Dockerfile.dashboard` (1 deployment).
See `docs/production/architecture.md`. Only the `api` deployment needs to be reachable from the load
balancer / scaled with traffic; the four worker deployments run one replica each unless you have a
specific throughput reason to run more (workforce-worker and maintenance both also run the queue
consumer — see `QueueConsumerWorker`).

## Migrations

```bash
pnpm db:migrate   # prisma migrate deploy — never `prisma migrate dev` in production
```

Run this as a single, separate step in your deploy pipeline (a one-off job/task, not something every
replica does on startup) — concurrent replicas all racing to run migrations is a real footgun with Prisma's
migration locking. Run it once, wait for it to succeed, then roll out the new application version.

## Reference data (RBAC permissions, plans) — required, not optional

```bash
pnpm db:seed   # prisma db seed, database/prisma/seed.ts
```

**Run this immediately after `db:migrate`, every time, on first deploy and every subsequent one.** This is
easy to miss because nothing about skipping it fails loudly: migrations succeed, the app boots cleanly,
`/health/ready` reports healthy — the failure only shows up later as confusing 403s when real customers hit
core features. The `permissions` table (which `agents.run`, `knowledge.read`, `billing.usage.read`, and
~130 other permission keys live in) is populated by this seed script, **not** by any migration — a fresh
database with migrations applied but never seeded has as few as ~29 permission rows instead of ~136. Since
a new organization's Owner role is granted every row currently in `permissions` at the moment the
organization is created, every self-service signup on an unseeded database gets an Owner who cannot run AI
employees, view knowledge, check billing usage, or see the onboarding checklist — the entire product is
unusable, while every automated health/readiness check reports green. Verified end-to-end during Sprint
5.0A: a fresh `docker-compose.production-like.yml` stack (migrations only, no seed) produced exactly this —
`GET /agents` returned `403 AUTHORIZATION_FAILED` for a freshly self-registered Owner; running `pnpm
db:seed` and nothing else fixed it immediately, for both the pre-existing organization and new ones,
without needing to recreate anything.

## Health checks

- `GET /health/live` — process is up (container orchestrator liveness probe)
- `GET /health/ready` — database + queue table reachable (readiness probe / load balancer target health)
- `GET /observability/health` (authenticated, org-scoped) — the detailed 12-component operator view

## Config

See `docs/production/environment-variables.md`. Every `requiredIn: ["production","staging"]` variable is
validated at boot — a misconfigured deploy fails immediately with a clear list, not a confusing runtime
error partway into serving traffic.

## Rollback

See `docs/operations/runbooks/` and the release-process section of the Sprint 5.0 final report. In short:
keep the previous container image tagged and deployable; a rollback is "redeploy the previous tag," not a
database rollback (this platform's migrations are additive within a release — don't ship a migration that
isn't backward-compatible with the previous release's code, so a rollback never needs a down-migration).
