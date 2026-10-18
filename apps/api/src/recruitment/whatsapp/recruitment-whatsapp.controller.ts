import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../../identity/presentation/http/permission.guard";
import { RequirePermission } from "../../identity/presentation/http/permission.decorators";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import {
  normalizeInboundWhatsAppPayload,
  resolveTwilioCredentials,
  verifyTwilioSignature,
  WebhookRateLimiter
} from "../../channels/channel.runtime";
import { RecruitmentWhatsAppLinkService } from "./recruitment-whatsapp-link.service";
import { RecruitmentWhatsAppMenuService } from "./recruitment-whatsapp-menu.service";
import { RecruitmentWhatsAppSenderService } from "./recruitment-whatsapp-sender.service";
import { RecruitmentResumeService, type UploadedResumeFile } from "../recruitment-resume.service";
import { SECURITY_CONFIG, type SecurityConfig } from "../../identity/infrastructure/security/security-config";

function org(p: AuthenticatedPrincipal): string {
  return p.organizationId.toString();
}
function user(p: AuthenticatedPrincipal): string {
  return p.userId.toString();
}

interface MinimalRequest {
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}
interface MinimalResponse {
  status(code: number): MinimalResponse;
  type(type: string): MinimalResponse;
  send(body: string): void;
}

const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

/**
 * Sprint 7.16 — Recruitment's own WhatsApp surface. Deliberately a fully separate controller/route from
 * `ChannelWebhookController`/`MetaWebhookController` (apps/api/src/channels/) rather than branching
 * inside them — the sprint requires Recruitment to "remain independent of AI Receptionist", and the
 * existing webhook controllers are wired directly to the Receptionist/EmployeeRouter conversation flow.
 * This controller reuses their lower-level, already-tested primitives (Twilio signature verification,
 * inbound payload normalization, the rate limiter) without depending on any of their routing logic.
 */
@Controller("recruitment/whatsapp")
export class RecruitmentWhatsAppController {
  private readonly rateLimiter = new WebhookRateLimiter(30, 10_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly links: RecruitmentWhatsAppLinkService,
    private readonly menu: RecruitmentWhatsAppMenuService,
    private readonly sender: RecruitmentWhatsAppSenderService,
    private readonly resumes: RecruitmentResumeService,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig
  ) {}

  /** Phase 14 — real signature verification (not a stub): rejects any request that doesn't carry a valid
   * `X-Twilio-Signature` for this exact URL + form body, computed against the same credentials
   * `RecruitmentWhatsAppSenderService` sends with. */
  @Post("webhook/twilio")
  @HttpCode(200)
  async twilioWebhook(@Req() req: MinimalRequest, @Res() res: MinimalResponse): Promise<void> {
    const credentials = resolveTwilioCredentials({});
    if (!credentials) {
      res.status(200).type("text/xml").send(EMPTY_TWIML);
      return;
    }
    const signature = req.headers["x-twilio-signature"];
    const url = `${this.security.apiPublicUrl}/api/v1/recruitment/whatsapp/webhook/twilio`;
    const params = Object.fromEntries(
      Object.entries(req.body).map(([k, v]) => [k, String(v)])
    );
    const valid = verifyTwilioSignature(credentials.authToken, url, params, Array.isArray(signature) ? signature[0] : signature);
    if (!valid) {
      res.status(403).send("Invalid signature");
      return;
    }

    let normalized;
    try {
      normalized = normalizeInboundWhatsAppPayload(req.body);
    } catch {
      res.status(200).type("text/xml").send(EMPTY_TWIML);
      return;
    }

    if (!this.rateLimiter.allow(normalized.externalUserId)) {
      res.status(200).type("text/xml").send(EMPTY_TWIML);
      return;
    }

    await this.processInbound(normalized.externalUserId, normalized.providerMessageSid, normalized.body, normalized.media);
    res.status(200).type("text/xml").send(EMPTY_TWIML);
  }

  private async processInbound(
    whatsappNumber: string,
    providerMessageSid: string,
    body: string,
    media: Array<{ url: string; contentType: string }>
  ): Promise<void> {
    const authorized = await this.links.resolveAuthorizedUser(whatsappNumber);
    if (!authorized) {
      // Phase 1: "If a number is unauthorized, provide a generic access-denied/link-account response
      // without revealing recruitment information." Never says WHY (no account, revoked, wrong org…).
      await this.sender.sendText(
        whatsappNumber,
        "This WhatsApp number isn't linked to a Krevia Recruitment Consultant account. Ask your admin to link it from the website (Settings → WhatsApp)."
      );
      return;
    }
    const { organizationId, userId } = authorized;

    // Phase 13/14 dedup — a retried webhook delivery for the same MessageSid is swallowed, not
    // reprocessed (WA-022). Scoped per-conversation via the session row rather than a separate table,
    // since Twilio retries always target the same conversation.
    const session = await this.prisma.recruitmentWhatsAppSession.findUnique({ where: { whatsappNumber } });
    if (session?.lastProviderMessageId === providerMessageSid) return;

    try {
      if (media.length > 0) {
        await this.handleDocumentUpload(organizationId, userId, whatsappNumber, providerMessageSid, media[0]!);
        return;
      }
      const reply = await this.menu.handleMessage(organizationId, userId, whatsappNumber, body);
      await this.prisma.recruitmentWhatsAppSession.update({
        where: { whatsappNumber },
        data: { lastProviderMessageId: providerMessageSid }
      }).catch(() => undefined);
      await this.sender.sendText(whatsappNumber, reply.text);
    } catch (error) {
      await this.sender.sendText(whatsappNumber, "Something went wrong processing that. Type \"menu\" to start again.");
      throw error;
    }
  }

