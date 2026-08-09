import { Injectable, Logger } from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";
import type { ObjectMetadata, ObjectStorageService, PutObjectInput } from "./object-storage.types";
import { sanitizeObjectKey } from "./object-storage.types";

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_EXPIRY_SECONDS = 300;
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export interface S3AdapterConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}
function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
function amzDate(): { date: string; dateStamp: string } {
  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { date: iso, dateStamp: iso.slice(0, 8) };
}
function uriEncode(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Sprint 5.0 — Phase 6: S3-compatible object storage without a new dependency. AWS Signature Version 4,
 * implemented with Node's built-in crypto + fetch — no `@aws-sdk/*` package exists in this repo
 * (confirmed at audit time), and this repo's established convention (pdfkit over Playwright/Puppeteer for
 * PDFs) favors minimal dependencies. Works against AWS S3, Cloudflare R2, and MinIO alike since all three
 * speak the same S3 REST + SigV4 contract; `forcePathStyle` (default true, matching S3_FORCE_PATH_STYLE)
 * covers R2/MinIO, which require path-style requests.
 */
@Injectable()
export class S3ObjectStorageAdapter implements ObjectStorageService {
  private readonly logger = new Logger(S3ObjectStorageAdapter.name);

  constructor(private readonly config: S3AdapterConfig) {}

  async putObject(input: PutObjectInput): Promise<ObjectMetadata> {
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    if (input.buffer.byteLength > maxBytes) throw new Error("OBJECT_STORAGE_FILE_TOO_LARGE");
    const scoped = this.scopedKey(input.organizationId, input.key);
    await this.request("PUT", scoped, {
      body: input.buffer,
      headers: { "content-type": input.contentType }
    });
    return {
      key: input.key,
      sizeBytes: input.buffer.byteLength,
      contentType: input.contentType,
      checksumSha256: sha256Hex(input.buffer),
      lastModified: new Date()
    };
  }

  async getObject(organizationId: string, key: string): Promise<Buffer> {
    const scoped = this.scopedKey(organizationId, key);
    const response = await this.request("GET", scoped);
    return Buffer.from(await response.arrayBuffer());
  }

  /** SigV4 presigned URL (query-string signing) — a real, short-lived, non-public S3 URL, not a token
   *  format specific to this adapter. */
  async getSignedDownloadUrl(organizationId: string, key: string, expirySeconds = DEFAULT_EXPIRY_SECONDS): Promise<string> {
    const scoped = this.scopedKey(organizationId, key);
    return this.presign("GET", scoped, expirySeconds);
  }

  async deleteObject(organizationId: string, key: string): Promise<void> {
    const scoped = this.scopedKey(organizationId, key);
    await this.request("DELETE", scoped);
  }

  async objectExists(organizationId: string, key: string): Promise<boolean> {
    const scoped = this.scopedKey(organizationId, key);
    try {
      await this.request("HEAD", scoped);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "OBJECT_STORAGE_NOT_FOUND") return false;
      throw error;
    }
  }

  async copyObject(organizationId: string, sourceKey: string, destKey: string): Promise<ObjectMetadata> {
    // Downloads + re-uploads rather than using x-amz-copy-source: keeps the signer to one request shape
    // (PUT/GET/DELETE/HEAD with a body-hash) instead of adding copy-source header signing for a
    // not-yet-hot-path operation. Acceptable for the object sizes this platform generates (tickets/reports).
    const buffer = await this.getObject(organizationId, sourceKey);
    return this.putObject({ organizationId, key: destKey, buffer, contentType: "application/octet-stream" });
  }

  async getMetadata(organizationId: string, key: string): Promise<ObjectMetadata | null> {
    try {
      const buffer = await this.getObject(organizationId, key);
      return {
        key,
        sizeBytes: buffer.byteLength,
        contentType: "application/octet-stream",
        checksumSha256: sha256Hex(buffer),
        lastModified: new Date()
      };
    } catch (error) {
      if (error instanceof Error && error.message === "OBJECT_STORAGE_NOT_FOUND") return null;
      throw error;
    }
  }

  private scopedKey(organizationId: string, key: string): string {
    return `${organizationId}/${sanitizeObjectKey(key)}`;
  }

  private hostAndPath(scopedKey: string): { host: string; path: string } {
    const endpointUrl = new URL(this.config.endpoint);
    if (this.config.forcePathStyle) {
      return { host: endpointUrl.host, path: `/${this.config.bucket}/${scopedKey}` };
    }
    return { host: `${this.config.bucket}.${endpointUrl.host}`, path: `/${scopedKey}` };
  }

  private canonicalPath(path: string): string {
    return path.split("/").map(uriEncode).join("/");
  }

  private signingKey(dateStamp: string): Buffer {
    const kDate = hmac(`AWS4${this.config.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.config.region);
    const kService = hmac(kRegion, "s3");
    return hmac(kService, "aws4_request");
  }

  private async request(method: "GET" | "PUT" | "DELETE" | "HEAD", scopedKey: string, options: { body?: Buffer; headers?: Record<string, string> } = {}): Promise<Response> {
    const { host, path } = this.hostAndPath(scopedKey);
    const { date, dateStamp } = amzDate();
    const payloadHash = options.body ? sha256Hex(options.body) : sha256Hex(Buffer.alloc(0));
    const extraHeaders = options.headers ?? {};
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": date,
      ...extraHeaders
    };
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = [method, this.canonicalPath(path), "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", date, credentialScope, sha256Hex(canonicalRequest)].join("\n");
    const signature = hmac(this.signingKey(dateStamp), stringToSign).toString("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const url = `${new URL(this.config.endpoint).protocol}//${host}${path}`;
    const response = await fetch(url, {
      method,
      headers: { ...headers, authorization },
      ...(options.body ? { body: new Uint8Array(options.body) } : {})
    });
    if (response.status === 404) throw new Error("OBJECT_STORAGE_NOT_FOUND");
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      this.logger.error({ event: "OBJECT_STORAGE_REQUEST_FAILED", method, status: response.status, detail: detail.slice(0, 300) });
      throw new Error("OBJECT_STORAGE_REQUEST_FAILED");
    }
    return response;
  }

  /** Query-string SigV4 presigning (distinct from header-signing used by `request`) — the canonical form
   *  for a shareable, time-limited download URL. */
  private presign(method: "GET", scopedKey: string, expirySeconds: number): string {
    const { host, path } = this.hostAndPath(scopedKey);
    const { date, dateStamp } = amzDate();
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const query = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.config.accessKeyId}/${credentialScope}`,
      "X-Amz-Date": date,
      "X-Amz-Expires": String(Math.max(expirySeconds, 1)),
      "X-Amz-SignedHeaders": "host"
    });
    const canonicalQuery = [...query.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");
    const canonicalRequest = [method, this.canonicalPath(path), canonicalQuery, `host:${host}\n`, "host", UNSIGNED_PAYLOAD].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", date, credentialScope, sha256Hex(canonicalRequest)].join("\n");
    const signature = hmac(this.signingKey(dateStamp), stringToSign).toString("hex");
    const protocol = new URL(this.config.endpoint).protocol;
    return `${protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }
}
