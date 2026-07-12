import { Module } from "@nestjs/common";
import { IdentityModule } from "./identity/identity.module";
import { TeamModule } from "./teams/team.module";

@Module({ imports: [IdentityModule, TeamModule] })
export class AppModule {}
