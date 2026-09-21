/** Sprint 7.12 STEP 14 — provider-neutral SMS abstraction. No existing SMS abstraction exists anywhere
 * in this codebase (confirmed by inspection) — Twilio's client only implements WhatsApp sending. */
export interface SmsSendInput {
  to: string;
  message: string;
}

export interface SmsSendResult {
  provider: string;
  status: "SENT" | "FAILED";
  messageId: string | null;
  /** Normalized error code, never a raw provider message — same convention as classifyProviderError. */
  error: string | null;
  /** Whether a retry might succeed (rate limit, timeout) vs a permanent rejection (invalid number). */
  retryable: boolean;
}

export interface SmsProvider {
  readonly name: string;
  isConfigured(): boolean;
  send(input: SmsSendInput): Promise<SmsSendResult>;
}
