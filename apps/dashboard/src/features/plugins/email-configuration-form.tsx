"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Input } from "../../components/ui";
import type { EmailConfiguration, UpdateEmailConfigurationInput } from "./plugin-api";
import type { ApiError } from "../../lib/api-error";

export interface EmailConfigurationPayloadResult {
  payload?: UpdateEmailConfigurationInput;
  errors: Record<string, string>;
}

export function shouldClearPasswordAfterSave(saveSucceeded: boolean): boolean {
  return saveSucceeded;
}

export function emailConfigurationErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as Pick<ApiError, "code">).code)
      : "UNKNOWN_ERROR";
  const messages: Record<string, string> = {
    PLUGIN_SECRETS_KEY_INVALID: "Secret encryption is not configured on the server.",
    DATABASE_SCHEMA_OUT_OF_DATE:
      "The server database is not ready for email delivery configuration. Apply the latest migrations.",
    VALIDATION_ERROR: "Check the SMTP fields and try again.",
    EMAIL_CONFIGURATION_INVALID: "Check the SMTP host, port, and sender email and try again.",
    AUTHORIZATION_FAILED: "Only organization Owners and Admins can change this configuration.",
    PLUGIN_NOT_FOUND: "This plugin installation is no longer available.",
    USER_NOT_FOUND: "This plugin installation is no longer available.",
    INTERNAL_ERROR: "The server could not save this configuration."
  };
  return messages[code] ?? "Your saved values remain unchanged. Check the fields and try again.";
}

export function buildEmailConfigurationPayload(values: {
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  fromEmail: string;
  fromName: string;
  password: string;
  removePassword: boolean;
}): EmailConfigurationPayloadResult {
  const errors: Record<string, string> = {};
  const smtpHost = values.smtpHost.trim();
  const fromEmail = values.fromEmail.trim();
  if (smtpHost && !fromEmail) errors.fromEmail = "A sender email is required once an SMTP host is set.";
  if (fromEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail))
    errors.fromEmail = "Enter a valid email address.";
  let smtpPort: number | undefined;
  if (values.smtpPort.trim()) {
    smtpPort = Number(values.smtpPort);
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)
      errors.smtpPort = "Port must be between 1 and 65,535.";
  }
  if (Object.keys(errors).length) return { errors };

  const payload: UpdateEmailConfigurationInput = {};
  if (smtpHost) payload.smtpHost = smtpHost;
  if (smtpPort !== undefined) payload.smtpPort = smtpPort;
  payload.smtpSecure = values.smtpSecure;
  const smtpUser = values.smtpUser.trim();
  if (smtpUser) payload.smtpUser = smtpUser;
  if (fromEmail) payload.fromEmail = fromEmail;
  const fromName = values.fromName.trim();
  if (fromName) payload.fromName = fromName;
  const password = values.password.trim();
  if (password && !values.removePassword) payload.secrets = { password };
  if (values.removePassword) payload.removeSecrets = ["password"];
  return { payload, errors };
}

