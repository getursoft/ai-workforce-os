"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Input, Label } from "../../components/ui";
import type { PaymentSettings, UpdatePaymentSettingsInput } from "./billing-api";
import type { ApiError } from "../../lib/api-error";

export interface PaymentSettingsPayloadResult {
  payload?: UpdatePaymentSettingsInput;
  errors: Record<string, string>;
}

export function paymentSettingsErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as Pick<ApiError, "code">).code)
      : "UNKNOWN_ERROR";
  const messages: Record<string, string> = {
    PLUGIN_SECRETS_KEY_INVALID: "Secret encryption is not configured on the server.",
    DATABASE_SCHEMA_OUT_OF_DATE:
      "The server database is not ready for payment gateway configuration. Apply the latest migrations.",
    VALIDATION_ERROR: "Check the Key ID and Key Secret and try again.",
    PAYMENT_SETTINGS_INVALID: "The Key ID cannot be empty.",
    AUTHORIZATION_FAILED: "Only the organization Owner can change payment settings.",
    INTERNAL_ERROR: "The server could not save this configuration."
  };
  return messages[code] ?? "Your saved values remain unchanged. Check the fields and try again.";
}

export function buildPaymentSettingsPayload(values: {
  keyId: string;
  keySecret: string;
  removeSecret: boolean;
}): PaymentSettingsPayloadResult {
  const keyId = values.keyId.trim();
  const payload: UpdatePaymentSettingsInput = {};
  if (keyId) payload.keyId = keyId;
  const keySecret = values.keySecret.trim();
  if (keySecret && !values.removeSecret) payload.keySecret = keySecret;
  if (values.removeSecret) payload.removeSecrets = ["keySecret"];
  return { payload, errors: {} };
}

export function PaymentSettingsForm({
  settings,
  saving,
  save,
  saveError,
  saveSucceeded
}: {
  settings: PaymentSettings | undefined;
  saving: boolean;
  save: (body: UpdatePaymentSettingsInput) => void;
  saveError: unknown;
  saveSucceeded: boolean;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const secretRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (saveSucceeded && secretRef.current) secretRef.current.value = "";
  }, [saveSucceeded]);

  return (
    <form
      className="admin-form"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const result = buildPaymentSettingsPayload({
          keyId: String(data.get("keyId") ?? ""),
          keySecret: String(data.get("keySecret") ?? ""),
          removeSecret: data.get("removeSecret") !== null
        });
        setErrors(result.errors);
        if (result.payload) save(result.payload);
      }}
    >
      <fieldset>
        <legend>Razorpay</legend>
        <p>
          Used to process AI-credit top-ups on the Buy Credits page. Your Key Secret is encrypted and
          never displayed once saved.
        </p>

        <Label htmlFor="payment-config-keyId">Key ID</Label>
        <Input
          id="payment-config-keyId"
          name="keyId"
          defaultValue={settings?.keyId ?? ""}
          placeholder="rzp_live_xxxxxxxxxxxx"
          aria-invalid={Boolean(errors.keyId)}
        />
        <small>The publishable key_id shown in your Razorpay dashboard under API Keys.</small>

        <Label htmlFor="payment-config-keySecret">Key Secret</Label>
        <Input
          id="payment-config-keySecret"
          name="keySecret"
          type="password"
          autoComplete="new-password"
          ref={secretRef}
          placeholder={
            settings?.keySecret.configured
              ? "Configured. Leave blank to keep the stored secret."
              : "Not configured."
          }
        />

        {settings?.keySecret.configured ? (
          <label>
            <input type="checkbox" name="removeSecret" /> I confirm removal of the stored Key Secret
          </label>
        ) : null}
      </fieldset>

      {saveError ? (
        <Alert tone="danger" title="Payment settings were not saved">
          {paymentSettingsErrorMessage(saveError)}
        </Alert>
      ) : null}
      {saveSucceeded ? <Alert tone="success" title="Payment settings saved" /> : null}
      <Button type="submit" loading={saving} disabled={saving}>
        Save payment settings
      </Button>
    </form>
  );
}
