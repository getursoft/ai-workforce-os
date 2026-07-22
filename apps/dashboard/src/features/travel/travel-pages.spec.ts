import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api-error";
import { travelErrorMessage } from "./travel-pages";

function error(code: string) {
  return new ApiError({ kind: "not_found", code, message: code });
}

describe("travelErrorMessage", () => {
  it("maps known error codes to safe, user-facing messages", () => {
    expect(travelErrorMessage(error("TRAVEL_EMPLOYEE_NOT_FOUND"))).toMatch(/not installed/i);
    expect(travelErrorMessage(error("CONVERSATION_NOT_FOUND"))).toMatch(/could not be found/i);
    expect(travelErrorMessage(error("PLUGIN_ALREADY_INSTALLED"))).toMatch(/already installed/i);
  });
  it("falls back to a safe generic message for unknown codes", () => {
    expect(travelErrorMessage(error("SOMETHING_UNEXPECTED"))).toBe(
      "The request could not be completed safely."
    );
  });
  it("falls back to a safe generic message for non-ApiError values", () => {
    expect(travelErrorMessage(new Error("boom"))).toBe("The request could not be completed safely.");
    expect(travelErrorMessage(null)).toBe("The request could not be completed safely.");
  });
});
