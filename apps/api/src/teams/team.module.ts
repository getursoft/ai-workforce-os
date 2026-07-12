import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { TeamController } from "./team.controller";
import { TeamService } from "./team.service";
@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [TeamController],
  providers: [TeamService],
  exports: [TeamService]
})
export class TeamModule {}
