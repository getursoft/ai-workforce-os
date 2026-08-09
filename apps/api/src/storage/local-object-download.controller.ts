import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Query,
  Res
} from "@nestjs/common";
import { LocalObjectStorageAdapter } from "./local-object-storage.adapter";
import { OBJECT_STORAGE, sanitizeObjectKey, type ObjectStorageService } from "./object-storage.types";

/** Minimal structural type for the Express response, matching this codebase's convention of not
 *  importing Express types directly (see identity/presentation/http/request-context.ts). */
interface DownloadResponse {
  setHeader(name: string, value: string): void;
  send(body: Buffer): void;
}

/**
 * Sprint 5.0B: serves the signed URLs `LocalObjectStorageAdapter.getSignedDownloadUrl` issues — the local
 * equivalent of fetching a presigned S3 URL directly from S3. Deliberately public (no JWT guard): the
 * signature itself is the credential, exactly like a real presigned URL — anyone who already has the
 * *specific, time-limited, tenant-scoped* URL can use it, and nobody else can construct one without the
 * signing secret. Only reachable when STORAGE_PROVIDER=local; the OBJECT_STORAGE binding is never a
 * LocalObjectStorageAdapter when STORAGE_PROVIDER=s3, so this always 404s there (as it should — real S3
 * URLs are fetched directly from S3, never proxied through this API).
 */
@Controller("objects")
export class LocalObjectDownloadController {
  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorageService) {}

  @Get("local")
  async download(
    @Query("org") organizationId: string | undefined,
    @Query("key") key: string | undefined,
    @Query("exp") exp: string | undefined,
    @Query("sig") sig: string | undefined,
    @Res() response: DownloadResponse
  ): Promise<void> {
    if (!(this.storage instanceof LocalObjectStorageAdapter)) {
      throw new NotFoundException("OBJECT_NOT_FOUND");
    }
    if (!organizationId || !key || !exp || !sig) {
      throw new BadRequestException("SIGNED_URL_PARAMS_MISSING");
    }
    const expiresAtMs = Number(exp);
    if (!Number.isFinite(expiresAtMs)) {
      throw new BadRequestException("SIGNED_URL_PARAMS_INVALID");
    }
    let scopedKey: string;
    try {
      scopedKey = `${organizationId}/${sanitizeObjectKey(key)}`;
    } catch {
      throw new BadRequestException("SIGNED_URL_PARAMS_INVALID");
    }
    if (!this.storage.verifySignedReference(scopedKey, expiresAtMs, sig)) {
      throw new ForbiddenException("SIGNED_URL_INVALID_OR_EXPIRED");
    }
    const [buffer, metadata] = await Promise.all([
      this.storage.getObject(organizationId, key),
      this.storage.getMetadata(organizationId, key)
    ]);
    response.setHeader("Content-Type", metadata?.contentType ?? "application/octet-stream");
    // Never cached by a shared cache: the URL is tenant-scoped and time-limited, not a stable public asset.
    response.setHeader("Cache-Control", "private, max-age=0, no-store");
    response.send(buffer);
  }
}
