import semver from "semver";
import type { PluginManifest } from "@ai-workforce-os/plugin-sdk";

export type PluginLifecycleStatus = "ACTIVE" | "DISABLED" | "DEPRECATED";
export class PluginAggregate {
  private constructor(
    readonly slug: string,
    private currentStatus: PluginLifecycleStatus,
    private removedAt?: Date
  ) {}
  static install(manifest: PluginManifest) {
    if (manifest.id !== manifest.entryPoint || !semver.valid(manifest.version))
      throw new Error("PLUGIN_MANIFEST_INVALID");
    return new PluginAggregate(manifest.id, "DISABLED");
  }
  get status() {
    return this.currentStatus;
  }
  get deletedAt() {
    return this.removedAt;
  }
  enable() {
    if (this.removedAt) throw new Error("PLUGIN_STATE_CONFLICT");
    if (this.currentStatus === "DEPRECATED") throw new Error("PLUGIN_DEPRECATED");
    this.currentStatus = "ACTIVE";
  }
  disable() {
    if (this.removedAt) throw new Error("PLUGIN_STATE_CONFLICT");
    this.currentStatus = "DISABLED";
  }
  deprecate() {
    if (this.removedAt) throw new Error("PLUGIN_STATE_CONFLICT");
    this.currentStatus = "DEPRECATED";
  }
  remove(now = new Date()) {
    this.currentStatus = "DISABLED";
    this.removedAt ??= now;
  }
}
