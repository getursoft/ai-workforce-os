import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { AgentController } from "./agent.controller";
import { AgentService, MemoryService } from "./agent.service";

@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [AgentController],
  providers: [MemoryService, AgentService],
  exports: [AgentService, MemoryService]
})
export class AgentModule {}
