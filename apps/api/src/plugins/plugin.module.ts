import { Module } from "@nestjs/common";
import { resolve } from "node:path";
import { IdentityModule } from "../identity/identity.module";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { EntitlementModule } from "../entitlements/entitlement.module";
import { AiConfigurationModule } from "../ai-configuration/ai-configuration.module";
import { PluginController } from "./plugin.controller";
import { PluginService } from "./plugin.service";
import { PluginAiService } from "./plugin-ai.service";
import { EmailConfigurationService } from "./email-configuration.service";
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
  imports: [PrismaModule, IdentityModule, EntitlementModule, AiConfigurationModule],
  controllers: [PluginController],
  providers: [
    ManifestValidator,
    ConfigurationSchemaValidator,
    PluginRegistry,
    PluginLifecycleEngine,
    PluginEventBus,
    {
      provide: PluginDiscovery,
      inject: [ManifestValidator, SECURITY_CONFIG],
      useFactory: (validator: ManifestValidator, config: SecurityConfig) =>
        new PluginDiscovery(
          config.pluginDirectory || resolve(__dirname, "../../../../plugins"),
          validator
        )
    },
    {
      provide: PluginSecretsEncryptionService,
      inject: [SECURITY_CONFIG],
      useFactory: (config: SecurityConfig) =>
        new PluginSecretsEncryptionService(
          config.pluginSecrets.encryptionKey,
          config.pluginSecrets.previousKey,
          config.pluginSecrets.currentVersion,
          config.pluginSecrets.previousVersion
        )
    },
    SafeHttpTool,
    PluginAiService,
    EmailConfigurationService,
    PluginService
  ],
  exports: [
    PluginRegistry,
    PluginService,
    PluginAiService,
    EmailConfigurationService,
    PluginSecretsEncryptionService,
    SafeHttpTool
  ]
})
export class PluginModule {}
