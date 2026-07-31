import { Module } from "@nestjs/common";
import { MulterModule } from "@nestjs/platform-express";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import {
  AttachmentExtractorRegistry,
  DocxAttachmentTextExtractor,
  ImageAttachmentTextExtractor,
  PdfAttachmentTextExtractor,
  PlainAttachmentTextExtractor
} from "./attachment.extractors";
import { ConversationAttachmentService, InMemoryAttachmentFileStore } from "./attachment.service";
import { ConversationAttachmentController } from "./attachment.controller";

@Module({
  imports: [
    PrismaModule,
    IdentityModule,
    MulterModule.register({ limits: { fileSize: 25 * 1024 * 1024 } })
  ],
  controllers: [ConversationAttachmentController],
  providers: [
    PlainAttachmentTextExtractor,
    PdfAttachmentTextExtractor,
    DocxAttachmentTextExtractor,
    ImageAttachmentTextExtractor,
    {
      provide: AttachmentExtractorRegistry,
      inject: [
        PlainAttachmentTextExtractor,
        PdfAttachmentTextExtractor,
        DocxAttachmentTextExtractor,
        ImageAttachmentTextExtractor
      ],
      useFactory: (
        plain: PlainAttachmentTextExtractor,
        pdf: PdfAttachmentTextExtractor,
        docx: DocxAttachmentTextExtractor,
        image: ImageAttachmentTextExtractor
      ) => new AttachmentExtractorRegistry([plain, pdf, docx, image])
    },
    InMemoryAttachmentFileStore,
    ConversationAttachmentService
  ],
  exports: [ConversationAttachmentService, AttachmentExtractorRegistry]
})
export class AttachmentsModule {}
