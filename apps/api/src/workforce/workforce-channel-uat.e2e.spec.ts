import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Prisma } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { WorkforceOrchestratorService } from "./workforce-orchestrator.service";
import { computeTwilioSignature } from "../channels/channel.runtime";
import { dummyEchoManifest } from "@ai-workforce-os/plugin-dummy";

/**
 * Sprint 4.6 Channel UAT (item 6): a real WhatsApp-style customer conversation, through the same Twilio
 * webhook pipeline exercised by channels/channel.e2e.spec.ts, combined with a REAL internal delegation
 * from the primary employee to a specialist via WorkforceOrchestratorService. There is no code path in
 * this codebase today where a live chat turn triggers delegation automatically (confirmed: AgentService's
 * turn pipeline never calls WorkforceOrchestratorService) — that in-conversation trigger is out of scope
 * for this completion pass. This test instead proves the property the requirement actually cares about:
 * once a specialist consult happens for a customer turn, it stays completely internal — the customer's
 * channel conversation gets exactly one outbound message, sent by the primary employee, and the delegated
 * child task/conversation is never itself channel-connected or capable of sending an outbound message.
 */

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const realFetch = globalThis.fetch;
let twilioMessageCounter = 0;
vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.startsWith("https://api.twilio.com/")) {
    if (init?.method === "GET")
      return new Response(JSON.stringify({ status: "active" }), { status: 200, headers: { "content-type": "application/json" } });
    twilioMessageCounter++;
    return new Response(JSON.stringify({ sid: `SM_OUTBOUND_${twilioMessageCounter}`, status: "queued" }), {
      status: 201,
      headers: { "content-type": "application/json" }
    });
  }
  return realFetch(input as never, init);
}) as typeof fetch);

function requireDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("TIMED_OUT_WAITING_FOR_CONDITION");
    await new Promise((r) => setTimeout(r, 100));
  }
}

