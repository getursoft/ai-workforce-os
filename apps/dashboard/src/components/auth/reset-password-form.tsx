"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "../../features/auth/auth-provider";
import { ApiError } from "../../lib/api-error";
import {
  getResetPasswordFailureMessage,
  validateResetPasswordForm
} from "./forgot-password-form.logic";
import { Alert, Button, Card, Input, Label, PasswordInput } from "../ui";

export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { client } = useAuth();
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [token, setToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    token?: string;
    newPassword?: string;
    confirmPassword?: string;
  }>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [succeeded, setSucceeded] = useState(false);

  function clearFieldError(field: "email" | "token" | "newPassword" | "confirmPassword") {
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const errors = validateResetPasswordForm({ token, newPassword, confirmPassword });
    const nextErrors = { ...errors, ...(email.trim() ? {} : { email: "Email is required." }) };
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await client.resetPassword({ email: email.trim(), token: token.trim(), newPassword });
      setSucceeded(true);
    } catch (caught: unknown) {
      const apiError = caught instanceof ApiError ? caught : null;
      setError(getResetPasswordFailureMessage(apiError?.kind ?? null));
    } finally {
      setSubmitting(false);
    }
  }

  if (succeeded) {
    return (
      <Card className="auth-card">
        <div className="auth-card__branding">
          <p className="auth-card__eyebrow">AI Workforce OS</p>
          <h1>Password updated</h1>
          <p>Your password has been reset. Sign in with your new password.</p>
        </div>
        <Button type="button" className="auth-form__submit" onClick={() => router.push("/login")}>
          Go to sign in
        </Button>
      </Card>
    );
  }

  return (
    <Card className="auth-card">
      <div className="auth-card__branding">
        <p className="auth-card__eyebrow">AI Workforce OS</p>
        <h1>Reset your password</h1>
        <p>Enter the reset code from your email along with your new password.</p>
      </div>
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        {error ? (
          <Alert tone="danger" title="Could not reset password">
            {error}
          </Alert>
        ) : null}
        <div className="ui-field">
          <Label htmlFor="reset-email">Email</Label>
          <Input
            id="reset-email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            aria-invalid={fieldErrors.email ? "true" : "false"}
            onChange={(event) => {
              setEmail(event.target.value);
              if (fieldErrors.email) clearFieldError("email");
            }}
          />
          {fieldErrors.email ? <p className="ui-field__error">{fieldErrors.email}</p> : null}
        </div>
        <div className="ui-field">
          <Label htmlFor="reset-token">Reset code</Label>
          <Input
            id="reset-token"
            name="token"
            type="text"
            autoComplete="one-time-code"
            value={token}
            aria-invalid={fieldErrors.token ? "true" : "false"}
            onChange={(event) => {
              setToken(event.target.value);
              if (fieldErrors.token) clearFieldError("token");
            }}
          />
          {fieldErrors.token ? <p className="ui-field__error">{fieldErrors.token}</p> : null}
        </div>
        <PasswordInput
          id="reset-new-password"
          label="New password"
          value={newPassword}
          onChange={(value) => {
            setNewPassword(value);
            if (fieldErrors.newPassword) clearFieldError("newPassword");
          }}
          autoComplete="new-password"
        />
        {fieldErrors.newPassword ? <p className="ui-field__error">{fieldErrors.newPassword}</p> : null}
        <PasswordInput
          id="reset-confirm-password"
          label="Confirm new password"
          value={confirmPassword}
          onChange={(value) => {
            setConfirmPassword(value);
            if (fieldErrors.confirmPassword) clearFieldError("confirmPassword");
          }}
          autoComplete="new-password"
        />
        {fieldErrors.confirmPassword ? (
          <p className="ui-field__error">{fieldErrors.confirmPassword}</p>
        ) : null}
        <Button type="submit" loading={submitting} disabled={submitting} className="auth-form__submit">
          Reset password
        </Button>
        <p className="auth-form__links">
          <Link href="/login">Back to sign in</Link>
        </p>
      </form>
    </Card>
  );
}
