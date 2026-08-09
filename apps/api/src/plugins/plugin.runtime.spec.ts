import { describe, expect, it } from "vitest";
import { DummyEchoPlugin, dummyEchoManifest } from "@ai-workforce-os/plugin-dummy";
import { PluginAggregate } from "./plugin.domain";
import {
  ConfigurationSchemaValidator,
  ManifestValidator,
  PluginRegistry,
  PluginSecretsEncryptionService,
  PluginDiscovery,
  PluginLifecycleEngine,
  PluginEventBus,
  createPluginServices,
  requirePluginService,
  PluginPermissionError
} from "./plugin.runtime";
import { PluginPermission } from "@ai-workforce-os/plugin-sdk";
import { resolve } from "node:path";

describe("plugin runtime foundation", () => {
  it("validates manifests and rejects duplicates and invalid versions", () => {
    const validator = new ManifestValidator();
    expect(validator.validate(dummyEchoManifest).id).toBe("dummy-echo");
    expect(() => validator.validate({ ...dummyEchoManifest, version: "nope" })).toThrow();
    expect(() => validator.validate({ ...dummyEchoManifest, permissions: ["x", "x"] })).toThrow();
    expect(() =>
      validator.validate({
        ...dummyEchoManifest,
        tools: [...dummyEchoManifest.tools, ...dummyEchoManifest.tools]
      })
    ).toThrow();
  });
  it("validates configuration schemas", () => {
    const validator = new ConfigurationSchemaValidator();
    validator.validate("x", dummyEchoManifest.configSchema, { prefix: "ok" });
    expect(() => validator.validate("x", dummyEchoManifest.configSchema, { prefix: 4 })).toThrow();
  });
  it("encrypts with unique IVs and detects tampering", () => {
    const crypto = new PluginSecretsEncryptionService(Buffer.alloc(32, 7)),
      a = crypto.encrypt({ token: "secret" }),
      b = crypto.encrypt({ token: "secret" });
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(crypto.decrypt(a)).toEqual({ token: "secret" });
    expect(() => crypto.decrypt({ ...a, ciphertext: `${a.ciphertext.slice(0, -2)}aa` })).toThrow(
      "PLUGIN_SECRETS_ENCRYPTION_FAILED"
    );
  });
  it("Sprint 5.0 Phase 7: supports a key-rotation window — old ciphertexts keep decrypting under the previous key while new ones use the current key", () => {
    const oldKey = Buffer.alloc(32, 1);
    const newKey = Buffer.alloc(32, 2);
    // Before rotation: only the old key exists, at version 1.
    const before = new PluginSecretsEncryptionService(oldKey, undefined, 1);
    const legacyPayload = before.encrypt({ token: "legacy-secret" });
    expect(legacyPayload.version).toBe(1);

    // After rotation: current key/version is now the new key at version 2, with the old key kept around
    // as `previousKey`/`previousVersion` so payloads encrypted before rotation still decrypt.
    const rotated = new PluginSecretsEncryptionService(newKey, oldKey, 2, 1);
    expect(rotated.decrypt(legacyPayload)).toEqual({ token: "legacy-secret" });

    const freshPayload = rotated.encrypt({ token: "fresh-secret" });
    expect(freshPayload.version).toBe(2);
    expect(rotated.decrypt(freshPayload)).toEqual({ token: "fresh-secret" });

    // A payload from neither the current nor the previous version is a diagnosable, distinct failure —
    // not silently swallowed into the generic decryption-failure message.
    expect(() => rotated.decrypt({ ...legacyPayload, version: 99 })).toThrow(
      "PLUGIN_SECRETS_ENCRYPTION_KEY_VERSION_UNKNOWN"
    );
  });
  it("isolates registry entries by tenant", async () => {
    const registry = new PluginRegistry(),
      plugin = new DummyEchoPlugin();
    registry.register("a", "dummy-echo", plugin);
    expect(registry.has("a", "dummy-echo")).toBe(true);
    expect(registry.has("b", "dummy-echo")).toBe(false);
    expect(() => registry.register("a", "dummy-echo", plugin)).toThrow(
      "PLUGIN_REGISTRATION_FAILED"
    );
    expect((await registry.health("a", "dummy-echo")).status).toBe("READY");
  });
  it("enforces lifecycle invariants", () => {
    const plugin = PluginAggregate.install(dummyEchoManifest);
    plugin.enable();
    expect(plugin.status).toBe("ACTIVE");
    plugin.disable();
    plugin.deprecate();
    expect(() => plugin.enable()).toThrow("PLUGIN_DEPRECATED");
    plugin.remove();
    expect(() => plugin.enable()).toThrow("PLUGIN_STATE_CONFLICT");
  });
  it("discovers the trusted dummy plugin from a configurable directory", async () => {
    const result = await new PluginDiscovery(
      resolve(process.cwd(), "../../plugins"),
      new ManifestValidator()
    ).discover();
    expect(result.plugins.map((x) => x.manifest.id)).toContain("dummy-echo");
    expect(result.errors).toEqual([]);
  });
  it("runs lifecycle hooks in order and enforces timeouts", async () => {
    const calls: string[] = [],
      plugin = new DummyEchoPlugin();
    plugin.enable = async () => {
      calls.push("enable");
    };
    plugin.start = async () => {
      calls.push("start");
    };
    const engine = new PluginLifecycleEngine(50),
      context = {
        organizationId: "o",
        installationId: "i",
        requestId: "r",
        manifest: dummyEchoManifest,
        config: {},
        permissions: new Set<PluginPermission>(),
        services: {},
        logger: { debug() {}, info() {}, warn() {}, error() {} }
      };
    await engine.enable(plugin, context);
    expect(calls).toEqual(["enable", "start"]);
    plugin.start = () => new Promise(() => undefined);
    await expect(engine.enable(plugin, context)).rejects.toThrow("PLUGIN_OPERATION_TIMEOUT");
  });
  it("provides only granted services and isolates event delivery by organization", async () => {
    const services = createPluginServices(new Set([PluginPermission.MEMORY]));
    expect(services.memory).toBeDefined();
    expect(() => requirePluginService(services.llm, PluginPermission.LLM)).toThrow(
      PluginPermissionError
    );
    const bus = new PluginEventBus(),
      received: string[] = [];
    bus.subscribe("a", "plugin", "USER_CREATED", async () => {
      received.push("a");
    });
    bus.subscribe("b", "plugin", "USER_CREATED", async () => {
      received.push("b");
    });
    await bus.publish({
      type: "USER_CREATED",
      organizationId: "a",
      payload: {},
      occurredAt: new Date().toISOString()
    });
    expect(received).toEqual(["a"]);
  });
});
