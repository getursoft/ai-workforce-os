import { Module } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { EntitlementService } from "./entitlement.service";

@Module({
  imports: [PrismaModule, IdentityModule],
  providers: [EntitlementService],
  exports: [EntitlementService]
})
export class EntitlementModule {}
