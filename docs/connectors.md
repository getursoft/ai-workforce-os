# Connector framework

Sprint 3.5 adds organization-scoped connectors as the business-integration boundary for AI
employees. Connector definitions are trusted, in-process adapters registered by the API. An
organization installs a definition, supplies non-secret configuration and write-only credentials,
grants declared capabilities, and enables the installation. Connector-specific code never runs in
the agent loop: connector tools are registered through the existing tool registry and executor.

## Security model

- Every installation, execution, event, audit record, and Dummy CRM lead is scoped by organization.
- Credentials use the existing AES-256-GCM plugin-secret encryption service and
  `PLUGIN_SECRETS_ENCRYPTION_KEY` (a base64-encoded 32-byte key).
- API reads return credential metadata only. Plaintext values are never returned or audited.
- Tool execution requires user RBAC, a ready installation, and an installation capability grant.
- Generic HTTP calls reuse the platform SSRF, DNS, redirect, timeout, and response-size controls.
- Connector manifests and request/configuration schemas are validated with AJV.
- Inbound events are size-limited and idempotent by installation plus external event ID. The SDK
  includes a signature-verification hook for connectors that expose public webhooks; Sprint 3.5's
  generic ingestion API remains authenticated.

Generate a local encryption key with:

```bash
openssl rand -base64 32
```

Apply committed migrations to the same development database used by the API before starting local
services:

```bash
pnpm db:migrate
pnpm --filter @ai-workforce-os/api dev
```

The API loads `DATABASE_URL` from the repository-root `.env`. Tests deliberately use
`TEST_DATABASE_URL` from `.env.test`; a successful test migration check does not migrate the
development database.

## Reference connectors

`dummy-crm` is credential-free and persists tenant-scoped leads. It exposes create, update, get,
search, and note tools. `generic-http` calls only administrator-approved methods and path prefixes
under one configured public base URL and delegates transport security to the platform HTTP tool.

The Dummy Echo/Travel AI manifest declares `CRM`. When both the plugin and a ready Dummy CRM
installation have that capability grant, the deterministic development provider can request the
connector's `crm.create_lead` tool. The resulting lead reference, connector execution, agent tool
execution, and audit event are persisted.

## API summary

- `GET /api/v1/connectors`, `GET /api/v1/connectors/:id`
- CRUD under `/api/v1/connector-installations`
- configuration, write-only credentials, capabilities, tools, lifecycle, test, and health endpoints
- paginated executions, events, and audit endpoints
- authenticated idempotent event ingestion at
  `POST /api/v1/connector-installations/:id/events`

The dashboard is available at `/connectors`; connector details are at `/connectors/:id`.

## Deliberate limitations

Only trusted built-in connector definitions are supported. Remote connector download, public
provider-specific webhook authentication, OAuth authorization-code UI, WhatsApp, telephony,
booking, payment, email, and calendar implementations are future connector adapters.
