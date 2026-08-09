import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { FeatureFlagService } from "./feature-flag.service";

@Global()
@Module({
  imports: [PrismaModule],
  providers: [FeatureFlagService],
  exports: [FeatureFlagService]
})
export class FeatureFlagModule {}
