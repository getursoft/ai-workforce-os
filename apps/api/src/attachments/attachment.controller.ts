import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { ConversationAttachmentService, type UploadedAttachmentFile } from "./attachment.service";

@ApiTags("Conversation Attachments")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("conversations/:conversationId/attachments")
export class ConversationAttachmentController {
  constructor(private readonly attachments: ConversationAttachmentService) {}

  @Post()
  @RequirePermission("agents.conversations.read")
  @UseInterceptors(FileInterceptor("file"))
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: { file: { type: "string", format: "binary" } }
    }
  })
  async upload(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("conversationId", new ParseUUIDPipe()) conversationId: string,
    @Req() fileRequest: Request & { file?: UploadedAttachmentFile }
  ) {
    return this.attachments.upload(
      org(p),
      await this.pluginForConversation(p, conversationId),
      conversationId,
      user(p),
      fileRequest.file
    );
  }

  @Get()
  @RequirePermission("agents.conversations.read")
  list(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("conversationId", new ParseUUIDPipe()) conversationId: string
  ) {
    return this.attachments.listForConversation(org(p), conversationId);
  }

  private async pluginForConversation(p: AuthenticatedPrincipal, conversationId: string) {
    const row = await this.attachments.requirePluginInstallationId(org(p), conversationId);
    return row;
  }
}
function org(p: AuthenticatedPrincipal) {
  return p.organizationId.toString();
}
function user(p: AuthenticatedPrincipal) {
  return p.userId.toString();
}
