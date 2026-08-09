import { Module } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { EntitlementModule } from "../entitlements/entitlement.module";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";

@Module({
  imports: [PrismaModule, IdentityModule, EntitlementModule],
  controllers: [OnboardingController],
  providers: [OnboardingService]
})
export class OnboardingModule {}
