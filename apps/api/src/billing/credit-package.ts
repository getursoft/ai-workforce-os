export interface CreditPackage {
  credits: number;
  amountMinor: number;
  currency: string;
}

const PACKAGE_TIERS = [10_000, 50_000, 200_000, 500_000] as const;

/**
 * Derives credit-package pricing from the organization's own configured overage rate — never an invented
 * price. `overageRateMicrosPerCredit` is already what the org pays per credit once it exceeds its monthly
 * allowance (see BillingService.summary's `estimatedOverageAmountMinor`); a purchased top-up credit is
 * priced identically; `amountMinor` matches that same `(credits * rateMicros) / 1000` conversion.
 */
export function buildCreditPackages(overageRateMicrosPerCredit: number, currency: string): CreditPackage[] {
  return PACKAGE_TIERS.map((credits) => ({
    credits,
    amountMinor: Math.round((credits * overageRateMicrosPerCredit) / 1000),
    currency
  }));
}

/** Only a `credits` amount that exactly matches one of the published tiers may be purchased — prevents a
 *  tampered client request from requesting an arbitrary (or negative/zero) credit amount at a fabricated
 *  price. */
export function findPackageByCredits(
  packages: readonly CreditPackage[],
  credits: number
): CreditPackage | null {
  return packages.find((p) => p.credits === credits) ?? null;
}
