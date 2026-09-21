/** Sprint 7.12 STEP 26 — mirrors voice-call-history.dto.ts's exact pagination/filter convention. */
import { InteractionChannel, InteractionStatus } from "@prisma/client";
import { Type } from "class-transformer";
import { IsDateString, IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";

export class InteractionPageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

export class InteractionListQueryDto extends InteractionPageDto {
  @IsOptional() @IsEnum(InteractionStatus) status?: InteractionStatus;
  @IsOptional() @IsEnum(InteractionChannel) channel?: InteractionChannel;
  @IsOptional() @IsUUID() agentId?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
}
