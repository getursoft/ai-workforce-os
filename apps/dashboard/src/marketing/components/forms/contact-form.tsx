"use client";

import { useState, type FormEvent } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { isValidEmail, isRequired } from "@/lib/validation";

interface FormState {
  name: string;
  email: string;
  company: string;
  role: string;
  teamSize: string;
  interest: string;
  message: string;
  preferredContact: string;
}

const initialState: FormState = {
  name: "",
  email: "",
  company: "",
  role: "",
  teamSize: "1-10",
  interest: "General Enquiry",
  message: "",
  preferredContact: "Email",
};

export function ContactForm() {
  const [form, setForm] = useState<FormState>(initialState);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");

  function update<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): boolean {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!isRequired(form.name)) next.name = "Please enter your name.";
    if (!isValidEmail(form.email)) next.email = "Please enter a valid business email.";
    if (!isRequired(form.company)) next.company = "Please enter your company name.";
    if (!isRequired(form.message)) next.message = "Please enter a message.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validate()) return;

    setStatus("submitting");
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!response.ok) throw new Error("Request failed");
      setStatus("success");
    } catch {
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div role="status" className="flex flex-col items-center gap-3 rounded-card border border-success/20 bg-success/5 p-10 text-center">
        <CheckCircle2 className="h-10 w-10 text-success" aria-hidden="true" />
        <h3 className="text-lg font-bold text-ink">Thank you, {form.name.split(" ")[0]}.</h3>
        <p className="max-w-sm text-sm text-muted">
          Our team has received your message and will get back to you at {form.email} shortly.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Full Name" htmlFor="name" error={errors.name}>
          <input
            id="name"
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            className={inputClass(!!errors.name)}
            autoComplete="name"
          />
        </Field>
        <Field label="Business Email" htmlFor="email" error={errors.email}>
          <input
            id="email"
            type="email"
            value={form.email}
            onChange={(e) => update("email", e.target.value)}
            className={inputClass(!!errors.email)}
            autoComplete="email"
          />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Company" htmlFor="company" error={errors.company}>
          <input
            id="company"
            value={form.company}
            onChange={(e) => update("company", e.target.value)}
            className={inputClass(!!errors.company)}
            autoComplete="organization"
          />
        </Field>
        <Field label="Job Role" htmlFor="role">
          <input id="role" value={form.role} onChange={(e) => update("role", e.target.value)} className={inputClass(false)} />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Team Size" htmlFor="teamSize">
          <select id="teamSize" value={form.teamSize} onChange={(e) => update("teamSize", e.target.value)} className={inputClass(false)}>
            <option>1-10</option>
            <option>11-50</option>
            <option>51-200</option>
            <option>201-1000</option>
            <option>1000+</option>
          </select>
        </Field>
        <Field label="Area of Interest" htmlFor="interest">
          <select id="interest" value={form.interest} onChange={(e) => update("interest", e.target.value)} className={inputClass(false)}>
            <option>General Enquiry</option>
            <option>AI Employees</option>
            <option>Enterprise Deployment</option>
            <option>Integrations</option>
            <option>Partnerships</option>
            <option>Press</option>
          </select>
        </Field>
      </div>

      <Field label="Preferred Contact Method" htmlFor="preferredContact">
        <select
          id="preferredContact"
          value={form.preferredContact}
          onChange={(e) => update("preferredContact", e.target.value)}
          className={inputClass(false)}
        >
          <option>Email</option>
          <option>Phone</option>
          <option>Either</option>
        </select>
      </Field>

      <Field label="Message" htmlFor="message" error={errors.message}>
        <textarea
          id="message"
          rows={5}
          value={form.message}
          onChange={(e) => update("message", e.target.value)}
          className={inputClass(!!errors.message)}
        />
      </Field>

      {status === "error" && (
        <p role="alert" className="text-sm text-[#b02a37]">
          Something went wrong sending your message. Please try again.
        </p>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="focus-ring flex w-full items-center justify-center gap-2 h-11 rounded-xl bg-royal px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-navy disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {status === "submitting" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {status === "submitting" ? "Sending…" : "Send Message"}
      </button>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {error && (
        <p className="mt-1 text-xs text-[#b02a37]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function inputClass(hasError: boolean) {
  return `focus-ring w-full rounded-xl border px-4 py-2.5 text-sm text-ink outline-none ${
    hasError ? "border-[#b02a37]" : "border-royal/15 focus:border-saffron"
  }`;
}
