import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { PluginModule } from "../plugins/plugin.module";
import { ConnectorController } from "./connector.controller";
import {
  ConnectorManifestValidator,
  ConnectorRegistry,
  ConnectorSchemaValidator
} from "./connector.runtime";
import { ConnectorService } from "./connector.service";

@Module({
  imports: [PrismaModule, IdentityModule, PluginModule],
  controllers: [ConnectorController],
  providers: [
    ConnectorManifestValidator,
    ConnectorSchemaValidator,
    ConnectorRegistry,
    ConnectorService
  ],
  exports: [ConnectorService]
})
export class ConnectorModule {}
