import { PluginAiProviderType, AiProfilePurpose } from "@prisma/client";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Max,
  MaxLength,
  Min
} from "class-validator";

export class CreateAiProviderConnectionDto {
  @IsString() @MaxLength(120) name!: string;
  @IsEnum(PluginAiProviderType) providerType!: PluginAiProviderType;
  @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(500) baseUrl?: string;
  @IsOptional() @IsString() @MaxLength(4000) apiKey?: string;
  @IsOptional() @IsObject() metadataJson?: Record<string, unknown>;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdateAiProviderConnectionDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(500) baseUrl?: string;
  /** Write-only: a new key rotates the stored credential. Omit to keep the existing one — this
   *  endpoint never returns the current value, so there is nothing to "leave unchanged" by echo. */
  @IsOptional() @IsString() @MaxLength(4000) apiKey?: string;
  @IsOptional() @IsBoolean() removeCredential?: boolean;
  @IsOptional() @IsObject() metadataJson?: Record<string, unknown>;
  @IsOptional() @IsEnum(["ACTIVE", "DISABLED"]) status?: "ACTIVE" | "DISABLED";
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class CreateAiModelProfileDto {
  @IsString() @MaxLength(120) name!: string;
  @IsUUID() providerConnectionId!: string;
  @IsEnum(AiProfilePurpose) purpose!: AiProfilePurpose;
  @IsOptional() @IsString() @MaxLength(160) model?: string;
  @IsOptional() @IsString() @MaxLength(160) embeddingModel?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(2) temperature?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) maxOutputTokens?: number;
  @IsOptional() @IsInt() @Min(1000) @Max(120000) timeoutMs?: number;
  @IsOptional() @IsObject() additionalSettingsJson?: Record<string, unknown>;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateAiModelProfileDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsUUID() providerConnectionId?: string;
  @IsOptional() @IsEnum(AiProfilePurpose) purpose?: AiProfilePurpose;
  @IsOptional() @IsString() @MaxLength(160) model?: string;
  @IsOptional() @IsString() @MaxLength(160) embeddingModel?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(2) temperature?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) maxOutputTokens?: number;
  @IsOptional() @IsInt() @Min(1000) @Max(120000) timeoutMs?: number;
  @IsOptional() @IsObject() additionalSettingsJson?: Record<string, unknown>;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpsertEmployeeAiProfileAssignmentDto {
  @IsUUID() modelProfileId!: string;
  @IsEnum(AiProfilePurpose) purpose!: AiProfilePurpose;
}

export class UpdateOrganizationAiDefaultsDto {
  @IsOptional() @IsUUID() defaultProfileId?: string | null;
  @IsOptional() @IsUUID() routingProfileId?: string | null;
  @IsOptional() @IsUUID() reasoningProfileId?: string | null;
  @IsOptional() @IsUUID() embeddingProfileId?: string | null;
}
