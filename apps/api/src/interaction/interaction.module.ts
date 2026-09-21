/** Sprint 7.12 — Interaction & Notification layer. @Global() so any domain (agents, channels, voice) can
 * inject InteractionService without an explicit imports[] wire, matching NotificationsModule's own
 * @Global() convention for EmailService. */
import { Global, Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { InteractionMetricsService } from "./interaction-metrics.service";
import { InteractionService } from "./interaction.service";
import { InteractionCompletionService } from "./interaction-completion.service";
import { InteractionReferenceLookupService } from "./interaction-reference-lookup.service";
import { InteractionNotificationOrchestrator } from "./interaction-notification.orchestrator";
import { MockSmsProvider } from "./sms/mock-sms.provider";
import { TwilioSmsProvider } from "./sms/twilio-sms.provider";
import { InteractionController } from "./interaction.controller";
import { InteractionAdminService } from "./interaction-admin.service";

@Global()
@Module({
  // No ChannelModule import here: AgentModule (a ChannelModule dependency) optionally injects
  // InteractionService back, which is a genuine circular module dependency. Rather than fight Nest's
  // module-initialization order with forwardRef() (which still failed — a @Global() module transitively
  // depended on by its own import deadlocks regardless), InteractionNotificationOrchestrator resolves
  // ChannelMessageProcessor lazily via ModuleRef instead — the exact same pattern AgentService already
  // uses for ChatDelegationTriggerService/ReceptionistRuntime for this identical reason (see
  // agent.service.ts's own doc comments on getChatDelegationTrigger/getReceptionistRuntime).
  imports: [PrismaModule, IdentityModule],
  controllers: [InteractionController],
  providers: [
    InteractionService,
    InteractionCompletionService,
    InteractionReferenceLookupService,
    InteractionNotificationOrchestrator,
    InteractionMetricsService,
    InteractionAdminService,
    MockSmsProvider,
    TwilioSmsProvider
  ],
  exports: [
    InteractionService,
    InteractionCompletionService,
    InteractionReferenceLookupService,
    InteractionNotificationOrchestrator,
    InteractionMetricsService
  ]
})
export class InteractionModule {}
