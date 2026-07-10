import { InvalidEntityStateError, InvalidStateTransitionError } from "../shared/domain.error";
import { requireValidDate } from "../shared/validation";
import type { UserId } from "../user/user-id";
import type { AuthenticationSessionId } from "./authentication-session-id";
import type { TokenFamilyId } from "./token-family-id";

export interface CreateAuthenticationSession {
  id: AuthenticationSessionId;
  userId: UserId;
  tokenHash: string;
  tokenFamilyId: TokenFamilyId;
  expiresAt: Date;
  lastUsedAt?: Date;
  ipAddress?: string;
  userAgent?: string;
  now?: Date;
}

export interface ReconstructedAuthenticationSession {
  id: AuthenticationSessionId;
  userId: UserId;
  tokenHash: string;
  tokenFamilyId: TokenFamilyId;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBySessionId: AuthenticationSessionId | null;
  lastUsedAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export class AuthenticationSession {
  readonly #tokenHash: string;
  #revokedAt: Date | null;
  #replacedBySessionId: AuthenticationSessionId | null;

  private constructor(
    readonly id: AuthenticationSessionId,
    readonly userId: UserId,
    tokenHash: string,
    readonly tokenFamilyId: TokenFamilyId,
    readonly expiresAt: Date,
    revokedAt: Date | null,
    replacedBySessionId: AuthenticationSessionId | null,
    readonly lastUsedAt: Date | null,
    readonly ipAddress: string | null,
    readonly userAgent: string | null,
    readonly createdAt: Date
  ) {
    this.#tokenHash = tokenHash;
    this.#revokedAt = revokedAt;
    this.#replacedBySessionId = replacedBySessionId;
  }

  static create(properties: CreateAuthenticationSession): AuthenticationSession {
    const createdAt = requireValidDate(properties.now ?? new Date(), "createdAt");
    const expiresAt = requireValidDate(properties.expiresAt, "expiresAt");
    const tokenHash = AuthenticationSession.requireBoundedText(
      properties.tokenHash,
      "tokenHash",
      128
    );
    const lastUsedAt = properties.lastUsedAt
      ? requireValidDate(properties.lastUsedAt, "lastUsedAt")
      : null;
    AuthenticationSession.assertExpiry(createdAt, expiresAt);
    return new AuthenticationSession(
      properties.id,
      properties.userId,
      tokenHash,
      properties.tokenFamilyId,
      expiresAt,
      null,
      null,
      lastUsedAt,
      AuthenticationSession.normalizeOptionalText(properties.ipAddress, "ipAddress", 64),
      AuthenticationSession.normalizeOptionalText(properties.userAgent, "userAgent", 512),
      createdAt
    );
  }

  static reconstruct(properties: ReconstructedAuthenticationSession): AuthenticationSession {
    const createdAt = requireValidDate(properties.createdAt, "createdAt");
    const expiresAt = requireValidDate(properties.expiresAt, "expiresAt");
    const tokenHash = AuthenticationSession.requireBoundedText(
      properties.tokenHash,
      "tokenHash",
      128
    );
    AuthenticationSession.assertExpiry(createdAt, expiresAt);
    const revokedAt = properties.revokedAt
      ? requireValidDate(properties.revokedAt, "revokedAt")
      : null;
    const lastUsedAt = properties.lastUsedAt
      ? requireValidDate(properties.lastUsedAt, "lastUsedAt")
      : null;
    if (revokedAt && revokedAt.getTime() < createdAt.getTime()) {
      throw new InvalidEntityStateError(
        "AuthenticationSession",
        "revokedAt cannot precede createdAt"
      );
    }
    if (properties.replacedBySessionId && !revokedAt) {
      throw new InvalidEntityStateError(
        "AuthenticationSession",
        "A rotated session must also be revoked"
      );
    }
    if (properties.replacedBySessionId?.equals(properties.id)) {
      throw new InvalidEntityStateError("AuthenticationSession", "A session cannot replace itself");
    }
    return new AuthenticationSession(
      properties.id,
      properties.userId,
      tokenHash,
      properties.tokenFamilyId,
      expiresAt,
      revokedAt,
      properties.replacedBySessionId,
      lastUsedAt,
      AuthenticationSession.normalizeNullableText(properties.ipAddress, "ipAddress", 64),
      AuthenticationSession.normalizeNullableText(properties.userAgent, "userAgent", 512),
      createdAt
    );
  }

  get revokedAt(): Date | null {
    return this.#revokedAt ? new Date(this.#revokedAt) : null;
  }

  get replacedBySessionId(): AuthenticationSessionId | null {
    return this.#replacedBySessionId;
  }

  tokenHashForPersistence(): string {
    return this.#tokenHash;
  }

  isExpired(at = new Date()): boolean {
    return this.expiresAt.getTime() <= requireValidDate(at, "comparisonDate").getTime();
  }

  isRevoked(): boolean {
    return this.#revokedAt !== null;
  }

  isRotated(): boolean {
    return this.#replacedBySessionId !== null;
  }

  revoke(at = new Date()): void {
    this.assertCanTransition(at);
    this.#revokedAt = requireValidDate(at, "revokedAt");
  }

  replaceWith(replacementId: AuthenticationSessionId, at = new Date()): void {
    this.assertCanTransition(at);
    if (replacementId.equals(this.id)) {
      throw new InvalidStateTransitionError(
        "AuthenticationSession",
        "A session cannot replace itself"
      );
    }
    this.#revokedAt = requireValidDate(at, "revokedAt");
    this.#replacedBySessionId = replacementId;
  }

  private assertCanTransition(at: Date): void {
    const transitionAt = requireValidDate(at, "transitionAt");
    if (this.isRevoked()) {
      throw new InvalidStateTransitionError(
        "AuthenticationSession",
        "A revoked session cannot transition again"
      );
    }
    if (transitionAt.getTime() < this.createdAt.getTime()) {
      throw new InvalidStateTransitionError(
        "AuthenticationSession",
        "A session transition cannot precede creation"
      );
    }
    if (this.isExpired(transitionAt)) {
      throw new InvalidStateTransitionError(
        "AuthenticationSession",
        "An expired session cannot transition"
      );
    }
  }

  private static assertExpiry(createdAt: Date, expiresAt: Date): void {
    if (expiresAt.getTime() <= createdAt.getTime()) {
      throw new InvalidEntityStateError(
        "AuthenticationSession",
        "expiresAt must be later than createdAt"
      );
    }
  }

  private static requireBoundedText(value: string, field: string, maximum: number): string {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > maximum) {
      throw new InvalidEntityStateError(
        "AuthenticationSession",
        `${field} must contain between 1 and ${maximum} characters`
      );
    }
    return normalized;
  }

  private static normalizeOptionalText(
    value: string | undefined,
    field: string,
    maximum: number
  ): string | null {
    return value === undefined
      ? null
      : AuthenticationSession.normalizeNullableText(value, field, maximum);
  }

  private static normalizeNullableText(
    value: string | null,
    field: string,
    maximum: number
  ): string | null {
    if (value === null) {
      return null;
    }
    const normalized = value.trim();
    if (normalized.length === 0) {
      return null;
    }
    if (normalized.length > maximum) {
      throw new InvalidEntityStateError(
        "AuthenticationSession",
        `${field} cannot exceed ${maximum} characters`
      );
    }
    return normalized;
  }
}
