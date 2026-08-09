import { Injectable, Logger, Module, type OnApplicationBootstrap } from "@nestjs/common";
import { SkillManifestValidator } from "@ai-workforce-os/skill-sdk";
import { IdentityModule } from "../identity/identity.module";
import { EntitlementModule } from "../entitlements/entitlement.module";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { PluginModule } from "../plugins/plugin.module";
import { DocumentReaderSkill } from "./built-in/document-reader.skill";
import { TextSummarizationSkill } from "./built-in/text-summarization.skill";
import { EntityExtractionSkill } from "./built-in/entity-extraction.skill";
import { TranslationSkill } from "./built-in/translation.skill";
import { FileValidationSkill } from "./built-in/file-validation.skill";
import { SkillInstallationService } from "./skill-installation.service";
import { SkillPlatformController } from "./skill-platform.controller";
import { SkillPublisherService } from "./skill-publisher.service";
import { SkillRegistryService } from "./skill-registry.service";
import { SkillsRuntimeService } from "./skill-runtime.service";
import { SkillDependencyResolverService } from "./skill-dependency-resolver.service";
import { SkillRecommendationService } from "./skill-recommendation.service";
import { SkillAnalyticsService } from "./skill-analytics.service";
import { SkillSearchService } from "./skill-search.service";
import { SkillPipelineService } from "./skill-pipeline.service";
import { SkillPackService } from "./skill-pack.service";
import { SkillPackPublisherService } from "./skill-pack-publisher.service";
import { SkillTemplateService } from "./skill-template.service";
import { SkillTemplatePublisherService } from "./skill-template-publisher.service";
import { SkillRegistryMetadataService } from "./skill-registry-metadata.service";

/**
 * Sprint 6.1 — Universal Skills Platform.
 *
 * Registers the built-in skill adapters into the process-local registry at startup, then syncs their
 * manifests into the Skill/SkillVersion tables (idempotent — see SkillPublisherService). The sync is
 * deliberately resilient: a registry or database failure is logged but never crashes the process, so a
 * deployment with missing/unmigrated skill tables still boots (the platform simply has no installable
 * skills until it can sync).
 */
@Injectable()
export class SkillPlatformBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SkillPlatformBootstrapService.name);

  constructor(
    private readonly registry: SkillRegistryService,
    private readonly publisher: SkillPublisherService,
    private readonly registryMetadata: SkillRegistryMetadataService,
    private readonly packPublisher: SkillPackPublisherService,
    private readonly templatePublisher: SkillTemplatePublisherService,
    private readonly documentReader: DocumentReaderSkill,
    private readonly textSummarization: TextSummarizationSkill,
    private readonly entityExtraction: EntityExtractionSkill,
    private readonly translation: TranslationSkill,
    private readonly fileValidation: FileValidationSkill
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.registry.register(this.documentReader);
    this.registry.register(this.textSummarization);
    this.registry.register(this.entityExtraction);
    this.registry.register(this.translation);
    this.registry.register(this.fileValidation);
    this.logger.log({
      event: "SKILL_PLATFORM_BOOTSTRAPPED",
      registered: this.registry.all().map((adapter) => `${adapter.manifest.key}@${adapter.manifest.version}`)
    });
    try {
      const result = await this.publisher.sync();
      if (result.rejected.length > 0) {
        this.logger.warn({
          event: "SKILL_PUBLICATION_PARTIAL",
          rejected: result.rejected
        });
      }
      // Sprint 6.1B — additive: registry metadata, packs and templates only ever reference skills
      // that just synced above, so they run strictly after the built-in skill publication succeeds.
      await this.registryMetadata.sync();
      await this.packPublisher.sync();
      await this.templatePublisher.sync();
    } catch (error) {
      this.logger.error({
        event: "SKILL_PUBLICATION_SYNC_FAILED",
        error: error instanceof Error ? error.message : "unknown",
        detail: "Skill tables may be unavailable; the platform will retry the sync on the next startup."
      });
    }
  }
}

@Module({
  imports: [IdentityModule, EntitlementModule, KnowledgeModule, PluginModule],
  controllers: [SkillPlatformController],
  providers: [
    SkillManifestValidator,
    SkillRegistryService,
    SkillPublisherService,
    SkillInstallationService,
    SkillsRuntimeService,
    DocumentReaderSkill,
    TextSummarizationSkill,
    EntityExtractionSkill,
    TranslationSkill,
    FileValidationSkill,
    // Sprint 6.1B — Skills Platform Enterprise Completion (additive)
    SkillDependencyResolverService,
    SkillRecommendationService,
    SkillAnalyticsService,
    SkillSearchService,
    SkillPipelineService,
    SkillPackService,
    SkillPackPublisherService,
    SkillTemplateService,
    SkillTemplatePublisherService,
    SkillRegistryMetadataService,
    SkillPlatformBootstrapService
  ],
  exports: [
    SkillsRuntimeService,
    SkillRegistryService,
    SkillInstallationService,
    SkillPublisherService,
    SkillDependencyResolverService,
    SkillRecommendationService,
    SkillAnalyticsService,
    SkillPipelineService,
    SkillPackService,
    SkillTemplateService
  ]
})
export class SkillPlatformModule {}
