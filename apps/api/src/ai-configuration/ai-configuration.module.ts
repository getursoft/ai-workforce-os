import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { SECURITY_CONFIG, type SecurityConfig } from "../identity/infrastructure/security/security-config";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { SafeHttpTool } from "../plugins/plugin-ai.runtime";
import { AiConfigurationController } from "./ai-configuration.controller";
import { AiConfigurationResolverService } from "./ai-configuration-resolver.service";
import { AiConfigurationBackfillService } from "./ai-configuration-backfill.service";
import { AiProviderConnectionService } from "./ai-provider-connection.service";
import { AiModelProfileService } from "./ai-model-profile.service";
import { EmployeeAiAssignmentService } from "./employee-ai-assignment.service";

/**
 * Deliberately does NOT import PluginModule, even though it needs the same
 * PluginSecretsEncryptionService construction PluginModule provides — importing PluginModule here
 * would create a module cycle, since PluginModule (via PluginAiService) needs
 * AiConfigurationResolverService from THIS module (see PluginAiService.resolveProvider). Instead
 * this module builds its own PluginSecretsEncryptionService instance from the same SECURITY_CONFIG
 * key material via an identical factory — functionally interchangeable with PluginModule's
 * instance (same key, same algorithm), just a different object, so encryption/decryption stay
 * fully compatible across both. FeatureFlagService comes from the @Global() FeatureFlagModule, so
 * it needs no explicit import here.
 */
@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [AiConfigurationController],
  providers: [
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
    AiConfigurationResolverService,
    AiConfigurationBackfillService,
    AiProviderConnectionService,
    AiModelProfileService,
    EmployeeAiAssignmentService
  ],
  exports: [
    AiConfigurationResolverService,
    AiConfigurationBackfillService,
    AiProviderConnectionService,
    AiModelProfileService,
    EmployeeAiAssignmentService
  ]
})
export class AiConfigurationModule {}
