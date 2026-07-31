import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api-error";
import { employeeErrorMessage } from "./employee-pages";
import type { EmployeePageSpec } from "./employee-pages";

const SPEC: EmployeePageSpec = {
  pluginId: "hr-employee",
  permissionPrefix: "hr",
  artifactNoun: "HR request",
  title: "HR Employee",
  description: "desc",
  basePath: "/hr-employee",
  artifactEndpoint: "tickets",
  fallbackDescription: "fallback"
};

function error(code: string) {
  return new ApiError({ kind: "not_found", code, message: code });
}

describe("employeeErrorMessage", () => {
  it("maps known error codes to safe, user-facing messages naming the employee", () => {
    expect(employeeErrorMessage(error("EMPLOYEE_NOT_FOUND"), SPEC)).toMatch(/not installed/i);
    expect(employeeErrorMessage(error("EMPLOYEE_MANIFEST_UNAVAILABLE"), SPEC)).toMatch(
      /not available to install/i
    );
    expect(employeeErrorMessage(error("CONVERSATION_NOT_FOUND"), SPEC)).toMatch(
      /could not be found/i
    );
    expect(employeeErrorMessage(error("PLUGIN_ALREADY_INSTALLED"), SPEC)).toMatch(
      /already installed/i
    );
  });
  it("falls back to a safe generic message for unknown codes", () => {
    expect(employeeErrorMessage(error("SOMETHING_UNEXPECTED"), SPEC)).toBe(
      "The request could not be completed safely."
    );
  });
  it("falls back to a safe generic message for non-ApiError values", () => {
    expect(employeeErrorMessage(new Error("boom"), SPEC)).toBe(
      "The request could not be completed safely."
    );
    expect(employeeErrorMessage(null, SPEC)).toBe("The request could not be completed safely.");
  });
});
