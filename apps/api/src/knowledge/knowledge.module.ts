import { Module } from "@nestjs/common";
import { MulterModule } from "@nestjs/platform-express";
import { resolve } from "node:path";
import { IdentityModule } from "../identity/identity.module";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginModule } from "../plugins/plugin.module";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { KnowledgeChunkingService } from "./knowledge.chunking";
import { KnowledgeController } from "./knowledge.controller";
import { KnowledgeEmbeddingService } from "./knowledge.embedding";
import {
  DocxKnowledgeTextExtractor,
  KnowledgeExtractorRegistry,
  PdfKnowledgeTextExtractor,
  PlainKnowledgeTextExtractor
} from "./knowledge.extractors";
import { KnowledgeSearchService } from "./knowledge.search";
import { KnowledgeIndexingService, KnowledgeService } from "./knowledge.service";
import { LocalKnowledgeFileStorage, NoopKnowledgeVirusScanner } from "./knowledge.storage";

@Module({
  imports: [
    PrismaModule,
    IdentityModule,
    PluginModule,
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
    {
      provide: KnowledgeExtractorRegistry,
      inject: [PlainKnowledgeTextExtractor, PdfKnowledgeTextExtractor, DocxKnowledgeTextExtractor],
      useFactory: (
        plain: PlainKnowledgeTextExtractor,
        pdf: PdfKnowledgeTextExtractor,
        docx: DocxKnowledgeTextExtractor
      ) => new KnowledgeExtractorRegistry([plain, pdf, docx])
    },
    {
      provide: LocalKnowledgeFileStorage,
      inject: [SECURITY_CONFIG],
      useFactory: (config: SecurityConfig) =>
        new LocalKnowledgeFileStorage(resolve(config.knowledge.storagePath))
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
      ) => new KnowledgeSearchService(prisma, embeddings, config.knowledge.searchCandidateLimit)
    },
    KnowledgeEmbeddingService,
    NoopKnowledgeVirusScanner,
    {
      provide: KnowledgeIndexingService,
      inject: [
        PrismaService,
        LocalKnowledgeFileStorage,
        KnowledgeExtractorRegistry,
        KnowledgeChunkingService,
        KnowledgeEmbeddingService,
        AuditEventLogger
      ],
      useFactory: (
        prisma: PrismaService,
        storage: LocalKnowledgeFileStorage,
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
        LocalKnowledgeFileStorage,
        NoopKnowledgeVirusScanner,
        KnowledgeIndexingService,
        AuditEventLogger,
        SECURITY_CONFIG
      ],
      useFactory: (
        prisma: PrismaService,
        storage: LocalKnowledgeFileStorage,
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
  exports: [KnowledgeSearchService]
})
export class KnowledgeModule {}
