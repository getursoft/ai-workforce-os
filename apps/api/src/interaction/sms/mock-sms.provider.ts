/** Sprint 7.12 STEP 14/35 — the default, mandatory, credential-free SMS provider. `simulateNextFailure()`
 * lets tests deterministically exercise the transient-vs-permanent retry classification (STEP 32/43)
 * without magic phone-number strings — the same explicit-scripting-hook idea as
 * MockRealtimeVoiceProvider.simulateUserUtterance. */
import { Injectable } from "@nestjs/common";
import type { SmsProvider, SmsSendInput, SmsSendResult } from "./sms-provider.types";

@Injectable()
export class MockSmsProvider implements SmsProvider {
  readonly name = "mock";
  private nextFailure: "transient" | "permanent" | null = null;

  isConfigured(): boolean {
    return true;
  }

  /** Arms a ONE-SHOT failure for the next `send()` call only — resets to normal success afterward. */
  simulateNextFailure(kind: "transient" | "permanent"): void {
    this.nextFailure = kind;
  }

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    void input; // interface conformance only — the mock never inspects the destination/message.
    if (this.nextFailure) {
      const kind = this.nextFailure;
      this.nextFailure = null;
      return {
        provider: this.name,
        status: "FAILED",
        messageId: null,
        error: kind === "transient" ? "MOCK_SMS_TRANSIENT_ERROR" : "MOCK_SMS_PERMANENT_ERROR",
        retryable: kind === "transient"
      };
    }
    return {
      provider: this.name,
      status: "SENT",
      messageId: `mock-sms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      error: null,
      retryable: false
    };
  }
}
