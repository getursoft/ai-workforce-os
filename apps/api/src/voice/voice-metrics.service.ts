/** Sprint 7 — in-memory voice metrics. The repo has no prom-client/StatsD integration (confirmed by
 * repository inspection); this follows the codebase's existing observability convention of Prisma-backed
 * read-side reporting (ObservabilityMetricsService) rather than introducing a new metrics dependency —
 * counters live in memory and are exposed via a snapshot, which a future StatsD/Prometheus exporter can
 * read from without any call-site changes.
 */
import { Injectable } from "@nestjs/common";

export type VoiceCounterName =
  | "voice_calls_started_total"
  | "voice_calls_completed_total"
  | "voice_calls_failed_total"
  | "voice_user_turns_total"
  | "voice_agent_turns_total"
  | "voice_interruptions_total"
  | "voice_tool_calls_total"
  | "voice_audio_frames_dropped_total";

export type VoiceHistogramName =
  | "voice_response_latency_ms"
  | "voice_first_audio_latency_ms"
  | "voice_call_duration_seconds"
  | "voice_agent_execution_latency_ms"
  | "voice_speech_to_transcript_latency_ms";

@Injectable()
export class VoiceMetricsService {
  private readonly counters = new Map<VoiceCounterName, number>();
  private readonly histograms = new Map<VoiceHistogramName, number[]>();
  private activeSessions = 0;

  increment(name: VoiceCounterName, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observe(name: VoiceHistogramName, valueMs: number): void {
    const values = this.histograms.get(name) ?? [];
    values.push(valueMs);
    // Bounded — this is a snapshot metrics store, not an unbounded audit log.
    if (values.length > 1000) values.shift();
    this.histograms.set(name, values);
  }

  sessionStarted(): void {
    this.activeSessions++;
  }

  sessionEnded(): void {
    this.activeSessions = Math.max(0, this.activeSessions - 1);
  }

  snapshot() {
    const histogramSummary = (values: number[] | undefined) => {
      if (!values || values.length === 0) return { count: 0, avgMs: 0, p95Ms: 0 };
      const sorted = [...values].sort((a, b) => a - b);
      const avgMs = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
      const p95Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
      return { count: sorted.length, avgMs: Math.round(avgMs), p95Ms: Math.round(p95Ms) };
    };
    return {
      counters: Object.fromEntries(this.counters),
      histograms: {
        voice_response_latency_ms: histogramSummary(this.histograms.get("voice_response_latency_ms")),
        voice_first_audio_latency_ms: histogramSummary(this.histograms.get("voice_first_audio_latency_ms")),
        voice_call_duration_seconds: histogramSummary(this.histograms.get("voice_call_duration_seconds")),
        voice_agent_execution_latency_ms: histogramSummary(
          this.histograms.get("voice_agent_execution_latency_ms")
        ),
        voice_speech_to_transcript_latency_ms: histogramSummary(
          this.histograms.get("voice_speech_to_transcript_latency_ms")
        )
      },
      voice_active_sessions: this.activeSessions
    };
  }
}
