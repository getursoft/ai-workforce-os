import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { InvalidRefreshTokenFormatError } from "../../application/errors/security.error";
import type {
  ParsedRefreshToken,
  RefreshTokenService
} from "../../application/ports/refresh-token-service";
import { AuthenticationSessionId } from "../../domain/authentication/authentication-session-id";

const SECRET_BYTES = 32;
const BASE64URL_SECRET = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export class HmacRefreshTokenService implements RefreshTokenService {
  constructor(private readonly pepper: string) {}

  generate(sessionId: AuthenticationSessionId): string {
    return `${sessionId.toString()}.${randomBytes(SECRET_BYTES).toString("base64url")}`;
  }

  parse(rawToken: string): ParsedRefreshToken {
    const parts = rawToken.split(".");
    if (parts.length !== 2 || !BASE64URL_SECRET.test(parts[1] ?? "")) {
      throw new InvalidRefreshTokenFormatError();
    }
    try {
      return { sessionId: AuthenticationSessionId.from(parts[0] ?? "") };
    } catch {
      throw new InvalidRefreshTokenFormatError();
    }
  }

  hash(rawToken: string): string {
    this.parse(rawToken);
    return createHmac("sha256", this.pepper).update(rawToken, "utf8").digest("hex");
  }

  verifyHash(rawToken: string, storedHash: string): boolean {
    if (!SHA256_HEX.test(storedHash)) {
      return false;
    }
    try {
      const expected = Buffer.from(this.hash(rawToken), "hex");
      const actual = Buffer.from(storedHash, "hex");
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
}
