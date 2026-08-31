/** Organization-level rollout switch for shared AI provider configuration (see
 *  AiConfigurationResolverService). OFF: legacy per-employee PluginAiConfiguration remains
 *  authoritative, unchanged. ON: the shared resolver is consulted first, falling back to legacy
 *  config when nothing shared is configured yet — existing organizations keep working during
 *  migration even before their backfill has run. Checked via FeatureFlagService.isEnabled(). */
export const SHARED_AI_CONFIGURATION_ENABLED = "SHARED_AI_CONFIGURATION_ENABLED";
