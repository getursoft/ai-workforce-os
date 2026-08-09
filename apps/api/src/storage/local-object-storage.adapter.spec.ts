import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalObjectStorageAdapter } from "./local-object-storage.adapter";

describe("LocalObjectStorageAdapter", () => {
  let root: string;
  let adapter: LocalObjectStorageAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "object-storage-test-"));
    adapter = new LocalObjectStorageAdapter(root, Buffer.alloc(32, 9), "http://localhost:4000");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a put/get and reports a real sha256 checksum", async () => {
    const buffer = Buffer.from("hello ticket pdf");
    const meta = await adapter.putObject({ organizationId: "org-1", key: "tickets/booking-1.pdf", buffer, contentType: "application/pdf" });
    expect(meta.sizeBytes).toBe(buffer.byteLength);
    expect(meta.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    const read = await adapter.getObject("org-1", "tickets/booking-1.pdf");
    expect(read.equals(buffer)).toBe(true);
  });

  it("scopes objects by organization — one tenant can never read another's key", async () => {
    await adapter.putObject({ organizationId: "org-1", key: "a.pdf", buffer: Buffer.from("x"), contentType: "application/pdf" });
    await expect(adapter.getObject("org-2", "a.pdf")).rejects.toThrow();
    expect(await adapter.objectExists("org-1", "a.pdf")).toBe(true);
    expect(await adapter.objectExists("org-2", "a.pdf")).toBe(false);
  });

  it("rejects a path-traversal key instead of writing outside the tenant root", async () => {
    await expect(adapter.putObject({ organizationId: "org-1", key: "../../etc/passwd", buffer: Buffer.from("x"), contentType: "text/plain" })).rejects.toThrow("OBJECT_STORAGE_KEY_INVALID");
  });

  it("enforces maxBytes", async () => {
    await expect(
      adapter.putObject({ organizationId: "org-1", key: "big.bin", buffer: Buffer.alloc(100), contentType: "application/octet-stream", maxBytes: 10 })
    ).rejects.toThrow("OBJECT_STORAGE_FILE_TOO_LARGE");
  });

  it("deletes an object and copyObject duplicates content under a new key", async () => {
    await adapter.putObject({ organizationId: "org-1", key: "src.txt", buffer: Buffer.from("copy me"), contentType: "text/plain" });
    await adapter.copyObject("org-1", "src.txt", "dest.txt");
    expect((await adapter.getObject("org-1", "dest.txt")).toString()).toBe("copy me");
    await adapter.deleteObject("org-1", "src.txt");
    expect(await adapter.objectExists("org-1", "src.txt")).toBe(false);
    expect(await adapter.objectExists("org-1", "dest.txt")).toBe(true);
  });

  it("produces a real, directly-fetchable signed URL that verifies before expiry and rejects after, or when tampered", async () => {
    await adapter.putObject({ organizationId: "org-1", key: "ticket.pdf", buffer: Buffer.from("x"), contentType: "application/pdf" });
    const url = await adapter.getSignedDownloadUrl("org-1", "ticket.pdf", 60);
    expect(url).toMatch(/^http:\/\/localhost:4000\/api\/v1\/objects\/local\?/);
    const parsed = new URL(url);
    const org = parsed.searchParams.get("org");
    const key = parsed.searchParams.get("key");
    const exp = parsed.searchParams.get("exp");
    const sig = parsed.searchParams.get("sig");
    if (!org || !key || !exp || !sig) throw new Error("signed reference did not match the expected shape");
    const scopedKey = `${org}/${key}`;
    expect(adapter.verifySignedReference(scopedKey, Number(exp), sig)).toBe(true);
    const lastChar = sig.slice(-1);
    const flipped = lastChar === "0" ? "1" : "0";
    expect(adapter.verifySignedReference(scopedKey, Number(exp), `${sig.slice(0, -1)}${flipped}`)).toBe(false);
    expect(adapter.verifySignedReference(scopedKey, Date.now() - 1, sig)).toBe(false);
  });

  it("persists content-type via a metadata sidecar so getMetadata reports the real type, not a generic default", async () => {
    await adapter.putObject({
      organizationId: "org-1",
      key: "ticket.pdf",
      buffer: Buffer.from("x"),
      contentType: "application/pdf"
    });
    const meta = await adapter.getMetadata("org-1", "ticket.pdf");
    expect(meta?.contentType).toBe("application/pdf");
  });

  it("getMetadata returns null for a missing object instead of throwing", async () => {
    expect(await adapter.getMetadata("org-1", "missing.pdf")).toBeNull();
  });
});
