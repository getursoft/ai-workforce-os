import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { computeTwilioSignature } from "./channel.runtime";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
// ConfigModule.forRoot() (no envFilePath) loads apps/api/.env from CWD by default, which may carry real
// TWILIO_* credentials from local dev work. resolveTwilioCredentials() prefers env vars over the DB-
// stored per-channel secret when all three are set — clear them so this suite deterministically exercises
// the encrypted ChannelConnection credential path this test's own signatures are computed against,
// instead of silently depending on whatever happens to be in a developer's local .env.
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_WHATSAPP_FROM;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const realFetch = globalThis.fetch;
let twilioMessageCounter = 0;
vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.startsWith("https://api.twilio.com/")) {
    if (init?.method === "GET")
      return new Response(JSON.stringify({ status: "active" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    twilioMessageCounter++;
    return new Response(
      JSON.stringify({ sid: `SM_OUTBOUND_${twilioMessageCounter}`, status: "queued" }),
      { status: 201, headers: { "content-type": "application/json" } }
    );
  }
  return realFetch(input as never, init);
}) as typeof fetch);

function requireDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

async function waitFor<T>(check: () => Promise<T | undefined | null>, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("TIMED_OUT_WAITING_FOR_CONDITION");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

suite("Channels (Twilio WhatsApp) HTTP", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let pluginId: string;
  let channelId: string;
  const authToken = "e2e-test-twilio-auth-token-value";
  const accountSid = "AC" + "e".repeat(32);
  const fromNumber = "+14155238886";
  const customerNumber = "+14155550100";

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup(prisma);

    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Channel Org ${Date.now()}`,
        firstName: "Owner",
        email: `channel-owner-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    ownerToken = registered.body.data.tokens.accessToken;

    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        pluginId: "dummy-echo",
        grantedPermissions: ["MEMORY"],
        configuration: { config: {}, secrets: {} },
        enable: true
      })
      .expect(201);
    pluginId = installed.body.id;
    const plugin = await prisma.plugin.findUniqueOrThrow({ where: { id: pluginId } });
    const owner = await prisma.user.findFirstOrThrow({
      where: { organizationId: plugin.organizationId }
    });
    const encryption = app.get(PluginSecretsEncryptionService);
    await prisma.pluginAiConfiguration.create({
      data: {
        organizationId: plugin.organizationId,
        pluginInstallationId: pluginId,
        providerType: "DETERMINISTIC",
        configuration: { timeoutMs: 30000 },
        encryptedSecrets: encryption.encrypt({}) as unknown as Prisma.InputJsonValue,
        updatedBy: owner.id
      }
    });
  });

  afterAll(async () => {
    if (prisma) await cleanup(prisma);
    await app?.close();
    vi.unstubAllGlobals();
  });

  function auth() {
    return { Authorization: `Bearer ${ownerToken}` };
  }

  function twilioForm(overrides: Record<string, string> = {}) {
    return {
      MessageSid: `SM${Date.now()}${Math.floor(Math.random() * 1000)}`,
      From: `whatsapp:${customerNumber}`,
      To: `whatsapp:${fromNumber}`,
      Body: "Hi, can you help me plan a trip?",
      NumMedia: "0",
      ...overrides
    };
  }

  function signedWebhookRequest(webhookUrl: string, form: Record<string, string>) {
    const signature = computeTwilioSignature(authToken, webhookUrl, form);
    const path = new URL(webhookUrl).pathname;
    return request(app.getHttpServer())
      .post(path)
      .type("form")
      .set("X-Twilio-Signature", signature)
      .send(form);
  }

  it("creates a channel, never returns the auth token, and exposes a working webhook URL", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/channels")
      .set(auth())
      .send({
        name: "Travel WhatsApp",
        provider: "TWILIO",
        channelType: "WHATSAPP",
        agentId: pluginId,
        configuration: { accountSid, authToken, fromNumber }
      })
      .expect(201);
    channelId = created.body.id;
    expect(created.body.hasAuthToken).toBe(true);
    expect(created.body.authToken).toBeUndefined();
    expect(created.body.configuration.authToken).toBeUndefined();
    expect(created.body.webhookUrl).toContain(
      `/api/v1/channels/twilio/whatsapp/webhook/${channelId}`
    );
    expect(created.body.status).toBe("DRAFT");

    await request(app.getHttpServer())
      .post(`/api/v1/channels/${channelId}/test`)
      .set(auth())
      .expect(201);

    const enabled = await request(app.getHttpServer())
      .post(`/api/v1/channels/${channelId}/enable`)
      .set(auth())
      .expect(201);
    expect(enabled.body.status).toBe("ACTIVE");
  });

  it("rejects a webhook with an invalid signature and does not persist a message", async () => {
    const form = twilioForm();
    await request(app.getHttpServer())
      .post(`/api/v1/channels/twilio/whatsapp/webhook/${channelId}`)
      .type("form")
      .set("X-Twilio-Signature", "clearly-invalid-signature")
      .send(form)
      .expect(401);
    expect(
      await prisma.channelMessage.count({ where: { providerMessageSid: form.MessageSid } })
    ).toBe(0);
  });

  it("returns 404 for an unknown channel id", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/channels/twilio/whatsapp/webhook/00000000-0000-4000-8000-000000000099")
      .type("form")
      .send(twilioForm())
      .expect(404);
  });

  it("processes a verified inbound webhook end-to-end and replies through Twilio", async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/channels/${channelId}`)
      .set(auth())
      .expect(200);
    const webhookUrl = detail.body.webhookUrl as string;
    const form = twilioForm();

    await signedWebhookRequest(webhookUrl, form).expect(200);

    const inbound = await waitFor(() =>
      prisma.channelMessage.findFirst({
        where: { providerMessageSid: form.MessageSid, status: { in: ["SENT", "FAILED"] } }
      })
    );
    expect(inbound.status).toBe("SENT");
    expect(inbound.conversationId).toBeTruthy();

    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: requireDefined(inbound.conversationId, "inbound.conversationId missing") }
    });
    expect(conversation.channelConnectionId).toBe(channelId);
    expect(conversation.externalUserId).toBe(customerNumber);
    expect(conversation.createdByUserId).toBeNull();

    const outbound = await prisma.channelMessage.findFirstOrThrow({
      where: { channelConnectionId: channelId, direction: "OUTBOUND", conversationId: conversation.id }
    });
    expect(outbound.status).toBe("SENT");
    expect(outbound.providerMessageSid).toMatch(/^SM_OUTBOUND_/);
    expect(outbound.body).toContain("practical travel itinerary");

    const execution = await prisma.agentExecution.findFirstOrThrow({
      where: { conversationId: conversation.id }
    });
    expect(execution.userId).toBeNull();
    expect(execution.status).toBe("COMPLETED");
  });

  it("ignores a duplicate webhook delivery (same MessageSid) without creating a second execution", async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/channels/${channelId}`)
      .set(auth())
      .expect(200);
    const webhookUrl = detail.body.webhookUrl as string;
    const form = twilioForm();

    await signedWebhookRequest(webhookUrl, form).expect(200);
    await waitFor(() =>
      prisma.channelMessage.findFirst({
        where: { providerMessageSid: form.MessageSid, status: { in: ["SENT", "FAILED"] } }
      })
    );
    const countAfterFirst = await prisma.channelMessage.count({
      where: { providerMessageSid: form.MessageSid }
    });
    const executionsAfterFirst = await prisma.agentExecution.count();

    await signedWebhookRequest(webhookUrl, form).expect(200);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));

    expect(
      await prisma.channelMessage.count({ where: { providerMessageSid: form.MessageSid } })
    ).toBe(countAfterFirst);
    expect(await prisma.agentExecution.count()).toBe(executionsAfterFirst);
  });

  it("reuses the same conversation for a second message from the same WhatsApp user", async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/channels/${channelId}`)
      .set(auth())
      .expect(200);
    const webhookUrl = detail.body.webhookUrl as string;
    const form = twilioForm({ Body: "One more question about the itinerary." });

    await signedWebhookRequest(webhookUrl, form).expect(200);
    const inbound = await waitFor(() =>
      prisma.channelMessage.findFirst({
        where: { providerMessageSid: form.MessageSid, status: { in: ["SENT", "FAILED"] } }
      })
    );
    const conversations = await prisma.conversation.findMany({
      where: { channelConnectionId: channelId, externalUserId: customerNumber }
    });
    expect(conversations).toHaveLength(1);
    const conversation = requireDefined(conversations[0], "conversation not found");
    expect(inbound.conversationId).toBe(conversation.id);

    // Three distinct inbound WhatsApp messages have now landed in this same conversation
    // across the preceding tests (initial message, duplicate-delivery message, and this one):
    // 3 USER + 3 ASSISTANT ConversationMessage rows, all under a single Conversation.
    const conversationMessages = await prisma.conversationMessage.count({
      where: { conversationId: conversation.id }
    });
    expect(conversationMessages).toBe(6);
  });

  it("preserves the stored auth token when a channel is updated without changing credentials", async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/channels/${channelId}`)
      .set(auth())
      .send({ name: "Travel WhatsApp (renamed)" })
      .expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/channels/${channelId}`)
      .set(auth())
      .expect(200);
    expect(detail.body.name).toBe("Travel WhatsApp (renamed)");
    expect(detail.body.hasAuthToken).toBe(true);

    // The original auth token must still verify signatures after the update.
    const form = twilioForm({ Body: "Still working after rename?" });
    await signedWebhookRequest(detail.body.webhookUrl, form).expect(200);
    await waitFor(() =>
      prisma.channelMessage.findFirst({
        where: { providerMessageSid: form.MessageSid, status: { in: ["SENT", "FAILED"] } }
      })
    );
  });

  it("rejects inbound webhooks once the channel is disabled", async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/channels/${channelId}/disable`)
      .set(auth())
      .expect(201);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/channels/${channelId}`)
      .set(auth())
      .expect(200);
    const form = twilioForm();
    await signedWebhookRequest(detail.body.webhookUrl, form).expect(409);
    expect(
      await prisma.channelMessage.count({ where: { providerMessageSid: form.MessageSid } })
    ).toBe(0);
    await request(app.getHttpServer())
      .post(`/api/v1/channels/${channelId}/enable`)
      .set(auth())
      .expect(201);
  });

  it("enforces tenant isolation: a different organization cannot read or modify this channel", async () => {
    const otherOrg = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Other Org ${Date.now()}`,
        firstName: "Owner",
        email: `other-owner-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    const otherToken = otherOrg.body.data.tokens.accessToken;
    await request(app.getHttpServer())
      .get(`/api/v1/channels/${channelId}`)
      .set({ Authorization: `Bearer ${otherToken}` })
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/v1/channels/${channelId}`)
      .set({ Authorization: `Bearer ${otherToken}` })
      .send({ name: "Hijacked" })
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/channels/${channelId}/messages`)
      .set({ Authorization: `Bearer ${otherToken}` })
      .expect(404);
  }, 15_000); // registration sends a real verification email when SMTP is configured locally — the
  // default 5s test timeout can be too tight for that round-trip, independent of anything under test here

  it("requires authentication for the configuration API but not for the Twilio webhook", async () => {
    await request(app.getHttpServer()).get("/api/v1/channels").expect(401);
    // The webhook itself is unauthenticated by design (Twilio cannot send a bearer token);
    // an invalid signature is still required and yields 401, not because auth is missing.
    await request(app.getHttpServer())
      .post(`/api/v1/channels/twilio/whatsapp/webhook/${channelId}`)
      .type("form")
      .send(twilioForm())
      .expect(401);
  });

  it("archives the channel and stops accepting webhooks for it", async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/channels/${channelId}`)
      .set(auth())
      .expect(204);
    await request(app.getHttpServer()).get(`/api/v1/channels/${channelId}`).set(auth()).expect(404);
  });

  it("lists channels — returns 200 with paginated items for the owning organisation", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/channels").set(auth()).expect(200);
    expect(res.body).toHaveProperty("items");
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("page");
    expect(res.body).toHaveProperty("pageSize");
    expect(res.body).toHaveProperty("totalPages");
    // Each item should have the agent field (mapped from pluginInstallation)
    for (const item of res.body.items) {
      expect(item).toHaveProperty("agentId");
      expect(item).toHaveProperty("agent");
      expect(item).toHaveProperty("hasAuthToken");
      expect(item).toHaveProperty("webhookUrl");
      expect(item).not.toHaveProperty("encryptedSecrets");
      expect(item).not.toHaveProperty("pluginInstallation");
    }
  });

  it("list response has the correct paginated shape even when no channels exist", async () => {
    // Verify the response contract: items array, pagination fields, no secrets exposed
    const res = await request(app.getHttpServer()).get("/api/v1/channels").set(auth()).expect(200);
    expect(res.body).toHaveProperty("items");
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("page");
    expect(res.body).toHaveProperty("pageSize");
    expect(res.body).toHaveProperty("totalPages");
    for (const item of res.body.items) {
      expect(item).toHaveProperty("agentId");
      expect(item).toHaveProperty("agent");
      expect(item).toHaveProperty("hasAuthToken");
      expect(item).toHaveProperty("webhookUrl");
      expect(item).not.toHaveProperty("encryptedSecrets");
      expect(item).not.toHaveProperty("pluginInstallation");
      expect(item).not.toHaveProperty("pluginInstallationId");
    }
  });
});

async function cleanup(prisma: PrismaService) {
  await prisma.channelMessage.deleteMany();
  await prisma.channelConnection.deleteMany();
  await prisma.conversationMessage.deleteMany();
  await prisma.agentToolExecution.deleteMany();
  await prisma.agentExecution.deleteMany();
  await prisma.agentMemory.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.pluginAiConfiguration.deleteMany();
  await prisma.pluginConfiguration.deleteMany();
  await prisma.plugin.deleteMany();
}
