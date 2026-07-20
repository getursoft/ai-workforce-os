import { ConnectorInstallationStatus, ConnectorEventStatus } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsArray,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min
} from "class-validator";

export class ConnectorPageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}
export class ConnectorInstallationQueryDto extends ConnectorPageDto {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsEnum(ConnectorInstallationStatus) status?: ConnectorInstallationStatus;
}
export class InstallConnectorDto {
  @IsString() @Length(2, 100) connectorKey!: string;
  @IsString() @Length(1, 160) displayName!: string;
  @IsOptional() @IsObject() configuration?: Record<string, unknown>;
  @IsOptional() @IsObject() credentials?: Record<string, string>;
  @IsOptional() @IsArray() @IsString({ each: true }) grantedCapabilities?: string[];
  @IsOptional() credentialExpiresAt?: string;
}
export class UpdateConnectorDto {
  @IsOptional() @IsString() @Length(1, 160) displayName?: string;
}
export class UpdateConnectorConfigurationDto {
  @IsObject() configuration!: Record<string, unknown>;
}
export class UpdateConnectorCredentialsDto {
  @IsObject() credentials!: Record<string, string>;
  @IsOptional() credentialExpiresAt?: string;
}
export class UpdateConnectorCapabilitiesDto {
  @IsArray() @IsString({ each: true }) grantedCapabilities!: string[];
}
export class ConnectorEventDto {
  @IsString() @Length(1, 120) eventType!: string;
  @IsString() @Length(1, 255) externalEventId!: string;
  @IsObject() payload!: Record<string, unknown>;
}
export class ConnectorEventQueryDto extends ConnectorPageDto {
  @IsOptional() @IsEnum(ConnectorEventStatus) status?: ConnectorEventStatus;
}
