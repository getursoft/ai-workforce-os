import { Transform } from "class-transformer";
import { IsOptional, IsString, Length, MaxLength } from "class-validator";

function trim(value: unknown): unknown {
  return typeof value === "string" ? value.trim() : value;
}

export class UpdateOrganizationDto {
  @Transform(({ value }: { value: unknown }) => trim(value))
  @IsString()
  @Length(3, 100)
  name!: string;
}

export class UpdateOrganizationSettingsDto {
  @Transform(({ value }: { value: unknown }) => trim(value))
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @Transform(({ value }: { value: unknown }) => trim(value))
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @Transform(({ value }: { value: unknown }) => trim(value))
  @IsOptional()
  @IsString()
  @MaxLength(35)
  locale?: string;
}
