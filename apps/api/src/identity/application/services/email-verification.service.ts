import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";

const VERIFICATION_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Email verification. Additive and non-blocking: it tracks `User.emailVerifiedAt` and issues/confirms
 * one-time tokens, but nothing in the authentication flow (login/register/refresh) is gated on it — this
 * sprint's spec explicitly forbids changing authentication APIs. Callers that want to enforce verification
 * (e.g. a future feature gate) can check `isVerified`.
 */
@Injectable()
export class EmailVerificationService {
  constructor(private readonly prisma: PrismaService) {}

  async issueToken(userId: string): Promise<{ token: string; email: string } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerifiedAt: true }
    });
    if (!user || user.emailVerifiedAt) return null;
    await this.prisma.emailVerificationToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() }
    });
    const token = randomBytes(24).toString("base64url");
    await this.prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(token),
        expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_LIFETIME_MS)
      }
    });
    return { token, email: user.email };
  }

  async confirm(token: string): Promise<void> {
    if (!token) throw new BadRequestException("VERIFICATION_TOKEN_INVALID");
    const candidates = await this.prisma.emailVerificationToken.findMany({
      where: { usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" }
    });
    const record = candidates.find((candidate) => this.verifyToken(token, candidate.tokenHash));
    if (!record) throw new BadRequestException("VERIFICATION_TOKEN_INVALID");
    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() }
      }),
      this.prisma.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() }
      })
    ]);
  }

  async isVerified(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerifiedAt: true }
    });
    return Boolean(user?.emailVerifiedAt);
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
