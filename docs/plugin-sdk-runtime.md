# Plugin SDK and runtime engine

Sprint 3.2 separates trusted repository plugin definitions from organization installations. Repository plugins live below the configurable `PLUGIN_DIRECTORY` (default: the monorepo `plugins` directory), contain a `plugin.json`, and export an SDK-compatible constructor from a safe relative JavaScript entry path.

The runtime rejects absolute paths, traversal, unsupported permissions, duplicate IDs, duplicate capabilities, duplicate permissions, malformed schemas, and invalid semantic versions. One broken definition is reported through discovery without preventing other plugins from loading. Remote download, package installation, shell execution, `eval`, and unrestricted imports are unsupported.

Lifecycle order is `install`, then `enable`/`start`, and `stop`/`disable` before `uninstall`. Every hook and event handler has a timeout. Contexts are created per organization installation and contain only immutable configuration, granted permissions, scoped service adapters, safe logging, and identity metadata—never Prisma, NestJS, environment variables, or raw secrets.

Supported plugin permissions are `LLM`, `MEMORY`, `EVENTS`, `TOOLS`, `EMAIL`, `CALENDAR`, `CRM`, `VOICE`, `SEARCH`, and `FILES`. Grants must be a subset of the definition manifest. The dummy plugin demonstrates discovery, lifecycle hooks, health, configuration, `dummy.echo`, and deterministic execution without a paid service.

```bash
pnpm --filter @ai-workforce-os/plugin-sdk build
pnpm --filter @ai-workforce-os/plugin-dummy build
pnpm --filter @ai-workforce-os/api test:e2e
```
