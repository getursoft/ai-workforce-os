import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from "class-validator";
import { TravelLeadStatus } from "@prisma/client";

const BRAND_TONES = ["FRIENDLY", "FORMAL", "CASUAL", "PROFESSIONAL"] as const;

export class UpdateTravelConfigurationDto {
  @IsOptional() @IsString() @MaxLength(2000) persona?: string;

  @IsOptional() @IsString() @Length(1, 1000) welcomeMessage?: string;

  @IsOptional() @IsString() @MaxLength(64) businessHoursTimezone?: string;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "businessHoursStart must be in HH:MM 24-hour format" })
  businessHoursStart?: string;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "businessHoursEnd must be in HH:MM 24-hour format" })
  businessHoursEnd?: string;

  @IsOptional() @IsString() @MaxLength(255) escalationContact?: string;

  @IsOptional() @IsIn(BRAND_TONES) brandTone?: (typeof BRAND_TONES)[number];

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: "defaultCurrency must be a 3-letter ISO currency code" })
  defaultCurrency?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2}(-[A-Z]{2})?$/, { message: "defaultLanguage must be an ISO language tag, e.g. en or en-US" })
  defaultLanguage?: string;
}

export class ListTravelLeadsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsIn(Object.values(TravelLeadStatus)) status?: TravelLeadStatus;
}

export class UpdateTravelLeadStatusDto {
  @IsIn(Object.values(TravelLeadStatus)) status!: TravelLeadStatus;
}
