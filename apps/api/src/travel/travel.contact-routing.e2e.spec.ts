import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from "@ai-workforce-os/plugin-sdk";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { KnowledgeSearchService } from "../knowledge/knowledge.search";
import { PluginAiService } from "../plugins/plugin-ai.service";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Travel contact input routing through POST /api/v1/agents/run", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let organizationId: string;
  let pluginInstallationId: string;
  let knowledgeSearch: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);

    const provider: AiProvider = {
      complete: async (completion: AiCompletionRequest): Promise<AiCompletionResult> => {
        const extraction = completion.messages[0]?.content.includes("information-extraction engine");
        const prompt = (completion.messages.at(-1)?.content ?? "").toLowerCase();
        let content = "I’ve noted that.";
        if (extraction) {
          const values: Record<string, unknown> = { intent: "provide_trip_details" };
          if (prompt.includes("my name is krishna")) values.customerName = "Krishna";
          if (prompt.includes("delhi") && prompt.includes("dubai")) {
            Object.assign(values, {
              originCity: "Delhi",
              destinationCity: "Dubai",
              travelMonth: "November",
              days: 5,
              adults: 5,
              totalTravellers: 5,
              budget: 100,
              budgetCurrency: "USD",
              intent: "ask_recommendation"
            });
          }
          if (prompt.includes("delhi") && prompt.includes("london")) {
            Object.assign(values, {
              originCity: "Delhi",
              destinationCity: "London",
              nights: 3,
              adults: 5,
              totalTravellers: 5,
              intent: "ask_budget_guidance"
            });
          }
          content = JSON.stringify(values);
        }
        return {
          content,
          toolCalls: [],
          provider: "contact-routing-test",
          model: "contact-routing-test",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
        };
      }
    };
    app.get(PluginAiService).resolveProvider = async () => ({
      provider,
      settings: { providerType: "OPENAI_COMPATIBLE", model: "contact-routing-test", timeoutMs: 30_000 }
    });
    knowledgeSearch = vi.spyOn(app.get(KnowledgeSearchService), "search");

    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Contact Routing ${Date.now()}`,
        firstName: "Owner",
        email: `contact-routing-${Date.now()}@example.com`,
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
      await prisma.travelEmployeeConfiguration.deleteMany({
        where: { pluginInstallationId }
      });
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

  it("keeps lead contact pending through thanks, creates once, and reuses it for international format", async () => {
    const named = await turn("my name is krishna");
    const conversationId = named.body.conversationId as string;
    const below = await turn(
      "plan Delhi to Dubai in November for 5 days, 5 adults, budget $100 and show flights",
      conversationId
    );
    expect(below.body.response).toMatch(/mobile number/i);

    const thanks = await turn("okay thank you", conversationId);
    expect(thanks.body.response).toMatch(/whenever you're ready/i);
    expect(thanks.body.response).not.toMatch(/doesn't look like a valid mobile/i);

    const phone = await turn("8380031193", conversationId);
    expect(phone.body.response).toMatch(/submitted successfully/i);
    const lead = await prisma.travelLead.findFirstOrThrow({ where: { conversationId } });
    expect(phone.body.response).toContain(lead.reference);

    const repeated = await turn("+918380031193", conversationId);
    expect(repeated.body.response).toContain(lead.reference);
    expect(await prisma.travelLead.count({ where: { conversationId } })).toBe(1);

    // Stage 9E: BELOW_MINIMUM's contact collection is now owned by TRIP_SUBMISSION (same architecture as
    // the already-migrated triggers, see the other test in this file), which creates the internal lead via
    // a direct TravelLeadService call rather than the travel.create_lead tool-call round trip the legacy
    // engine used — no AgentToolExecution row is created.
    const tools = await prisma.agentToolExecution.findMany({
      where: { execution: { conversationId } },
      select: { toolName: true }
    });
    expect(tools).toEqual([]);
    expect(knowledgeSearch).not.toHaveBeenCalledWith(
      organizationId,
      pluginInstallationId,
      expect.objectContaining({ query: expect.stringMatching(/8380031193|thank you/i) })
    );
  });

  it("asks before using a standalone phone after closure and creates only after confirmation", async () => {
    const named = await turn("my name is krishna");
    const conversationId = named.body.conversationId as string;
    await turn("Delhi to London, 5 travellers, 3 nights, estimate budget", conversationId);
    await turn("thank you", conversationId);

    const phone = await turn("8380031193", conversationId);
    expect(phone.body.response).toMatch(/looks like a mobile number/i);
    expect(phone.body.response).toMatch(/Delhi-to-London trip/i);
    expect(phone.body.response).not.toMatch(/travellers noted|adults.*children.*infants/i);
    expect(await prisma.travelLead.count({ where: { conversationId } })).toBe(0);

    const confirmed = await turn("yes, create the enquiry", conversationId);
    const lead = await prisma.travelLead.findFirstOrThrow({ where: { conversationId } });
    expect(confirmed.body.response).toContain(lead.reference);
    expect(lead).toMatchObject({
      phoneNumber: "8380031193",
      departureCity: "Delhi",
      destination: "London"
    });
    expect(await prisma.travelLead.count({ where: { conversationId } })).toBe(1);

    // Stage 9D: this flow is now owned by the TRIP_SUBMISSION workflow, which creates the lead via a
    // direct TravelLeadService call (see TripSubmissionWorkflowService) rather than the
    // travel.create_lead tool-call round trip the legacy engine used — no AgentToolExecution row is
    // created, matching the same architecture already used by Contact Capture and Booking Handoff.
    const tools = await prisma.agentToolExecution.findMany({
      where: { execution: { conversationId } },
      select: { toolName: true }
    });
    expect(tools).toEqual([]);
  });

  it("Stage 9E: migrates a conversation whose BELOW_MINIMUM contact state predates the Workflow Signal Engine, resuming seamlessly with no repeated ask", async () => {
    const named = await turn("my name is krishna");
    const conversationId = named.body.conversationId as string;
    const below = await turn(
      "plan Delhi to Dubai in November for 5 days, 5 adults, budget $100 and show flights",
      conversationId
    );
    expect(below.body.response).toMatch(/mobile number/i);

    // Simulate a conversation that reached this exact legacy pending-contact state BEFORE the Workflow
    // Signal Engine existed: the legacy pendingInputAction/completionStage memory is present, but no
    // WorkflowExecution row is (in production, such conversations exist naturally from before Stage 9E
    // shipped; here the only way to reproduce that is to delete the row Stage 9E's own signal just created).
    await prisma.workflowExecution.deleteMany({ where: { conversationId } });
    expect(await prisma.workflowExecution.count({ where: { conversationId } })).toBe(0);

    const phone = await turn("8380031193", conversationId);
    expect(phone.body.response).toMatch(/submitted successfully/i);
    const lead = await prisma.travelLead.findFirstOrThrow({ where: { conversationId } });
    expect(phone.body.response).toContain(lead.reference);
    expect(await prisma.travelLead.count({ where: { conversationId } })).toBe(1);

    const migratedWorkflow = await prisma.workflowExecution.findFirst({
      where: { conversationId, workflowType: "TRIP_SUBMISSION" }
    });
    expect(migratedWorkflow?.status).toBe("COMPLETED");
  });

  it("Stage 9F: a budget correction that resolves BELOW_MINIMUM feasibility supersedes the stale contact-collection workflow instead of continuing to demand a phone number", async () => {
    // Steps 1-2 reuse the file's default provider (fixed budget: 100 USD for Delhi/Dubai) to reliably
    // reach the same BELOW_MINIMUM/TRIP_SUBMISSION state the first test in this file already proves.
    const named = await turn("my name is krishna");
    const conversationId = named.body.conversationId as string;
    const below = await turn(
      "plan Delhi to Dubai in November for 5 days, 5 adults, budget $100 and show flights",
      conversationId
    );
    expect(below.body.response).toMatch(/mobile number/i);
    const beforeCorrection = await prisma.workflowExecution.findFirstOrThrow({
      where: { conversationId, workflowType: "TRIP_SUBMISSION" }
    });
    expect(beforeCorrection.status).toBe("WAITING_FOR_INPUT");

    // Now a materially higher, clearly-feasible budget correction, in the "<amount> AED" (postfix
    // currency) shape from the Stage 9F UAT charter's own scenario — 500,000 AED because this trip is for
    // 5 travellers (test 1's fixed setup), not the charter's single-traveller example; the exact minimum
    // doesn't matter, only that it clearly resolves BELOW_MINIMUM. The provider for this turn parses only
    // the LATEST message (mirroring this file's other semantic-turn-sensitive test), independent of the
    // fixed extraction the earlier turns used; it deliberately returns the SAME "provide_trip_details"
    // intent a real (non-corrected-for) classification might produce — the deterministic
    // `explicitBudgetCorrection` override in `travel.runtime.ts` (Stage 9F) is what makes the correction
    // take effect regardless, and the newly-added postfix-currency support in `extractBudget` (Stage 9F)
    // is what lets that override recognize "500000 AED" as a budget at all.
    const correctionProvider: AiProvider = {
      complete: async (completion: AiCompletionRequest): Promise<AiCompletionResult> => {
        const extraction = completion.messages[0]?.content.includes("information-extraction engine");
        const prompt = completion.messages.at(-1)?.content ?? "";
        const latest = /Latest user message: \"\"\"([\s\S]*?)\"\"\"/.exec(prompt)?.[1]?.toLowerCase() ?? "";
        const values: Record<string, unknown> = { intent: "provide_trip_details" };
        if (latest.includes("500000 aed")) Object.assign(values, { budget: 500_000, budgetCurrency: "AED" });
        return {
          content: extraction ? JSON.stringify(values) : "Understood.",
          toolCalls: [],
          provider: "budget-correction-test",
          model: "budget-correction-test",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
        };
      }
    };
    app.get(PluginAiService).resolveProvider = async () => ({
      provider: correctionProvider,
      settings: { providerType: "OPENAI_COMPATIBLE", model: "budget-correction-test", timeoutMs: 30_000 }
    });

    const corrected = await turn("500000 AED", conversationId);

    // The stale workflow is superseded, not left demanding contact for a now-invalid reason.
    const afterCorrection = await prisma.workflowExecution.findFirstOrThrow({
      where: { id: beforeCorrection.id }
    });
    expect(afterCorrection.status).toBe("CANCELLED");
    expect(afterCorrection.currentStep).toBe("SUPERSEDED_BUDGET_CORRECTED");
    // No lead was ever created for the stale, invalidated trigger.
    expect(await prisma.travelLead.count({ where: { conversationId } })).toBe(0);
    // The correction turn's own response is never the legacy "wasn't able to save" fallback nor a bare
    // repeat of the contact ask — it fell through to Travel Runtime's normal turn processing.
    expect(corrected.body.response).not.toMatch(/mobile number/i);
  });

  it("answers a semantic budget detour while contact is pending (deferred to Travel Runtime), then still creates the lead with the correct trip details once given", async () => {
    knowledgeSearch.mockClear();
    const semanticProvider: AiProvider = {
      complete: async (completion: AiCompletionRequest): Promise<AiCompletionResult> => {
        const extraction = completion.messages[0]?.content.includes("information-extraction engine");
        const prompt = completion.messages.at(-1)?.content ?? "";
        const latest = /Latest user message: \"\"\"([\s\S]*?)\"\"\"/.exec(prompt)?.[1]?.toLowerCase() ?? "";
        const values: Record<string, unknown> = { intent: "provide_trip_details" };
        if (latest === "krishna") values.customerName = "Krishna";
        if (latest.includes("delhi to dubai"))
          Object.assign(values, { originCity: "Delhi", destinationCity: "Dubai" });
        if (latest.includes("3 adult") && latest.includes("4 days"))
          Object.assign(values, { adults: 3, totalTravellers: 3, days: 4 });
        if (latest.includes("12 jan 2027"))
          Object.assign(values, { departureDate: "2027-01-12", travelMonth: "January" });
        if (latest.includes("500000 aed"))
          Object.assign(values, { budget: 500_000, budgetCurrency: "AED" });
        if (latest.includes("minimal possible budget")) values.intent = "ask_budget_guidance";
        return {
          content: extraction ? JSON.stringify(values) : "I’ve noted that.",
          toolCalls: [],
          provider: "semantic-turn-test",
          model: "semantic-turn-test",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
        };
      }
    };
    app.get(PluginAiService).resolveProvider = async () => ({
      provider: semanticProvider,
      settings: { providerType: "OPENAI_COMPATIBLE", model: "semantic-turn-test", timeoutMs: 30_000 }
    });

    const named = await turn("Krishna");
    const conversationId = named.body.conversationId as string;
    await turn("plan my trip for delhi to dubai", conversationId);
    await turn("3 adult for 4 days", conversationId);
    await turn("12 Jan 2027", conversationId);
    const lowBudget = await turn("10000 AED", conversationId);
    expect(lowBudget.body.response).toMatch(/minimum budget|mobile number/i);

    // Stage 9E.1: TRIP_SUBMISSION's resume() recognizes this as an unrelated semantic detour (not a
    // contact reply) and DEFERs it (see TripSubmissionWorkflowService.resume()'s "default" branch and the
    // new WorkflowResumeDecision "DEFER") — the workflow makes no state change and the turn falls through
    // to the normal pipeline, where Travel Runtime (still holding its own legacy pending-contact awareness,
    // preserved deliberately — see travel.runtime.ts's TravelRuntimeExecutionMode) answers the budget
    // question with a real estimate, exactly as it did before BELOW_MINIMUM was migrated onto a real
    // workflow (Stage 9E).
    const budget = await turn("share the minimal possible budget", conversationId);
    expect(budget.body.response).toMatch(/AED/);
    expect(budget.body.response).toMatch(/budget|estimate/i);
    expect(budget.body.response).not.toMatch(/you'?re welcome|whenever you'?re ready|retrieve the options/i);
    expect(await prisma.travelLead.count({ where: { conversationId } })).toBe(0);

    const phone = await turn("8380031193", conversationId);
    const lead = await prisma.travelLead.findFirstOrThrow({ where: { conversationId } });
    expect(phone.body.response).toContain(lead.reference);
    expect(phone.body.response).not.toMatch(/retrieve the options/i);
    expect(lead).toMatchObject({
      phoneNumber: "8380031193",
      departureCity: "Delhi",
      destination: "Dubai",
      budgetCurrency: "AED"
    });
    expect(Number(lead.budgetAmount)).toBe(10_000);
    // Stage 9E: TRIP_SUBMISSION records the bare traveller count ("3"), not a formatted phrase like
    // "3 adults" — the same convention already used by the two triggers TRIP_SUBMISSION already owned
    // since Stage 9D (see TripSubmissionTripContext.passengers / trip-submission.service.spec.ts's fixture).
    expect(lead.passengers).toBe("3");
    expect(await prisma.travelLead.count({ where: { conversationId } })).toBe(1);

    const repeated = await turn("+918380031193", conversationId);
    expect(repeated.body.response).toContain(lead.reference);
    expect(await prisma.travelLead.count({ where: { conversationId } })).toBe(1);
    // Stage 9E: this lead is now created by TRIP_SUBMISSION via a direct TravelLeadService call (same
    // architecture as the already-migrated triggers, see travel.contact-routing.e2e.spec.ts's other test) —
    // no travel.create_lead tool round trip, so no AgentToolExecution row is created.
    const tools = await prisma.agentToolExecution.findMany({
      where: { execution: { conversationId } },
      select: { toolName: true }
    });
    expect(tools).toEqual([]);
    expect(knowledgeSearch).not.toHaveBeenCalled();
  });
});
