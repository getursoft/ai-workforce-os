import { PluginStatus } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min
} from "class-validator";

export class PluginQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsEnum(PluginStatus) status?: PluginStatus;
}
export class InstallPluginDto {
  @IsObject() manifest!: Record<string, unknown>;
  @IsOptional() @IsObject() configuration?: {
    config?: Record<string, unknown>;
    secrets?: Record<string, string>;
  };
}
export class UpdatePluginDto {
  @IsOptional() @IsString() @MaxLength(160) displayName?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsObject() manifest?: Record<string, unknown>;
}
export class UpdatePluginConfigurationDto {
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsObject() secrets?: Record<string, string | null>;
}
