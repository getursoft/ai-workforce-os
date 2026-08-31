import { Module } from "@nestjs/common";
import { MulterModule } from "@nestjs/platform-express";
import { IdentityModule } from "../identity/identity.module";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginModule } from "../plugins/plugin.module";
import { AiConfigurationModule } from "../ai-configuration/ai-configuration.module";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { KnowledgeChunkingService } from "./knowledge.chunking";
import { KnowledgeCollectionService } from "./knowledge.collection";
import { KnowledgeController } from "./knowledge.controller";
import { KnowledgeEmbeddingService } from "./knowledge.embedding";
import {
  DocxKnowledgeTextExtractor,
  KnowledgeExtractorRegistry,
  PdfKnowledgeTextExtractor,
  PlainKnowledgeTextExtractor,
  XlsxKnowledgeTextExtractor,
  ZipKnowledgeTextExtractor
} from "./knowledge.extractors";
import { KnowledgeSearchService } from "./knowledge.search";
import { KnowledgeIndexingService, KnowledgeService } from "./knowledge.service";
import { NoopKnowledgeVirusScanner } from "./knowledge.storage";
import { OBJECT_STORAGE, type ObjectStorageService } from "../storage/object-storage.types";

@Module({
  imports: [
    PrismaModule,
    IdentityModule,
    PluginModule,
    AiConfigurationModule,
    MulterModule.registerAsync({
      imports: [IdentityModule],
      inject: [SECURITY_CONFIG],
      useFactory: (config: SecurityConfig) => ({
        limits: { fileSize: config.knowledge.maxFileSizeBytes }
      })
    })
  ],
  controllers: [KnowledgeController],
  providers: [
    PlainKnowledgeTextExtractor,
    PdfKnowledgeTextExtractor,
    DocxKnowledgeTextExtractor,
    XlsxKnowledgeTextExtractor,
    {
      // ZipKnowledgeTextExtractor gets its own "inner" extractor list directly (not the registry, and
      // never including itself) — a zip's entries are processed with plain/pdf/docx/xlsx only, no
      // zip-in-zip recursion (see the extractor's own doc comment for why).
      provide: ZipKnowledgeTextExtractor,
      inject: [PlainKnowledgeTextExtractor, PdfKnowledgeTextExtractor, DocxKnowledgeTextExtractor, XlsxKnowledgeTextExtractor],
      useFactory: (
        plain: PlainKnowledgeTextExtractor,
        pdf: PdfKnowledgeTextExtractor,
        docx: DocxKnowledgeTextExtractor,
        xlsx: XlsxKnowledgeTextExtractor
      ) => new ZipKnowledgeTextExtractor([plain, pdf, docx, xlsx])
    },
    {
      provide: KnowledgeExtractorRegistry,
      inject: [
        PlainKnowledgeTextExtractor,
        PdfKnowledgeTextExtractor,
        DocxKnowledgeTextExtractor,
        XlsxKnowledgeTextExtractor,
        ZipKnowledgeTextExtractor
      ],
      useFactory: (
        plain: PlainKnowledgeTextExtractor,
        pdf: PdfKnowledgeTextExtractor,
        docx: DocxKnowledgeTextExtractor,
        xlsx: XlsxKnowledgeTextExtractor,
        zip: ZipKnowledgeTextExtractor
      ) => new KnowledgeExtractorRegistry([plain, pdf, docx, xlsx, zip])
    },
    {
      provide: KnowledgeChunkingService,
      inject: [SECURITY_CONFIG],
      useFactory: (config: SecurityConfig) =>
        new KnowledgeChunkingService(
          config.knowledge.chunkTargetTokens,
          config.knowledge.chunkOverlapTokens
        )
    },
    {
      provide: KnowledgeSearchService,
      inject: [PrismaService, KnowledgeEmbeddingService, SECURITY_CONFIG],
      useFactory: (
        prisma: PrismaService,
        embeddings: KnowledgeEmbeddingService,
        config: SecurityConfig
      ) =>
        new KnowledgeSearchService(
          prisma,
          embeddings,
          config,
          config.knowledge.searchCandidateLimit
        )
    },
    KnowledgeEmbeddingService,
    KnowledgeCollectionService,
    NoopKnowledgeVirusScanner,
    {
      provide: KnowledgeIndexingService,
      inject: [
        PrismaService,
        OBJECT_STORAGE,
        KnowledgeExtractorRegistry,
        KnowledgeChunkingService,
        KnowledgeEmbeddingService,
        AuditEventLogger
      ],
      useFactory: (
        prisma: PrismaService,
        storage: ObjectStorageService,
        extractors: KnowledgeExtractorRegistry,
        chunker: KnowledgeChunkingService,
        embeddings: KnowledgeEmbeddingService,
        audit: AuditEventLogger
      ) => new KnowledgeIndexingService(prisma, storage, extractors, chunker, embeddings, audit)
    },
    {
      provide: KnowledgeService,
      inject: [
        PrismaService,
        OBJECT_STORAGE,
        NoopKnowledgeVirusScanner,
        KnowledgeIndexingService,
        AuditEventLogger,
        SECURITY_CONFIG
      ],
      useFactory: (
        prisma: PrismaService,
        storage: ObjectStorageService,
        scanner: NoopKnowledgeVirusScanner,
        indexing: KnowledgeIndexingService,
        audit: AuditEventLogger,
        config: SecurityConfig
      ) =>
        new KnowledgeService(
          prisma,
          storage,
          scanner,
          indexing,
          audit,
          config.knowledge.maxFileSizeBytes
        )
    }
  ],
  exports: [KnowledgeSearchService, KnowledgeEmbeddingService, KnowledgeExtractorRegistry]
})
export class KnowledgeModule {}
