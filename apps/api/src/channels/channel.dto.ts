import { ChannelConnectionStatus, ChannelMessageDirection, ChannelMessageStatus } from "@prisma/client";
import { Transform, Type, plainToInstance } from "class-transformer";
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

/** `UpdateChannelDto` carries no `provider` (it's immutable once a channel is created — see
 *  `ChannelService.update`, which already looks up the existing row's real provider and branches
 *  accordingly), so there is no sibling field to discriminate on at validation time the way
 *  `CreateChannelDto` can. All fields from both provider shapes are simply optional here; the service
 *  layer — which does know the existing provider — only ever reads the fields relevant to it. */
export class ChannelConfigurationUpdateDto {
  @IsOptional() @IsString() @Matches(/^AC[a-zA-Z0-9]{32}$/, { message: "accountSid must be a valid Twilio Account SID" })
  accountSid?: string;
  @IsOptional() @IsString() @MaxLength(128) authToken?: string;
  @IsOptional() @IsString() @Matches(/^(whatsapp:)?\+[1-9]\d{6,14}$/, { message: "fromNumber must be an E.164 phone number" })
  fromNumber?: string;
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

/** `configuration`'s real shape is decided by the sibling `provider` field, not by anything inside
 *  `configuration` itself, so class-transformer's built-in discriminator (which only inspects the
 *  nested object's own properties) can't pick the right class — a plain `@Type(() => TwilioConfigurationDto)`
 *  silently forced every request through Twilio's shape, rejecting every real Meta field
 *  (`metaAppId`/`metaAppSecret`/...) as "should not exist" regardless of `provider`. This transforms
 *  against the correct class by reading `obj.provider` from the object being transformed. */
function toChannelConfiguration({
  obj,
  value
}: {
  obj: { provider?: string };
  value: unknown;
}): TwilioConfigurationDto | MetaWhatsAppConfigurationDto {
  if (obj.provider === "META_CLOUD_API") return plainToInstance(MetaWhatsAppConfigurationDto, value);
  return plainToInstance(TwilioConfigurationDto, value);
}

export class CreateChannelDto {
  @IsString() @Length(1, 160) name!: string;
  @IsIn(["TWILIO", "META_CLOUD_API"]) provider!: "TWILIO" | "META_CLOUD_API";
  @IsIn(["WHATSAPP"]) channelType!: "WHATSAPP";
  @IsUUID() agentId!: string;
  @ValidateNested() @Transform(toChannelConfiguration)
  configuration!: TwilioConfigurationDto | MetaWhatsAppConfigurationDto;
}

export class UpdateChannelDto {
  @IsOptional() @IsString() @Length(1, 160) name?: string;
  @IsOptional() @IsUUID() agentId?: string;
  @IsOptional() @ValidateNested() @Type(() => ChannelConfigurationUpdateDto)
  configuration?: ChannelConfigurationUpdateDto;
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
