import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailService, EmailNotConfiguredError } from "./email.service";

const sendMailMock = vi.fn(async () => ({ messageId: "msg-1" }));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: sendMailMock }))
  }
}));

const ORIGINAL_ENV = { ...process.env };

describe("EmailService", () => {
  beforeEach(() => {
    sendMailMock.mockClear();
    process.env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SMTP_")));
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports not configured when SMTP_HOST is unset", () => {
    const service = new EmailService();
    expect(service.isConfigured()).toBe(false);
  });

  it("throws EmailNotConfiguredError rather than silently pretending to succeed", async () => {
    const service = new EmailService();
    await expect(
      service.sendMail({ to: "traveler@example.com", subject: "Ticket", text: "body" })
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
  });

  it("sends a real message (attachment included) once SMTP is configured", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "no-reply@example.com";
    process.env.SMTP_PASSWORD = "secret";
    process.env.SMTP_FROM_EMAIL = "no-reply@example.com";
    process.env.SMTP_FROM_NAME = "Krevia.ai";

    const service = new EmailService();
    const result = await service.sendMail({
      to: "traveler@example.com",
      subject: "Your travel ticket — PNR ABC123",
      text: "Attached is your ticket.",
      attachments: [{ filename: "ticket.pdf", content: Buffer.from("%PDF-1.3"), contentType: "application/pdf" }]
    });

    expect(result.messageId).toBe("msg-1");
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const [call] = sendMailMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call.to).toBe("traveler@example.com");
    expect(call.from).toBe('"Krevia.ai" <no-reply@example.com>');
    expect(call.attachments).toHaveLength(1);
  });

  it("sends an HTML body alongside the plain-text fallback when provided", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_FROM_EMAIL = "no-reply@example.com";

    const service = new EmailService();
    await service.sendMail({
      to: "user@example.com",
      subject: "Reset your password",
      text: "Reset your password: https://example.com/reset",
      html: "<p>Reset your password: <a href=\"https://example.com/reset\">link</a></p>"
    });

    const [call] = sendMailMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call.text).toBe("Reset your password: https://example.com/reset");
    expect(call.html).toBe('<p>Reset your password: <a href="https://example.com/reset">link</a></p>');
  });

  it("omits the html field entirely (not even undefined) when no html body is given, matching pre-HTML-support behavior", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_FROM_EMAIL = "no-reply@example.com";

    const service = new EmailService();
    await service.sendMail({ to: "user@example.com", subject: "Ticket", text: "body" });

    const [call] = sendMailMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect("html" in call).toBe(false);
  });

  it("isConfigured() reflects SMTP_HOST presence", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    const service = new EmailService();
    expect(service.isConfigured()).toBe(true);
  });

  it("sends via a per-call SMTP override (employee configuration) instead of the env defaults, even when no env vars are set at all", async () => {
    const service = new EmailService();
    const result = await service.sendMail({
      to: "traveler@example.com",
      subject: "Your travel ticket — PNR ABC123",
      text: "Attached is your ticket.",
      smtp: {
        host: "smtp.employee.example.com",
        port: 465,
        secure: true,
        user: "employee@example.com",
        password: "employee-secret",
        fromEmail: "employee@example.com",
        fromName: "Travel Desk"
      }
    });

    expect(result.messageId).toBe("msg-1");
    const [call] = sendMailMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call.from).toBe('"Travel Desk" <employee@example.com>');
  });

  it("isConfigured(smtp) reflects the override's own host, independent of env vars", () => {
    const service = new EmailService();
    expect(
      service.isConfigured({
        host: "smtp.employee.example.com",
        port: 587,
        secure: false,
        user: null,
        password: null,
        fromEmail: "employee@example.com",
        fromName: null
      })
    ).toBe(true);
    expect(service.isConfigured({ host: "", port: 587, secure: false, user: null, password: null, fromEmail: "", fromName: null })).toBe(
      false
    );
  });

  it("throws EmailNotConfiguredError when the override has no host, even if env vars ARE set (override always wins)", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_FROM_EMAIL = "no-reply@example.com";
    const service = new EmailService();
    await expect(
      service.sendMail({
        to: "traveler@example.com",
        subject: "Ticket",
        text: "body",
        smtp: { host: "", port: 587, secure: false, user: null, password: null, fromEmail: "", fromName: null }
      })
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
  });
});
