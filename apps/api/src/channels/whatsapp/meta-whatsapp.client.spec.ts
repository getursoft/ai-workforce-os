import { describe, expect, it, vi } from "vitest";
import { uploadMetaWhatsAppMedia, sendMetaWhatsAppDocument } from "./meta-whatsapp.client";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body
  } as Response;
}

describe("uploadMetaWhatsAppMedia", () => {
  it("uploads the buffer as multipart form data and returns the media ID", async () => {
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://graph.facebook.com/v22.0/PHONE_ID/media");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      return jsonResponse({ id: "media-123" });
    });

    const result = await uploadMetaWhatsAppMedia(
      {
        phoneNumberId: "PHONE_ID",
        accessToken: "TOKEN",
        buffer: Buffer.from("%PDF-1.3"),
        filename: "ticket.pdf",
        mimeType: "application/pdf"
      },
      fetcher as unknown as typeof fetch
    );

    expect(result.mediaId).toBe("media-123");
  });

  it("throws a descriptive error when Meta rejects the upload", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: { message: "Invalid access token" } }, false, 401));
    await expect(
      uploadMetaWhatsAppMedia(
        { phoneNumberId: "PHONE_ID", accessToken: "BAD", buffer: Buffer.from("x"), filename: "t.pdf", mimeType: "application/pdf" },
        fetcher as unknown as typeof fetch
      )
    ).rejects.toThrow(/META_WHATSAPP_MEDIA_UPLOAD_FAILED/);
  });
});

describe("sendMetaWhatsAppDocument", () => {
  it("sends a document message referencing the uploaded media ID", async () => {
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://graph.facebook.com/v22.0/PHONE_ID/messages");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        messaging_product: "whatsapp",
        to: "+919876543210",
        type: "document",
        document: { id: "media-123", filename: "ticket.pdf", caption: "Your ticket — PNR ABC123" }
      });
      return jsonResponse({ messages: [{ id: "wamid.abc" }] });
    });

    const result = await sendMetaWhatsAppDocument(
      {
        phoneNumberId: "PHONE_ID",
        accessToken: "TOKEN",
        to: "+919876543210",
        mediaId: "media-123",
        filename: "ticket.pdf",
        caption: "Your ticket — PNR ABC123"
      },
      fetcher as unknown as typeof fetch
    );

    expect(result.providerMessageId).toBe("wamid.abc");
    expect(result.status).toBe("sent");
  });

  it("throws a descriptive error when Meta rejects the send", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: { message: "Recipient not opted in" } }, false, 400));
    await expect(
      sendMetaWhatsAppDocument(
        { phoneNumberId: "PHONE_ID", accessToken: "TOKEN", to: "+91", mediaId: "media-123", filename: "t.pdf" },
        fetcher as unknown as typeof fetch
      )
    ).rejects.toThrow(/META_WHATSAPP_SEND_FAILED/);
  });
});
