import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
export type KeyEnvironment = "live" | "test" | "development";
export interface ParsedApiKey {
  environment: KeyEnvironment;
  publicId: string;
  secret: string;
}
export class ApiKeyCrypto {
  constructor(private readonly pepper: string) {}
  generate(environment: KeyEnvironment) {
    const publicId = randomBytes(12).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const plaintext = `awo_${environment}_${publicId}_${secret}`;
    return {
      plaintext,
      publicId,
      secretHash: this.hash(secret),
      keyPrefix: `awo_${environment}`,
      maskedValue: `awo_${environment}_${publicId.slice(0, 4)}••••••••${secret.slice(-4)}`
    };
  }
  parse(value: string): ParsedApiKey | null {
    const match = /^awo_(live|test|development)_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/.exec(
      value
    );
    return match?.[1] && match[2] && match[3]
      ? { environment: match[1] as KeyEnvironment, publicId: match[2], secret: match[3] }
      : null;
  }
  hash(secret: string) {
    return createHmac("sha256", this.pepper).update(secret).digest("hex");
  }
  verify(secret: string, expected: string) {
    const actual = Buffer.from(this.hash(secret), "hex"),
      stored = Buffer.from(expected, "hex");
    return actual.length === stored.length && timingSafeEqual(actual, stored);
  }
}
