import { Module } from "@nestjs/common";
import { resolve } from "node:path";
import { IdentityModule } from "../identity/identity.module";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { PluginController } from "./plugin.controller";
import { PluginService } from "./plugin.service";
import { PluginAiService } from "./plugin-ai.service";
import { SafeHttpTool } from "./plugin-ai.runtime";
import {
  ConfigurationSchemaValidator,
  ManifestValidator,
  PluginRegistry,
  PluginDiscovery,
  PluginLifecycleEngine,
  PluginEventBus,
  PluginSecretsEncryptionService
} from "./plugin.runtime";

@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [PluginController],
  providers: [
    ManifestValidator,
    ConfigurationSchemaValidator,
    PluginRegistry,
    PluginLifecycleEngine,
    PluginEventBus,
    {
      provide: PluginDiscovery,
      inject: [ManifestValidator],
      useFactory: (validator: ManifestValidator) =>
        new PluginDiscovery(
          process.env.PLUGIN_DIRECTORY?.trim() || resolve(__dirname, "../../../../plugins"),
          validator
        )
    },
    {
      provide: PluginSecretsEncryptionService,
      inject: [SECURITY_CONFIG],
      useFactory: (config: SecurityConfig) =>
        new PluginSecretsEncryptionService(config.pluginSecrets.encryptionKey)
    },
    SafeHttpTool,
    PluginAiService,
    PluginService
  ],
  exports: [
    PluginRegistry,
    PluginService,
    PluginAiService,
    PluginSecretsEncryptionService,
    SafeHttpTool
  ]
})
export class PluginModule {}
