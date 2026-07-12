import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength
} from "class-validator";
import { UserStatus } from "@prisma/client";

export class PageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
}
export class CreateUserDto {
  @IsString() @Length(1, 80) firstName!: string;
  @IsOptional() @IsString() @MaxLength(80) lastName?: string;
  @IsEmail() @MaxLength(320) email!: string;
  @IsString() @MinLength(12) @MaxLength(128) password!: string;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(10) @IsUUID("4", { each: true }) roleIds!: string[];
}
export class UpdateUserDto {
  @IsOptional() @IsString() @Length(1, 80) firstName?: string;
  @IsOptional() @IsString() @MaxLength(80) lastName?: string;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
}
export class AssignRolesDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(10) @IsUUID("4", { each: true }) roleIds!: string[];
}
export class CreateRoleDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 80)
  name!: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID("4", { each: true }) permissionIds?: string[];
}
export class UpdateRoleDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
}
export class AssignPermissionsDto {
  @IsArray() @ArrayMaxSize(100) @IsUUID("4", { each: true }) permissionIds!: string[];
}
export class CreateInvitationDto {
  @IsEmail() @MaxLength(320) email!: string;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(10) @IsUUID("4", { each: true }) roleIds!: string[];
}
export class AcceptInvitationDto {
  @IsString() @MinLength(40) @MaxLength(100) token!: string;
  @IsString() @Length(1, 80) firstName!: string;
  @IsOptional() @IsString() @MaxLength(80) lastName?: string;
  @IsString() @MinLength(12) @MaxLength(128) password!: string;
}
