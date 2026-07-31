import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { LegalPdfService } from "./legal-pdf.service";

class CreateLegalDocumentDto {
  @IsString() @MinLength(1) @MaxLength(255) title!: string;
  @IsString() @MinLength(1) content!: string;
  @IsString() @MaxLength(64) conversationId!: string;
}

@ApiTags("Legal Employee Documents")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("legal-employee/documents")
export class LegalDocumentController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: LegalPdfService
  ) {}

  /** Persists a drafted legal document and returns its id + download URL, so the chat can offer a
   *  "Download PDF" attachment. The plugin installation is resolved from the (optional) conversation. */
  @Post()
  @RequirePermission("legal.config.read")
  async create(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() body: CreateLegalDocumentDto
  ) {
    const { pluginInstallationId, conversationId } = await this.resolveScope(p, body.conversationId);
    const row = await this.prisma.legalDocument.create({
      data: {
        organizationId: org(p),
        pluginInstallationId,
        conversationId: conversationId ?? null,
        createdByUserId: user(p),
        title: body.title,
        content: body.content
      }
    });
    return {
      id: row.id,
      title: row.title,
      downloadUrl: `/api/v1/legal-employee/documents/${row.id}/pdf`,
      createdAt: row.createdAt
    };
  }

  @Get(":documentId/pdf")
  @RequirePermission("legal.config.read")
  async download(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("documentId", new ParseUUIDPipe()) documentId: string,
    @Res() res: {
      setHeader: (name: string, value: string) => void;
      status: (code: number) => { send: (body: Buffer | string) => void };
      send: (body: Buffer) => void;
    }
  ) {
    const row = await this.prisma.legalDocument.findFirst({
      where: { id: documentId, organizationId: org(p) }
    });
    if (!row) {
      res.status(404).send(
        JSON.stringify({ error: { code: "LEGAL_DOCUMENT_NOT_FOUND", message: "Document not found" } })
      );
      return;
    }
    const pdf = await this.pdf.generatePdf(row.title, row.content);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFilename(row.title)}.pdf"`);
    res.send(pdf);
  }

  private async resolveScope(p: AuthenticatedPrincipal, conversationId: string) {
    const organizationId = org(p);
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId, deletedAt: null }
    });
    if (!conversation) throw new Error("CONVERSATION_NOT_FOUND");
    return { pluginInstallationId: conversation.pluginInstallationId, conversationId: conversation.id };
  }
}
function org(p: AuthenticatedPrincipal) {
  return p.organizationId.toString();
}
function user(p: AuthenticatedPrincipal) {
  return p.userId.toString();
}
function sanitizeFilename(value: string): string {
  return value.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "legal-document";
}
