import { KnowledgeDocumentStatus } from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
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
}
export class KnowledgeSearchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  query!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10) topK = 5;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-1) @Max(1) scoreThreshold = 0.2;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID("4", { each: true })
  documentIds?: string[];
}
