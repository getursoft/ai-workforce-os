# Krevia iOS (V1)

Native SwiftUI client for the existing Krevia backend (`apps/api`). Consumes the same REST API as
`apps/dashboard` — no mobile-specific endpoints.

## Structure

```
apps/ios/
  KreviaCore/        Swift Package: networking, auth, models, ViewModels (testable, no UIKit deps)
  Krevia.xcodeproj/   Xcode project — thin SwiftUI app target, depends on KreviaCore
  Krevia/             App target sources (Views, App entry, Info.plist, Assets)
```

`KreviaCore` has no dependency on the app target, so all business logic is unit-testable without
launching the simulator.

## Requirements

- Xcode 16+ (iOS 18 SDK), Swift 6
- iOS 16.0+ deployment target
- Krevia API running locally (`apps/api`) or a deployed instance

## Open the project

```
open apps/ios/Krevia.xcodeproj
```

Xcode resolves the local `KreviaCore` Swift Package automatically (it's referenced by relative path,
no remote package fetch, no network needed to open the project).

## API configuration

Base URL is configurable, never hardcoded to a single environment:

- **Development (default in DEBUG builds):** `http://localhost:4000/api/v1` — works against the
  Simulator (`localhost` reaches the host Mac running `apps/api`). `Info.plist` carries a
  development-only ATS exception for plain-HTTP `localhost`.
- **Production (default in RELEASE builds):** `https://api.krevia.in/api/v1` — HTTPS only.

Override at runtime via `AppConfig.shared.baseURL = URL(string: "...")!` / `AppConfig.shared.environment`
(backed by `UserDefaults`, see `KreviaCore/Sources/KreviaCore/Config/AppConfig.swift`).

## Run in Simulator

1. `open apps/ios/Krevia.xcodeproj`
2. Start the backend: `pnpm --filter @ai-workforce-os/api dev` (or however `apps/api` is normally run
   locally) so `http://localhost:4000` is live.
3. Select an iPhone simulator, ⌘R.
4. Sign in with an existing Krevia organization's email/password (matches `apps/dashboard`'s login —
   same backend, same accounts). Login requires **Organization name, Email, Password**, matching
   `POST /api/v1/auth/login`'s real contract (`LoginDto.organizationName` is required server-side).

## Testing

```
cd apps/ios/KreviaCore
swift test
```

Covers: Lead/Activity/Summary/Page decoding against real API response shapes, the login/error envelope,
`APIClient` request building (Bearer header, query params/pagination), 401 → refresh → retry, 403/404/500
mapping, malformed-JSON decoding errors, the in-memory Keychain abstraction, and `LeadListViewModel`
(loading/empty/error/pagination states) via a mocked `URLProtocol` — no live backend or credentials
required.

> This sandboxed environment's Xcode Command Line Tools installation has a broken SDK/compiler version
> match (`import Foundation` itself fails to compile — see the PR/task notes), so `swift build`/`swift
> test` could not be executed here. The code was written and reviewed against the real API contracts
> inspected directly from `apps/api/src`; run the commands above in a standard Xcode 16 environment to
> verify.

## Production configuration

Set `AppConfig.shared.environment = .production` (or ship a Release build, which defaults to it) before
distribution. Production enforces HTTPS for the base URL defensively even if a bad value were ever
persisted. No credentials or API keys are embedded in the app — only the API host.

## Security notes

- Access/refresh tokens are stored in the iOS **Keychain** (`KreviaCore/Sources/KreviaCore/Auth/KeychainStore.swift`), never `UserDefaults`, never logged.
- Passwords are never persisted on-device.
- A 401 triggers one automatic `POST /auth/refresh` + retry; if that also fails, the app clears the
  Keychain and returns to the login screen.
- The app never sends an arbitrary `organizationId` to bypass tenancy — every request relies on the
  backend deriving the tenant from the JWT (`Authorization: Bearer <accessToken>`), same as the
  dashboard.