  /** Phase 4's full inbound document workflow: authenticated media retrieval, type/size enforcement
   * (delegated to RecruitmentResumeService.createBatch, which already enforces both and verifies real
   * file signatures — never trusting the declared Content-Type), then the existing durable batch
   * pipeline. Malware scanning beyond magic-byte signature verification is not configured in this
   * environment — same documented limitation as the website upload path. */
  private async handleDocumentUpload(
    organizationId: string,
    userId: string,
    whatsappNumber: string,
    providerMessageSid: string,
    mediaItem: { url: string; contentType: string }
  ): Promise<void> {
    const session = await this.prisma.recruitmentWhatsAppSession.findUnique({ where: { whatsappNumber } });
    if (!session?.currentJobId || !session.awaitingUpload) {
      await this.sender.sendText(
        whatsappNumber,
        "I received a document, but no job is selected for upload yet. Type \"jobs\", pick a job, then choose \"Upload Resumes\" before sending a document."
      );
      return;
    }
    const job = await this.prisma.recruitmentJob.findFirst({ where: { id: session.currentJobId, organizationId } });
    if (!job) {
      await this.sender.sendText(whatsappNumber, "That job is no longer available. Type \"jobs\" to pick another.");
      return;
    }

    const credentials = resolveTwilioCredentials({});
    if (!credentials) {
      await this.sender.sendText(whatsappNumber, "Document upload isn't available right now — the WhatsApp provider isn't configured.");
      return;
    }
    const mediaResponse = await fetch(mediaItem.url, {
      headers: { authorization: `Basic ${Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString("base64")}` }
    });
    if (!mediaResponse.ok) {
      await this.sender.sendText(whatsappNumber, "I couldn't download that document — please try sending it again.");
      return;
    }
    const buffer = Buffer.from(await mediaResponse.arrayBuffer());
    const file: UploadedResumeFile = {
      originalname: `whatsapp-${providerMessageSid}.${mediaItem.contentType.includes("pdf") ? "pdf" : "docx"}`,
      mimetype: mediaItem.contentType || "application/pdf",
      size: buffer.length,
      buffer
    };

    try {
      const result = await this.resumes.createBatch(organizationId, job.id, userId, [file], "WHATSAPP");
      const first = result.results[0];
      await this.prisma.recruitmentWhatsAppSession.update({
        where: { whatsappNumber },
        data: { lastProviderMessageId: providerMessageSid }
      });
      if (first?.status === "QUEUED" && first.resumeId) {
        const resume = await this.prisma.recruitmentResume.findUnique({ where: { id: first.resumeId } });
        await this.sender.sendText(
          whatsappNumber,
          await this.menu.confirmUploadQueued(job.jobCode, resume?.resumeCode ?? first.resumeId)
        );
      } else {
        await this.sender.sendText(whatsappNumber, `That document couldn't be accepted: ${first?.error ?? "unknown error"}. Please try a different file.`);
      }
    } catch (error) {
      await this.sender.sendText(whatsappNumber, "That document couldn't be processed. Please confirm it's a PDF or DOCX file and try again.");
      throw error;
    }
  }

  // --- Website-facing linking endpoints (Phase 1) ------------------------------------------------------

  @ApiTags("Recruitment")
  @ApiBearerAuth()
  @UseGuards(JwtAccessGuard, PermissionGuard)
  @Post("link/initiate")
  @RequirePermission("recruitment.whatsapp.link")
  async initiateLink(@CurrentPrincipal() p: AuthenticatedPrincipal, @Body() body: { whatsappNumber?: string }) {
    if (!body.whatsappNumber) throw new BadRequestException("RECRUITMENT_WHATSAPP_NUMBER_REQUIRED");
    return this.links.initiateLink(org(p), user(p), body.whatsappNumber);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAccessGuard, PermissionGuard)
  @Post("link/confirm")
  @RequirePermission("recruitment.whatsapp.link")
  async confirmLink(@CurrentPrincipal() p: AuthenticatedPrincipal, @Body() body: { whatsappNumber?: string; code?: string }) {
    if (!body.whatsappNumber || !body.code) throw new BadRequestException("RECRUITMENT_WHATSAPP_CONFIRM_FIELDS_REQUIRED");
    await this.links.confirmLink(org(p), user(p), body.whatsappNumber, body.code);
    return { linked: true };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAccessGuard, PermissionGuard)
  @Get("links")
  @RequirePermission("recruitment.whatsapp.link")
  listLinks(@CurrentPrincipal() p: AuthenticatedPrincipal) {
    return this.links.listLinks(org(p), user(p));
  }

  @ApiBearerAuth()
  @UseGuards(JwtAccessGuard, PermissionGuard)
  @Delete("links/:linkId")
  @RequirePermission("recruitment.whatsapp.link")
  async revokeLink(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("linkId", new ParseUUIDPipe()) linkId: string) {
    await this.links.revokeLink(org(p), linkId, user(p));
    return { revoked: true };
  }
}
