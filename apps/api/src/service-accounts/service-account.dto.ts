import { ApiKeyEnvironment, ServiceAccountStatus } from "@prisma/client";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min
} from "class-validator";
export class ServiceAccountQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsEnum(ServiceAccountStatus) status?: ServiceAccountStatus;
}
export class CreateServiceAccountDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(10) @IsUUID("4", { each: true }) roleIds!: string[];
}
export class UpdateServiceAccountDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsEnum(ServiceAccountStatus) status?: ServiceAccountStatus;
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(10)
  @IsUUID("4", { each: true })
  roleIds?: string[];
}
export class CreateApiKeyDto {
  @IsString() @Length(1, 120) name!: string;
  @IsEnum(ApiKeyEnvironment) environment!: ApiKeyEnvironment;
  @IsOptional() @IsDateString() expiresAt?: string;
}
