"use client";

import { useState, type FormEvent } from "react";
import { Send, CheckCircle2 } from "lucide-react";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function NewsletterForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "error" | "success">("idle");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!EMAIL_PATTERN.test(email)) {
      setStatus("error");
      return;
    }
    setStatus("success");
  }

  if (status === "success") {
    return (
      <p className="flex items-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-sm text-white" role="status">
        <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
        You&apos;re subscribed. Thank you for joining us.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-2">
      <label htmlFor="newsletter-email" className="sr-only">
        Email address
      </label>
      <div className="flex overflow-hidden rounded-xl border border-white/20 bg-white/10 focus-within:border-gold">
        <input
          id="newsletter-email"
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (status === "error") setStatus("idle");
          }}
          placeholder="Enter your email"
          aria-invalid={status === "error"}
          aria-describedby={status === "error" ? "newsletter-error" : undefined}
          className="w-full bg-transparent px-4 py-2.5 text-sm text-white placeholder:text-white/50 focus:outline-none"
        />
        <button
          type="submit"
          aria-label="Subscribe"
          className="focus-ring flex items-center justify-center bg-saffron px-4 text-white transition-colors hover:bg-[#d97b00]"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {status === "error" && (
        <p id="newsletter-error" className="text-xs text-[#ffb4b4]">
          Please enter a valid email address.
        </p>
      )}
    </form>
  );
}
