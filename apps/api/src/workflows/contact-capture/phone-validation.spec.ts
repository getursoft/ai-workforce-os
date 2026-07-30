import { describe, it, expect } from "vitest";
import { validateIndianMobileNumber, extractIndianMobileNumber } from "./phone-validation";

describe("validateIndianMobileNumber", () => {
  it("accepts the UAT number 8380031193 as a valid Indian 10-digit mobile number", () => {
    const result = validateIndianMobileNumber("8380031193");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("8380031193");
  });

  it.each(["9876543210", "7000000000", "6123456789", "8380031193"])(
    "accepts %s (10 digits, starts with 6-9)",
    (value) => {
      expect(validateIndianMobileNumber(value).valid).toBe(true);
    }
  );

  it("strips spaces, dashes, and parentheses before validating", () => {
    const result = validateIndianMobileNumber("83800 31193");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("8380031193");
  });

  it("strips a leading +91 country code without fabricating one", () => {
    const result = validateIndianMobileNumber("+918380031193");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("8380031193");
  });

  it("strips a leading 91 country code when the remainder is exactly 10 digits", () => {
    const result = validateIndianMobileNumber("918380031193");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("8380031193");
  });

  it("strips a leading 0 trunk prefix when the remainder is exactly 10 digits", () => {
    const result = validateIndianMobileNumber("08380031193");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("8380031193");
  });

  it.each(["12345", "5380031193", "83800311930", "abcdefghij", ""])(
    "rejects invalid input %j",
    (value) => {
      const result = validateIndianMobileNumber(value);
      expect(result.valid).toBe(false);
      expect(result.normalized).toBeNull();
    }
  );

  it("rejects a number starting with 0-5 (not a valid Indian mobile prefix)", () => {
    expect(validateIndianMobileNumber("5123456789").valid).toBe(false);
  });
});

describe("extractIndianMobileNumber", () => {
  it("extracts the number from free text", () => {
    const result = extractIndianMobileNumber("my number is 8380031193, please call");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("8380031193");
  });

  it("returns invalid when no valid Indian mobile number is present", () => {
    const result = extractIndianMobileNumber("call me sometime");
    expect(result.valid).toBe(false);
    expect(result.normalized).toBeNull();
  });
});
