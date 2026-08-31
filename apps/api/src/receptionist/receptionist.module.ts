import { Module } from "@nestjs/common";
import { AgentModule } from "../agents/agent.module";
import { CustomerIdentityModule } from "../customer-identity/customer-identity.module";
import { IdentityModule } from "../identity/identity.module";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { PluginModule } from "../plugins/plugin.module";
import { WorkforceModule } from "../workforce/workforce.module";
import { ReceptionistController } from "./receptionist.controller";
import {
  ReceptionistRouteDecisionValidator,
  ReceptionistRoutingService
} from "./receptionist-routing.service";
import { ReceptionistService } from "./receptionist.service";
import { RECEPTIONIST_RUNTIME } from "./receptionist.types";
import { SpecialistPendingInputRegistry, TravelPendingInputResolver } from "./specialist-pending-input";
import { VoiceReceptionistTurnService, VoiceSessionService } from "./voice-channel.adapter";
import { WorkforceDirectoryService } from "./workforce-directory.service";

@Module({
  imports: [
    PrismaModule,
    IdentityModule,
    PluginModule,
    AgentModule,
    CustomerIdentityModule,
    WorkforceModule
  ],
  controllers: [ReceptionistController],
  providers: [
    WorkforceDirectoryService,
    ReceptionistRouteDecisionValidator,
    ReceptionistRoutingService,
    ReceptionistService,
    VoiceSessionService,
    VoiceReceptionistTurnService,
    TravelPendingInputResolver,
    SpecialistPendingInputRegistry,
    { provide: RECEPTIONIST_RUNTIME, useExisting: ReceptionistService }
  ],
  exports: [
    WorkforceDirectoryService,
    ReceptionistRoutingService,
    ReceptionistService,
    VoiceSessionService,
    VoiceReceptionistTurnService,
    RECEPTIONIST_RUNTIME
  ]
})
export class ReceptionistModule {}
