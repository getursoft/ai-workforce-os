import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { PluginModule } from "../plugins/plugin.module";
import { ConnectorModule } from "../connectors/connector.module";
import { AgentController } from "./agent.controller";
import { AgentService, MemoryService } from "./agent.service";
import { KnowledgeModule } from "../knowledge/knowledge.module";

@Module({
  imports: [PrismaModule, IdentityModule, PluginModule, ConnectorModule, KnowledgeModule],
  controllers: [AgentController],
  providers: [MemoryService, AgentService],
  exports: [AgentService, MemoryService]
})
export class AgentModule {}
