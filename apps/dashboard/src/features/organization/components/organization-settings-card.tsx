"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert, Button, Card, Input, Label } from "../../../components/ui";
import { friendlyOrganizationError } from "./organization-ui";
import { useUpdateOrganizationSettings } from "../hooks/use-organization";
import type { OrganizationSettings } from "../types";

const TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Paris",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney"
] as const;
const LOCALES = ["en-US", "en-GB", "en-IN", "de-DE", "fr-FR", "ja-JP"] as const;
const CURRENCIES = ["USD", "EUR", "GBP", "INR", "AED", "JPY", "SGD", "AUD"] as const;

export const settingsSchema = z.object({
  timezone: z.string().trim().min(1, "Timezone is required.").max(64),
  locale: z.string().trim().min(1, "Locale is required.").max(35),
  currency: z.string().trim().length(3, "Currency must use a three-letter code.")
});
type SettingsFormValues = z.infer<typeof settingsSchema>;

export function OrganizationSettingsCard({
  settings,
  onSuccess
}: Readonly<{ settings: OrganizationSettings; onSuccess(message: string): void }>) {
  const mutation = useUpdateOrganizationSettings();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty }
  } = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: settings
  });
  useEffect(() => reset(settings), [reset, settings]);

  const submit = handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync(values);
      reset(values);
      onSuccess("Organization settings updated successfully.");
    } catch {
      /* rendered from mutation state */
    }
  });

  return (
    <Card className="organization-card">
      <div className="organization-card__header">
        <div>
          <p className="organization-eyebrow">Regional preferences</p>
          <h2>Organization Settings</h2>
        </div>
      </div>
      {mutation.error ? (
        <Alert tone="danger" title="Could not update settings">
          <p>{friendlyOrganizationError(mutation.error)}</p>
        </Alert>
      ) : null}
      <form onSubmit={submit} className="organization-form" noValidate>
        <div className="ui-field organization-form__wide">
          <Label htmlFor="timezone">Timezone</Label>
          <Input
            id="timezone"
            list="timezone-options"
            disabled={mutation.isPending}
            placeholder="Search timezones"
            {...register("timezone")}
          />
          <datalist id="timezone-options">
            {TIMEZONES.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
          {errors.timezone ? <p className="ui-field__error">{errors.timezone.message}</p> : null}
        </div>
        <div className="ui-field">
          <Label htmlFor="locale">Locale</Label>
          <select
            id="locale"
            className="ui-input"
            disabled={mutation.isPending}
            {...register("locale")}
          >
            {LOCALES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          {errors.locale ? <p className="ui-field__error">{errors.locale.message}</p> : null}
        </div>
        <div className="ui-field">
          <Label htmlFor="currency">Currency</Label>
          <select
            id="currency"
            className="ui-input"
            disabled={mutation.isPending}
            {...register("currency")}
          >
            {CURRENCIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          {errors.currency ? <p className="ui-field__error">{errors.currency.message}</p> : null}
        </div>
        <div className="ui-field">
          <Label htmlFor="date-format">Date Format</Label>
          <select
            id="date-format"
            className="ui-input"
            disabled
            title="Not supported by the current API"
          >
            <option>Not provided by API</option>
          </select>
          <p className="organization-help">Requires backend contract support.</p>
        </div>
        <div className="ui-field">
          <Label htmlFor="time-format">Time Format</Label>
          <select
            id="time-format"
            className="ui-input"
            disabled
            title="Not supported by the current API"
          >
            <option>12h</option>
            <option>24h</option>
          </select>
          <p className="organization-help">Requires backend contract support.</p>
        </div>
        <div className="organization-form__footer organization-form__wide">
          <span className={`organization-unsaved ${isDirty ? "organization-unsaved--active" : ""}`}>
            {isDirty ? "Unsaved changes" : "All changes saved"}
          </span>
          <div className="organization-form__actions">
            <Button
              type="button"
              variant="secondary"
              disabled={!isDirty || mutation.isPending}
              onClick={() => {
                reset(settings);
                mutation.reset();
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={mutation.isPending}
              disabled={!isDirty || mutation.isPending}
            >
              Save settings
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}
