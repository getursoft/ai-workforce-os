import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api-error";
import { agentRunErrorMessage } from "./agent-pages";

describe("AI Employees runtime errors", () => {
  it.each([
    ["AI_PROVIDER_AUTHENTICATION_FAILED", "credentials were rejected"],
    ["AI_PROVIDER_MODEL_NOT_FOUND", "model is unavailable"],
    ["AI_PROVIDER_QUOTA_EXCEEDED", "quota has been exceeded"],
    ["AI_PROVIDER_UNAVAILABLE", "currently unavailable"],
    ["AI_PROVIDER_TEST_FAILED", "could not complete"],
    ["AI_PROVIDER_RESPONSE_INVALID", "invalid response"],
    ["AGENT_EXECUTION_FAILED", "could not be completed safely"]
  ])("displays a stable message for %s", (code, expected) => {
    expect(
      agentRunErrorMessage(
        new ApiError({ kind: "server", code, message: "Unsafe backend detail" })
      )
    ).toContain(expected);
  });
});
