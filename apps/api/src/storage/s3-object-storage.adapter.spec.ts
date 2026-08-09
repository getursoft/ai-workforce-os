import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3ObjectStorageAdapter } from "./s3-object-storage.adapter";

const CONFIG = {
  endpoint: "http://127.0.0.1:9000",
  region: "us-east-1",
  bucket: "test-bucket",
  accessKeyId: "AKIATEST",
  secretAccessKey: "secret-value",
  forcePathStyle: true
};

describe("S3ObjectStorageAdapter", () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("putObject sends a path-style, tenant-scoped, SigV4-signed PUT request", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const adapter = new S3ObjectStorageAdapter(CONFIG);
    const buffer = Buffer.from("ticket-pdf-bytes");
    const meta = await adapter.putObject({ organizationId: "org-1", key: "tickets/b1.pdf", buffer, contentType: "application/pdf" });

    expect(meta.sizeBytes).toBe(buffer.byteLength);
    expect(meta.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9000/test-bucket/org-1/tickets/b1.pdf");
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST\//);
    expect(headers["x-amz-content-sha256"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("objectExists returns false on a 404 and true on a 200, without throwing either way", async () => {
    const adapter = new S3ObjectStorageAdapter(CONFIG);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await adapter.objectExists("org-1", "missing.pdf")).toBe(false);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await adapter.objectExists("org-1", "present.pdf")).toBe(true);
  });

  it("throws OBJECT_STORAGE_REQUEST_FAILED on a non-2xx, non-404 response instead of silently succeeding", async () => {
    const adapter = new S3ObjectStorageAdapter(CONFIG);
    fetchMock.mockResolvedValue(new Response("access denied", { status: 403 }));
    await expect(adapter.deleteObject("org-1", "a.pdf")).rejects.toThrow("OBJECT_STORAGE_REQUEST_FAILED");
  });

  it("getSignedDownloadUrl produces a query-string-signed URL scoped to the tenant, without making a network call", async () => {
    const adapter = new S3ObjectStorageAdapter(CONFIG);
    const url = await adapter.getSignedDownloadUrl("org-1", "reports/q1.csv", 120);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(url).toContain("http://127.0.0.1:9000/test-bucket/org-1/reports/q1.csv");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=120");
    expect(url).toContain("X-Amz-Credential=AKIATEST");
  });

  it("uses virtual-hosted-style requests when forcePathStyle is false", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const adapter = new S3ObjectStorageAdapter({ ...CONFIG, forcePathStyle: false });
    await adapter.putObject({ organizationId: "org-1", key: "a.pdf", buffer: Buffer.from("x"), contentType: "application/pdf" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test-bucket.127.0.0.1:9000/org-1/a.pdf");
  });

  it("rejects a path-traversal key before ever calling fetch", async () => {
    const adapter = new S3ObjectStorageAdapter(CONFIG);
    await expect(adapter.getObject("org-1", "../../secrets.env")).rejects.toThrow("OBJECT_STORAGE_KEY_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
