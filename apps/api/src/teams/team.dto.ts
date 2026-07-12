import { TeamMemberRole, TeamStatus } from "@prisma/client";
import { Type } from "class-transformer";
import {
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
export class TeamQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsEnum(TeamStatus) status?: TeamStatus;
  @IsOptional() @IsUUID() managerId?: string;
  @IsOptional() @IsUUID() parentTeamId?: string;
}
export class CreateTeamDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsUUID() managerId?: string;
  @IsOptional() @IsUUID() parentTeamId?: string;
}
export class UpdateTeamDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsUUID() managerId?: string | null;
  @IsOptional() @IsUUID() parentTeamId?: string | null;
  @IsOptional() @IsEnum(TeamStatus) status?: TeamStatus;
}
export class AddTeamMemberDto {
  @IsUUID() userId!: string;
  @IsEnum(TeamMemberRole) role!: TeamMemberRole;
}
export class UpdateTeamMemberDto {
  @IsEnum(TeamMemberRole) role!: TeamMemberRole;
}
export class TeamMemberQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsEnum(TeamMemberRole) role?: TeamMemberRole;
}
