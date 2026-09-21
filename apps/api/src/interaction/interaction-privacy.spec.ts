import { describe, expect, it } from "vitest";
import { maskEmail, maskPhone } from "./interaction-privacy";

describe("maskPhone (Sprint 7.12 STEP 30)", () => {
  it("keeps the country code and last 4 digits visible, masks the middle", () => {
    expect(maskPhone("+919876541193")).toBe("+91******1193");
  });
  it("falls back to a generic mask for a non-E.164-shaped value", () => {
    expect(maskPhone("12345")).toBe("*2345");
  });
});

describe("maskEmail (Sprint 7.12 STEP 30)", () => {
  it("keeps the first 2 local-part characters and the domain visible", () => {
    expect(maskEmail("krishna@example.com")).toBe("kr*****@example.com");
  });
  it("handles a short local part gracefully", () => {
    expect(maskEmail("ab@example.com")).toBe("ab***@example.com");
  });
});
