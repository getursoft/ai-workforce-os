import { PluginAiProviderType, PluginStatus } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsArray,
  IsEnum,
  IsInt,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  ValidateNested,
  Max,
  MaxLength,
  Min
} from "class-validator";
import { PluginPermission } from "@ai-workforce-os/plugin-sdk";

export class PluginQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsEnum(PluginStatus) status?: PluginStatus;
}
export class InstallPluginDto {
  @IsOptional() @IsObject() manifest?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(100) pluginId?: string;
  @IsOptional()
  @IsArray()
  @IsEnum(PluginPermission, { each: true })
  grantedPermissions?: PluginPermission[];
  @IsOptional() enable?: boolean;
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
export class UpdatePluginGrantsDto {
  @IsArray()
  @IsString({ each: true })
  grantedPermissions!: string[];
}

export class PluginAiSecretsDto {
  @IsOptional() @IsString() @MaxLength(10000) apiKey?: string;
}

export class UpdatePluginAiConfigurationDto {
  @IsOptional() @IsEnum(PluginAiProviderType) providerType?: PluginAiProviderType;
  @IsOptional() @IsString() @MaxLength(200) model?: string;
  @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(1000) baseUrl?: string;
  @IsOptional()
  @IsUrl({ protocols: ["https"], require_protocol: true })
  @MaxLength(1000)
  endpoint?: string;
  @IsOptional() @IsString() @MaxLength(200) deploymentName?: string;
  @IsOptional() @IsString() @MaxLength(100) apiVersion?: string;
  @IsOptional() @IsInt() @Min(1000) @Max(120000) timeoutMs?: number;
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => PluginAiSecretsDto)
  secrets?: PluginAiSecretsDto;
  @IsOptional() @IsArray() @IsIn(["apiKey"], { each: true }) removeSecrets?: string[];
}

export class PluginChatMessageDto {
  @IsIn(["user", "assistant"]) role!: "user" | "assistant";
  @IsString() @MaxLength(12000) content!: string;
}
export class PluginChatDto {
  @IsString() @MaxLength(12000) message!: string;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PluginChatMessageDto)
  conversation?: PluginChatMessageDto[];
}
