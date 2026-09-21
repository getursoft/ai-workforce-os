"use client";
import { useEffect, useRef, useState, type ComponentPropsWithRef, type FormEvent } from "react";
import { Alert, Button, Input } from "../../components/ui";
import type { AiProviderType, PluginAiConfiguration } from "./plugin-api";
import type { ApiError } from "../../lib/api-error";

export interface AiProviderFormValues {
  model?: string;
  embeddingModel?: string;
  baseUrl?: string;
  endpoint?: string;
  deploymentName?: string;
  embeddingDeployment?: string;
  apiVersion?: string;
  timeoutMs: string;
  apiKey?: string;
  removeApiKey: boolean;
}
export interface AiConfigurationPayloadResult {
  payload?: Record<string, unknown>;
  errors: Record<string, string>;
}
export function developmentProvidersAvailable(environment = process.env.NEXT_PUBLIC_APP_ENV) {
  return environment !== "production" && environment !== "staging";
}

export function providerConfigurationErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as Pick<ApiError, "code">).code)
      : "UNKNOWN_ERROR";
  const messages: Record<string, string> = {
    INVALID_SECURITY_CONFIGURATION: "Secret encryption is not configured on the server.",
    PLUGIN_SECRETS_KEY_INVALID: "Secret encryption is not configured on the server.",
    DATABASE_SCHEMA_OUT_OF_DATE:
      "The server database is not ready for AI provider configuration. Apply the latest migrations.",
    VALIDATION_ERROR: "Check the provider fields and try again.",
    AI_PROVIDER_CONFIGURATION_INVALID: "Check the provider-specific settings and try again.",
    AI_PROVIDER_AUTHENTICATION_FAILED:
      "The provider rejected the configured API key. Replace it and try again.",
    AI_PROVIDER_MODEL_NOT_FOUND: "The configured model or deployment was not found.",
    AI_PROVIDER_QUOTA_EXCEEDED: "The provider quota has been exceeded.",
    AI_PROVIDER_UNAVAILABLE: "The provider is unavailable or the request timed out.",
    AI_PROVIDER_TEST_FAILED: "The provider connection test failed.",
    AUTHORIZATION_FAILED: "Only the platform owner can change AI provider settings.",
    PLUGIN_NOT_FOUND: "This plugin installation is no longer available.",
    USER_NOT_FOUND: "This plugin installation is no longer available.",
    RESOURCE_NOT_FOUND: "This plugin installation is no longer available.",
    INTERNAL_ERROR: "The server could not save this configuration."
  };
  return messages[code] ?? "Your saved values remain unchanged. Check the fields and try again.";
}

export function shouldClearApiKeyAfterSave(saveSucceeded: boolean): boolean {
  return saveSucceeded;
}

export function buildAiConfigurationPayload(
  providerType: AiProviderType,
  values: AiProviderFormValues
): AiConfigurationPayloadResult {
  const errors: Record<string, string> = {};
  const timeoutMs = Number(values.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000)
    errors.timeoutMs = "Timeout must be between 1,000 and 120,000 milliseconds.";
  const payload: Record<string, unknown> = { providerType, timeoutMs };
  if (providerType === "OPENAI_COMPATIBLE") {
    const model = values.model?.trim() ?? "";
    const baseUrl = values.baseUrl?.trim() ?? "";
    if (!model) errors.model = "Model is required.";
    if (baseUrl && !validUrl(baseUrl, false))
      errors.baseUrl = "Base URL must be a valid HTTP or HTTPS URL.";
    if (model) payload.model = model;
    const embeddingModel = values.embeddingModel?.trim() ?? "";
    if (embeddingModel) payload.embeddingModel = embeddingModel;
    if (baseUrl) payload.baseUrl = baseUrl;
  } else if (providerType === "AZURE_OPENAI") {
    const endpoint = values.endpoint?.trim() ?? "";
    const deploymentName = values.deploymentName?.trim() ?? "";
    const apiVersion = values.apiVersion?.trim() ?? "";
    if (!endpoint || !validUrl(endpoint, true))
      errors.endpoint = "A valid HTTPS endpoint is required.";
    if (!deploymentName) errors.deploymentName = "Deployment name is required.";
    if (!apiVersion) errors.apiVersion = "API version is required.";
    if (endpoint) payload.endpoint = endpoint;
    if (deploymentName) payload.deploymentName = deploymentName;
    const embeddingDeployment = values.embeddingDeployment?.trim() ?? "";
    if (embeddingDeployment) payload.embeddingDeployment = embeddingDeployment;
    if (apiVersion) payload.apiVersion = apiVersion;
  }
  if (providerType !== "DETERMINISTIC") {
    const apiKey = values.apiKey?.trim();
    if (apiKey && !values.removeApiKey) payload.secrets = { apiKey };
    if (values.removeApiKey) payload.removeSecrets = ["apiKey"];
  }
  return Object.keys(errors).length ? { errors } : { payload, errors };
}

