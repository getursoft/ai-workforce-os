# Service accounts and API keys

Service accounts are organization-scoped machine identities managed at `/dashboard/service-accounts`. Human administrators assign existing roles, then create one or more API keys.

API keys use `awo_<live|test|development>_<public-id>_<secret>` and authenticate with `Authorization: ApiKey <key>`. Only an HMAC-SHA-256 digest is stored, protected by the required `API_KEY_PEPPER` environment variable. The plaintext is returned once at creation or rotation and is never available from list/detail APIs.

Endpoints: `GET/POST /api/v1/service-accounts`, `GET/PATCH/DELETE /api/v1/service-accounts/:id`, `GET/POST /api/v1/service-accounts/:id/api-keys`, and `POST /api/v1/service-accounts/:id/api-keys/:keyId/{rotate|revoke}`. Rotation transactionally revokes the old key. Revocation and account disablement are immediate. Expiry is checked during authentication. `lastUsedAt` is updated at most once every five minutes.

```bash
curl http://localhost:4000/api/v1/teams -H 'Authorization: ApiKey awo_live_<public-id>_<secret>'
```

Run `pnpm test:db:prepare` after configuring the isolated test database. Never commit real keys or the API-key pepper.
