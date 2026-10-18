/** Krevia CRM. @Global() so any AI Employee's own lead-capture service (TravelLeadService, a future
 * SalesLeadService, ...) can inject LeadService without an explicit imports[] wire — same convention as
 * InteractionModule (see apps/api/src/interaction/interaction.module.ts's own doc comment). */
import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { LeadController } from "./lead.controller";
import { LeadService } from "./lead.service";

@Global()
@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [LeadController],
  providers: [LeadService],
  exports: [LeadService]
})
export class LeadModule {}