suite("Workforce Sprint 4.6 — WhatsApp channel UAT (delegation stays internal)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orchestrator: WorkforceOrchestratorService;
  let ownerToken: string;
  let orgId: string;
  let primaryId: string;
  let specialistId: string;
  let channelId: string;
  const authToken = "e2e-test-twilio-auth-token-value";
  const accountSid = "AC" + "e".repeat(32);
  const fromNumber = "+14155238886";
  const customerNumber = "+14155550199";

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    orchestrator = app.get(WorkforceOrchestratorService);

    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ organizationName: `Channel UAT Org ${Date.now()}`, firstName: "Owner", email: `channel-uat-${Date.now()}@example.com`, password: "StrongPassword@123" })
      .expect(201);
    ownerToken = registered.body.data.tokens.accessToken;
    orgId = registered.body.data.organization.id;
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId: orgId } });

    const encryption = app.get(PluginSecretsEncryptionService);
    async function install(idSuffix: string): Promise<string> {
      const res = await request(app.getHttpServer())
        .post("/api/v1/plugins/install")
        .set(auth())
        .send({ manifest: { ...dummyEchoManifest, id: `channel-uat-${idSuffix}`, name: `UAT ${idSuffix}`, displayName: `UAT ${idSuffix}` }, enable: true })
        .expect(201);
      await prisma.pluginAiConfiguration.create({
        data: {
          organizationId: orgId,
          pluginInstallationId: res.body.id,
          providerType: "DETERMINISTIC",
          configuration: { timeoutMs: 30000 },
          encryptedSecrets: encryption.encrypt({}) as unknown as Prisma.InputJsonValue,
          updatedBy: owner.id
        }
      });
      return res.body.id as string;
    }
    primaryId = await install("primary");
    specialistId = await install("specialist");

    const created = await request(app.getHttpServer())
      .post("/api/v1/channels")
      .set(auth())
      .send({ name: "Support WhatsApp", provider: "TWILIO", channelType: "WHATSAPP", agentId: primaryId, configuration: { accountSid, authToken, fromNumber } })
      .expect(201);
    channelId = created.body.id;
    await request(app.getHttpServer()).post(`/api/v1/channels/${channelId}/test`).set(auth()).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/channels/${channelId}/enable`).set(auth()).expect(201);
  });

  afterAll(async () => {
    if (prisma && orgId) {
      await prisma.channelMessage.deleteMany({ where: { channelConnectionId: channelId } }).catch(() => undefined);
      await prisma.channelConnection.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.employeeDelegatedTask.deleteMany({ where: { organizationId: orgId } });
      await prisma.agentExecution.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.conversation.deleteMany({ where: { organizationId: orgId } });
      await prisma.pluginAiConfiguration.deleteMany({ where: { organizationId: orgId } });
      await prisma.pluginConfiguration.deleteMany({ where: { organizationId: orgId } });
      await prisma.plugin.deleteMany({ where: { organizationId: orgId } });
    }
    await app?.close();
    vi.unstubAllGlobals();
  });

  function auth() {
    return { Authorization: `Bearer ${ownerToken}` };
  }

  it("a real inbound WhatsApp message produces exactly one outbound reply from the primary employee", async () => {
    const detail = await request(app.getHttpServer()).get(`/api/v1/channels/${channelId}`).set(auth()).expect(200);
    const webhookUrl = detail.body.webhookUrl as string;
    const form = {
      MessageSid: `SM${Date.now()}`,
      From: `whatsapp:${customerNumber}`,
      To: `whatsapp:${fromNumber}`,
      Body: "Hi, I have a billing question about my account",
      NumMedia: "0"
    };
    const signature = computeTwilioSignature(authToken, webhookUrl, form);
    const path = new URL(webhookUrl).pathname;
    await request(app.getHttpServer()).post(path).type("form").set("X-Twilio-Signature", signature).send(form).expect(200);

    const inbound = await waitFor(() => prisma.channelMessage.findFirst({ where: { providerMessageSid: form.MessageSid, status: { in: ["SENT", "FAILED"] } } }));
    expect(inbound.status).toBe("SENT");
    const customerConversationId = requireDefined(inbound.conversationId, "inbound.conversationId missing");

    const outboundBefore = await prisma.channelMessage.count({
      where: { channelConnectionId: channelId, direction: "OUTBOUND", conversationId: customerConversationId }
    });
    expect(outboundBefore).toBe(1);

    // Simulates the primary employee consulting a specialist internally while handling this customer
    // turn — the real Sprint 4.6 delegation engine, invoked exactly as a future in-conversation trigger
    // would call it. No such automatic trigger exists in the live chat pipeline yet (see file header).
    const delegated = await orchestrator.delegate({
      organizationId: orgId,
      sourceEmployeeInstallationId: primaryId,
      targetEmployeeInstallationId: specialistId,
      requestedByActorType: "EMPLOYEE",
      requestedByActorId: primaryId,
      contract: {
        taskType: "GENERAL_QUERY",
        objective: "Internal consult: verify the billing policy for this customer question",
        input: { customerConversationId, question: form.Body }
      },
      mode: "SYNCHRONOUS"
    });
    expect(["COMPLETED", "FAILED"]).toContain(delegated.status);

    const delegatedTask = await prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: delegated.id } });
    expect(delegatedTask.childConversationId).toBeTruthy();
    expect(delegatedTask.childConversationId).not.toBe(customerConversationId);
    const childConversationId = requireDefined(delegatedTask.childConversationId, "childConversationId missing");

    const childConversation = await prisma.conversation.findUniqueOrThrow({ where: { id: childConversationId } });
    expect(childConversation.channelConnectionId).toBeNull();
    expect(childConversation.externalUserId).toBeNull();

    // The specialist consult must never itself reach the customer over the channel — the customer-facing
    // conversation keeps exactly the one outbound message the primary employee already sent above.
    const outboundAfter = await prisma.channelMessage.count({
      where: { channelConnectionId: channelId, direction: "OUTBOUND", conversationId: customerConversationId }
    });
    expect(outboundAfter).toBe(outboundBefore);

    const anyOutboundOnChildConversation = await prisma.channelMessage.count({
      where: { conversationId: childConversationId }
    });
    expect(anyOutboundOnChildConversation).toBe(0);
  });
});
