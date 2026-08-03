import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class ObservabilityDateRangeQueryDto {
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

export class ListTracesQueryDto extends ObservabilityDateRangeQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
  @IsOptional() @IsIn(["RUNNING", "COMPLETED", "FAILED"]) status?: string;
  @IsOptional() @IsString() @MaxLength(200) channelConnectionId?: string;
  @IsOptional() @IsString() @MaxLength(200) errorCode?: string;
}

export class ListAlertsQueryDto {
  @IsOptional() @IsIn(["OPEN", "ACKNOWLEDGED", "RESOLVED", "SUPPRESSED"]) status?: string;
}

export class ListErrorsQueryDto extends ObservabilityDateRangeQueryDto {}
