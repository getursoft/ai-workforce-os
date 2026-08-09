"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "../../features/auth/auth-provider";
import { ApiError } from "../../lib/api-error";
import { getForgotPasswordFailureMessage, validateForgotPasswordForm } from "./forgot-password-form.logic";
import { Alert, Button, Card, Input, Label } from "../ui";

export function ForgotPasswordForm() {
  const router = useRouter();
  const { client } = useAuth();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const errors = validateForgotPasswordForm(email);
    if (errors.email) {
      setFieldError(errors.email);
      return;
    }
    setFieldError(undefined);
    setSubmitting(true);
    try {
      const result = await client.forgotPassword(email);
      setSubmittedEmail(result.email);
    } catch (caught: unknown) {
      const apiError = caught instanceof ApiError ? caught : null;
      setError(getForgotPasswordFailureMessage(apiError?.kind ?? null));
    } finally {
      setSubmitting(false);
    }
  }

  if (submittedEmail) {
    return (
      <Card className="auth-card">
        <div className="auth-card__branding">
          <p className="auth-card__eyebrow">Krevia.ai</p>
          <h1>Check your email</h1>
          <p>
            If an account exists for <strong>{submittedEmail}</strong>, an 8-digit password reset code
            has been sent. It expires in 30 minutes.
          </p>
        </div>
        <Button
          type="button"
          className="auth-form__submit"
          onClick={() =>
            router.push(`/reset-password?email=${encodeURIComponent(submittedEmail)}`)
          }
        >
          I have a reset code
        </Button>
        <p className="auth-form__links">
          <Link href="/login">Back to sign in</Link>
        </p>
      </Card>
    );
  }

  return (
    <Card className="auth-card">
      <div className="auth-card__branding">
        <p className="auth-card__eyebrow">Krevia.ai</p>
        <h1>Forgot your password?</h1>
        <p>Enter your account email and we will send you a code to reset your password.</p>
      </div>
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        {error ? (
          <Alert tone="danger" title="Could not send reset code">
            {error}
          </Alert>
        ) : null}
        <div className="ui-field">
          <Label htmlFor="forgot-email">Email</Label>
          <Input
            id="forgot-email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            aria-invalid={fieldError ? "true" : "false"}
            onChange={(event) => {
              setEmail(event.target.value);
              if (fieldError) setFieldError(undefined);
            }}
          />
          {fieldError ? <p className="ui-field__error">{fieldError}</p> : null}
        </div>
        <Button type="submit" loading={submitting} disabled={submitting} className="auth-form__submit">
          Send reset code
        </Button>
        <p className="auth-form__links">
          <Link href="/login">Back to sign in</Link>
        </p>
      </form>
    </Card>
  );
}
