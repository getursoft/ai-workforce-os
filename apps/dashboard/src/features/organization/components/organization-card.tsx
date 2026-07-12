"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert, Button, Card, Input, Label } from "../../../components/ui";
import type { Organization } from "../types";
import { useUpdateOrganization } from "../hooks/use-organization";
import { friendlyOrganizationError, StatusBadge } from "./organization-ui";

export const organizationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(3, "Organization name must be at least 3 characters.")
    .max(100, "Organization name must be at most 100 characters.")
});

type OrganizationFormValues = z.infer<typeof organizationSchema>;

function displayTimestamp(value?: string): string {
  if (!value) return "Not provided by API";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        parsed
      );
}

export function OrganizationCard({
  organization,
  onSuccess
}: Readonly<{ organization: Organization; onSuccess(message: string): void }>) {
  const [editing, setEditing] = useState(false);
  const mutation = useUpdateOrganization();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty }
  } = useForm<OrganizationFormValues>({
    resolver: zodResolver(organizationSchema),
    defaultValues: { name: organization.name }
  });

  useEffect(() => reset({ name: organization.name }), [organization.name, reset]);

  const cancel = () => {
    reset({ name: organization.name });
    mutation.reset();
    setEditing(false);
  };

  const submit = handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync({ name: values.name.trim() });
      reset({ name: values.name.trim() });
      setEditing(false);
      onSuccess("Organization updated successfully.");
    } catch (error: unknown) {
      const message = friendlyOrganizationError(error);
      if (message.toLowerCase().includes("name")) setError("name", { message });
    }
  });

  return (
    <Card className="organization-card">
      <div className="organization-card__header">
        <div>
          <p className="organization-eyebrow">Identity</p>
          <h2>Organization Profile</h2>
        </div>
        {!editing ? (
          <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : null}
      </div>
      {mutation.error ? (
        <Alert tone="danger" title="Could not update organization">
          <p>{friendlyOrganizationError(mutation.error)}</p>
        </Alert>
      ) : null}
      <form onSubmit={submit} className="organization-form" noValidate>
        <div className="ui-field organization-form__wide">
          <Label htmlFor="organization-name">Organization Name</Label>
          <Input
            id="organization-name"
            disabled={!editing || mutation.isPending}
            aria-invalid={Boolean(errors.name)}
            {...register("name")}
          />
          {errors.name ? <p className="ui-field__error">{errors.name.message}</p> : null}
        </div>
        <div className="ui-field">
          <Label htmlFor="organization-slug">Slug</Label>
          <Input id="organization-slug" value={organization.slug} readOnly disabled />
        </div>
        <div className="ui-field">
          <Label>Status</Label>
          <div className="organization-field-value">
            <StatusBadge status={organization.status} />
          </div>
        </div>
        <div className="ui-field">
          <Label>Created At</Label>
          <div className="organization-field-value">{displayTimestamp(organization.createdAt)}</div>
        </div>
        <div className="ui-field">
          <Label>Updated At</Label>
          <div className="organization-field-value">{displayTimestamp(organization.updatedAt)}</div>
        </div>
        {editing ? (
          <div className="organization-form__footer organization-form__wide">
            <span
              className={`organization-unsaved ${isDirty ? "organization-unsaved--active" : ""}`}
            >
              {isDirty ? "Unsaved changes" : "No changes"}
            </span>
            <div className="organization-form__actions">
              <Button
                type="button"
                variant="secondary"
                disabled={mutation.isPending}
                onClick={cancel}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={mutation.isPending}
                disabled={!isDirty || mutation.isPending}
              >
                Save changes
              </Button>
            </div>
          </div>
        ) : null}
      </form>
    </Card>
  );
}
