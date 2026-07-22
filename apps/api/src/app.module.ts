import { Module } from "@nestjs/common";
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

@Module({
  imports: [
    IdentityModule,
    TeamModule,
    ServiceAccountModule,
    PluginModule,
    ConnectorModule,
    AgentModule,
    KnowledgeModule,
    ChannelModule,
    TravelModule,
    ProductionModule
  ]
})
export class AppModule {}
