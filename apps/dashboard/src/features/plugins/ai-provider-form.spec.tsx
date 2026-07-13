import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiProviderForm, buildAiConfigurationPayload } from "./ai-provider-form";
import type { AiProviderType, PluginAiConfiguration } from "./plugin-api";

function configuration(providerType: AiProviderType): PluginAiConfiguration {
  return {
    pluginInstallationId: "plugin-1",
    configured: true,
    providerType,
    configuration: {
      model: "saved-model",
      baseUrl: "https://api.example.test/v1",
      endpoint: "https://azure.example.test",
      deploymentName: "travel",
      apiVersion: "2026-01-01",
      timeoutMs: 30000
    },
    secrets: { apiKey: { configured: true, updatedAt: "2026-07-13T00:00:00.000Z" } },
    updatedAt: "2026-07-13T00:00:00.000Z"
  };
}
function markup(provider: AiProviderType, saveError = false) {
  return renderToStaticMarkup(
    <AiProviderForm
      configuration={configuration(provider)}
      canManage
      saving={false}
      testing={false}
      save={vi.fn()}
      test={vi.fn()}
      clearStatus={vi.fn()}
      saveError={saveError}
    />
  );
}
describe("AI provider form", () => {
  it("renders OpenAI-compatible fields only", () => {
    const html = markup("OPENAI_COMPATIBLE");
    expect(html).toContain("Model");
    expect(html).toContain("OpenAI-compatible base URL");
    expect(html).toContain("New API key");
    expect(html).not.toContain("Azure endpoint");
    expect(html).not.toContain("Azure deployment name");
    expect(html).not.toContain("Azure API version");
  });
  it("renders Azure fields only", () => {
    const html = markup("AZURE_OPENAI");
    expect(html).toContain("Azure endpoint");
    expect(html).toContain("Azure deployment name");
    expect(html).toContain("Azure API version");
    expect(html).not.toContain("OpenAI-compatible base URL");
    expect(html).not.toContain(">Model<");
  });
  it("hides vendor and secret controls for deterministic provider", () => {
    const html = markup("DETERMINISTIC");
    expect(html).toContain("Timeout (milliseconds)");
    expect(html).not.toContain("New API key");
    expect(html).not.toContain("Configured. Leave blank");
    expect(html).not.toContain("Azure endpoint");
    expect(html).not.toContain(">Model<");
  });
  it("creates an OpenAI payload without stale Azure values or an empty key", () => {
    const result = buildAiConfigurationPayload("OPENAI_COMPATIBLE", {
      model: "gpt-configured",
      baseUrl: "https://api.example.test/v1",
      endpoint: "https://stale.azure.test",
      deploymentName: "stale",
      apiVersion: "stale",
      timeoutMs: "30000",
      apiKey: "",
      removeApiKey: false
    });
    expect(result.payload).toEqual({
      providerType: "OPENAI_COMPATIBLE",
      model: "gpt-configured",
      baseUrl: "https://api.example.test/v1",
      timeoutMs: 30000
    });
  });
  it("creates an Azure payload without stale OpenAI values", () => {
    const result = buildAiConfigurationPayload("AZURE_OPENAI", {
      model: "stale",
      baseUrl: "https://stale.test",
      endpoint: "https://azure.example.test",
      deploymentName: "travel",
      apiVersion: "2026-01-01",
      timeoutMs: "30000",
      apiKey: "replacement",
      removeApiKey: false
    });
    expect(result.payload).toEqual({
      providerType: "AZURE_OPENAI",
      endpoint: "https://azure.example.test",
      deploymentName: "travel",
      apiVersion: "2026-01-01",
      timeoutMs: 30000,
      secrets: { apiKey: "replacement" }
    });
  });
  it("sends secret removal only after explicit confirmation", () => {
    const result = buildAiConfigurationPayload("OPENAI_COMPATIBLE", {
      model: "model",
      timeoutMs: "30000",
      apiKey: "",
      removeApiKey: true
    });
    expect(result.payload).toMatchObject({ removeSecrets: ["apiKey"] });
    expect(result.payload).not.toHaveProperty("secrets");
  });
  it("validates provider-specific fields and timeout limits", () => {
    expect(
      buildAiConfigurationPayload("OPENAI_COMPATIBLE", {
        model: "",
        baseUrl: "invalid",
        timeoutMs: "0",
        removeApiKey: false
      }).errors
    ).toMatchObject({
      model: expect.any(String),
      baseUrl: expect.any(String),
      timeoutMs: expect.any(String)
    });
    expect(
      buildAiConfigurationPayload("AZURE_OPENAI", {
        endpoint: "http://insecure.test",
        deploymentName: "",
        apiVersion: "",
        timeoutMs: "30000",
        removeApiKey: false
      }).errors
    ).toMatchObject({
      endpoint: expect.any(String),
      deploymentName: expect.any(String),
      apiVersion: expect.any(String)
    });
    expect(
      buildAiConfigurationPayload("DETERMINISTIC", { timeoutMs: "30000", removeApiKey: false })
        .payload
    ).toEqual({ providerType: "DETERMINISTIC", timeoutMs: 30000 });
  });
  it("keeps saved non-secret values visible in the failure state", () => {
    const html = markup("OPENAI_COMPATIBLE", true);
    expect(html).toContain('value="saved-model"');
    expect(html).toContain('value="https://api.example.test/v1"');
    expect(html).toContain("Your saved values remain unchanged");
    expect(html).not.toContain('value="2026-07-13');
  });
  it("associates visible labels, help, errors, and password semantics", () => {
    const html = markup("OPENAI_COMPATIBLE");
    expect(html).toContain('for="plugin-ai-model"');
    expect(html).toContain('id="plugin-ai-model"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
  });
});
