import { randomUUID } from "node:crypto";
import type { IdentifierGenerator } from "../../application/ports/identifier-generator";

export class CryptoIdentifierGenerator implements IdentifierGenerator {
  generate(): string {
    return randomUUID();
  }
}
