/** Sprint 7.12 STEP 39/40/42/44 — real Postgres, real HTTP, real webhook signature verification, real
 * channel-message processor. Proves the Interaction/reference lifecycle end-to-end for WhatsApp text
 * (STEP 40), and separately for reference lookup + tenant isolation (STEP 42/44). Web chat (STEP 39)
 * shares the identical AgentService.execute() code path exercised here (a WhatsApp CHANNEL actor vs. a
 * dashboard USER actor only changes `input.actor`, not the Interaction hook itself — both are covered
 * by the same `applyInteractionCompletion`/`executeTraced` hook in agent.service.ts), so it is not
 * duplicated as a second full HTTP fixture.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { computeTwilioSignature } from "../channels/channel.runtime";
import { InteractionReferenceLookupService } from "./interaction-reference-lookup.service";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_WHATSAPP_FROM;
delete process.env.TWILIO_SMS_FROM_NUMBER;

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const realFetch = globalThis.fetch;
let outboundCounter = 0;
vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.startsWith("https://api.twilio.com/")) {
    if (init?.method === "GET")
      return new Response(JSON.stringify({ status: "active" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    outboundCounter++;
    return new Response(JSON.stringify({ sid: `SM_OUT_${outboundCounter}`, status: "queued" }), {
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

async function waitFor<T>(check: () => Promise<T | undefined | null>, timeoutMs = 6000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("TIMED_OUT_WAITING_FOR_CONDITION");
    await new Promise((r) => setTimeout(r, 100));
  }
}

suite("Sprint 7.12: Interaction/reference lifecycle", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const authToken = "e2e-interaction-twilio-auth-token";
  const accountSid = "AC" + "f".repeat(32);
  const fromNumber = "+14155238887";

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    vi.unstubAllGlobals();
  });

  async function registerOrgWithWhatsAppChannel(label: string, customerNumber: string) {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Interaction ${label} ${Date.now()}`,
        firstName: "Owner",
        email: `interaction-${label}-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    const token = registered.body.data.tokens.accessToken as string;
    const organizationId = registered.body.data.organization.id as string;

    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "dummy-echo", grantedPermissions: ["MEMORY"], configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    const pluginId = installed.body.id as string;
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId } });
    const encryption = app.get(PluginSecretsEncryptionService);
    await prisma.pluginAiConfiguration.create({
      data: {
        organizationId,
        pluginInstallationId: pluginId,
        providerType: "DETERMINISTIC",
        configuration: { timeoutMs: 30000 },
        encryptedSecrets: encryption.encrypt({}) as unknown as Prisma.InputJsonValue,
        updatedBy: owner.id
      }
    });

    const created = await request(app.getHttpServer())
      .post("/api/v1/channels")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: `Interaction ${label} WhatsApp`,
        provider: "TWILIO",
        channelType: "WHATSAPP",
        agentId: pluginId,
        configuration: { accountSid, authToken, fromNumber }
      })
      .expect(201);
    const channelId = created.body.id as string;
    await request(app.getHttpServer()).post(`/api/v1/channels/${channelId}/test`).set("Authorization", `Bearer ${token}`).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/channels/${channelId}/enable`).set("Authorization", `Bearer ${token}`).expect(201);

    const webhookUrl = `${(await request(app.getHttpServer()).get(`/api/v1/channels/${channelId}`).set("Authorization", `Bearer ${token}`)).body.webhookUrl}`;

    function sendInbound(body: string) {
      const form = {
        MessageSid: `SM${Date.now()}${Math.floor(Math.random() * 100000)}`,
        From: `whatsapp:${customerNumber}`,
        To: `whatsapp:${fromNumber}`,
        Body: body,
        NumMedia: "0"
      };
      const signature = computeTwilioSignature(authToken, webhookUrl, form);
      const path = new URL(webhookUrl).pathname;
      return request(app.getHttpServer()).post(path).type("form").set("X-Twilio-Signature", signature).send(form);
    }

    return { token, organizationId, channelId, pluginId, sendInbound };
  }

  it("creates an Interaction on the first inbound WhatsApp message, keeps the same reference across turns, completes on a closing remark, and notifies via WhatsApp", async () => {
    const org = await registerOrgWithWhatsAppChannel("A", "+14155551201");

    await org.sendInbound("Hi there, can you help me?").expect(200);
    const firstInbound = await waitFor(() =>
      prisma.channelMessage.findFirst({
        where: { channelConnectionId: org.channelId, direction: "INBOUND", conversationId: { not: null } }
      })
    );
    const conversationId = requireDefined(firstInbound.conversationId, "firstInbound.conversationId missing");
    await waitFor(() => prisma.channelMessage.findFirst({ where: { conversationId, direction: "OUTBOUND", status: "SENT" } }));

    const interaction = await waitFor(() => prisma.interaction.findFirst({ where: { organizationId: org.organizationId, conversationId } }));
    expect(interaction.status).toBe("ACTIVE");
    expect(interaction.referenceId).toMatch(/^KRV-[A-Z0-9]{6}$/);
    expect(interaction.channel).toBe("WHATSAPP");
    expect(interaction.channelConnectionId).toBe(org.channelId);
    const firstReferenceId = interaction.referenceId;

    // Second turn — same conversation, same reference, no second Interaction row.
    await org.sendInbound("One more question please").expect(200);
    await waitFor(async () => {
      const count = await prisma.channelMessage.count({ where: { conversationId, direction: "OUTBOUND" } });
      return count >= 2 ? true : null;
    });
    const interactionsForConversation = await prisma.interaction.count({ where: { organizationId: org.organizationId, conversationId } });
    expect(interactionsForConversation).toBe(1);

    // Closing remark — completes the interaction, appends the reference to the response, and triggers a
    // WhatsApp reference notification through the SAME ChannelMessageProcessor pipeline.
    await org.sendInbound("That's all, thanks!").expect(200);
    const completed = await waitFor(async () => {
      const row = await prisma.interaction.findFirst({ where: { id: interaction.id } });
      return row?.status === "COMPLETED" ? row : null;
    });
    expect(completed.referenceId).toBe(firstReferenceId);
    expect(completed.referenceCommunicatedAt).toBeTruthy();

    const closingOutbound = await waitFor(() =>
      prisma.channelMessage.findFirst({
        where: { conversationId, direction: "OUTBOUND", body: { contains: firstReferenceId } }
      })
    );
    expect(closingOutbound.body).toContain(firstReferenceId);

    const notification = await waitFor(() =>
      prisma.interactionNotification.findFirst({ where: { interactionId: interaction.id, type: "WHATSAPP" } })
    );
    expect(["SENT", "FAILED"]).toContain(notification.status);
  }, 30_000);

  it("never leaks another organization's interaction through reference lookup (STEP 42/44 tenant isolation)", async () => {
    const orgA = await registerOrgWithWhatsAppChannel("B", "+14155551202");
    const orgB = await registerOrgWithWhatsAppChannel("C", "+14155551203");

    await orgA.sendInbound("Plan my trip please").expect(200);
    const inboundA = await waitFor(() =>
      prisma.channelMessage.findFirst({
        where: { channelConnectionId: orgA.channelId, direction: "INBOUND", conversationId: { not: null } }
      })
    );
    const interactionA = await waitFor(() =>
      prisma.interaction.findFirst({
        where: { organizationId: orgA.organizationId, conversationId: requireDefined(inboundA.conversationId, "inboundA.conversationId missing") }
      })
    );

    const lookup = app.get(InteractionReferenceLookupService);
    const foundByOwner = await lookup.lookup(orgA.organizationId, interactionA.referenceId);
    expect(foundByOwner?.referenceId).toBe(interactionA.referenceId);

    const foundByOtherOrg = await lookup.lookup(orgB.organizationId, interactionA.referenceId);
    expect(foundByOtherOrg).toBeNull();
  }, 30_000);
});
