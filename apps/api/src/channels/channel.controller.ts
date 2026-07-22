import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import type { IdentityRequest } from "../identity/presentation/http/request-context";
import {
  ChannelConversationQueryDto,
  ChannelListQueryDto,
  ChannelMessageQueryDto,
  CreateChannelDto,
  UpdateChannelDto
} from "./channel.dto";
import { ChannelService } from "./channel.service";

@ApiTags("Channels")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("channels")
export class ChannelController {
  constructor(private readonly channels: ChannelService) {}

  @Get() @RequirePermission("channel.read") list(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query() query: ChannelListQueryDto
  ) {
    return this.channels.list(org(p), query);
  }

  @Post() @RequirePermission("channel.create") create(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Body() dto: CreateChannelDto
  ) {
    return this.channels.create(org(p), user(p), req.requestId, dto);
  }

  @Get(":id") @RequirePermission("channel.read") get(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.channels.get(org(p), id);
  }

  @Patch(":id") @RequirePermission("channel.update") update(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateChannelDto
  ) {
    return this.channels.update(org(p), user(p), req.requestId, id, dto);
  }

  @Delete(":id") @RequirePermission("channel.delete") @HttpCode(204) async remove(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    await this.channels.remove(org(p), user(p), req.requestId, id);
  }

  @Post(":id/test") @RequirePermission("channel.test") test(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.channels.test(org(p), user(p), req.requestId, id);
  }

  @Post(":id/enable") @RequirePermission("channel.update") enable(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.channels.enable(org(p), user(p), req.requestId, id);
  }

  @Post(":id/disable") @RequirePermission("channel.update") disable(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.channels.disable(org(p), user(p), req.requestId, id);
  }

  @Get(":id/conversations") @RequirePermission("channel.message.read") conversations(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() query: ChannelConversationQueryDto
  ) {
    return this.channels.conversations(org(p), id, query);
  }

  @Get(":id/messages") @RequirePermission("channel.message.read") messages(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() query: ChannelMessageQueryDto
  ) {
    return this.channels.messages(org(p), id, query);
  }
}
function org(p: AuthenticatedPrincipal) {
  return p.organizationId.toString();
}
function user(p: AuthenticatedPrincipal) {
  return p.userId.toString();
}
