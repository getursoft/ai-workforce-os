import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { ServiceAccountController } from "./service-account.controller";
import { ServiceAccountService } from "./service-account.service";
@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [ServiceAccountController],
  providers: [ServiceAccountService],
  exports: [ServiceAccountService]
})
export class ServiceAccountModule {}
