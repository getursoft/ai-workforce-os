# Runbook: Credential Rotation

## Plugin/connector secret encryption key (`PLUGIN_SECRETS_ENCRYPTION_KEY`)

Sprint 5.0 Phase 7 added rotation support to `PluginSecretsEncryptionService` — this was previously a
single hardcoded key with no rotation path at all.

1. Generate a new 32-byte key: `openssl rand -base64 32`.
2. Deploy with:
   - `PLUGIN_SECRETS_ENCRYPTION_KEY` = the **new** key
   - `SECRET_KEY_VERSION` = current version + 1 (e.g. `2`)
   - `PLUGIN_SECRETS_ENCRYPTION_KEY_PREVIOUS` = the **old** key (unchanged)
   - `SECRET_KEY_VERSION_PREVIOUS` = the old version (e.g. `1`)
3. All *new* encryptions (new connector installs, updated credentials) now use the new key/version. All
   *existing* ciphertexts, still recorded under the old version, keep decrypting via the previous-key pair.
4. There is no automated re-encryption job in this pass — existing rows stay on the old key until they're
   naturally rewritten (credential update) or a future migration re-encrypts them explicitly. Don't remove
   `PLUGIN_SECRETS_ENCRYPTION_KEY_PREVIOUS`/`SECRET_KEY_VERSION_PREVIOUS` until you've confirmed nothing
   still depends on the old key — a payload whose version matches neither key throws
   `PLUGIN_SECRETS_ENCRYPTION_KEY_VERSION_UNKNOWN`, a clear, diagnosable error rather than silent corruption.

## JWT / refresh token secrets (`JWT_ACCESS_SECRET`, `REFRESH_TOKEN_PEPPER`)

Rotating these invalidates every existing access/refresh token immediately (no rotation window exists for
these today) — every user is logged out. Plan a maintenance window; this is not a hot rotation.

## API key pepper (`API_KEY_PEPPER`)

Same as above — rotating invalidates every service-account API key. Coordinate with anything holding one.

## Database credentials

Standard managed-provider credential rotation (e.g. AWS Secrets Manager rotation Lambda, or your
provider's built-in rotation). Update `DATABASE_URL` and redeploy; `PrismaService`'s bounded-retry
`$connect()` (Phase 5) tolerates a brief connection gap during the cutover, it does not tolerate a
sustained one.
