import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { normalizeWhatsAppAddress } from "../../channels/channel.runtime";
import { RecruitmentWhatsAppSenderService } from "./recruitment-whatsapp-sender.service";

const OTP_DIGITS = 6;
const OTP_MAX_EXCLUSIVE = 10 ** OTP_DIGITS;
const OTP_EXPIRY_MINUTES = 10;
const MAX_VERIFICATION_ATTEMPTS = 5;

function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/**
 * Sprint 7.16 (Phase 1) — proves possession of a WhatsApp number before it can ever reach the
 * Recruitment Consultant. A phone number appearing inside a candidate's resume text is NEVER sufficient
 * for access on its own (explicit sprint requirement) — the only path to a VERIFIED link is this
 * out-of-band OTP flow, initiated from an already-authenticated website session and confirmed by
 * demonstrating receipt of a code sent to the WhatsApp number itself.
 */
@Injectable()
export class RecruitmentWhatsAppLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: RecruitmentWhatsAppSenderService
  ) {}

  /** Step 1 — called from an authenticated website session only (RequirePermission at the controller
   * layer). Generates a fresh OTP, replacing any still-pending attempt for this user. */
  async initiateLink(organizationId: string, userId: string, rawNumber: string): Promise<{ expiresInSeconds: number }> {
    const { externalUserId } = normalizeWhatsAppAddress(rawNumber);
    const code = randomInt(0, OTP_MAX_EXCLUSIVE).toString().padStart(OTP_DIGITS, "0");
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60_000);

    // No DB-level unique constraint models "one pending link per user+number" (only the id is unique),
    // so this is a plain find-then-create/update rather than a Prisma upsert.
    const existingPending = await this.prisma.recruitmentWhatsAppLink.findFirst({
      where: { organizationId, userId, whatsappNumber: externalUserId, status: "PENDING_VERIFICATION" }
    });
    if (existingPending) {
      await this.prisma.recruitmentWhatsAppLink.update({
        where: { id: existingPending.id },
        data: { verificationCodeHash: hashCode(code), verificationExpiresAt: expiresAt, verificationAttempts: 0 }
      });
    } else {
      await this.prisma.recruitmentWhatsAppLink.create({
        data: {
          organizationId,
          userId,
          whatsappNumber: externalUserId,
          status: "PENDING_VERIFICATION",
          verificationCodeHash: hashCode(code),
          verificationExpiresAt: expiresAt,
          verificationAttempts: 0
        }
      });
    }

    await this.sender.sendText(
      externalUserId,
      `Your Krevia Recruitment Consultant verification code is ${code}. It expires in ${OTP_EXPIRY_MINUTES} minutes. Never share this code.`
    );
    return { expiresInSeconds: OTP_EXPIRY_MINUTES * 60 };
  }

  /** Step 2 — confirms the code the user received on WhatsApp, entered back on the authenticated
   * website. Rate-limited per link row (MAX_VERIFICATION_ATTEMPTS) so OTP guessing can't be brute-forced. */
  async confirmLink(organizationId: string, userId: string, rawNumber: string, code: string): Promise<void> {
    const { externalUserId } = normalizeWhatsAppAddress(rawNumber);
    const link = await this.prisma.recruitmentWhatsAppLink.findFirst({
      where: { organizationId, userId, whatsappNumber: externalUserId, status: "PENDING_VERIFICATION" },
      orderBy: { createdAt: "desc" }
    });
    if (!link || !link.verificationCodeHash || !link.verificationExpiresAt) {
      throw new NotFoundException("RECRUITMENT_WHATSAPP_LINK_NOT_FOUND");
    }
    if (link.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
      throw new ForbiddenException("RECRUITMENT_WHATSAPP_LINK_TOO_MANY_ATTEMPTS");
    }
    if (link.verificationExpiresAt.getTime() < Date.now()) {
      await this.prisma.recruitmentWhatsAppLink.update({ where: { id: link.id }, data: { status: "EXPIRED" } });
      throw new BadRequestException("RECRUITMENT_WHATSAPP_LINK_EXPIRED");
    }
    const expected = Buffer.from(link.verificationCodeHash, "hex");
    const actual = Buffer.from(hashCode(code.trim()), "hex");
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!matches) {
      await this.prisma.recruitmentWhatsAppLink.update({
        where: { id: link.id },
        data: { verificationAttempts: { increment: 1 } }
      });
      throw new BadRequestException("RECRUITMENT_WHATSAPP_LINK_CODE_INVALID");
    }
    // Revoke any other VERIFIED link for this number within the org (a number belongs to one user at a
    // time) before promoting this one — keeps the partial-uniqueness invariant true without a DB-level
    // partial unique index, which Prisma's schema DSL can't express directly here.
    await this.prisma.recruitmentWhatsAppLink.updateMany({
      where: { organizationId, whatsappNumber: externalUserId, status: "VERIFIED" },
      data: { status: "REVOKED", revokedAt: new Date() }
    });
    await this.prisma.recruitmentWhatsAppLink.update({
      where: { id: link.id },
      data: { status: "VERIFIED", linkedAt: new Date(), verificationCodeHash: null, verificationExpiresAt: null }
    });
  }

  async revokeLink(organizationId: string, linkId: string, revokedByUserId: string): Promise<void> {
    const link = await this.prisma.recruitmentWhatsAppLink.findFirst({ where: { id: linkId, organizationId } });
    if (!link) throw new NotFoundException("RECRUITMENT_WHATSAPP_LINK_NOT_FOUND");
    await this.prisma.recruitmentWhatsAppLink.update({
      where: { id: linkId },
      data: { status: "REVOKED", revokedAt: new Date(), revokedByUserId }
    });
  }

  async listLinks(organizationId: string, userId: string) {
    return this.prisma.recruitmentWhatsAppLink.findMany({
      where: { organizationId, userId },
      orderBy: { createdAt: "desc" }
    });
  }

  /** Phase 1's core authorization check, called on EVERY inbound WhatsApp message — never cached beyond
   * the request, never trusted from session state alone (Phase 3: "Never rely solely on the stored
   * conversation context for authorization"). A number with no VERIFIED link resolves to null, which the
   * webhook handler turns into a generic access-denied reply that reveals nothing about recruitment data. */
  async resolveAuthorizedUser(rawNumber: string): Promise<{ organizationId: string; userId: string; linkId: string } | null> {
    const { externalUserId } = normalizeWhatsAppAddress(rawNumber);
    const link = await this.prisma.recruitmentWhatsAppLink.findFirst({
      where: { whatsappNumber: externalUserId, status: "VERIFIED" }
    });
    if (!link) return null;
    await this.prisma.recruitmentWhatsAppLink.update({ where: { id: link.id }, data: { lastUsedAt: new Date() } });
    return { organizationId: link.organizationId, userId: link.userId, linkId: link.id };
  }
}
