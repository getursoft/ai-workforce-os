import { describe, expect, it } from "vitest";
import { buildCreditPackages, findPackageByCredits } from "./credit-package";

describe("buildCreditPackages", () => {
  it("derives package price from the org's own overage rate — never an invented number", () => {
    // rate 1000 micros/credit == 1 paisa/credit (see BillingService.summary's identical /1000 conversion).
    const packages = buildCreditPackages(1000, "INR");
    expect(packages).toEqual([
      { credits: 10_000, amountMinor: 10_000, currency: "INR" },
      { credits: 50_000, amountMinor: 50_000, currency: "INR" },
      { credits: 200_000, amountMinor: 200_000, currency: "INR" },
      { credits: 500_000, amountMinor: 500_000, currency: "INR" }
    ]);
  });

  it("scales linearly with a different configured rate", () => {
    const packages = buildCreditPackages(2500, "INR");
    expect(packages[0]).toEqual({ credits: 10_000, amountMinor: 25_000, currency: "INR" });
  });
});

describe("findPackageByCredits", () => {
  const packages = buildCreditPackages(1000, "INR");

  it("finds the exact tier", () => {
    expect(findPackageByCredits(packages, 50_000)?.amountMinor).toBe(50_000);
  });

  it("returns null for a non-tier amount — never lets a client dictate an arbitrary price", () => {
    expect(findPackageByCredits(packages, 1)).toBeNull();
    expect(findPackageByCredits(packages, 49_999)).toBeNull();
    expect(findPackageByCredits(packages, -10_000)).toBeNull();
  });
});
