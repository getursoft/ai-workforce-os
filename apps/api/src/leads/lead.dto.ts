import { LeadPriority, LeadSource, LeadStatus } from "@prisma/client";
import { Type } from "class-transformer";
import { IsDateString, IsEmail, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator";

export class ListLeadsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsEnum(LeadStatus) status?: LeadStatus;
  @IsOptional() @IsEnum(LeadSource) source?: LeadSource;
  @IsOptional() @IsUUID() agentId?: string;
  @IsOptional() @IsUUID() assignedToUserId?: string;
  @IsOptional() @IsString() @MaxLength(160) search?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
}

export class CreateLeadDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(24) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(160) email?: string;
  @IsOptional() @IsString() @MaxLength(2000) requirement?: string;
  @IsOptional() @IsEnum(LeadPriority) priority?: LeadPriority;
  @IsOptional() @IsUUID() assignedToUserId?: string;
}

export class UpdateLeadDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(24) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(160) email?: string;
  @IsOptional() @IsString() @MaxLength(2000) requirement?: string;
  @IsOptional() @IsEnum(LeadStatus) status?: LeadStatus;
  @IsOptional() @IsEnum(LeadPriority) priority?: LeadPriority;
}

export class AssignLeadDto {
  @IsOptional() @IsUUID() assignedToUserId?: string | null;
}

export class AddLeadNoteDto {
  @IsString() @MinLength(1) @MaxLength(2000) note!: string;
}
