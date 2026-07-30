"use client";

import { useState, type FormEvent } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { isValidEmail, isRequired } from "@/lib/validation";

interface FormState {
  fullName: string;
  email: string;
  company: string;
  jobTitle: string;
  phone: string;
  companySize: string;
  department: string;
  useCase: string;
  employeeCount: string;
  integrationNeeds: string;
  preferredDate: string;
  message: string;
}

const initialState: FormState = {
  fullName: "",
  email: "",
  company: "",
  jobTitle: "",
  phone: "",
  companySize: "1-10",
  department: "Customer Support",
  useCase: "",
  employeeCount: "1",
  integrationNeeds: "",
  preferredDate: "",
  message: "",
};

export function DemoForm() {
  const [form, setForm] = useState<FormState>(initialState);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");

  function update<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): boolean {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!isRequired(form.fullName)) next.fullName = "Please enter your full name.";
    if (!isValidEmail(form.email)) next.email = "Please enter a valid business email.";
    if (!isRequired(form.company)) next.company = "Please enter your company name.";
    if (!isRequired(form.jobTitle)) next.jobTitle = "Please enter your job title.";
    if (!isRequired(form.useCase)) next.useCase = "Please describe your primary use case.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validate()) return;

    setStatus("submitting");
    try {
      const response = await fetch("/api/demo", {
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
        <h3 className="text-lg font-bold text-ink">Demo request received, {form.fullName.split(" ")[0]}.</h3>
        <p className="max-w-sm text-sm text-muted">
          Our team will reach out to {form.email} to confirm a time that works for you.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Full Name" htmlFor="fullName" error={errors.fullName}>
          <input id="fullName" value={form.fullName} onChange={(e) => update("fullName", e.target.value)} className={inputClass(!!errors.fullName)} autoComplete="name" />
        </Field>
        <Field label="Business Email" htmlFor="email" error={errors.email}>
          <input id="email" type="email" value={form.email} onChange={(e) => update("email", e.target.value)} className={inputClass(!!errors.email)} autoComplete="email" />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Company Name" htmlFor="company" error={errors.company}>
          <input id="company" value={form.company} onChange={(e) => update("company", e.target.value)} className={inputClass(!!errors.company)} autoComplete="organization" />
        </Field>
        <Field label="Job Title" htmlFor="jobTitle" error={errors.jobTitle}>
          <input id="jobTitle" value={form.jobTitle} onChange={(e) => update("jobTitle", e.target.value)} className={inputClass(!!errors.jobTitle)} />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Phone Number" htmlFor="phone">
          <input id="phone" type="tel" value={form.phone} onChange={(e) => update("phone", e.target.value)} className={inputClass(false)} autoComplete="tel" />
        </Field>
        <Field label="Company Size" htmlFor="companySize">
          <select id="companySize" value={form.companySize} onChange={(e) => update("companySize", e.target.value)} className={inputClass(false)}>
            <option>1-10</option>
            <option>11-50</option>
            <option>51-200</option>
            <option>201-1000</option>
            <option>1000+</option>
          </select>
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Department" htmlFor="department">
          <select id="department" value={form.department} onChange={(e) => update("department", e.target.value)} className={inputClass(false)}>
            <option>Customer Support</option>
            <option>Operations</option>
            <option>Sales</option>
            <option>Marketing</option>
            <option>HR</option>
            <option>Finance</option>
            <option>IT</option>
            <option>Travel</option>
            <option>Executive</option>
            <option>Other</option>
          </select>
        </Field>
        <Field label="Number of AI Employees Required" htmlFor="employeeCount">
          <select id="employeeCount" value={form.employeeCount} onChange={(e) => update("employeeCount", e.target.value)} className={inputClass(false)}>
            <option>1</option>
            <option>2-5</option>
            <option>6-10</option>
            <option>10+</option>
          </select>
        </Field>
      </div>

      <Field label="Primary Use Case" htmlFor="useCase" error={errors.useCase}>
        <textarea id="useCase" rows={3} value={form.useCase} onChange={(e) => update("useCase", e.target.value)} className={inputClass(!!errors.useCase)} placeholder="Tell us what you'd like an AI employee to handle" />
      </Field>

      <Field label="Integration Needs" htmlFor="integrationNeeds">
        <input id="integrationNeeds" value={form.integrationNeeds} onChange={(e) => update("integrationNeeds", e.target.value)} className={inputClass(false)} placeholder="e.g. Salesforce, Google Workspace" />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Preferred Meeting Date" htmlFor="preferredDate">
          <input id="preferredDate" type="date" value={form.preferredDate} onChange={(e) => update("preferredDate", e.target.value)} className={inputClass(false)} />
        </Field>
        <Field label="Message" htmlFor="message">
          <input id="message" value={form.message} onChange={(e) => update("message", e.target.value)} className={inputClass(false)} placeholder="Anything else we should know?" />
        </Field>
      </div>

      {status === "error" && (
        <p role="alert" className="text-sm text-[#b02a37]">
          Something went wrong submitting your request. Please try again.
        </p>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="focus-ring flex w-full items-center justify-center gap-2 h-11 rounded-xl bg-saffron px-4 text-sm font-semibold text-white shadow-gold transition-colors hover:bg-[#d97b00] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {status === "submitting" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {status === "submitting" ? "Submitting…" : "Book a Demo"}
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
