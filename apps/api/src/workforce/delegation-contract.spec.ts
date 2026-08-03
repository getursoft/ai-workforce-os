import { describe, expect, it } from "vitest";
import { DelegationContractValidator, MAX_DELEGATION_CONTRACT_BYTES } from "./delegation-contract";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";

describe("DelegationContractValidator", () => {
  const validator = new DelegationContractValidator();

  it("accepts a well-formed contract", () => {
    const contract = validator.validate({
      taskType: "CHECK_POLICY",
      targetCapability: "HR_POLICY",
      objective: "Check whether the requested leave is allowed",
      input: { employeeId: "e1", leaveType: "ANNUAL" },
      expectedOutput: { allowed: "boolean", reason: "string" },
      constraints: { readOnly: true, requiresApproval: false, timeoutMs: 10000 }
    });
    expect(contract.taskType).toBe("CHECK_POLICY");
  });

  it("rejects a malformed task missing required fields", () => {
    expect(() => validator.validate({ taskType: "X" })).toThrow(IdentityApplicationError);
    try {
      validator.validate({ taskType: "X" });
    } catch (error) {
      expect((error as IdentityApplicationError).code).toBe("TASK_SCHEMA_INVALID");
    }
  });

  it("rejects an unknown/extra top-level field (no additionalProperties)", () => {
    expect(() =>
      validator.validate({ taskType: "X", objective: "o", input: {}, unknownField: true })
    ).toThrow(IdentityApplicationError);
  });

  it("rejects a taskType with invalid characters", () => {
    expect(() => validator.validate({ taskType: "bad task type!", objective: "o", input: {} })).toThrow(
      IdentityApplicationError
    );
  });

  it("rejects an oversized payload", () => {
    const input = { blob: "x".repeat(MAX_DELEGATION_CONTRACT_BYTES + 1000) };
    expect(() => validator.validate({ taskType: "X", objective: "o", input })).toThrow(IdentityApplicationError);
  });

  it("rejects an out-of-range timeoutMs constraint", () => {
    expect(() =>
      validator.validate({ taskType: "X", objective: "o", input: {}, constraints: { timeoutMs: 999999 } })
    ).toThrow(IdentityApplicationError);
  });

  describe("validateResult", () => {
    it("accepts any object result when no expectedOutput schema was declared", () => {
      expect(() => validator.validateResult({ anything: "goes" }, null)).not.toThrow();
    });

    it("rejects a non-object result", () => {
      expect(() => validator.validateResult("just text", null)).toThrow(IdentityApplicationError);
      expect(() => validator.validateResult(["array"], null)).toThrow(IdentityApplicationError);
    });

    it("rejects a result missing fields declared in expectedOutput", () => {
      expect(() => validator.validateResult({ allowed: true }, { allowed: "boolean", reason: "string" })).toThrow(
        IdentityApplicationError
      );
    });

    it("accepts a result containing all declared expectedOutput fields", () => {
      expect(() =>
        validator.validateResult({ allowed: true, reason: "within policy" }, { allowed: "boolean", reason: "string" })
      ).not.toThrow();
    });
  });
});
