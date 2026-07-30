import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { IdentityModule } from "./identity/identity.module";
import { TeamModule } from "./teams/team.module";
import { ServiceAccountModule } from "./service-accounts/service-account.module";
import { PluginModule } from "./plugins/plugin.module";
import { AgentModule } from "./agents/agent.module";
import { ConnectorModule } from "./connectors/connector.module";
import { ProductionModule } from "./production/production.module";
import { KnowledgeModule } from "./knowledge/knowledge.module";
import { ChannelModule } from "./channels/channel.module";
import { TravelModule } from "./travel/travel.module";
import { ApprovalModule } from "./workflows/approval/approval.module";
import { BillingModule } from "./billing/billing.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    IdentityModule,
    TeamModule,
    ServiceAccountModule,
    PluginModule,
    ConnectorModule,
    AgentModule,
    KnowledgeModule,
    ChannelModule,
    TravelModule,
    ApprovalModule,
    BillingModule,
    ProductionModule,
  ],
})
export class AppModule {}