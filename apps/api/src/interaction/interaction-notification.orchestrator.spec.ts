import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config/config.tokens";
import { EmailNotConfiguredError, type EmailService } from "../notifications/email.service";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { InteractionMetricsService } from "./interaction-metrics.service";
import { InteractionNotificationOrchestrator } from "./interaction-notification.orchestrator";
import { MockSmsProvider } from "./sms/mock-sms.provider";
import type { TwilioSmsProvider } from "./sms/twilio-sms.provider";
import type { WhatsAppSender } from "./whatsapp-sender.types";

function enabledConfig(overrides: Record<string, boolean> = {}): AppConfig {
  return {
    boolean: (name: string, fallback?: boolean) => (name in overrides ? overrides[name] : (fallback ?? true)),
    number: (_: string, fallback?: number) => fallback ?? 0,
    string: (_: string, fallback?: string) => fallback ?? ""
  } as unknown as AppConfig;
}

function baseInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: "interaction-1",
    organizationId: "org-1",
    referenceId: "KRV-842731",
    conversationId: "conversation-1",
    channel: "WHATSAPP",
    transport: null,
    externalUserId: "+14155551234",
    phoneNumber: null,
    email: null,
    ...overrides
  };
}

function buildHarness(overrides: {
  interaction?: Record<string, unknown>;
  config?: Record<string, boolean>;
  existingNotification?: unknown;
  emailSend?: () => Promise<{ messageId: string }>;
  // Phase 5.3 — defaults to ACTIVE so none of the pre-existing tests below are affected.
  organizationStatus?: string;
}) {
  const interaction = baseInteraction(overrides.interaction);
  const findFirst = vi.fn().mockResolvedValue(interaction);
  const findUnique = vi.fn().mockResolvedValue({ id: "org-1", name: "Krevia", status: overrides.organizationStatus ?? "ACTIVE" });
  const notificationFindFirst = vi.fn().mockResolvedValue(overrides.existingNotification ?? null);
  const notificationCreate = vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "notification-1", ...data }));
  const notificationUpdate = vi.fn().mockResolvedValue({});
  const prisma = {
    interaction: { findFirst },
    organization: { findUnique },
    interactionNotification: { findFirst: notificationFindFirst, create: notificationCreate, update: notificationUpdate }
  } as unknown as PrismaService;

  const email = { sendMail: overrides.emailSend ?? vi.fn().mockResolvedValue({ messageId: "email-1" }) } as unknown as EmailService;
  const mockSms = new MockSmsProvider();
  const twilioSms = { isConfigured: () => false, name: "twilio", send: vi.fn() } as unknown as TwilioSmsProvider;
  const channelProcessor = {
    sendHumanMessage: vi.fn().mockResolvedValue({ delivered: true, channelMessageId: "channel-message-1" })
  } as unknown as WhatsAppSender;
  const metrics = new InteractionMetricsService();

  const orchestrator = new InteractionNotificationOrchestrator(
    prisma,
    enabledConfig(overrides.config),
    email,
    mockSms,
    twilioSms,
    metrics,
    undefined,
    channelProcessor
  );
  return { orchestrator, prisma, email, mockSms, twilioSms, channelProcessor, metrics, notificationUpdate, notificationCreate };
}

describe("InteractionNotificationOrchestrator (Sprint 7.12 STEP 13)", () => {
  it("sends a WhatsApp reference through the existing ChannelMessageProcessor pipeline", async () => {
    const h = buildHarness({});
    await h.orchestrator.notifyReferenceIssued("org-1", "interaction-1");
    expect(h.channelProcessor.sendHumanMessage).toHaveBeenCalledWith("org-1", "conversation-1", expect.stringContaining("KRV-842731"));
    expect(h.notificationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SENT" }) })
    );
  });

  it("sends email when an email address is known", async () => {
    const h = buildHarness({ interaction: { channel: "WEB_CHAT", externalUserId: null, email: "traveler@example.com" } });
    await h.orchestrator.notifyReferenceIssued("org-1", "interaction-1");
    expect(h.email.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "traveler@example.com", subject: expect.stringContaining("KRV-842731") })
    );
  });

  it("falls back to SMS when there is a phone number but no WhatsApp identity", async () => {
    const h = buildHarness({ interaction: { channel: "VOICE", externalUserId: null, phoneNumber: "+14155551234" } });
    const sendSpy = vi.spyOn(h.mockSms, "send");
    await h.orchestrator.notifyReferenceIssued("org-1", "interaction-1");
    expect(sendSpy).toHaveBeenCalledWith({ to: "+14155551234", message: expect.stringContaining("KRV-842731") });
  });

  it("records SKIPPED, not FAILED, when there is no destination for the only applicable channel", async () => {
    const h = buildHarness({ interaction: { channel: "VOICE", externalUserId: null, phoneNumber: null, email: null } });
    await h.orchestrator.notifyReferenceIssued("org-1", "interaction-1");
    expect(h.notificationCreate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PENDING" }) }));
  });

  it("marks email FAILED (not thrown) when SMTP is not configured — never blocks the caller", async () => {
    const h = buildHarness({
      interaction: { channel: "WEB_CHAT", externalUserId: null, email: "traveler@example.com" },
      emailSend: () => Promise.reject(new EmailNotConfiguredError())
    });
    await expect(h.orchestrator.notifyReferenceIssued("org-1", "interaction-1")).resolves.toBeUndefined();
    expect(h.notificationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", failureReason: "EMAIL_NOT_CONFIGURED" }) })
    );
  });

  it("retries a transient SMS failure once, then succeeds (STEP 32)", async () => {
    const h = buildHarness({ interaction: { channel: "VOICE", externalUserId: null, phoneNumber: "+14155551234" } });
    h.mockSms.simulateNextFailure("transient");
    await h.orchestrator.notifyReferenceIssued("org-1", "interaction-1");
    expect(h.notificationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SENT" }) })
    );
  });

  it("never sends the same channel twice for one interaction (STEP 31 dedup)", async () => {
    const h = buildHarness({
      interaction: { channel: "WEB_CHAT", externalUserId: null, email: "traveler@example.com" },
      existingNotification: { id: "existing", status: "SENT" }
    });
    await h.orchestrator.notifyReferenceIssued("org-1", "interaction-1");
    expect(h.email.sendMail).not.toHaveBeenCalled();
    expect(h.notificationCreate).not.toHaveBeenCalled();
  });

  it("does nothing when REFERENCE_NOTIFICATION_ENABLED is false", async () => {
    const h = buildHarness({ config: { REFERENCE_NOTIFICATION_ENABLED: false } });
    await h.orchestrator.notifyReferenceIssued("org-1", "interaction-1");
    expect(h.channelProcessor.sendHumanMessage).not.toHaveBeenCalled();
  });

  // --- Phase 5.3 — background worker suspension audit ---------------------------------------------------

  it("sends no real WhatsApp/email notification for a suspended organization — this runs via the NOTIFICATION_JOBS queue, with no HTTP request and no JwtAccessGuard at all", async () => {
    const h = buildHarness({
      organizationStatus: "SUSPENDED",
      interaction: { channel: "WEB_CHAT", externalUserId: null, email: "traveler@example.com" }
    });
    await h.orchestrator.notifyReferenceIssued("org-1", "interaction-1");
    expect(h.channelProcessor.sendHumanMessage).not.toHaveBeenCalled();
    expect(h.email.sendMail).not.toHaveBeenCalled();
    expect(h.notificationCreate).not.toHaveBeenCalled();
  });
});
