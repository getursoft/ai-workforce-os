import { AgentMemoryScope, ConversationStatus } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min
} from "class-validator";

export class AgentRunDto {
  @IsUUID() pluginInstallationId!: string;
  @IsOptional() @IsUUID() conversationId?: string;
  // Optional: an omitted/empty message on a brand-new conversation is how the dashboard/channel triggers
  // a proactive greeting (see AgentService.execute) instead of requiring a first user message.
  @IsOptional() @IsString() @MaxLength(12000) message?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}
export class PageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsUUID() pluginInstallationId?: string;
  @IsOptional() @IsEnum(ConversationStatus) status?: ConversationStatus;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
}
export class UpdateConversationDto {
  @IsEnum(ConversationStatus) status!: ConversationStatus;
}
export class SaveMemoryDto {
  @IsUUID() pluginInstallationId!: string;
  @IsOptional() @IsUUID() conversationId?: string;
  @IsEnum(AgentMemoryScope) scope!: AgentMemoryScope;
  @IsString() @MaxLength(160) key!: string;
  @IsObject() value!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(2000) searchableText?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}
export class UpdateMemoryDto {
  @IsObject() value!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(2000) searchableText?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}
export class SearchMemoryDto {
  @IsUUID() pluginInstallationId!: string;
  @IsString() @MaxLength(200) query!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 10;
}
