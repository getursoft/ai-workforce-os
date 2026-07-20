import { Module } from "@nestjs/common";
import { IdentityModule } from "./identity/identity.module";
import { TeamModule } from "./teams/team.module";
import { ServiceAccountModule } from "./service-accounts/service-account.module";
import { PluginModule } from "./plugins/plugin.module";
import { AgentModule } from "./agents/agent.module";
import { ConnectorModule } from "./connectors/connector.module";

@Module({
  imports: [
    IdentityModule,
    TeamModule,
    ServiceAccountModule,
    PluginModule,
    ConnectorModule,
    AgentModule
  ]
})
export class AppModule {}
