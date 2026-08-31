import { Module } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { PlatformLeadService } from "./platform-lead.service";
import { PlatformLeadsController } from "./platform-leads.controller";
import { PlatformLeadsPublicController } from "./platform-leads-public.controller";

@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [PlatformLeadsController, PlatformLeadsPublicController],
  providers: [PlatformLeadService],
  exports: [PlatformLeadService]
})
export class PlatformLeadsModule {}
