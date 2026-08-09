import { Global, Logger, Module } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { APP_CONFIG, type AppConfig } from "../config/config.tokens";
import { LocalObjectDownloadController } from "./local-object-download.controller";
import { LocalObjectStorageAdapter } from "./local-object-storage.adapter";
import { S3ObjectStorageAdapter } from "./s3-object-storage.adapter";
import { OBJECT_STORAGE } from "./object-storage.types";

const logger = new Logger("ObjectStorageModule");

/**
 * Sprint 5.0 — Phase 6: selects the local-disk or S3-compatible adapter behind one `ObjectStorageService`
 * token via STORAGE_PROVIDER, matching the spec's "feature flag/provider setting so local development can
 * continue using the existing adapter" requirement. @Global so any module can inject OBJECT_STORAGE
 * without importing this one, matching ConfigModule/QueueModule/SecurityModule.
 */
@Global()
@Module({
  controllers: [LocalObjectDownloadController],
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const provider = config.string("STORAGE_PROVIDER", "local");
        if (provider === "s3") {
          const endpoint = config.string("S3_ENDPOINT");
          const bucket = config.string("S3_BUCKET");
          const accessKeyId = config.string("S3_ACCESS_KEY_ID");
          const secretAccessKey = config.string("S3_SECRET_ACCESS_KEY");
          if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
            throw new Error("OBJECT_STORAGE_S3_CONFIG_INCOMPLETE: S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are all required when STORAGE_PROVIDER=s3");
          }
          return new S3ObjectStorageAdapter({
            endpoint,
            bucket,
            accessKeyId,
            secretAccessKey,
            region: config.string("S3_REGION", "us-east-1"),
            forcePathStyle: config.boolean("S3_FORCE_PATH_STYLE", true)
          });
        }
        // local: PLATFORM_ENCRYPTION_KEY (if configured) signs download references so they survive a
        // restart; otherwise an ephemeral per-process secret is fine — this mode is documented as
        // development-only and signed references never need to outlive the process.
        const platformKeyBase64 = config.string("PLATFORM_ENCRYPTION_KEY", "");
        const signingSecret = platformKeyBase64 ? Buffer.from(platformKeyBase64, "base64") : randomBytes(32);
        if (!platformKeyBase64 && config.productionLike) {
          logger.warn({ event: "OBJECT_STORAGE_LOCAL_IN_PRODUCTION", detail: "STORAGE_PROVIDER=local in a production-like environment; set STORAGE_PROVIDER=s3 for durable, multi-instance-safe storage." });
        }
        return new LocalObjectStorageAdapter(
          config.string("OBJECT_STORAGE_LOCAL_PATH", "./storage/objects"),
          signingSecret,
          config.security.apiPublicUrl
        );
      }
    }
  ],
  exports: [OBJECT_STORAGE]
})
export class ObjectStorageModule {}
