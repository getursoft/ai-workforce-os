# Production operations

## Environment precedence

The API loads the repository-root `.env` for local execution. Existing process variables take
precedence. `APP_ENV` selects `development`, `test`, `staging`, or `production`; `NODE_ENV` is the
compatibility fallback. Tests load `.env.test` and replace `DATABASE_URL` with
`TEST_DATABASE_URL`. Container environments should inject variables directly and should not copy an
`.env` file into the image.

Use `.env.production.example` only as a key-name template. Generate independent JWT, refresh-token,
API-key, and AES encryption secrets with an approved secrets manager. Never reuse test or staging
values. Rotation requires a planned overlap for token verification and a versioned re-encryption
process for stored connector/plugin credentials.

## Deployment

1. Back up PostgreSQL and verify the backup is readable.
2. Build immutable API/dashboard images from the reviewed commit.
3. Run `pnpm exec prisma migrate status` against staging.
4. Run `pnpm exec prisma migrate deploy` as a dedicated migration job.
5. Run only the idempotent required-system-data seed. The current combined seed must be reviewed
   before production use; it creates no Dummy CRM records but has not yet been split.
6. Deploy API instances and wait for `/health/ready`.
7. Deploy dashboard and execute authenticated smoke tests.
8. Roll back application images on runtime failure. Never roll back a database by editing migration
   history; use a reviewed forward repair migration or restore a tested backup when necessary.

`Dockerfile.api` and `Dockerfile.dashboard` are multi-stage, non-root images. The API liveness probe
uses `/health/live`; orchestration readiness should use `/health/ready`.

## Backup and recovery

PostgreSQL backup, WAL archiving, point-in-time recovery, replication, and restore testing are
infrastructure responsibilities and are **not configured by this repository**. Define RPO/RTO per
deployment. Test restoration into an isolated environment at a scheduled interval, then run Prisma
migration status and tenant-isolation smoke tests.

## Incidents and external outages

- Revoke or rotate affected API keys and connector credentials.
- Disable the affected connector installation; do not enable a development fallback.
- Preserve request IDs, execution IDs, provider request IDs, and sanitized audit events.
- For ambiguous non-idempotent provider writes, reconcile with the provider before retrying.
- Queue/dead-letter recovery is not available yet and remains a production blocker.
- Webhook replay recovery must retain provider external event IDs and use provider-specific
  signature/timestamp verification once the queue/webhook blocker is implemented.

## Privacy and lifecycle

Treat authentication data, prompts, messages, memories, CRM contact properties, connector payloads,
and provider metadata as personal or sensitive according to the deploying organization’s policy.
The application provides tenant boundaries, encryption, redaction, soft deletion, and audit
extension points; it does not confer legal compliance certification.

Before production rollout, define:

- conversation, prompt, execution, connector event, and audit retention periods;
- legal-hold exclusions;
- tenant export and offboarding procedures;
- regional storage and subprocessors;
- personal-data deletion across external connectors;
- consent and purpose limitations for AI/CRM processing.

## Staging HubSpot verification

1. Deploy with `ALLOW_DEVELOPMENT_IMPLEMENTATIONS=false` and confirm the catalogue contains
   `hubspot-crm`, not `dummy-crm`.
2. In **Connectors**, install HubSpot CRM without credentials so it remains `DRAFT`.
3. Open the installation, enter a sandbox private-app token in the credential field, and save.
   Reload and confirm the token is never returned, only the configured state.
4. Test the connection, grant `CRM`, enable the installation, and run health. Require `READY`.
5. Assign the CRM capability to the Travel AI plugin and submit a uniquely addressed test-contact
   request. Confirm the assistant reports only the provider-confirmed contact/deal identifier.
6. In connector executions and audit history, correlate the request and execution; verify no
   authorization header, token, prompt body, or raw provider response appears.
7. Disable the connector and repeat the request. Verify no HubSpot call occurs and the response
   safely reports CRM unavailability without claiming creation.
8. Run the opt-in sandbox contract test:
   `HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN='<secret>' pnpm --filter @ai-workforce-os/api exec vitest run src/connectors/hubspot.sandbox.spec.ts`.
