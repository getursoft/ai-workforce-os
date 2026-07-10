import { Transform } from "class-transformer";
import { IsEmail, IsOptional, IsString, Length, MaxLength, MinLength } from "class-validator";

export class RegisterOrganizationDto {
  @IsString()
  @Length(2, 120)
  organizationName!: string;

  @IsString()
  @Length(1, 80)
  firstName!: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  lastName?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Length(12, 128)
  password!: string;
}

export class LoginDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class RefreshTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  refreshToken!: string;
}
