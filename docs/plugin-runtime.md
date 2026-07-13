# Plugin runtime foundation

Sprint 3.1 provides organization-scoped plugin installation, lifecycle management, safe configuration, registry synchronization, health checks, and a framework-neutral SDK. It intentionally does not load arbitrary third-party JavaScript or expose tool execution; those capabilities belong to Sprint 3.2.

## Security and configuration

Set `PLUGIN_SECRETS_ENCRYPTION_KEY` to exactly 32 random bytes encoded as canonical base64:

```bash
openssl rand -base64 32
```

Plugin secrets are stored as versioned AES-256-GCM envelopes containing a unique IV, authentication tag, and ciphertext. APIs return only secret key names. Omitted secret keys remain unchanged; a `null` value deliberately removes a key.

Only trusted built-in `entryPoint` identifiers are registered. Sprint 3.1 includes `dummy-echo`; no filesystem path, dynamic import, `eval`, or shell execution is accepted from manifests.

## Lifecycle and API

Plugins install as `DISABLED`, can transition to `ACTIVE`, may be disabled idempotently, and are soft-deleted. Deprecated plugins cannot be enabled. All endpoints are tenant-scoped and protected by `plugin.read`, `plugin.install`, `plugin.update`, or `plugin.delete`.

```bash
curl -X POST http://localhost:4000/api/v1/plugins/install -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data @dummy-plugin.json
curl http://localhost:4000/api/v1/plugins -H 'Authorization: Bearer <token>'
curl http://localhost:4000/api/v1/plugins/<plugin-id> -H 'Authorization: Bearer <token>'
curl -X POST http://localhost:4000/api/v1/plugins/<plugin-id>/enable -H 'Authorization: Bearer <token>'
curl -X POST http://localhost:4000/api/v1/plugins/<plugin-id>/disable -H 'Authorization: Bearer <token>'
curl http://localhost:4000/api/v1/plugins/<plugin-id>/health -H 'Authorization: Bearer <token>'
curl -X PATCH http://localhost:4000/api/v1/plugins/<plugin-id>/configuration -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' -d '{"config":{"prefix":"Hi"},"secrets":{"apiKey":"<secret>"}}'
curl -X DELETE http://localhost:4000/api/v1/plugins/<plugin-id> -H 'Authorization: Bearer <token>'
```

The dashboard management surface is available at `/dashboard/plugins`. SDK consumers import `BasePlugin`, manifest, context, tool, health, request, result, logger, and response contracts from `@ai-workforce-os/plugin-sdk`.
