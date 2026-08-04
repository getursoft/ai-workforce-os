/** Shared types for the built-in job definition/template catalog. */

export interface JobDefinitionSeed {
  key: string;
  name: string;
  description: string;
  category: string;
  handlerType: string;
  retryPolicy: string;
  maxRetry: number;
  timeoutMs?: number;
  eventName?: string | null;
}

export interface JobTemplateSeed {
  name: string;
  description: string;
  definitionKey: string;
  triggerType:
    "DAILY" | "WEEKLY" | "MONTHLY" | "INTERVAL" | "AFTER_BOOKING" | "AFTER_APPROVAL" | "EVENT";
  atTime?: string;
  interval?: string;
  dayOfMonth?: number;
  eventName?: string | null;
  payload?: Record<string, unknown>;
}
