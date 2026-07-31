import { IsArray, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdatePaymentSettingsDto {
  @IsOptional() @IsString() @MaxLength(120) keyId?: string;
  @IsOptional() @IsString() @MaxLength(120) keySecret?: string;
  @IsOptional() @IsArray() @IsIn(["keySecret"], { each: true }) removeSecrets?: string[];
}
