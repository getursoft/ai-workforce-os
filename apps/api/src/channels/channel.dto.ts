import { ChannelConnectionStatus, ChannelMessageDirection, ChannelMessageStatus } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID,
  Length, Matches, Max, MaxLength, Min, ValidateNested
} from "class-validator";

export class TwilioConfigurationDto {
  @IsOptional() @IsString() @Matches(/^AC[a-zA-Z0-9]{32}$/, { message: "accountSid must be a valid Twilio Account SID" })
  accountSid?: string;
  @IsOptional() @IsString() @MaxLength(128) authToken?: string;
  @IsOptional() @IsString() @Matches(/^(whatsapp:)?\+[1-9]\d{6,14}$/, { message: "fromNumber must be an E.164 phone number" })
  fromNumber?: string;
}

export class MetaWhatsAppConfigurationDto {
  @IsOptional() @IsString() @MaxLength(200) metaAppId?: string;
  @IsOptional() @IsString() @MaxLength(200) metaAppSecret?: string;
  @IsOptional() @IsString() @MaxLength(100) whatsappBusinessAccountId?: string;
  @IsOptional() @IsString() @MaxLength(100) phoneNumberId?: string;
  @IsOptional() @IsString() @Matches(/^\+[1-9]\d{6,14}$/, { message: "displayPhoneNumber must be E.164" })
  displayPhoneNumber?: string;
  @IsOptional() @IsString() @MaxLength(500) accessToken?: string;
  @IsOptional() @IsString() @MaxLength(200) webhookVerifyToken?: string;
  @IsOptional() @IsString() @MaxLength(16) apiVersion?: string;
}

export class CreateChannelDto {
  @IsString() @Length(1, 160) name!: string;
  @IsIn(["TWILIO", "META_CLOUD_API"]) provider!: "TWILIO" | "META_CLOUD_API";
  @IsIn(["WHATSAPP"]) channelType!: "WHATSAPP";
  @IsUUID() agentId!: string;
  @ValidateNested() @Type(() => TwilioConfigurationDto)
  configuration!: TwilioConfigurationDto | MetaWhatsAppConfigurationDto;
}

export class UpdateChannelDto {
  @IsOptional() @IsString() @Length(1, 160) name?: string;
  @IsOptional() @IsUUID() agentId?: string;
  @IsOptional() @ValidateNested() @Type(() => TwilioConfigurationDto)
  configuration?: TwilioConfigurationDto | MetaWhatsAppConfigurationDto;
}

export class ChannelPageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

export class ChannelConversationQueryDto extends ChannelPageDto {
  @IsOptional() @IsEnum(["ACTIVE", "ARCHIVED"]) status?: "ACTIVE" | "ARCHIVED";
}

export class ChannelMessageQueryDto extends ChannelPageDto {
  @IsOptional() @IsEnum(ChannelMessageDirection) direction?: ChannelMessageDirection;
  @IsOptional() @IsEnum(ChannelMessageStatus) status?: ChannelMessageStatus;
  @IsOptional() @IsUUID() conversationId?: string;
}

export class ChannelListQueryDto extends ChannelPageDto {
  @IsOptional() @IsEnum(ChannelConnectionStatus) status?: ChannelConnectionStatus;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
}
