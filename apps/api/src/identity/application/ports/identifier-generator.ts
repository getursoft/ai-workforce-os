export interface IdentifierGenerator {
  generate(): string;
}

export const IDENTIFIER_GENERATOR = Symbol("IdentifierGenerator");