function validUrl(value: string, httpsOnly: boolean) {
  try {
    const protocol = new URL(value).protocol;
    return httpsOnly ? protocol === "https:" : protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function AiProviderForm({
  configuration,
  canManage,
  saving,
  testing,
  save,
  test,
  clearStatus,
  saveError,
  saveSucceeded,
  testState,
  testError
}: {
  configuration: PluginAiConfiguration | undefined;
  canManage: boolean;
  saving: boolean;
  testing: boolean;
  save: (body: Record<string, unknown>) => void;
  test: (body: Record<string, unknown>) => void;
  clearStatus: () => void;
  saveError: unknown;
  saveSucceeded: boolean;
  testState?: "success";
  testError: unknown;
}) {
  const developmentProviders = developmentProvidersAvailable();
  const [provider, setProvider] = useState<AiProviderType>(
    configuration?.providerType === "DETERMINISTIC" && !developmentProviders
      ? "OPENAI_COMPATIBLE"
      : (configuration?.providerType ??
          (developmentProviders ? "DETERMINISTIC" : "OPENAI_COMPATIBLE"))
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const apiKeyRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (shouldClearApiKeyAfterSave(saveSucceeded) && apiKeyRef.current)
      apiKeyRef.current.value = "";
  }, [saveSucceeded]);
  const submit = (form: HTMLFormElement, action: "save" | "test") => {
    const data = new FormData(form);
    const result = buildAiConfigurationPayload(provider, {
      model: String(data.get("model") ?? ""),
      embeddingModel: String(data.get("embeddingModel") ?? ""),
      baseUrl: String(data.get("baseUrl") ?? ""),
      endpoint: String(data.get("endpoint") ?? ""),
      deploymentName: String(data.get("deploymentName") ?? ""),
      embeddingDeployment: String(data.get("embeddingDeployment") ?? ""),
      apiVersion: String(data.get("apiVersion") ?? ""),
      timeoutMs: String(data.get("timeoutMs") ?? ""),
      apiKey: String(data.get("apiKey") ?? ""),
      removeApiKey: data.get("removeApiKey") !== null
    });
    setErrors(result.errors);
    if (!result.payload) return;
    if (action === "save") save(result.payload);
    else test(result.payload);
  };
  const field = (
    name: string,
    label: string,
    help: string,
    props: ComponentPropsWithRef<"input"> = {}
  ) => (
    <label className="plugin-ai-field" htmlFor={`plugin-ai-${name}`}>
      <span>{label}</span>
      <Input
        id={`plugin-ai-${name}`}
        name={name}
        aria-describedby={`plugin-ai-${name}-help${errors[name] ? ` plugin-ai-${name}-error` : ""}`}
        aria-invalid={Boolean(errors[name])}
        disabled={!canManage}
        {...props}
      />
      <small id={`plugin-ai-${name}-help`}>{help}</small>
      {errors[name] ? (
        <small id={`plugin-ai-${name}-error`} role="alert" className="field-error">
          {errors[name]}
        </small>
      ) : null}
    </label>
  );
  return (
    <section className="plugin-ai-section">
      <h3>AI Provider Configuration</h3>
      <p>Provider credentials are encrypted. Stored secrets are never displayed.</p>
      <form
        className="admin-form plugin-ai-form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          submit(event.currentTarget, "save");
        }}
      >
        <label className="plugin-ai-field" htmlFor="plugin-ai-provider">
          <span>Provider type</span>
          <select
            id="plugin-ai-provider"
            name="providerType"
            value={provider}
            disabled={!canManage}
            onChange={(event) => {
              setProvider(event.target.value as AiProviderType);
              setErrors({});
              clearStatus();
            }}
          >
            {developmentProviders ? (
              <option value="DETERMINISTIC">Deterministic (development)</option>
            ) : null}
            <option value="OPENAI_COMPATIBLE">OpenAI-compatible</option>
            <option value="AZURE_OPENAI">Azure OpenAI</option>
          </select>
          <small>Select the provider used by this plugin installation.</small>
        </label>
        {provider === "OPENAI_COMPATIBLE" ? (
          <>
            {field("model", "Model", "Enter the configured provider model name.", {
              defaultValue: configuration?.configuration.model ?? "",
              required: true
            })}
            {field(
              "embeddingModel",
              "Embedding model",
              "Model used to index and search enterprise knowledge.",
              { defaultValue: configuration?.configuration.embeddingModel ?? "" }
            )}
            {field(
              "baseUrl",
              "OpenAI-compatible base URL",
              "Optional. Defaults to https://api.openai.com/v1.",
              { type: "url", defaultValue: configuration?.configuration.baseUrl ?? "" }
            )}
          </>
        ) : null}
        {provider === "AZURE_OPENAI" ? (
          <>
            {field(
              "endpoint",
              "Azure endpoint",
              "The HTTPS endpoint for the Azure OpenAI resource.",
              {
                type: "url",
                defaultValue: configuration?.configuration.endpoint ?? "",
                required: true
              }
            )}
            {field(
              "deploymentName",
              "Azure deployment name",
              "The configured Azure model deployment.",
              { defaultValue: configuration?.configuration.deploymentName ?? "", required: true }
            )}
            {field(
              "embeddingDeployment",
              "Embedding deployment",
              "Azure deployment used to index and search enterprise knowledge.",
              {
                defaultValue: configuration?.configuration.embeddingDeployment ?? ""
              }
            )}
            {field(
              "apiVersion",
              "Azure API version",
              "The API version enabled for this deployment.",
              { defaultValue: configuration?.configuration.apiVersion ?? "", required: true }
            )}
          </>
        ) : null}
        {field(
          "timeoutMs",
          "Timeout (milliseconds)",
          "Allowed range: 1,000–120,000 milliseconds.",
          {
            type: "number",
            min: 1000,
            max: 120000,
            defaultValue: String(configuration?.configuration.timeoutMs ?? 30000),
            required: true
          }
        )}
        {provider !== "DETERMINISTIC" ? (
          <>
            {field(
              "apiKey",
              "New API key",
              configuration?.secrets.apiKey.configured
                ? "Configured. Leave blank to keep the stored key."
                : "Not configured. Enter a key to configure the provider.",
              { type: "password", autoComplete: "new-password", ref: apiKeyRef }
            )}
            {canManage && configuration?.secrets.apiKey.configured ? (
              <label className="plugin-ai-remove">
                <input type="checkbox" name="removeApiKey" /> I confirm removal of the stored API
                key
              </label>
            ) : null}
          </>
        ) : null}
        {!canManage ? (
          <p>Only the platform owner can change AI provider settings.</p>
        ) : null}
        {saveError ? (
          <Alert tone="danger" title="Provider configuration was not saved">
            {providerConfigurationErrorMessage(saveError)}
          </Alert>
        ) : null}
        {testState === "success" ? (
          <Alert tone="success" title="Provider connection succeeded" />
        ) : null}
        {testError ? (
          <Alert tone="danger" title="Provider connection failed">
            {providerConfigurationErrorMessage(testError)}
          </Alert>
        ) : null}
        {canManage ? (
          <div className="ui-dialog__actions plugin-ai-actions">
            <Button
              type="button"
              variant="secondary"
              loading={testing}
              disabled={testing || saving}
              onClick={(event) => {
                const form = event.currentTarget.form;
                if (form) submit(form, "test");
              }}
            >
              Test connection
            </Button>
            <Button type="submit" loading={saving} disabled={saving || testing}>
              Save AI provider
            </Button>
          </div>
        ) : null}
      </form>
    </section>
  );
}
