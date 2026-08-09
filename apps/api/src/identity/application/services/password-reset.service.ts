import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { PASSWORD_HASHER, type PasswordHasher } from "../ports/password-hasher";

const RESET_TOKEN_LIFETIME_MS = 30 * 60 * 1000;
export const RESET_TOKEN_LIFETIME_MINUTES = RESET_TOKEN_LIFETIME_MS / 60_000;
/** 8-digit numeric OTP: easy to read/type from an email, unlike the previous long opaque token.
 *  100,000,000 possible values; combined with 30-minute expiry, one-time use, and the existing
 *  AUTH_STRICT rate limit on /reset-password, this matches the security posture of mainstream
 *  numeric-OTP email/SMS reset flows (e.g. 6–8 digit codes are industry-standard for this exact
 *  threat model — the code is worthless after one guess-limited window, not a long-lived secret). */
const OTP_DIGITS = 8;
const OTP_MAX_EXCLUSIVE = 10 ** OTP_DIGITS;

/**
 * "Forgot password" flow. A one-time, short-lived 8-digit reset code is issued for a user and
 * confirmed via `confirmReset`. The raw code is only ever returned to the caller (dev/test);
 * production deployments should deliver it out-of-band (email/SMS) — see the controller for how
 * that is surfaced.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: PasswordHasher
  ) {}

  /** Issues a reset token for the account with `email`. Never reveals whether the account exists. */
  async requestReset(email: string): Promise<{ resetToken: string; email: string }> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { normalizedEmail, deletedAt: null, status: "ACTIVE" },
      select: { id: true }
    });
    if (!user) {
      // Do not reveal account existence — the caller receives an empty token either way.
      return { resetToken: "", email: normalizedEmail };
    }
    // Revoke any previously issued, still-valid tokens for this user.
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() }
    });
    const resetToken = randomInt(0, OTP_MAX_EXCLUSIVE).toString().padStart(OTP_DIGITS, "0");
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(resetToken),
        expiresAt: new Date(Date.now() + RESET_TOKEN_LIFETIME_MS)
      }
    });
    return { resetToken, email: normalizedEmail };
  }

  /** Validates a reset token and sets a new password, revoking the user's active sessions. */
  async confirmReset(input: { email: string; token: string; newPassword: string }): Promise<void> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { normalizedEmail, deletedAt: null },
      select: { id: true }
    });
    if (!user || !input.token) throw new BadRequestException("RESET_TOKEN_INVALID");
    const record = await this.prisma.passwordResetToken.findFirst({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" }
    });
    if (!record || !this.verifyToken(input.token, record.tokenHash)) {
      throw new BadRequestException("RESET_TOKEN_INVALID");
    }
    const passwordHash = await this.passwordHasher.hash(input.newPassword);
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() }
      }),
      // Also revokes any other still-active reset tokens for this user (Phase 4: previous tokens are
      // invalidated once a new request/confirmation happens) and clears the account-lockout counters —
      // a successful reset proves account ownership, so a stale lockout must not block the next login.
      this.prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null, id: { not: record.id } },
        data: { usedAt: new Date() }
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null }
      }),
      this.prisma.authenticationSession.deleteMany({ where: { userId: user.id } })
    ]);
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  private verifyToken(token: string, storedHash: string): boolean {
    const expected = Buffer.from(this.hashToken(token), "hex");
    const actual = Buffer.from(storedHash, "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
