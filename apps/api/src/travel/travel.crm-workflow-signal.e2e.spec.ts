import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from "@ai-workforce-os/plugin-sdk";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginAiService } from "../plugins/plugin-ai.service";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Stage 9E.1: proves the CRM-tool sales-handoff variant of BELOW_MINIMUM is converged onto the same
 * TRIP_SUBMISSION signal as the common case, instead of Travel Runtime calling a CRM tool directly.
 */
suite("Stage 9E.1: BELOW_MINIMUM with a CRM connector installed, through POST /api/v1/agents/run", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let pluginInstallationId: string;
  let connectorInstallationId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);

    const provider: AiProvider = {
      complete: async (completion: AiCompletionRequest): Promise<AiCompletionResult> => {
        const extraction = completion.messages[0]?.content.includes("information-extraction engine");
        const prompt = (completion.messages.at(-1)?.content ?? "").toLowerCase();
        const values: Record<string, unknown> = { intent: "provide_trip_details" };
        if (prompt.includes("krishna")) values.customerName = "Krishna";
        if (prompt.includes("delhi") && prompt.includes("dubai")) {
          Object.assign(values, {
            originCity: "Delhi",
            destinationCity: "Dubai",
            travelMonth: "November",
            days: 5,
            adults: 5,
            totalTravellers: 5,
            budget: 100,
            budgetCurrency: "USD"
          });
        }
        return {
          content: extraction ? JSON.stringify(values) : "I've noted that.",
          toolCalls: [],
          provider: "crm-workflow-signal-test",
          model: "crm-workflow-signal-test",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
        };
      }
    };
    app.get(PluginAiService).resolveProvider = async () => ({
      provider,
      settings: { providerType: "OPENAI_COMPATIBLE", model: "crm-workflow-signal-test", timeoutMs: 30_000 }
    });

    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `CRM Workflow Signal ${Date.now()}`,
        firstName: "Owner",
        email: `crm-workflow-signal-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    token = registered.body.data.tokens.accessToken;

    const installedConnector = await request(app.getHttpServer())
      .post("/api/v1/connector-installations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        connectorKey: "dummy-crm",
        displayName: "Travel CRM",
        configuration: {},
        credentials: {},
        grantedCapabilities: ["CRM"]
      })
      .expect(201);
    connectorInstallationId = installedConnector.body.id;
    await request(app.getHttpServer())
      .post(`/api/v1/connector-installations/${connectorInstallationId}/enable`)
      .set("Authorization", `Bearer ${token}`)
      .expect(201);

    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "travel-employee", grantedPermissions: ["CRM"], enable: true })
      .expect(201);
    pluginInstallationId = installed.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function turn(message: string, conversationId?: string) {
    return request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginInstallationId, ...(conversationId ? { conversationId } : {}), message })
      .expect(201);
  }

  it("creates the internal TravelLead directly via TRIP_SUBMISSION — Travel Runtime never calls the CRM tool itself, and the lead is best-effort synced to the installed CRM connector", async () => {
    const named = await turn("my name is krishna");
    const conversationId = named.body.conversationId as string;
    const below = await turn(
      "plan Delhi to Dubai in November for 5 days, 5 adults, budget $100 and show flights",
      conversationId
    );
    expect(below.body.response).toMatch(/minimum budget/i);
    expect(below.body.response).toMatch(/mobile number/i);
    // The turn that detected BELOW_MINIMUM never itself calls a CRM tool.
    const belowTools = await prisma.agentToolExecution.findMany({
      where: { execution: { conversationId } },
      select: { toolName: true }
    });
    expect(belowTools).toEqual([]);

    const phone = await turn("8380031193", conversationId);
    expect(phone.body.response).toMatch(/submitted successfully/i);
    const lead = await prisma.travelLead.findFirstOrThrow({ where: { conversationId } });
    expect(phone.body.response).toContain(lead.reference);
    expect(await prisma.travelLead.count({ where: { conversationId } })).toBe(1);

    // The internal lead was created directly (never via a travel.create_lead / CRM tool call tied to this
    // conversation's own turns) — internal persistence and external CRM sync are tracked separately.
    const tools = await prisma.agentToolExecution.findMany({
      where: { execution: { conversationId } },
      select: { toolName: true }
    });
    expect(tools).toEqual([]);

    // The best-effort CRM mirror is fire-and-forget; poll briefly (bounded) for it to complete rather than
    // asserting a fixed sleep — it must eventually leave the initial PENDING status.
    const deadline = Date.now() + 2000;
    let synced = await prisma.travelLead.findUniqueOrThrow({ where: { id: lead.id } });
    while (synced.crmSyncStatus === "PENDING" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      synced = await prisma.travelLead.findUniqueOrThrow({ where: { id: lead.id } });
    }
    expect(synced.crmSyncStatus).toBe("SYNCED");
    expect(await prisma.dummyCrmLead.count({ where: { connectorInstallationId } })).toBe(1);
  });
});
