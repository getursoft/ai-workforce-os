import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested
} from "class-validator";

export class DelegateTaskConstraintsDto {
  @IsOptional() @IsBoolean() readOnly?: boolean;
  @IsOptional() @IsBoolean() requiresApproval?: boolean;
  @IsOptional() @IsInt() @Min(100) @Max(120_000) timeoutMs?: number;
}

export class DelegateTaskDto {
  @IsUUID() sourceEmployeeInstallationId!: string;
  @IsOptional() @IsUUID() targetEmployeeInstallationId?: string;
  @IsString() @IsNotEmpty() @MaxLength(80) taskType!: string;
  @IsOptional() @IsString() @MaxLength(80) targetCapability?: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) objective!: string;
  @IsObject() input!: Record<string, unknown>;
  @IsOptional() @IsObject() expectedOutput?: Record<string, unknown>;
  @IsOptional() @ValidateNested() @Type(() => DelegateTaskConstraintsDto) constraints?: DelegateTaskConstraintsDto;
  @IsOptional() @IsString({ each: true }) @MaxLength(80, { each: true }) requestedMemoryCategories?: string[];
  @IsOptional() @IsIn(["SYNCHRONOUS", "ASYNCHRONOUS"]) mode?: "SYNCHRONOUS" | "ASYNCHRONOUS";
  @IsOptional() @IsString() @MaxLength(500) idempotencyKey?: string;
}

export class ParallelDelegateContractDto {
  @IsOptional() @IsUUID() targetEmployeeInstallationId?: string;
  @IsString() @IsNotEmpty() @MaxLength(80) taskType!: string;
  @IsOptional() @IsString() @MaxLength(80) targetCapability?: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) objective!: string;
  @IsObject() input!: Record<string, unknown>;
  @IsOptional() @IsObject() expectedOutput?: Record<string, unknown>;
  @IsOptional() @ValidateNested() @Type(() => DelegateTaskConstraintsDto) constraints?: DelegateTaskConstraintsDto;
  @IsOptional() @IsString({ each: true }) @MaxLength(80, { each: true }) requestedMemoryCategories?: string[];
}

export class DelegateParallelTaskDto {
  @IsUUID() sourceEmployeeInstallationId!: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ParallelDelegateContractDto) requests!: ParallelDelegateContractDto[];
  @IsIn(["ALL_REQUIRED", "ANY_ONE", "MINIMUM_N", "BEST_EFFORT"]) joinPolicy!: "ALL_REQUIRED" | "ANY_ONE" | "MINIMUM_N" | "BEST_EFFORT";
  @IsOptional() @IsInt() @Min(1) minimumRequired?: number;
  @IsOptional() @IsIn(["SYNCHRONOUS", "ASYNCHRONOUS"]) mode?: "SYNCHRONOUS" | "ASYNCHRONOUS";
}

export class UpdateCollaborationPolicyDto {
  @IsOptional() @IsBoolean() collaborationEnabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(5) maximumDelegationDepth?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) maximumTasksPerParentExecution?: number;
  @IsOptional() @IsUUID("4", { each: true }) allowedSourceEmployeeIds?: string[];
  @IsOptional() @IsUUID("4", { each: true }) allowedTargetEmployeeIds?: string[];
  @IsOptional() @IsString({ each: true }) allowedTaskTypes?: string[];
  @IsOptional() @IsString() @MaxLength(40) crossEmployeeMemorySharingMode?: string;
  @IsOptional() @IsBoolean() requireApprovalForSensitiveDelegation?: boolean;
  @IsOptional() @IsInt() @Min(1000) @Max(120_000) delegationTimeoutMs?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5) retryLimit?: number;
  @IsOptional() @IsBoolean() allowParallelDelegation?: boolean;
  @IsOptional() @IsBoolean() exposeDelegationToUser?: boolean;
}
