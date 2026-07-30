import { KnowledgeDocumentStatus } from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength
} from "class-validator";

export class KnowledgePageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsString() @MaxLength(160) search?: string;
  @IsOptional() @IsEnum(KnowledgeDocumentStatus) status?: KnowledgeDocumentStatus;
  @IsOptional() @IsUUID("4") collectionId?: string;
}

export class KnowledgeSearchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  query!: string;
  /** Server-side default/ceiling come from SecurityConfig.knowledge (searchDefaultTopK/searchMaxTopK). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) topK?: number;
  /** Server-side default comes from SecurityConfig.knowledge.searchDefaultScoreThreshold. */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-1) @Max(1) scoreThreshold?: number;
  @IsOptional() @IsUUID("4") collectionId?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID("4", { each: true })
  documentIds?: string[];
  /** Only takes effect when KNOWLEDGE_RETRIEVAL_DEBUG_LOGGING is also enabled server-side. */
  @IsOptional() @IsBoolean() debug?: boolean;
}

export class KnowledgeCollectionCreateDto {
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(80) domain?: string;
}

export class KnowledgeCollectionUpdateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(80) domain?: string;
}
