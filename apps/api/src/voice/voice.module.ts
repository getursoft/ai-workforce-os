/** Sprint 7 — wires the voice module together. Both providers are bound behind DI tokens
 * (VOICE_TRANSPORT_PROVIDER / VOICE_REALTIME_SPEECH_PROVIDER) so Twilio and the mock realtime provider
 * are genuinely swappable later without touching the controller/gateway/engine.
 *
 * Missing real provider credentials must never crash the app when RECEPTIONIST_VOICE_ENABLED=false or
 * VOICE_REALTIME_PROVIDER=mock (the default) — only requesting a non-mock realtime provider that has no
 * implementation yet fails fast, with a clear configuration error, at module-init time.
 */
import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.tokens";
import { IdentityModule } from "../identity/identity.module";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { PluginModule } from "../plugins/plugin.module";
import { ReceptionistModule } from "../receptionist/receptionist.module";
import { VoiceReceptionistTurnService, VoiceSessionService } from "../receptionist/voice-channel.adapter";
import { InteractionService } from "../interaction/interaction.service";
import { InteractionCompletionService } from "../interaction/interaction-completion.service";
import { buildVoiceEngineConfig, validateVoiceRealtimeProviderSelection } from "./voice-config";
import { VoiceMetricsService } from "./voice-metrics.service";
import { VoiceSessionEngine } from "./voice-session.engine";
import { VoiceStreamGateway } from "./voice-stream.gateway";
import { VoiceTranscriptService } from "./voice-transcript.service";
import { VoiceWebhookController } from "./voice-webhook.controller";
import { VoiceCallHistoryController } from "./voice-call-history.controller";
import { VoiceCallHistoryService } from "./voice-call-history.service";
import { MockRealtimeVoiceProvider } from "./voice-mock-realtime.provider";
import { TwilioVoiceTransportProvider } from "./twilio-voice.provider";
import {
  VOICE_REALTIME_SPEECH_PROVIDER,
  VOICE_TRANSPORT_PROVIDER,
  type RealtimeSpeechProvider,
  type VoiceTransportProvider
} from "./voice.types";

@Module({
  imports: [PrismaModule, IdentityModule, PluginModule, ReceptionistModule],
  controllers: [VoiceWebhookController, VoiceCallHistoryController],
  providers: [
    VoiceCallHistoryService,
    TwilioVoiceTransportProvider,
    MockRealtimeVoiceProvider,
    { provide: VOICE_TRANSPORT_PROVIDER, useExisting: TwilioVoiceTransportProvider },
    {
      provide: VOICE_REALTIME_SPEECH_PROVIDER,
      useFactory: (config: AppConfig, mock: MockRealtimeVoiceProvider): RealtimeSpeechProvider => {
        const requested = config.string("VOICE_REALTIME_PROVIDER", "mock");
        // STEP 17/34/35: fail fast for both directions — a non-mock provider that isn't implemented yet,
        // and (separately) mock silently running in production without an explicit opt-in. Never
        // silently fall back to mock for a real deployment.
        validateVoiceRealtimeProviderSelection({
          productionLike: config.productionLike,
          requestedProvider: requested,
          allowMockInProduction: config.boolean("VOICE_ALLOW_MOCK_IN_PRODUCTION", false),
          implementedProviders: []
        });
        return mock;
      },
      inject: [APP_CONFIG, MockRealtimeVoiceProvider]
    },
    VoiceMetricsService,
    VoiceTranscriptService,
    {
      provide: VoiceSessionEngine,
      useFactory: (
        transport: VoiceTransportProvider,
        realtime: RealtimeSpeechProvider,
        sessions: VoiceSessionService,
        turns: VoiceReceptionistTurnService,
        transcripts: VoiceTranscriptService,
        metrics: VoiceMetricsService,
        config: AppConfig,
        interactions: InteractionService,
        interactionCompletion: InteractionCompletionService
      ) =>
        new VoiceSessionEngine(
          transport,
          realtime,
          sessions,
          turns,
          transcripts,
          metrics,
          buildVoiceEngineConfig(config),
          interactions,
          interactionCompletion
        ),
      inject: [
        VOICE_TRANSPORT_PROVIDER,
        VOICE_REALTIME_SPEECH_PROVIDER,
        VoiceSessionService,
        VoiceReceptionistTurnService,
        VoiceTranscriptService,
        VoiceMetricsService,
        APP_CONFIG,
        InteractionService,
        InteractionCompletionService
      ]
    },
    VoiceStreamGateway
  ],
  exports: [VoiceSessionEngine, VoiceMetricsService, VoiceTranscriptService]
})
export class VoiceModule {}
