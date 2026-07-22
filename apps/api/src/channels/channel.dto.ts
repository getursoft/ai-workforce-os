import { ChannelConnectionStatus, ChannelMessageDirection, ChannelMessageStatus } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested
} from "class-validator";

export class ChannelConfigurationDto {
  @IsOptional()
  @IsString()
  @Matches(/^AC[a-zA-Z0-9]{32}$/, { message: "accountSid must be a valid Twilio Account SID" })
  accountSid?: string;

  @IsOptional() @IsString() @MaxLength(128) authToken?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(whatsapp:)?\+[1-9]\d{6,14}$/, {
    message: "fromNumber must be an E.164 phone number, optionally prefixed with whatsapp:"
  })
  fromNumber?: string;
}

export class CreateChannelDto {
  @IsString() @Length(1, 160) name!: string;
  @IsIn(["TWILIO"]) provider!: "TWILIO";
  @IsIn(["WHATSAPP"]) channelType!: "WHATSAPP";
  @IsUUID() agentId!: string;
  @ValidateNested() @Type(() => ChannelConfigurationDto) configuration!: ChannelConfigurationDto;
}

export class UpdateChannelDto {
  @IsOptional() @IsString() @Length(1, 160) name?: string;
  @IsOptional() @IsUUID() agentId?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => ChannelConfigurationDto)
  configuration?: ChannelConfigurationDto;
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
