import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { PluginModule } from "../plugins/plugin.module";
import { AgentModule } from "../agents/agent.module";
import { ChannelController } from "./channel.controller";
import { ChannelWebhookController } from "./channel-webhook.controller";
import { MetaWebhookController } from "./meta-webhook.controller";
import { ChannelService } from "./channel.service";
import { ChannelMessageProcessor } from "./channel-message.processor";
import { EmployeeRouterService } from "./employee-router.service";

@Module({
  imports: [PrismaModule, IdentityModule, PluginModule, AgentModule],
  controllers: [ChannelController, ChannelWebhookController, MetaWebhookController],
  providers: [ChannelService, ChannelMessageProcessor, EmployeeRouterService],
  exports: [ChannelService]
})
export class ChannelModule {}
