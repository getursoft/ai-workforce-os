import { Module } from "@nestjs/common";
import { MulterModule } from "@nestjs/platform-express";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { AttachmentsModule } from "../attachments/attachment.module";
import { PluginModule } from "../plugins/plugin.module";
import { RecruitmentJobController } from "./recruitment-job.controller";
import { RecruitmentResumeController } from "./recruitment-resume.controller";
import { RecruitmentCandidatesController } from "./recruitment-candidates.controller";
import { RecruitmentJobService } from "./recruitment-job.service";
import { RecruitmentResumeService } from "./recruitment-resume.service";
import { RecruitmentParsingService } from "./recruitment-parsing.service";
import { RecruitmentScoringService } from "./recruitment-scoring.service";
import { RecruitmentBatchProcessor } from "./recruitment-batch-processor";
import { RecruitmentCandidateQueryService } from "./recruitment-candidate-query.service";
import { RecruitmentExportService } from "./recruitment-export.service";
import { RecruitmentExportWorkerService } from "./recruitment-export-worker";
import { RecruitmentChatIdentityVerificationService } from "./recruitment-chat-identity-verification.service";

/** AI Recruitment Consultant — internal-only employee (Phase 1). Reuses the existing attachment
 * text-extractor registry (PDF/DOCX), the existing plugin AI-provider resolution, and the existing
 * object-storage module rather than duplicating any of them. */
@Module({
  imports: [PrismaModule, IdentityModule, AttachmentsModule, PluginModule, MulterModule.register({ limits: { fileSize: 10 * 1024 * 1024 } })],
  controllers: [RecruitmentJobController, RecruitmentResumeController, RecruitmentCandidatesController],
  providers: [
    RecruitmentJobService,
    RecruitmentResumeService,
    RecruitmentParsingService,
    RecruitmentScoringService,
    RecruitmentBatchProcessor,
    RecruitmentCandidateQueryService,
    RecruitmentExportService,
    RecruitmentExportWorkerService,
    RecruitmentChatIdentityVerificationService
  ],
  // Exported so a future RecruitmentWhatsAppModule (Phase 1+) can import RecruitmentModule and reuse the
  // same query/export services rather than re-implementing them — the whole point of Phase 6 being "one
  // reusable server-side candidate query service" shared by every client.
  exports: [
    RecruitmentCandidateQueryService,
    RecruitmentExportService,
    RecruitmentJobService,
    RecruitmentResumeService,
    RecruitmentParsingService,
    RecruitmentChatIdentityVerificationService
  ]
})
export class RecruitmentModule {}
