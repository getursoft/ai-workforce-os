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
import { WHATSAPP_SENDER } from "../interaction/whatsapp-sender.types";

@Module({
  imports: [PrismaModule, IdentityModule, PluginModule, AgentModule],
  controllers: [ChannelController, ChannelWebhookController, MetaWebhookController],
  providers: [
    ChannelService,
    ChannelMessageProcessor,
    EmployeeRouterService,
    // Sprint 7.12 STEP 16 — bound behind a token (not the concrete class) so
    // InteractionNotificationOrchestrator can resolve it via ModuleRef without a circular file import
    // through AgentService (see whatsapp-sender.types.ts).
    { provide: WHATSAPP_SENDER, useExisting: ChannelMessageProcessor }
  ],
  exports: [ChannelService, ChannelMessageProcessor, WHATSAPP_SENDER]
})
export class ChannelModule {}
