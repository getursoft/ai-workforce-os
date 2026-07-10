import { describe, expect, it } from "vitest";
import { InvalidDomainValueError } from "../shared/domain.error";
import { Email } from "./email";

describe("Email", () => {
  it("trims and lowercases addresses for comparison", () => {
    const normalized = Email.create("  OWNER@Example.COM ");
    expect(normalized.toString()).toBe("owner@example.com");
    expect(normalized.equals(Email.create("owner@example.com"))).toBe(true);
  });

  it.each(["", "owner", "@example.com", "owner @example.com", "owner@example"])(
    "rejects invalid address %s",
    (address) => {
      expect(() => Email.create(address)).toThrow(InvalidDomainValueError);
    }
  );
});
