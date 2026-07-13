import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { PluginController } from "./plugin.controller";
import { PluginService } from "./plugin.service";
import {
  ConfigurationSchemaValidator,
  ManifestValidator,
  PluginRegistry,
  PluginSecretsEncryptionService
} from "./plugin.runtime";

@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [PluginController],
  providers: [
    ManifestValidator,
    ConfigurationSchemaValidator,
    PluginRegistry,
    {
      provide: PluginSecretsEncryptionService,
      inject: [SECURITY_CONFIG],
      useFactory: (config: SecurityConfig) =>
        new PluginSecretsEncryptionService(config.pluginSecrets.encryptionKey)
    },
    PluginService
  ],
  exports: [PluginRegistry, PluginService]
})
export class PluginModule {}
