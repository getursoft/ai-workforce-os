import { Injectable, Logger } from "@nestjs/common";

const EXPORT_TIMEOUT_MS = 2000;

export interface OtelSpanInput {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  spanType: string;
  component: string;
  status: "COMPLETED" | "FAILED";
  startedAtMs: number;
  durationMs: number;
  errorCode?: string | null;
}

/**
 * Sprint 4.7A Phase 12: optional OTLP/HTTP JSON exporter. Disabled by default (OTEL_ENABLED unset/false) —
 * the internal DB-backed trace store (ExecutionTrace/ExecutionSpan) is always the source of truth and keeps
 * working with zero external dependency; this only ever ADDS a best-effort mirror of completed spans to an
 * external collector. Every export is fire-and-forget with a short timeout: a slow, misconfigured, or
 * entirely absent collector can never slow down or fail the request that produced the span. traceId/spanId
 * are already OTel-shaped (see trace-context.ts), so no re-encoding is needed for those fields.
 */
@Injectable()
export class ObservabilityOtelExporterService {
  private readonly logger = new Logger(ObservabilityOtelExporterService.name);
  readonly enabled: boolean;
  private readonly endpoint: string | null;
  private readonly serviceName: string;
  private readonly sampleRate: number;

  constructor() {
    this.enabled = process.env.OTEL_ENABLED === "true";
    this.endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || null;
    this.serviceName = process.env.OTEL_SERVICE_NAME?.trim() || "ai-workforce-os-api";
    const parsedRate = Number(process.env.OTEL_SAMPLE_RATE ?? "1");
    this.sampleRate = Number.isFinite(parsedRate) ? Math.min(Math.max(parsedRate, 0), 1) : 1;
  }

  /** Never throws, never awaited by callers — see the class doc comment. */
  exportSpan(span: OtelSpanInput): void {
    if (!this.enabled || !this.endpoint) return;
    if (Math.random() >= this.sampleRate) return;
    void this.send(span).catch((error: unknown) => {
      this.logger.debug({ event: "OTEL_EXPORT_FAILED", error: error instanceof Error ? error.message : String(error) });
    });
  }

  private async send(span: OtelSpanInput): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
    try {
      const startNanos = BigInt(span.startedAtMs) * 1_000_000n;
      const endNanos = BigInt(span.startedAtMs + span.durationMs) * 1_000_000n;
      const body = {
        resourceSpans: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: this.serviceName } }] },
            scopeSpans: [
              {
                scope: { name: "ai-workforce-os.observability" },
                spans: [
                  {
                    traceId: span.traceId,
                    spanId: span.spanId,
                    parentSpanId: span.parentSpanId ?? undefined,
                    name: span.name,
                    startTimeUnixNano: startNanos.toString(),
                    endTimeUnixNano: endNanos.toString(),
                    kind: 1,
                    status: { code: span.status === "FAILED" ? 2 : 1 },
                    attributes: [
                      { key: "aiworkforce.span_type", value: { stringValue: span.spanType } },
                      { key: "aiworkforce.component", value: { stringValue: span.component } },
                      ...(span.errorCode ? [{ key: "aiworkforce.error_code", value: { stringValue: span.errorCode } }] : [])
                    ]
                  }
                ]
              }
            ]
          }
        ]
      };
      await fetch(`${this.endpoint}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
