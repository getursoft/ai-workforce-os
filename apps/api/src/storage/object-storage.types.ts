/**
 * Sprint 5.0 — Phase 6: production object/file storage abstraction.
 *
 * A platform-wide contract for tenant-scoped file storage, usable by knowledge uploads, generated ticket
 * PDFs/reports, and other exports/attachments. Sprint 5.0B migrated Knowledge document uploads onto this
 * (see `knowledge.service.ts`) — the old knowledge-only `LocalKnowledgeFileStorage` is gone.
 * `TicketGeneratorService` has not been migrated yet and still has its own storage handling.
 */

export interface ObjectMetadata {
  key: string;
  sizeBytes: number;
  contentType: string;
  checksumSha256: string;
  lastModified: Date;
}

export interface PutObjectInput {
  /** Tenant scoping is mandatory — every key this service writes is prefixed `${organizationId}/...`. */
  organizationId: string;
  /** Logical path under the tenant prefix, e.g. "tickets/booking-123.pdf" — sanitized before use. */
  key: string;
  buffer: Buffer;
  contentType: string;
  maxBytes?: number;
}

export interface ObjectStorageService {
  putObject(input: PutObjectInput): Promise<ObjectMetadata>;
  getObject(organizationId: string, key: string): Promise<Buffer>;
  /** A short-lived, non-public download reference — never a permanently public URL. */
  getSignedDownloadUrl(organizationId: string, key: string, expirySeconds?: number): Promise<string>;
  deleteObject(organizationId: string, key: string): Promise<void>;
  objectExists(organizationId: string, key: string): Promise<boolean>;
  copyObject(organizationId: string, sourceKey: string, destKey: string): Promise<ObjectMetadata>;
  getMetadata(organizationId: string, key: string): Promise<ObjectMetadata | null>;
}

export const OBJECT_STORAGE = Symbol("ObjectStorageService");

/** Safe-filename + path-traversal guard shared by every adapter — a tenant-scoped key must never resolve
 *  outside its own prefix, and must never contain characters that could be reinterpreted by a filesystem
 *  or an S3 key parser (`..`, leading slash, null bytes). */
export function sanitizeObjectKey(key: string): string {
  const trimmed = key.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!trimmed || trimmed.includes("\0") || trimmed.split("/").some((segment) => segment === "..")) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  return trimmed;
}
