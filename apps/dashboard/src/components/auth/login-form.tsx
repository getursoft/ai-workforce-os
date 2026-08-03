"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth, useLogin } from "../../features/auth/auth-provider";
import { ApiError } from "../../lib/api-error";
import { resolveReturnUrl } from "../../lib/return-url";
import {
  getLoginFailureMessage,
  isLoginSubmitDisabled,
  resolveLoginRedirectTarget,
  validateLoginForm
} from "./login-form.logic";
import { Alert, Button, Card, Input, Label, PasswordInput } from "../ui";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { state } = useAuth();
  const login = useLogin();
  const returnUrl = useMemo(
    () => resolveReturnUrl(searchParams.get("returnUrl"), "/dashboard"),
    [searchParams]
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
    organizationName?: string;
  }>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const target = resolveLoginRedirectTarget(
      state.isAuthenticated && !state.isInitializing,
      returnUrl
    );
    if (target) {
      router.replace(target);
    }
  }, [router, returnUrl, state.isAuthenticated, state.isInitializing]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const nextFieldErrors = validateLoginForm(email, password, organizationName);
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await login({ email, password, organizationName: organizationName.trim() });
      router.replace(returnUrl);
    } catch (caught: unknown) {
      const apiError = caught instanceof ApiError ? caught : null;
      setError(getLoginFailureMessage(apiError?.kind ?? null, apiError?.code ?? null));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="auth-card">
      <div className="auth-card__branding">
        <p className="auth-card__eyebrow">AI Workforce OS</p>
        <h1>Sign in to your workspace</h1>
        <p>Secure access for your organization, dashboard, and sessions.</p>
      </div>
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        {error ? (
          <Alert tone="danger" title="Authentication failed">
            {error}
          </Alert>
        ) : null}
        <div className="ui-field">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            aria-invalid={fieldErrors.email ? "true" : "false"}
            onChange={(event) => {
              setEmail(event.target.value);
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
          value={password}
          onChange={(value) => {
            setPassword(value);
            if (fieldErrors.password) {
              setFieldErrors((current) => {
                const next = { ...current };
                delete next.password;
                return next;
              });
            }
          }}
          autoComplete="current-password"
        />
        {fieldErrors.password ? <p className="ui-field__error">{fieldErrors.password}</p> : null}
        <p className="auth-form__links">
          <Link href="/forgot-password">Forgot password?</Link>
        </p>
        <div className="ui-field">
          <Label htmlFor="organizationName">Organization ID</Label>
          <Input
            id="organizationName"
            name="organizationName"
            type="text"
            autoComplete="organization"
            value={organizationName}
            aria-invalid={fieldErrors.organizationName ? "true" : "false"}
            onChange={(event) => {
              setOrganizationName(event.target.value);
              if (fieldErrors.organizationName) {
                setFieldErrors((current) => {
                  const next = { ...current };
                  delete next.organizationName;
                  return next;
                });
              }
            }}
          />
          {fieldErrors.organizationName ? (
            <p className="ui-field__error">{fieldErrors.organizationName}</p>
          ) : (
            <small>Your organization&apos;s name, as shown to you by your organization owner.</small>
          )}
        </div>
        <Button
          type="submit"
          loading={isLoginSubmitDisabled(submitting)}
          className="auth-form__submit"
        >
          Sign in
        </Button>
      </form>
    </Card>
  );
}
