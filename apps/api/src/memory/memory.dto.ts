import { MemoryImportance, MemoryScope, MemorySource } from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength
} from "class-validator";

/** POST /memory — create (or upsert) a memory record. */
export class MemoryCreateDto {
  @IsEnum(MemoryScope)
  scope!: MemoryScope;
  @IsString() @MinLength(1) @MaxLength(160) key!: string;
  @IsObject() value!: Record<string, unknown>;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) category?: string;
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsUUID() conversationId?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1) confidence?: number;
  @IsOptional() @IsEnum(MemoryImportance) importance?: MemoryImportance;
  @IsOptional() @IsEnum(MemorySource) source?: MemorySource;
  @IsOptional() @IsString() @MaxLength(2000) searchableText?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
  @IsOptional() @Transform(({ value }) => (value ? new Date(value) : undefined)) expiresAt?: Date;
}

/** PATCH /memory/:id — partial update. */
export class MemoryUpdateDto {
  @IsOptional() @IsObject() value?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(2000) searchableText?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1) confidence?: number;
  @IsOptional() @IsEnum(MemoryImportance) importance?: MemoryImportance;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) category?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) key?: string;
  @IsOptional() @Transform(({ value }) => (value === null ? null : new Date(value))) expiresAt?: Date | null;
}

/** GET /memory — list filters. */
export class MemoryListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsEnum(MemoryScope) scope?: MemoryScope;
  @IsOptional() @IsString() @MaxLength(80) category?: string;
  @IsOptional() @IsString() @MaxLength(160) key?: string;
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() conversationId?: string;
  @IsOptional() @IsEnum(MemoryImportance) importance?: MemoryImportance;
  @IsOptional() @IsEnum(MemorySource) source?: MemorySource;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() includeDeleted?: boolean;
}

/** POST /memory/search — hybrid search. */
export class MemorySearchDto {
  @IsString() @MinLength(1) @MaxLength(500) query!: string;
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsUUID() conversationId?: string;
  @IsOptional() @IsEnum(MemoryScope) scope?: MemoryScope;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1) minScore?: number;
  @IsOptional() @Type(() => Boolean) @IsBoolean() semantic?: boolean;
}

/** POST /memory/recall — per-actor context retrieval. */
export class MemoryRecallDto {
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsUUID() conversationId?: string;
}

/** POST /memory/forget — bulk forget by criteria. */
export class MemoryForgetDto {
  @IsOptional() @IsEnum(MemoryScope) scope?: MemoryScope;
  @IsOptional() @IsString() @MaxLength(80) category?: string;
  @IsOptional() @IsString() @MaxLength(160) key?: string;
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsUUID() conversationId?: string;
}

/** POST /memory/summarize — summarize a conversation. */
export class MemorySummarizeDto {
  @IsUUID() conversationId!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) threshold?: number;
}

/** POST /memory/merge — merge duplicate memories. */
export class MemoryMergeDto {
  @IsArray() @ArrayMaxSize(100) @IsUUID("4", { each: true }) ids!: string[];
}

/** POST /memory/expire — expire live memories (optional scope filter). */
export class MemoryExpireDto {
  @IsOptional() @IsEnum(MemoryScope) scope?: MemoryScope;
}

/** GET /memory/audit — audit trail query. */
export class MemoryAuditQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsUUID() memoryId?: string;
  @IsOptional() @IsEnum(MemoryScope) scope?: MemoryScope;
}
