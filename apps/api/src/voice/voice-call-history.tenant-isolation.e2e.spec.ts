/** Sprint 7.11 — STEP 4: tenant isolation for the Call History API. Real Postgres, two real
 * organizations created through the real registration/install HTTP flow — proves
 * VoiceCallHistoryService can never return, fetch, or transcript another tenant's voice session, at the
 * data-access layer the controller's RBAC guards sit in front of.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Prisma } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { VoiceCallHistoryService } from "./voice-call-history.service";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Sprint 7.11: Call History API tenant isolation", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let history: VoiceCallHistoryService;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    history = app.get(VoiceCallHistoryService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  }, 20_000);

  async function registerOrgWithVoiceSession(label: string) {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Call History ${label} ${Date.now()}`,
        firstName: "Owner",
        email: `call-history-${label}-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    const organizationId = registered.body.data.organization.id as string;
    const token = registered.body.data.tokens.accessToken as string;

    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "receptionist-employee", configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    const pluginInstallationId = installed.body.id as string;

    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId } });
    const encryption = app.get(PluginSecretsEncryptionService);
    const channel = await prisma.channelConnection.create({
      data: {
        organizationId,
        pluginInstallationId,
        name: `Call History ${label} Channel`,
        provider: "TWILIO",
        channelType: "WHATSAPP",
        status: "ACTIVE",
        voiceEnabled: true,
        routingMode: "INTENT_ROUTER",
        receptionistGreeting: null,
        configuration: {} as unknown as Prisma.InputJsonValue,
        encryptedSecrets: encryption.encrypt({ authToken: "sim" }) as unknown as Prisma.InputJsonValue,
        secretMetadata: {},
        createdByUserId: owner.id
      }
    });
    const session = await prisma.voiceSession.create({
      data: {
        organizationId,
        channelConnectionId: channel.id,
        provider: "SIMULATOR",
        providerCallId: `ISOLATION-${label}-${Date.now()}`,
        transport: "SIMULATOR",
        direction: "INBOUND",
        externalCallerId: "+15550009999",
        status: "ENDED",
        startedAt: new Date(),
        answeredAt: new Date(),
        endedAt: new Date()
      }
    });
    await prisma.voiceTranscriptSegment.create({
      data: {
        organizationId,
        voiceSessionId: session.id,
        speaker: "USER",
        text: `secret to ${label} only`,
        isFinal: true,
        sequenceNumber: 1
      }
    });
    return { organizationId, sessionId: session.id, pluginInstallationId };
  }

  it("never returns, fetches, or transcripts another tenant's voice session", async () => {
    const orgA = await registerOrgWithVoiceSession("A");
    const orgB = await registerOrgWithVoiceSession("B");

    const listA = await history.list(orgA.organizationId, { page: 1, pageSize: 50 });
    expect(listA.items.map((i) => (i as { id: string }).id)).toContain(orgA.sessionId);
    expect(listA.items.map((i) => (i as { id: string }).id)).not.toContain(orgB.sessionId);

    await expect(history.get(orgA.organizationId, orgB.sessionId)).rejects.toMatchObject({ status: 404 });
    await expect(history.transcript(orgA.organizationId, orgB.sessionId, { page: 1, pageSize: 20 })).rejects.toMatchObject({
      status: 404
    });

    const ownTranscript = await history.transcript(orgB.organizationId, orgB.sessionId, { page: 1, pageSize: 20 });
    expect(ownTranscript.items).toHaveLength(1);

    const agentFilteredA = await history.list(orgA.organizationId, {
      page: 1,
      pageSize: 50,
      agentId: orgB.pluginInstallationId
    });
    expect(agentFilteredA.items).toHaveLength(0);
  }, 60_000);
});
