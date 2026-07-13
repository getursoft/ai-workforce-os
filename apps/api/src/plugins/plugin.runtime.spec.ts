import { describe, expect, it } from "vitest";
import { DummyEchoPlugin, dummyEchoManifest } from "@ai-workforce-os/plugin-dummy";
import { PluginAggregate } from "./plugin.domain";
import {
  ConfigurationSchemaValidator,
  ManifestValidator,
  PluginRegistry,
  PluginSecretsEncryptionService
} from "./plugin.runtime";

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
});
