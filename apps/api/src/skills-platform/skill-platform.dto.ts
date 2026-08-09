import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested
} from "class-validator";

export class SkillInstallDto {
  @IsString() @MaxLength(160) skillKey!: string;
  @IsOptional() @IsString() @MaxLength(80) versionConstraint?: string;
  @IsOptional() @IsObject() configuration?: Record<string, unknown>;
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** Must be true to install a skill requesting a sensitive capability (network.external). */
  @IsOptional() @IsBoolean() approveSensitivePermissions?: boolean;
}

export class SkillConfigureDto {
  @IsObject() configuration!: Record<string, unknown>;
}

export class SkillVersionUpdateDto {
  @IsString() @MinLength(1) @MaxLength(80) versionConstraint!: string;
}

export class SkillGrantDto {
  @IsUUID("4") pluginInstallationId!: string;
  @IsOptional() @IsObject() configurationOverride?: Record<string, unknown>;
}

export class SkillGrantStateDto {
  @IsBoolean() enabled!: boolean;
}

export class SkillExecuteDto {
  @IsString() @MaxLength(160) skillKey!: string;
  @IsOptional() @IsString() @MaxLength(80) versionConstraint?: string;
  @IsOptional() @IsUUID("4") pluginInstallationId?: string;
  @IsOptional() @IsUUID("4") conversationId?: string;
  @IsOptional() @IsUUID("4") agentExecutionId?: string;
  @IsOptional() @IsUUID("4") workflowExecutionId?: string;
  @IsOptional() @IsString() @MaxLength(120) idempotencyKey?: string;
  @IsOptional() @IsObject() input?: unknown;
}

export class SkillPageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

// ------------------------------------------------------------------ Sprint 6.1B — Enterprise Completion

export class SkillRecommendQueryDto {
  @IsOptional() @IsUUID("4") pluginInstallationId?: string;
  @IsOptional() @IsString() @MaxLength(2000) message?: string;
  @IsOptional() @IsString() @MaxLength(200) intent?: string;
  @IsOptional() @IsString() @MaxLength(200) contentType?: string;
  /** Comma-separated MIME types of any files the employee is currently handling. */
  @IsOptional() @IsString() @MaxLength(500) mimeTypes?: string;
}

export class SkillSearchQueryDto {
  @IsOptional() @IsString() @MaxLength(200) query?: string;
  @IsOptional() @IsString() @MaxLength(100) category?: string;
  @IsOptional() @IsString() @MaxLength(100) capability?: string;
  @IsOptional() @IsString() @MaxLength(160) mimeType?: string;
  @IsOptional() @IsString() @MaxLength(100) industry?: string;
  @IsOptional() @IsString() @MaxLength(100) tag?: string;
  @IsOptional() @IsString() @MaxLength(160) author?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() installed?: boolean;
}

export class SkillAnalyticsQueryDto {
  @IsOptional() @IsString() @MaxLength(40) from?: string;
  @IsOptional() @IsString() @MaxLength(40) to?: string;
  @IsOptional() @IsString() @MaxLength(160) skillKey?: string;
  @IsOptional() @IsUUID("4") pluginInstallationId?: string;
}

export class SkillPipelineNodeDto {
  @IsInt() @Min(1) order!: number;
  @IsString() @MaxLength(160) skillKey!: string;
  @IsOptional() @IsString() @MaxLength(80) versionConstraint?: string;
  @IsOptional() @IsString() @MaxLength(500) conditionExpression?: string;
  @IsOptional() @IsIn(["STOP", "CONTINUE"]) onFailure?: "STOP" | "CONTINUE";
  @IsOptional() @IsInt() @Min(1) @Max(300_000) timeoutMs?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5) maxRetries?: number;
  @IsOptional() @IsBoolean() useTriggerInput?: boolean;
  @IsOptional() @IsObject() staticInput?: Record<string, unknown>;
}

export class SkillPipelineCreateDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsString() @MaxLength(2000) description!: string;
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => SkillPipelineNodeDto) nodes!: SkillPipelineNodeDto[];
}

export class SkillPipelineExecuteDto {
  @IsOptional() @IsObject() input?: unknown;
  @IsOptional() @IsUUID("4") pluginInstallationId?: string;
  @IsOptional() @IsUUID("4") conversationId?: string;
  @IsOptional() @IsUUID("4") workflowExecutionId?: string;
}

export class SkillPackInstallDto {
  @IsString() @MaxLength(160) packKey!: string;
  @IsOptional() @IsBoolean() approveSensitivePermissions?: boolean;
}

export class SkillTemplateInstallDto {
  @IsString() @MaxLength(160) templateKey!: string;
  @IsOptional() @IsUUID("4") pluginInstallationId?: string;
  @IsOptional() @IsBoolean() approveSensitivePermissions?: boolean;
}
