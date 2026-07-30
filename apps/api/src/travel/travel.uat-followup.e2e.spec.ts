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

/** Extracts only the current turn's raw text out of the extraction-call prompt, matching the established
 * pattern used by the other semantic-turn-sensitive e2e tests in this directory. */
function latestMessage(completion: AiCompletionRequest): string {
  const prompt = completion.messages.at(-1)?.content ?? "";
  return (/Latest user message: """([\s\S]*?)"""/.exec(prompt)?.[1] ?? "").toLowerCase();
}

function isExtractionCall(completion: AiCompletionRequest): boolean {
  return Boolean(completion.messages[0]?.content.includes("information-extraction engine"));
}

function providerResult(values: Record<string, unknown>, extraction: boolean): AiCompletionResult {
  return {
    content: extraction ? JSON.stringify(values) : "Understood.",
    toolCalls: [],
    provider: "uat-followup-test",
    model: "uat-followup-test",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  };
}

suite("Stage 9G Travel UAT follow-up: budget correction, open-budget, currency, hotel-area and itinerary routing", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let organizationId: string;
  let pluginInstallationId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `UAT Followup ${Date.now()}`,
        firstName: "Owner",
        email: `uat-followup-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    token = registered.body.data.tokens.accessToken;
    organizationId = registered.body.data.organization.id;
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "travel-employee", enable: true })
      .expect(201);
    pluginInstallationId = installed.body.id;
  });

  afterAll(async () => {
    if (prisma && organizationId) {
      await prisma.travelLead.deleteMany({ where: { organizationId } });
      await prisma.conversationMessage.deleteMany({ where: { organizationId } });
      await prisma.agentToolExecution.deleteMany({ where: { execution: { organizationId } } });
      await prisma.agentExecution.deleteMany({ where: { organizationId } });
      await prisma.agentMemory.deleteMany({ where: { organizationId } });
      await prisma.conversation.deleteMany({ where: { organizationId } });
      await prisma.travelEmployeeConfiguration.deleteMany({ where: { pluginInstallationId } });
      await prisma.pluginAiConfiguration.deleteMany({ where: { pluginInstallationId } });
      await prisma.pluginConfiguration.deleteMany({ where: { pluginId: pluginInstallationId } });
      await prisma.plugin.deleteMany({ where: { id: pluginInstallationId } });
    }
    await app.close();
  });

  async function turn(message: string, conversationId?: string) {
    return request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginInstallationId, ...(conversationId ? { conversationId } : {}), message })
      .expect(201);
  }

  it("Conversation 1: open budget + luxury typo + estimate ask never re-asks budget and settles on AED", async () => {
    const provider: AiProvider = {
      complete: async (completion) => {
        const extraction = isExtractionCall(completion);
        const latest = latestMessage(completion);
        const values: Record<string, unknown> = { intent: "provide_trip_details" };
        if (latest.includes("delhi") && latest.includes("singapore")) {
          Object.assign(values, {
            originCity: "Delhi",
            destinationCity: "Singapore",
            departureDate: "2027-08-12",
            travelMonth: "August",
            days: 5
          });
        }
        if (latest.includes("5 travellers")) Object.assign(values, { totalTravellers: 5 });
        if (latest.includes("5 adults")) Object.assign(values, { adults: 5, totalTravellers: 5 });
        if (latest.includes("luxary")) Object.assign(values, { hotelStars: 5 });
        if (latest.includes("give me your estimate")) values.intent = "ask_recommendation";
        return providerResult(values, extraction);
      }
    };
    app.get(PluginAiService).resolveProvider = async () => ({
      provider,
      settings: { providerType: "OPENAI_COMPATIBLE", model: "uat-followup-test", timeoutMs: 30_000 }
    });

    const t1 = await turn("Delhi to Singapore on 12 August 2027");
    const conversationId = t1.body.conversationId as string;
    await turn("5 travellers", conversationId);
    await turn("5 adults", conversationId);
    const openBudget = await turn("budget is openb", conversationId);
    expect(openBudget.body.response).not.toMatch(/what.*budget|budget.*range|share.*budget/i);

    const luxary = await turn("luxary", conversationId);
    expect(luxary.body.response).not.toMatch(/what.*budget|share.*budget/i);

    const estimate = await turn("give me your estimate", conversationId);
    expect(estimate.body.response).not.toMatch(/what.*budget|share.*budget|budget.*range/i);

    const aed = await turn("I need in AED", conversationId);
    expect(aed.body.response).toMatch(/AED/);
    expect(aed.body.response).not.toMatch(/what.*budget|share.*budget/i);
    expect(aed.body.response).not.toMatch(/₹|INR\b/);
  });

  it("Conversation 2: a budget correction, submission, then continued planning (policy/hotel/itinerary)", async () => {
    const provider: AiProvider = {
      complete: async (completion) => {
        const extraction = isExtractionCall(completion);
        const latest = latestMessage(completion);
        const values: Record<string, unknown> = { intent: "provide_trip_details" };
        if (latest.includes("krishna")) values.customerName = "Krishna";
        if (latest.includes("dubai") && latest.includes("5-day")) {
          Object.assign(values, { destinationCity: "Dubai", days: 5, travelMonth: "September" });
        }
        if (latest.includes("vegetarian")) values.preferences = ["vegetarian"];
        if (latest === "aed 5,000" || latest === "aed 5000")
          Object.assign(values, { budget: 5000, budgetCurrency: "AED" });
        if (latest.includes("alone")) Object.assign(values, { adults: 1, totalTravellers: 1 });
        if (latest === "delhi") Object.assign(values, { originCity: "Delhi" });
        if (latest.includes("aed 10,000") || latest.includes("aed 10000"))
          Object.assign(values, { budget: 10_000, budgetCurrency: "AED" });
        if (latest.includes("submit lead")) values.intent = "confirm_plan";
        return providerResult(values, extraction);
      }
    };
    app.get(PluginAiService).resolveProvider = async () => ({
      provider,
      settings: { providerType: "OPENAI_COMPATIBLE", model: "uat-followup-test", timeoutMs: 30_000 }
    });

    const named = await turn("my name is Krishna");
    const conversationId = named.body.conversationId as string;
    const t1 = await turn("5-day Dubai trip next month", conversationId);
    console.log("T1", t1.body.response);
    console.log("T2", (await turn("vegetarian", conversationId)).body.response);
    console.log("T3-below", (await turn("AED 5,000", conversationId)).body.response);
    console.log("T4-alone", (await turn("alone", conversationId)).body.response);
    console.log("T5-delhi", (await turn("Delhi", conversationId)).body.response);

    const corrected = await turn("AED 10,000", conversationId);
    console.log("T6-corrected", corrected.body.response);

    const submit = await turn("submit lead", conversationId);
    console.log("T7-submit", submit.body.response);
    const lead = await prisma.travelLead.findFirst({ where: { conversationId } });
    console.log("LEAD", lead?.reference, lead?.budgetAmount, lead?.budgetCurrency);

    const policy = await turn("cancellation policy", conversationId);
    console.log("T8-policy", policy.body.response);

    const hotels = await turn("suggest hotels near Marina", conversationId);
    console.log("T9-hotels", hotels.body.response);

    const itinerary = await turn("design day-to-day itinerary", conversationId);
    console.log("T10-itinerary", itinerary.body.response);
  });
});
