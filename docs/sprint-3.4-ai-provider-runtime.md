# Sprint 3.4 AI provider and tool runtime

Installed plugins can use organization-scoped OpenAI-compatible, Azure OpenAI, or deterministic development providers. Provider settings are stored separately from plugin configuration. API keys are encrypted with AES-256-GCM and are only decrypted immediately before provider execution.

Set `PLUGIN_SECRETS_ENCRYPTION_KEY` to a base64-encoded 32-byte value:

```bash
openssl rand -base64 32
```

The plugin APIs expose sanitized provider metadata at `GET/PATCH /api/v1/plugins/:id/ai-configuration`, connection testing at `POST .../test`, and bounded chat at `POST /api/v1/plugins/:id/chat`. Only organization Owner and Admin system roles can modify credentials. Viewers never receive plaintext or encrypted secret payloads.

OpenAI-compatible configuration requires `model`, optionally `baseUrl`, and `apiKey`. Azure requires `endpoint`, `deploymentName`, `apiVersion`, and `apiKey`. No provider fallback occurs.

The centralized `SafeHttpTool` supports GET/POST JSON with a strict timeout, response-size and redirect limit. It rejects non-HTTP protocols, IP-literal hosts, loopback, private, link-local, multicast, metadata and `.local` destinations, and unsafe headers. Every redirect is revalidated. Tools require both manifest declaration and an organization installation grant.

The Dummy Echo reference plugin also declares `travel.chat` and `platform.http.request`. Its chat prompt explicitly prohibits booking claims and payment-card collection. The deterministic provider is intended only for local development and automated tests; it is not a production intelligence provider.

Not included: bookings, calendar/email integrations, Amadeus/Booking.com, background automation, or an event bus.
