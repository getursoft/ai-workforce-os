import { Injectable } from "@nestjs/common";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ObjectMetadata, ObjectStorageService, PutObjectInput } from "./object-storage.types";
import { sanitizeObjectKey } from "./object-storage.types";

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_EXPIRY_SECONDS = 300;

/** Sprint 5.0 Phase 6 (Sprint 5.0B: wired to a real download route) — local-disk adapter for development.
 *  `getSignedDownloadUrl` returns a real, directly-fetchable HMAC-signed URL pointing at this API's own
 *  `GET /api/v1/objects/local` route (`LocalObjectDownloadController`), which verifies it via
 *  `verifySignedReference` before streaming the file — the same shape a real presigned S3 URL has from a
 *  client's perspective (no Authorization header, the signature itself is the credential). Content-type is
 *  preserved via a small `<key>.meta.json` sidecar written alongside each object, since the local
 *  filesystem has no equivalent of S3's object metadata. */
@Injectable()
export class LocalObjectStorageAdapter implements ObjectStorageService {
  private readonly root: string;
  constructor(
    storagePath: string,
    private readonly signingSecret: Buffer,
    private readonly apiPublicUrl: string
  ) {
    this.root = resolve(storagePath);
  }

  async putObject(input: PutObjectInput): Promise<ObjectMetadata> {
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    if (input.buffer.byteLength > maxBytes) throw new Error("OBJECT_STORAGE_FILE_TOO_LARGE");
    const key = this.scopedKey(input.organizationId, input.key);
    const path = this.resolvePath(key);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, input.buffer, { mode: 0o600 });
    await writeFile(this.metaPath(path), JSON.stringify({ contentType: input.contentType }), {
      mode: 0o600
    });
    return {
      key: input.key,
      sizeBytes: input.buffer.byteLength,
      contentType: input.contentType,
      checksumSha256: createHash("sha256").update(input.buffer).digest("hex"),
      lastModified: new Date()
    };
  }

  async getObject(organizationId: string, key: string): Promise<Buffer> {
    return readFile(this.resolvePath(this.scopedKey(organizationId, key)));
  }

  async getSignedDownloadUrl(organizationId: string, key: string, expirySeconds = DEFAULT_EXPIRY_SECONDS): Promise<string> {
    const scoped = this.scopedKey(organizationId, key);
    const expiresAt = Date.now() + Math.max(expirySeconds, 1) * 1000;
    const signature = this.sign(scoped, expiresAt);
    const url = new URL("/api/v1/objects/local", this.apiPublicUrl);
    url.searchParams.set("org", organizationId);
    url.searchParams.set("key", key);
    url.searchParams.set("exp", String(expiresAt));
    url.searchParams.set("sig", signature);
    return url.toString();
  }

  /** Verifies a reference produced by getSignedDownloadUrl — called by LocalObjectDownloadController. */
  verifySignedReference(scopedKey: string, expiresAtMs: number, signature: string): boolean {
    if (Date.now() > expiresAtMs) return false;
    const expected = this.sign(scopedKey, expiresAtMs);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async deleteObject(organizationId: string, key: string): Promise<void> {
    const path = this.resolvePath(this.scopedKey(organizationId, key));
    await rm(path, { force: true });
    await rm(this.metaPath(path), { force: true });
  }

  async objectExists(organizationId: string, key: string): Promise<boolean> {
    try {
      await stat(this.resolvePath(this.scopedKey(organizationId, key)));
      return true;
    } catch {
      return false;
    }
  }

  async copyObject(organizationId: string, sourceKey: string, destKey: string): Promise<ObjectMetadata> {
    const buffer = await this.getObject(organizationId, sourceKey);
    return this.putObject({ organizationId, key: destKey, buffer, contentType: "application/octet-stream" });
  }

  async getMetadata(organizationId: string, key: string): Promise<ObjectMetadata | null> {
    try {
      const path = this.resolvePath(this.scopedKey(organizationId, key));
      const info = await stat(path);
      const buffer = await readFile(path);
      const contentType = await this.readContentType(path);
      return {
        key,
        sizeBytes: info.size,
        contentType,
        checksumSha256: createHash("sha256").update(buffer).digest("hex"),
        lastModified: info.mtime
      };
    } catch {
      return null;
    }
  }

  private scopedKey(organizationId: string, key: string): string {
    return `${organizationId}/${sanitizeObjectKey(key)}`;
  }

  private sign(scopedKey: string, expiresAtMs: number): string {
    return createHmac("sha256", this.signingSecret).update(`${scopedKey}:${expiresAtMs}`).digest("hex");
  }

  private resolvePath(scopedKey: string): string {
    const path = resolve(this.root, scopedKey);
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) throw new Error("OBJECT_STORAGE_KEY_INVALID");
    return path;
  }

  private metaPath(objectPath: string): string {
    return `${objectPath}.meta.json`;
  }

  private async readContentType(objectPath: string): Promise<string> {
    try {
      const raw = await readFile(this.metaPath(objectPath), "utf8");
      const parsed = JSON.parse(raw) as { contentType?: unknown };
      return typeof parsed.contentType === "string" ? parsed.contentType : "application/octet-stream";
    } catch {
      return "application/octet-stream";
    }
  }
}
