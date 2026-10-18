import { Injectable, Logger } from "@nestjs/common";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { MockSmsProvider } from "../interaction/sms/mock-sms.provider";
import { TwilioSmsProvider } from "../interaction/sms/twilio-sms.provider";
import { EmailService, EmailNotConfiguredError } from "../notifications/email.service";
import { extractPhoneNumber } from "../conversation/conversation-completion";

const OTP_DIGITS = 6;
const OTP_MAX_EXCLUSIVE = 10 ** OTP_DIGITS;
const OTP_EXPIRY_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function maskContact(method: "PHONE" | "EMAIL", value: string): string {
  if (method === "EMAIL") {
    const [user, domain] = value.split("@");
    if (!user || !domain) return "your contact";
    return `${user.slice(0, 2)}***@${domain}`;
  }
  const last4 = value.slice(-4);
  return `${"*".repeat(Math.max(value.length - 4, 0))}${last4}`;
}

export interface VerificationTurnResult {
  /** True when this turn was consumed by the verification flow (welcome/contact/OTP exchange) and the
   *  caller must NOT proceed to the normal chat/tool pipeline this turn. False once already VERIFIED. */
  handled: boolean;
  reply?: string;
}

/**
 * Sprint 7.17 follow-up (2026-10-18) — identity verification gate for the dashboard/iOS chat tools.
 * Recruitment Consultant is an internal org tool, not a general-purpose assistant: before a Krevia user's
 * first message to it does anything real, they must verify a phone number or email via a one-time code —
 * the same "prove possession, never trust the claim alone" principle RecruitmentWhatsAppLinkService
 * already applies to the WhatsApp surface. Scoped to one (organization, user, employee installation); once
 * VERIFIED it stays verified for that user across every future conversation (revocable by an admin via
 * `revoke()`, not re-asked every time).
 */
@Injectable()
export class RecruitmentChatIdentityVerificationService {
  private readonly logger = new Logger(RecruitmentChatIdentityVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mockSms: MockSmsProvider,
    private readonly twilioSms: TwilioSmsProvider,
    private readonly email: EmailService
  ) {}

  private get smsProvider() {
    return this.twilioSms.isConfigured() ? this.twilioSms : this.mockSms;
  }

  async isVerified(organizationId: string, userId: string, pluginInstallationId: string): Promise<boolean> {
    const row = await this.prisma.recruitmentChatIdentityVerification.findUnique({
      where: { organizationId_userId_pluginInstallationId: { organizationId, userId, pluginInstallationId } }
    });
    return row?.status === "VERIFIED";
  }

