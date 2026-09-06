/** Sprint 7 — the real WebSocket wiring for Twilio Media Streams. Deliberately NOT built on
 * @nestjs/websockets' @WebSocketGateway (which defaults to socket.io's wire protocol and would require
 * switching the whole application's WS adapter) — Twilio speaks a plain WebSocket with plain JSON
 * frames, so a raw `ws` server attached to a single, specific upgrade path via HttpAdapterHost is the
 * correct, minimal-footprint integration. All protocol/business logic is delegated to
 * VoiceStreamConnectionHandler (unit-tested separately) and VoiceSessionEngine — this class only owns
 * the socket plumbing and the initial per-connection authorization/correlation lookup (STEP 10).
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { VoiceSessionEngine } from "./voice-session.engine";
import { VoiceStreamConnectionHandler } from "./voice-stream-connection.handler";
import { VOICE_TRANSPORT_PROVIDER, type VoiceTransportProvider } from "./voice.types";

export const VOICE_STREAM_PATH_PREFIX = "/api/v1/channels/twilio/voice/stream/";
const SESSION_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;

@Injectable()
export class VoiceStreamGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VoiceStreamGateway.name);
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private readonly upgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) =>
    this.handleUpgrade(request, socket, head);

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly prisma: PrismaService,
    private readonly engine: VoiceSessionEngine,
    @Inject(VOICE_TRANSPORT_PROVIDER) private readonly transport: VoiceTransportProvider
  ) {}

  onModuleInit(): void {
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    const server = httpAdapter?.getHttpServer?.() as HttpServer | undefined;
    if (!server) {
      this.logger.warn("No underlying HTTP server available — voice media stream endpoint not attached");
      return;
    }
    this.httpServer = server;
    this.wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", this.upgradeListener);
  }

  async onModuleDestroy(): Promise<void> {
    this.httpServer?.off("upgrade", this.upgradeListener);
    await this.engine.shutdownAll();
    this.wss?.close();
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = request.url ?? "";
    if (!url.startsWith(VOICE_STREAM_PATH_PREFIX)) return; // not ours — leave the socket for other listeners
    const voiceSessionId = url.slice(VOICE_STREAM_PATH_PREFIX.length).split(/[/?]/)[0] ?? "";
    if (!SESSION_ID_PATTERN.test(voiceSessionId)) {
      socket.destroy();
      return;
    }
    if (!this.transport.validateMediaConnection({ headers: request.headers })) {
      socket.destroy();
      return;
    }
    this.wss?.handleUpgrade(request, socket, head, (ws) => {
      void this.onConnection(ws, voiceSessionId);
    });
  }

  private async onConnection(ws: WebSocket, voiceSessionId: string): Promise<void> {
    // Twilio (and this test client) sends "connected"/"start" immediately once the WS handshake
    // completes — which can race the async correlation lookup below. Buffer raw frames from the moment
    // the socket is accepted so nothing sent in that window is silently dropped; replay them in order
    // once the real handler is attached.
    const buffered: Buffer[] = [];
    const bufferListener = (data: Buffer) => buffered.push(data);
    ws.on("message", bufferListener);

    // Reject unknown channel / inactive channel / a session that has already streamed once (STEP 10) —
    // the lookup is scoped to the exact, unguessable session UUID, so this is also the tenant-isolation
    // boundary: there is no ambiguity to exploit across organizations.
    const session = await this.prisma.voiceSession.findFirst({
      where: { id: voiceSessionId, status: { in: ["CREATED", "RINGING"] } }
    });
    const channel = session
      ? await this.prisma.channelConnection.findFirst({ where: { id: session.channelConnectionId } })
      : null;
    if (!session || !channel || !channel.voiceEnabled || channel.status !== "ACTIVE") {
      ws.off("message", bufferListener);
      ws.close(4004, "UNKNOWN_OR_INACTIVE_VOICE_SESSION");
      return;
    }

    const handler = new VoiceStreamConnectionHandler(
      this.engine,
      {
        id: session.id,
        organizationId: session.organizationId,
        providerCallId: session.providerCallId,
        externalCallerId: session.externalCallerId
      },
      channel.receptionistGreeting ?? null,
      {
        send: (json) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(json));
        },
        close: (code, reason) => ws.close(code, reason)
      }
    );
    ws.off("message", bufferListener);
    ws.on("message", (data: Buffer) => handler.handleMessage(data));
    ws.on("close", () => handler.handleClose());
    ws.on("error", (error) => this.logger.warn(`voice media stream socket error: ${error.message}`));
    for (const data of buffered) handler.handleMessage(data);
  }
}
