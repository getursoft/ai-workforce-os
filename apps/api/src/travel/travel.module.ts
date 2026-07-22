import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { AgentModule } from "../agents/agent.module";
import { TravelEmployeeController } from "./travel.controller";
import { TravelEmployeeService } from "./travel.service";

@Module({
  imports: [PrismaModule, IdentityModule, AgentModule],
  controllers: [TravelEmployeeController],
  providers: [TravelEmployeeService],
  exports: [TravelEmployeeService]
})
export class TravelModule {}