  async handleTurn(
    organizationId: string,
    userId: string,
    pluginInstallationId: string,
    text: string
  ): Promise<VerificationTurnResult> {
    const { row, isNew } = await this.getOrCreate(organizationId, userId, pluginInstallationId);
    if (row.status === "VERIFIED") return { handled: false };

    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    const welcomeReply =
      "Welcome to the Krevia Recruitment team! \u{1F44B}\n\n" +
      "This is an internal tool, not a public application — for your security, please share your " +
      "mobile number or email address so I can verify it's really you before we continue.";

    if (row.status === "PENDING_CONTACT") {
      const email = EMAIL_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
      const phone = !email ? extractPhoneNumber(trimmed) : null;
      if (email || phone) return this.sendOtp(row.id, email ? "EMAIL" : "PHONE", email ?? phone!);
      // A brand-new user's very first message (however they phrased it, e.g. a plain "Hi") gets the
      // welcome prompt rather than being told their greeting "isn't a phone number" — only a REPEATED
      // unparseable reply (meaning they already saw the welcome once) gets the stricter error.
      if (isNew || !trimmed) return { handled: true, reply: welcomeReply };
      return {
        handled: true,
        reply:
          "I didn't recognize that as a mobile number or email address. Please share your mobile " +
          "number (with country code) or your email address to verify your identity."
      };
    }

    // PENDING_OTP
    if (["resend", "resend code", "send again"].includes(lower)) {
      if (!row.contactMethod || !row.contactValue)
        return { handled: true, reply: "Something went wrong — please share your mobile number or email again." };
      return this.sendOtp(row.id, row.contactMethod as "PHONE" | "EMAIL", row.contactValue);
    }
    if (!row.otpHash || !row.otpExpiresAt)
      return { handled: true, reply: "Something went wrong — please share your mobile number or email again." };
    if (row.otpAttempts >= MAX_OTP_ATTEMPTS) {
      return {
        handled: true,
        reply: "Too many incorrect attempts. Please contact an administrator to verify your access."
      };
    }
    if (row.otpExpiresAt.getTime() < Date.now()) {
      await this.prisma.recruitmentChatIdentityVerification.update({
        where: { id: row.id },
        data: { status: "PENDING_CONTACT", otpHash: null, otpExpiresAt: null, otpAttempts: 0 }
      });
      return {
        handled: true,
        reply: "That code expired. Please share your mobile number or email again to get a new one."
      };
    }
    const code = trimmed.replace(/[\s-]/g, "");
    const expected = Buffer.from(row.otpHash, "hex");
    const actual = Buffer.from(hashCode(code), "hex");
    const matches = /^\d{6}$/.test(code) && expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!matches) {
      await this.prisma.recruitmentChatIdentityVerification.update({
        where: { id: row.id },
        data: { otpAttempts: { increment: 1 } }
      });
      return {
        handled: true,
        reply: `That code wasn't right. Please try again (${MAX_OTP_ATTEMPTS - row.otpAttempts - 1} attempts left), or type "resend" for a new code.`
      };
    }
    await this.prisma.recruitmentChatIdentityVerification.update({
      where: { id: row.id },
      data: { status: "VERIFIED", verifiedAt: new Date(), otpHash: null, otpExpiresAt: null, otpAttempts: 0 }
    });
    return {
      handled: true,
      reply: "You're verified! ✅ How can I help you today — job openings, candidates, or uploading a resume?"
    };
  }

  async revoke(organizationId: string, userId: string, pluginInstallationId: string, revokedByUserId: string): Promise<void> {
    await this.prisma.recruitmentChatIdentityVerification.updateMany({
      where: { organizationId, userId, pluginInstallationId },
      data: { status: "PENDING_CONTACT", verifiedAt: null, revokedAt: new Date(), revokedByUserId }
    });
  }

  private async getOrCreate(organizationId: string, userId: string, pluginInstallationId: string) {
    const existing = await this.prisma.recruitmentChatIdentityVerification.findUnique({
      where: { organizationId_userId_pluginInstallationId: { organizationId, userId, pluginInstallationId } }
    });
    if (existing) return { row: existing, isNew: false };
    const created = await this.prisma.recruitmentChatIdentityVerification.create({
      data: { organizationId, userId, pluginInstallationId }
    });
    return { row: created, isNew: true };
  }

  private async sendOtp(
    verificationId: string,
    method: "PHONE" | "EMAIL",
    value: string
  ): Promise<VerificationTurnResult> {
    const code = randomInt(0, OTP_MAX_EXCLUSIVE).toString().padStart(OTP_DIGITS, "0");
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60_000);
    await this.prisma.recruitmentChatIdentityVerification.update({
      where: { id: verificationId },
      data: {
        status: "PENDING_OTP",
        contactMethod: method,
        contactValue: value,
        otpHash: hashCode(code),
        otpExpiresAt: expiresAt,
        otpAttempts: 0
      }
    });
    const message = `Your Krevia Recruitment Consultant verification code is ${code}. It expires in ${OTP_EXPIRY_MINUTES} minutes. Never share this code.`;
    // Visible ONLY while no real SMS provider is configured — i.e. only ever alongside a fake,
    // never-delivered mock send, never a real Twilio dispatch. Lets manual/Playwright QA complete the
    // real conversational flow against a live dev server without a live telecom credential.
    if (method === "PHONE" && !this.twilioSms.isConfigured()) {
      this.logger.debug({ event: "RECRUITMENT_CHAT_OTP_CODE_DEV_ONLY_MOCK_SMS", to: maskContact(method, value), code });
    }
    try {
      if (method === "PHONE") {
        await this.smsProvider.send({ to: value, message });
      } else {
        await this.email.sendMail({ to: value, subject: "Your Krevia Recruitment verification code", text: message });
      }
    } catch (error) {
      // Never block the conversation on a delivery failure the user can't do anything about — they can
      // always type "resend". Email specifically degrades silently when SMTP isn't configured in this
      // environment (same contract as every other EmailService caller).
      if (!(error instanceof EmailNotConfiguredError)) {
        this.logger.warn({ event: "RECRUITMENT_CHAT_OTP_SEND_FAILED", method, error: String(error) });
      }
    }
    return {
      handled: true,
      reply: `I've sent a 6-digit verification code to ${maskContact(method, value)}. Please enter it here to continue.`
    };
  }
}
