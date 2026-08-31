import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { deleteAllOrganizationScopedRows, ensurePlatformOwner } from "../test/cleanup";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Reproduces the exact failed manual UAT sequence from the "Fix AI Receptionist UAT — Routing
 * Authority, Domain Switching, and Shared Customer Identity" correction pass, end-to-end against a real
 * NestJS app + Prisma. Each `it` here maps directly to one numbered scenario from that UAT transcript.
 */
suite("AI Receptionist correction pass: exact failed manual UAT regression", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: { Authorization: string };
  let receptionistId: string;
  const employeeIds: Record<string, string> = {};

  async function install(pluginId: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set(auth)
      .send({ pluginId, configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    return response.body.id as string;
  }

  async function run(message: string, conversationId?: string) {
    return request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({
        pluginInstallationId: receptionistId,
        ...(conversationId ? { conversationId } : {}),
        message
      })
      .expect(201);
  }

  /** Runs a fresh conversation through the "ask name -> provide name -> handoff" two-turn identity flow
   *  and returns the final (post-handoff) response, so each routing-only scenario below can focus on its
   *  own assertion without repeating the identity dance inline. */
  async function routeFreshRequest(message: string) {
    const askName = await run(message);
    expect(askName.body.receptionist.handoff).toBeNull();
    expect(askName.body.response).toMatch(/may I know your name/i);
    return run("Krishna", askName.body.conversationId);
  }

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await deleteAllOrganizationScopedRows(prisma);
    const registration = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Receptionist Correction UAT ${Date.now()}`,
        firstName: "Owner",
        email: `receptionist-correction-uat-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    auth = { Authorization: `Bearer ${registration.body.data.tokens.accessToken}` };

    for (const slug of [
      "hr-employee",
      "finance-employee",
      "legal-employee",
      "it-support-employee",
      "sales-employee",
      "marketing-employee",
      "customer-support-employee",
      "travel-employee"
    ])
      employeeIds[slug] = await install(slug);

    const receptionist = await install("receptionist-employee");
    receptionistId = receptionist;
  }, 60_000);

  afterAll(async () => {
    if (prisma) {
      await deleteAllOrganizationScopedRows(prisma);
      await ensurePlatformOwner(prisma);
    }
    await app?.close();
  }, 30_000);

  it("scenario 1: 'apply for 3 days leave' asks for the name before handing off to HR, and HR never asks it again", async () => {
    const askName = await run("I want to apply for 3 days leave next week.");
    expect(askName.body.receptionist.handoff).toBeNull();
    expect(askName.body.response).toMatch(/may I know your name/i);

    const handedOff = await run("Krishna", askName.body.conversationId);
    expect(handedOff.body.receptionist.handoff.targetEmployeeInstallationId).toBe(
      employeeIds["hr-employee"]
    );
    expect(handedOff.body.response).not.toMatch(/may I know your name/i);
  });

  it("scenario 2: 'invoice payment' routes to Finance, never an irrelevant Sales/Support clarification", async () => {
    const response = await routeFreshRequest("I need help with an invoice payment.");
    expect(response.body.receptionist.handoff?.targetEmployeeInstallationId).toBe(
      employeeIds["finance-employee"]
    );
  });

  it("scenario 3: 'review an employment contract' routes to Legal, not HR", async () => {
    const response = await routeFreshRequest("Please review an employment contract for me.");
    expect(response.body.receptionist.handoff?.targetEmployeeInstallationId).toBe(
      employeeIds["legal-employee"]
    );
  });

  it("scenario 4+5: IT active handoff, then a clear domain switch to Sales on 'new customer lead'", async () => {
    const askName = await run("My laptop VPN is not connecting.");
    expect(askName.body.response).toMatch(/may I know your name/i);
    const itHandoff = await run("Krishna", askName.body.conversationId);
    expect(itHandoff.body.receptionist.handoff.targetEmployeeInstallationId).toBe(
      employeeIds["it-support-employee"]
    );

    const switched = await run(
      "I have a new customer lead and want to follow up.",
      askName.body.conversationId
    );
    expect(switched.body.receptionist.routeType).not.toBe("CONTINUE_HANDOFF");
    expect(switched.body.receptionist.handoff.targetEmployeeInstallationId).toBe(
      employeeIds["sales-employee"]
    );
    // The superseded IT handoff must not vanish — its own specialist conversation stays intact.
    const priorHandoffs = await prisma.receptionistHandoff.findMany({
      where: { conversationId: askName.body.conversationId },
      orderBy: { createdAt: "asc" }
    });
    expect(priorHandoffs).toHaveLength(2);
    expect(priorHandoffs[0]?.targetEmployeeInstallationId).toBe(employeeIds["it-support-employee"]);
    expect(priorHandoffs[0]?.status).toBe("RETURNED_TO_RECEPTIONIST");
    expect(priorHandoffs[1]?.targetEmployeeInstallationId).toBe(employeeIds["sales-employee"]);
    const itConversationStillExists = await prisma.conversation.findFirst({
      where: { id: priorHandoffs[0]?.targetConversationId ?? "", deletedAt: null }
    });
    expect(itConversationStillExists).not.toBeNull();
  });

  it("scenario 6: 'create a marketing campaign' routes to Marketing", async () => {
    const response = await routeFreshRequest("Create a marketing campaign for my new product.");
    expect(response.body.receptionist.handoff?.targetEmployeeInstallationId).toBe(
      employeeIds["marketing-employee"]
    );
  });

  it("scenario 7: 'problem with my order' routes to Customer Support", async () => {
    const response = await routeFreshRequest(
      "I have a problem with my order and need customer support."
    );
    expect(response.body.receptionist.handoff?.targetEmployeeInstallationId).toBe(
      employeeIds["customer-support-employee"]
    );
  });

  it("scenario 8: 'plan a Dubai trip' routes to Travel, and Travel never re-asks the already-known name", async () => {
    const askName = await run("Plan a Dubai trip for 3 adults from Delhi.");
    expect(askName.body.response).toMatch(/may I know your name/i);
    const handedOff = await run("Krishna", askName.body.conversationId);
    expect(handedOff.body.receptionist.handoff.targetEmployeeInstallationId).toBe(
      employeeIds["travel-employee"]
    );
    expect(handedOff.body.response).not.toMatch(/may I know your name/i);
  });

  it("continuation regression: short structured Travel follow-ups never trigger a domain switch", async () => {
    const askName = await run("Plan a Dubai trip for 3 adults from Delhi.");
    const handedOff = await run("Krishna", askName.body.conversationId);
    expect(handedOff.body.receptionist.handoff.targetEmployeeInstallationId).toBe(
      employeeIds["travel-employee"]
    );
    for (const followUp of ["15 September 2026", "5 days", "3 adults", "AED 20,000", "yes"]) {
      const turn = await run(followUp, askName.body.conversationId);
      expect(turn.body.receptionist.routeType).toBe("CONTINUE_HANDOFF");
      expect(turn.body.receptionist.handoff.targetEmployeeInstallationId).toBe(
        employeeIds["travel-employee"]
      );
    }
  });
});
