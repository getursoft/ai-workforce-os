import type { AvailablePlugin, PluginHealthStatus } from "./plugin-api";
export function canInstallPlugin(plugin: AvailablePlugin) {
  return !plugin.installed;
}
export function displayedHealth(status: PluginHealthStatus | null | undefined): PluginHealthStatus {
  return status ?? "UNKNOWN";
}
export function isHealthPending(
  isPending: boolean,
  variables: string | undefined,
  installationId: string
) {
  return isPending && variables === installationId;
}
