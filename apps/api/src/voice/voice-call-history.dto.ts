/** Sprint 7.11 — STEP 4: Call History API DTOs. Mirrors channel.dto.ts's ChannelPageDto /
 * ChannelMessageQueryDto pagination-and-filter convention exactly, rather than inventing a new shape. */
import { VoiceSessionStatus, VoiceTransport } from "@prisma/client";
import { Type } from "class-transformer";
import { IsDateString, IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";

export class VoicePageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

export class VoiceSessionListQueryDto extends VoicePageDto {
  @IsOptional() @IsEnum(VoiceSessionStatus) status?: VoiceSessionStatus;
  @IsOptional() @IsEnum(VoiceTransport) transport?: VoiceTransport;
  @IsOptional() @IsUUID() channelConnectionId?: string;
  @IsOptional() @IsUUID() agentId?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
}

export class VoiceTranscriptQueryDto extends VoicePageDto {}
