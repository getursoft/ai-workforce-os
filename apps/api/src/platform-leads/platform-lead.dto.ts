import { Transform } from "class-transformer";
import {
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength
} from "class-validator";
import type { PlatformLeadSource, PlatformLeadStatus } from "@prisma/client";

const PLATFORM_LEAD_SOURCES: readonly PlatformLeadSource[] = [
  "WEBSITE_DEMO",
  "CONTACT_SALES",
  "CONTACT_US",
  "WEBSITE_ENQUIRY",
  "OTHER"
];

const PLATFORM_LEAD_STATUSES: readonly PlatformLeadStatus[] = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "DEMO_SCHEDULED",
  "WON",
  "LOST"
];

/**
 * Public, unauthenticated create payload — see PlatformLeadsPublicController. Deliberately has NO
 * organizationId/scope/ownerId field: `whitelist: true, forbidNonWhitelisted: true` on the global
 * ValidationPipe (main.ts) means any such field in the request body causes a 400, not a silently-ignored
 * field — the caller cannot inject tenant ownership or widen scope no matter what it sends.
 */
export class CreatePublicLeadDto {
  @IsIn(PLATFORM_LEAD_SOURCES)
  source!: PlatformLeadSource;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value
  )
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  company?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  requirement?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  preferredDemoDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  preferredDemoTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdatePlatformLeadStatusDto {
  @IsIn(PLATFORM_LEAD_STATUSES)
  status!: PlatformLeadStatus;
}
