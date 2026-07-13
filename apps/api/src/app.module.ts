import { Module } from "@nestjs/common";
import { IdentityModule } from "./identity/identity.module";
import { TeamModule } from "./teams/team.module";
import { ServiceAccountModule } from "./service-accounts/service-account.module";

@Module({ imports: [IdentityModule, TeamModule, ServiceAccountModule] })
export class AppModule {}
