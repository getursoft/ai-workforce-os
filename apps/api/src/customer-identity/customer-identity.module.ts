import { Module } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { CustomerIdentityService } from "./customer-identity.service";

@Module({
  imports: [PrismaModule],
  providers: [CustomerIdentityService],
  exports: [CustomerIdentityService]
})
export class CustomerIdentityModule {}
