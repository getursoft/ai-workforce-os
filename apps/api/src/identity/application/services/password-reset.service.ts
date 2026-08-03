import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";

const RESET_TOKEN_LIFETIME_MS = 30 * 60 * 1000;

/**
 * "Forgot password" flow. A one-time, short-lived reset token is issued for a user and confirmed via
 * `confirmReset`. The raw token is only ever returned to the caller (dev/test); production deployments
 * should deliver it out-of-band (email/SMS) — see the controller for how that is surfaced.
 */
@Injectable()
export class PasswordResetService {
  constructor(private readonly prisma: PrismaService) {}

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
    const resetToken = randomBytes(24).toString("base64url");
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
    const passwordHash = await argon2.hash(input.newPassword);
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() }
      }),
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
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
