import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../infrastructure/prisma/prisma.service";
import type { PluginSecretsEncryptionService } from "../../plugins/plugin.runtime";
import { EmailNotConfiguredError, type EmailService, type SmtpTransportConfig } from "../../notifications/email.service";
import type { EmailConfigurationService } from "../../plugins/email-configuration.service";
import type { TicketGeneratorService } from "./ticket-generator.service";
import { DeliveryRecorderService } from "./delivery-recorder.service";

vi.mock("../../channels/whatsapp/meta-whatsapp.client", () => ({
  uploadMetaWhatsAppMedia: vi.fn(async () => ({ mediaId: "media-123" })),
  sendMetaWhatsAppDocument: vi.fn(async () => ({ providerMessageId: "wamid.abc", status: "sent" }))
}));
import { uploadMetaWhatsAppMedia, sendMetaWhatsAppDocument } from "../../channels/whatsapp/meta-whatsapp.client";

const BOOKING = {
  id: "booking-1",
  organizationId: "org-1",
  pluginInstallationId: "plugin-1",
  customerEmail: "traveler@example.com",
  customerPhone: "+919876543210",
};

function harness(overrides: Partial<typeof BOOKING> = {}, channel: Record<string, unknown> | null = null) {
  const booking = { ...BOOKING, ...overrides };
  const updateMock = vi.fn(async () => booking);
  const prisma = {
    travelBooking: {
      findFirst: vi.fn(async () => booking),
      update: updateMock,
    },
    channelConnection: {
      findFirst: vi.fn(async () => channel),
    },
  } as unknown as PrismaService;

  const ticketGenerator = {
    generateTicketPackage: vi.fn(async () => ({ pnr: "PNR456", bookingReference: "REF123" })),
    generatePdfContent: vi.fn(async () => Buffer.from("%PDF-1.3 fake")),
  } as unknown as TicketGeneratorService;

  const sendMail = vi.fn(async () => ({ messageId: "email-msg-1" }));
  const email = { sendMail } as unknown as EmailService;

  const decrypt = vi.fn(() => ({ accessToken: "META_TOKEN" }));
  const secrets = { decrypt } as unknown as PluginSecretsEncryptionService;

  const resolve = vi.fn(async (): Promise<SmtpTransportConfig | null> => null);
  const emailConfig = { resolve } as unknown as EmailConfigurationService;

  const service = new DeliveryRecorderService(prisma, ticketGenerator, email, emailConfig, secrets);
  return { service, prisma, ticketGenerator, sendMail, updateMock, decrypt, resolve };
}

describe("DeliveryRecorderService.recordTicketDelivery", () => {
  it("sends a real email with the generated PDF attached when the booking has a customer email", async () => {
    const { service, sendMail } = harness({ customerPhone: undefined as unknown as string });
    const result = await service.recordTicketDelivery("booking-1", "org-1");

    expect(sendMail).toHaveBeenCalledTimes(1);
    const [call] = sendMail.mock.calls[0] as unknown as [{ to: string; attachments: Array<{ filename: string; content: Buffer }> }];
    expect(call.to).toBe("traveler@example.com");
    expect(call.attachments[0]?.filename).toBe("ticket-booking-.pdf");
    expect(call.attachments[0]?.content.toString().startsWith("%PDF-")).toBe(true);
    expect(result.email).toMatchObject({ channel: "email", status: "SENT", messageId: "email-msg-1" });
  });

  it("records a FAILED email status (never a fabricated success) when SMTP isn't configured", async () => {
    const { service, sendMail } = harness({ customerPhone: undefined as unknown as string });
    sendMail.mockRejectedValueOnce(new EmailNotConfiguredError());

    const result = await service.recordTicketDelivery("booking-1", "org-1");
    expect(result.email).toMatchObject({ status: "FAILED", errorCode: "EMAIL_NOT_CONFIGURED", messageId: null });
  });

  it("skips email delivery entirely when the booking has no customer email on file", async () => {
    const { service } = harness({ customerEmail: undefined as unknown as string, customerPhone: undefined as unknown as string });
    const result = await service.recordTicketDelivery("booking-1", "org-1");
    expect(result.email).toBeNull();
  });

  it("sends via the booking's own employee-installation SMTP configuration when one is set, instead of the process-wide env defaults", async () => {
    const { service, sendMail, resolve } = harness({ customerPhone: undefined as unknown as string });
    const smtp = {
      host: "smtp.employee.example.com",
      port: 587,
      secure: false,
      user: "employee@example.com",
      password: "secret",
      fromEmail: "employee@example.com",
      fromName: "Travel Desk",
    };
    resolve.mockResolvedValueOnce(smtp);

    await service.recordTicketDelivery("booking-1", "org-1");

    expect(resolve).toHaveBeenCalledWith("org-1", "plugin-1");
    const [call] = sendMail.mock.calls[0] as unknown as [{ smtp?: typeof smtp }];
    expect(call.smtp).toEqual(smtp);
  });

  it("uploads and sends a real WhatsApp document when an active channel is configured for the booking's plugin", async () => {
    const channel = {
      id: "channel-1",
      pluginInstallationId: "plugin-1",
      phoneNumberId: "PHONE_ID",
      encryptedSecrets: {},
    };
    const { service } = harness({ customerEmail: undefined as unknown as string }, channel);

    const result = await service.recordTicketDelivery("booking-1", "org-1");

    expect(uploadMetaWhatsAppMedia).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: "PHONE_ID", accessToken: "META_TOKEN" })
    );
    expect(sendMetaWhatsAppDocument).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+919876543210", mediaId: "media-123" })
    );
    expect(result.whatsapp).toMatchObject({ channel: "whatsapp", status: "SENT", messageId: "wamid.abc" });
  });

  it("skips WhatsApp delivery (never fabricates success) when no active channel is connected", async () => {
    const { service } = harness({ customerEmail: undefined as unknown as string }, null);
    const result = await service.recordTicketDelivery("booking-1", "org-1");
    expect(result.whatsapp).toMatchObject({ status: "SKIPPED", errorCode: "WHATSAPP_CHANNEL_NOT_CONFIGURED" });
  });

  it("marks the booking TICKETS_DELIVERED regardless of notification outcome — a failed notification never blocks the booking from being recognized as ticketed", async () => {
    const { service, updateMock } = harness({ customerEmail: undefined as unknown as string, customerPhone: undefined as unknown as string });
    await service.recordTicketDelivery("booking-1", "org-1");
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "TICKETS_DELIVERED" }) })
    );
  });
});
