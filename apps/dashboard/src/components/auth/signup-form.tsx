"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useRegister } from "../../features/auth/auth-provider";
import { ApiError } from "../../lib/api-error";
import {
  getSignupFailureMessage,
  getSignupSuccessRedirectTarget,
  isSignupSubmitDisabled,
  validateSignupForm,
  type SignupFormValues
} from "./signup-form.logic";
import { Alert, Button, Card, Input, Label, PasswordInput } from "../ui";

const INITIAL_FORM_STATE: SignupFormValues = {
  organizationName: "",
  firstName: "",
  lastName: "",
  email: "",
  password: "",
  confirmPassword: ""
};

export function SignupForm() {
  const router = useRouter();
  const { state } = useAuth();
  const register = useRegister();
  const [form, setForm] = useState<SignupFormValues>(INITIAL_FORM_STATE);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof SignupFormValues, string>>>({});
  const [submitting, setSubmitting] = useState(false);

  const isAuthenticated = useMemo(
    () => state.isAuthenticated && !state.isInitializing,
    [state.isAuthenticated, state.isInitializing]
  );

  useEffect(() => {
    if (isAuthenticated) {
      router.replace(getSignupSuccessRedirectTarget());
    }
  }, [isAuthenticated, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const nextFieldErrors = validateSignupForm(form);
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      return;
    }

    setFieldErrors({});
    setSubmitting(true);

    try {
      await register({
        organizationName: form.organizationName.trim(),
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        password: form.password
      });
      router.replace(getSignupSuccessRedirectTarget());
    } catch (caught: unknown) {
      const apiError = caught instanceof ApiError ? caught : null;
      setError(getSignupFailureMessage(apiError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="auth-card auth-card--wide">
      <div className="auth-card__branding">
        <p className="auth-card__eyebrow">AI Workforce OS</p>
        <h1>Create your workspace</h1>
        <p>Set up your organization and secure dashboard access in one step.</p>
      </div>
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        {error ? (
          <Alert tone="danger" title="Registration failed">
            {error}
          </Alert>
        ) : null}
        <div className="ui-field">
          <Label htmlFor="organizationName">Organization Name</Label>
          <Input
            id="organizationName"
            name="organizationName"
            autoComplete="organization"
            value={form.organizationName}
            aria-invalid={fieldErrors.organizationName ? "true" : "false"}
            onChange={(event) => {
              const value = event.target.value;
              setForm((current) => ({ ...current, organizationName: value }));
              if (fieldErrors.organizationName) {
                setFieldErrors((current) => {
                  const next = { ...current };
                  delete next.organizationName;
                  return next;
                });
              }
            }}
          />
          {fieldErrors.organizationName ? <p className="ui-field__error">{fieldErrors.organizationName}</p> : null}
        </div>
        <div className="auth-form__split">
          <div className="ui-field">
            <Label htmlFor="firstName">First Name</Label>
            <Input
              id="firstName"
              name="firstName"
              autoComplete="given-name"
              value={form.firstName}
              aria-invalid={fieldErrors.firstName ? "true" : "false"}
              onChange={(event) => {
                const value = event.target.value;
                setForm((current) => ({ ...current, firstName: value }));
                if (fieldErrors.firstName) {
                  setFieldErrors((current) => {
                    const next = { ...current };
                    delete next.firstName;
                    return next;
                  });
                }
              }}
            />
            {fieldErrors.firstName ? <p className="ui-field__error">{fieldErrors.firstName}</p> : null}
          </div>
          <div className="ui-field">
            <Label htmlFor="lastName">Last Name</Label>
            <Input
              id="lastName"
              name="lastName"
              autoComplete="family-name"
              value={form.lastName}
              aria-invalid={fieldErrors.lastName ? "true" : "false"}
              onChange={(event) => {
                const value = event.target.value;
                setForm((current) => ({ ...current, lastName: value }));
                if (fieldErrors.lastName) {
                  setFieldErrors((current) => {
                    const next = { ...current };
                    delete next.lastName;
                    return next;
                  });
                }
              }}
            />
            {fieldErrors.lastName ? <p className="ui-field__error">{fieldErrors.lastName}</p> : null}
          </div>
        </div>
        <div className="ui-field">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={form.email}
            aria-invalid={fieldErrors.email ? "true" : "false"}
            onChange={(event) => {
              const value = event.target.value;
              setForm((current) => ({ ...current, email: value }));
              if (fieldErrors.email) {
                setFieldErrors((current) => {
                  const next = { ...current };
                  delete next.email;
                  return next;
                });
              }
            }}
          />
          {fieldErrors.email ? <p className="ui-field__error">{fieldErrors.email}</p> : null}
        </div>
        <PasswordInput
          id="password"
          label="Password"
          value={form.password}
          autoComplete="new-password"
          onChange={(value) => {
            setForm((current) => ({ ...current, password: value }));
            if (fieldErrors.password) {
              setFieldErrors((current) => {
                const next = { ...current };
                delete next.password;
                return next;
              });
            }
          }}
        />
        {fieldErrors.password ? <p className="ui-field__error">{fieldErrors.password}</p> : null}
        <PasswordInput
          id="confirmPassword"
          label="Confirm Password"
          value={form.confirmPassword}
          autoComplete="new-password"
          onChange={(value) => {
            setForm((current) => ({ ...current, confirmPassword: value }));
            if (fieldErrors.confirmPassword) {
              setFieldErrors((current) => {
                const next = { ...current };
                delete next.confirmPassword;
                return next;
              });
            }
          }}
        />
        {fieldErrors.confirmPassword ? <p className="ui-field__error">{fieldErrors.confirmPassword}</p> : null}
        <Button
          type="submit"
          loading={isSignupSubmitDisabled(submitting)}
          className="auth-form__submit"
        >
          Create account
        </Button>
        <p className="auth-form__links">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </form>
    </Card>
  );
}
