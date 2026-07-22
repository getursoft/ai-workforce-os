import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api-error";
import { statusMessage } from "./channel-pages";

describe("channel status messages", () => {
  it.each([
    ["CHANNEL_CONFIGURATION_INCOMPLETE", "Account SID, Auth Token, and sender number"],
    ["AGENT_NOT_FOUND", "Select an active AI employee"],
    ["AGENT_NOT_ACTIVE", "not active"],
    ["CHANNEL_CREDENTIALS_REQUIRED", "Configure the Twilio credentials"],
    ["CHANNEL_PROVIDER_AUTHENTICATION_FAILED", "rejected the configured Account SID"],
    ["CHANNEL_PROVIDER_RATE_LIMITED", "rate-limited"],
    ["CHANNEL_PROVIDER_UNAVAILABLE", "currently unavailable"],
    ["CHANNEL_PROVIDER_TIMEOUT", "timed out"],
    ["CHANNEL_NOT_FOUND", "no longer available"]
  ])("displays a stable, safe message for %s", (code, expected) => {
    expect(
      statusMessage(new ApiError({ kind: "server", code, message: "Unsafe backend detail" }))
    ).toContain(expected);
  });

  it("falls back to a generic message for unknown error codes without leaking backend detail", () => {
    expect(
      statusMessage(
        new ApiError({
          kind: "server",
          code: "SOME_INTERNAL_DETAIL",
          message: "raw stack trace or internal detail"
        })
      )
    ).toBe("Check the fields and try again.");
  });
});
