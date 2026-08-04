import { IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, Max, Min } from "class-validator";

export const JOB_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED", "FAILED"] as const;
export const TRIGGER_TYPES = [
  "ONE_TIME",
  "CRON",
  "INTERVAL",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "EVENT",
  "DATE",
  "AFTER_APPROVAL",
  "AFTER_BOOKING",
  "AFTER_WORKFLOW",
  "AFTER_PAYMENT",
  "AFTER_UPLOAD"
] as const;
export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT", "CRITICAL"] as const;
export const EXECUTION_STATUSES = [
  "QUEUED",
  "RUNNING",
  "FAILED",
  "RETRYING",
  "COMPLETED",
  "CANCELLED",
  "TIMEOUT",
  "DEAD_LETTERED"
] as const;

export class CreateScheduleDto {
  @IsString()
  definitionKey!: string;

  @IsIn(TRIGGER_TYPES)
  triggerType!: (typeof TRIGGER_TYPES)[number];

  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsString()
  workflowId?: string;

  @IsOptional()
  @IsString()
  cronExpression?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  intervalMs?: number;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsIn(PRIORITIES)
  priority?: (typeof PRIORITIES)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  maxRetry?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  timeoutMs?: number;

  @IsOptional()
  @IsISO8601()
  nextRun?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  dedupeKey?: string;
}

export class CreateOneShotScheduleDto extends CreateScheduleDto {}

export class InstantiateTemplateDto {
  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsIn(PRIORITIES)
  priority?: (typeof PRIORITIES)[number];

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

export class ListJobsQueryDto {
  @IsOptional()
  @IsIn(JOB_STATUSES)
  status?: string;

  @IsOptional()
  @IsIn(TRIGGER_TYPES)
  triggerType?: string;

  @IsOptional()
  @IsString()
  definitionKey?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class ListExecutionsQueryDto {
  @IsOptional()
  @IsIn(EXECUTION_STATUSES)
  status?: string;

  @IsOptional()
  @IsString()
  jobId?: string;

  @IsOptional()
  @IsString()
  definitionKey?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
