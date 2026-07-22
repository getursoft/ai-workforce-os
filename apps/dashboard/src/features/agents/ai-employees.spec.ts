import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api-error";
import { agentRunErrorMessage, knowledgeSourceLabel } from "./agent-pages";

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
      agentRunErrorMessage(new ApiError({ kind: "server", code, message: "Unsafe backend detail" }))
    ).toContain(expected);
  });
});

describe("AI employee enterprise knowledge sources", () => {
  it("renders document, page or chunk, and relevance without exposing embeddings", () => {
    expect(
      knowledgeSourceLabel({
        title: "Travel Policy.pdf",
        pageNumber: 4,
        chunkIndex: 8,
        score: 0.84
      })
    ).toBe("Travel Policy.pdf — page 4 (84% relevance)");
    expect(
      knowledgeSourceLabel({
        title: "Visa SOP.docx",
        pageNumber: null,
        chunkIndex: 2,
        score: 0.7
      })
    ).toBe("Visa SOP.docx — chunk 3 (70% relevance)");
  });
});
