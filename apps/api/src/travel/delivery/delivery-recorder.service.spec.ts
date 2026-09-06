import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../infrastructure/prisma/prisma.service";
import type { PluginSecretsEncryptionService } from "../../plugins/plugin.runtime";
import { EmailNotConfiguredError, type EmailService, type SmtpTransportConfig } from "../../notifications/email.service";
import type { EmailConfigurationService } from "../../plugins/email-configuration.service";
import type { TicketGeneratorService } from "./ticket-generator.service";
import { DeliveryRecorderService } from "./delivery-recorder.service";

vi.mock("../../channels/whatsapp/meta-whatsapp.client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../channels/whatsapp/meta-whatsapp.client")>();
  return {
    ...actual,
    uploadMetaWhatsAppMedia: vi.fn(async () => ({ mediaId: "media-123" })),
    sendMetaWhatsAppDocument: vi.fn(async () => ({ providerMessageId: "wamid.abc", status: "sent" }))
  };
});
import {
  MetaProviderError,
  sendMetaWhatsAppDocument,
  uploadMetaWhatsAppMedia
} from "../../channels/whatsapp/meta-whatsapp.client";

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
  const channelMessages: Record<string, unknown>[] = [];
  const deliveryAttempts: Record<string, unknown>[] = [];
  let channelMessageIdCounter = 0;
  const channelMessageFindFirst = vi.fn(
    async ({ where }: { where: { status: { in: string[] } } }) =>
      channelMessages.find((row) => where.status.in.includes(row.status as string)) ?? null
  );
  const channelMessageCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    channelMessageIdCounter++;
    const row = { id: `channel-message-${channelMessageIdCounter}`, ...data };
    channelMessages.push(row);
    return row;
  });
  const channelMessageUpdate = vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = channelMessages.find((r) => r.id === where.id);
    if (row) Object.assign(row, data);
    return row;
  });
  const prisma = {
    travelBooking: {
      findFirst: vi.fn(async () => booking),
      update: updateMock,
    },
    channelConnection: {
      findFirst: vi.fn(async () => channel),
    },
    channelMessage: {
      findFirst: channelMessageFindFirst,
      create: channelMessageCreate,
      update: channelMessageUpdate,
    },
    channelDeliveryAttempt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        deliveryAttempts.push(data);
        return data;
      }),
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
  return { service, prisma, ticketGenerator, sendMail, updateMock, decrypt, resolve, channelMessages, deliveryAttempts };
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

  describe("Sprint 6.7 — durable delivery record + idempotency", () => {
    const channel = {
      id: "channel-1",
      pluginInstallationId: "plugin-1",
      phoneNumberId: "PHONE_ID",
      encryptedSecrets: {},
    };

    it("creates an OUTBOUND ChannelMessage with an attachmentRef and ONE successful ChannelDeliveryAttempt", async () => {
      const { service, channelMessages, deliveryAttempts } = harness(
        { customerEmail: undefined as unknown as string },
        channel
      );
      await service.recordTicketDelivery("booking-1", "org-1");

      expect(channelMessages).toHaveLength(1);
      expect(channelMessages[0]).toMatchObject({
        direction: "OUTBOUND",
        status: "SENT",
        attachmentRef: { bookingId: "booking-1", kind: "TRAVEL_TICKET_PDF" },
        providerMessageSid: "wamid.abc",
      });
      expect(deliveryAttempts).toHaveLength(1);
      expect(deliveryAttempts[0]).toMatchObject({ success: true, providerRequestId: "wamid.abc" });
    });

    it("does not re-send (or re-generate the PDF a second time on the wire) when a send for this booking is already SENT", async () => {
      const { service, channelMessages } = harness({ customerEmail: undefined as unknown as string }, channel);
      channelMessages.push({
        id: "existing-1",
        channelConnectionId: "channel-1",
        direction: "OUTBOUND",
        status: "SENT",
        attachmentRef: { bookingId: "booking-1", kind: "TRAVEL_TICKET_PDF" },
        providerMessageSid: "wamid.original",
      });
      vi.mocked(uploadMetaWhatsAppMedia).mockClear();
      vi.mocked(sendMetaWhatsAppDocument).mockClear();

      const result = await service.recordTicketDelivery("booking-1", "org-1");

      expect(uploadMetaWhatsAppMedia).not.toHaveBeenCalled();
      expect(sendMetaWhatsAppDocument).not.toHaveBeenCalled();
      expect(channelMessages).toHaveLength(1); // no second row created
      expect(result.whatsapp).toMatchObject({ status: "SENT", messageId: "wamid.original" });
    });

    it("records a FAILED ChannelDeliveryAttempt with a normalized error code when the send throws", async () => {
      const { service, deliveryAttempts, channelMessages } = harness(
        { customerEmail: undefined as unknown as string },
        channel
      );
      vi.mocked(sendMetaWhatsAppDocument).mockRejectedValueOnce(
        new MetaProviderError("META_WHATSAPP_SEND_FAILED: bad number", "META_INVALID_RECIPIENT", 400)
      );

      const result = await service.recordTicketDelivery("booking-1", "org-1");

      expect(result.whatsapp).toMatchObject({ status: "FAILED" });
      expect(channelMessages[0]).toMatchObject({ status: "FAILED", errorCode: "INVALID_RECIPIENT" });
      expect(deliveryAttempts[0]).toMatchObject({ success: false, errorCode: "INVALID_RECIPIENT" });
    });
  });

  it("marks the booking TICKETS_DELIVERED regardless of notification outcome — a failed notification never blocks the booking from being recognized as ticketed", async () => {
    const { service, updateMock } = harness({ customerEmail: undefined as unknown as string, customerPhone: undefined as unknown as string });
    await service.recordTicketDelivery("booking-1", "org-1");
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "TICKETS_DELIVERED" }) })
    );
  });
});