export function EmailConfigurationForm({
  configuration,
  canManage,
  saving,
  save,
  saveError,
  saveSucceeded
}: {
  configuration: EmailConfiguration | undefined;
  canManage: boolean;
  saving: boolean;
  save: (body: UpdateEmailConfigurationInput) => void;
  saveError: unknown;
  saveSucceeded: boolean;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const passwordRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (shouldClearPasswordAfterSave(saveSucceeded) && passwordRef.current) passwordRef.current.value = "";
  }, [saveSucceeded]);

  return (
    <section className="plugin-ai-section">
      <h3>Email Delivery (SMTP)</h3>
      <p>Used to send ticket PDFs and resends by email. Credentials are encrypted and never displayed once saved.</p>
      <form
        className="admin-form plugin-ai-form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const result = buildEmailConfigurationPayload({
            smtpHost: String(data.get("smtpHost") ?? ""),
            smtpPort: String(data.get("smtpPort") ?? ""),
            smtpSecure: data.get("smtpSecure") !== null,
            smtpUser: String(data.get("smtpUser") ?? ""),
            fromEmail: String(data.get("fromEmail") ?? ""),
            fromName: String(data.get("fromName") ?? ""),
            password: String(data.get("password") ?? ""),
            removePassword: data.get("removePassword") !== null
          });
          setErrors(result.errors);
          if (result.payload) save(result.payload);
        }}
      >
        <label className="plugin-ai-field" htmlFor="email-config-smtpHost">
          <span>SMTP host</span>
          <Input
            id="email-config-smtpHost"
            name="smtpHost"
            disabled={!canManage}
            defaultValue={configuration?.configuration.smtpHost ?? ""}
            placeholder="smtp.example.com"
            aria-invalid={Boolean(errors.smtpHost)}
          />
          {errors.smtpHost ? (
            <small role="alert" className="field-error">
              {errors.smtpHost}
            </small>
          ) : null}
        </label>

        <label className="plugin-ai-field" htmlFor="email-config-smtpPort">
          <span>SMTP port</span>
          <Input
            id="email-config-smtpPort"
            name="smtpPort"
            type="number"
            min={1}
            max={65535}
            disabled={!canManage}
            defaultValue={configuration?.configuration.smtpPort ?? 587}
            aria-invalid={Boolean(errors.smtpPort)}
          />
          {errors.smtpPort ? (
            <small role="alert" className="field-error">
              {errors.smtpPort}
            </small>
          ) : null}
        </label>

        <label className="plugin-ai-remove">
          <input
            type="checkbox"
            name="smtpSecure"
            disabled={!canManage}
            defaultChecked={configuration?.configuration.smtpSecure ?? false}
          />{" "}
          Use TLS (SSL) — typically on for port 465
        </label>

        <label className="plugin-ai-field" htmlFor="email-config-smtpUser">
          <span>SMTP username</span>
          <Input
            id="email-config-smtpUser"
            name="smtpUser"
            disabled={!canManage}
            defaultValue={configuration?.configuration.smtpUser ?? ""}
          />
        </label>

        <label className="plugin-ai-field" htmlFor="email-config-fromEmail">
          <span>Sender email</span>
          <Input
            id="email-config-fromEmail"
            name="fromEmail"
            type="email"
            disabled={!canManage}
            defaultValue={configuration?.configuration.fromEmail ?? ""}
            placeholder="tickets@example.com"
            aria-invalid={Boolean(errors.fromEmail)}
          />
          <small>The "from" address on every ticket email sent by this employee.</small>
          {errors.fromEmail ? (
            <small role="alert" className="field-error">
              {errors.fromEmail}
            </small>
          ) : null}
        </label>

        <label className="plugin-ai-field" htmlFor="email-config-fromName">
          <span>Sender name</span>
          <Input
            id="email-config-fromName"
            name="fromName"
            disabled={!canManage}
            defaultValue={configuration?.configuration.fromName ?? ""}
            placeholder="Travel Desk"
          />
        </label>

        <label className="plugin-ai-field" htmlFor="email-config-password">
          <span>SMTP password</span>
          <Input
            id="email-config-password"
            name="password"
            type="password"
            autoComplete="new-password"
            disabled={!canManage}
            ref={passwordRef}
            placeholder={
              configuration?.secrets.password.configured
                ? "Configured. Leave blank to keep the stored password."
                : "Not configured."
            }
          />
        </label>
        {canManage && configuration?.secrets.password.configured ? (
          <label className="plugin-ai-remove">
            <input type="checkbox" name="removePassword" /> I confirm removal of the stored SMTP
            password
          </label>
        ) : null}

        {!canManage ? <p>Only organization Owners and Admins may change email delivery settings.</p> : null}
        {saveError ? (
          <Alert tone="danger" title="Email delivery configuration was not saved">
            {emailConfigurationErrorMessage(saveError)}
          </Alert>
        ) : null}
        {saveSucceeded ? <Alert tone="success" title="Email delivery configuration saved" /> : null}
        {canManage ? (
          <div className="ui-dialog__actions plugin-ai-actions">
            <Button type="submit" loading={saving} disabled={saving}>
              Save email settings
            </Button>
          </div>
        ) : null}
      </form>
    </section>
  );
}
