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

suite("AI Receptionist universal front door", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: { Authorization: string };
  let receptionistId: string;
  let travelId: string;
  let hrId: string;
  let itSupportId: string;
  let receptionistConversationId: string;
  let handoffId: string;

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
        organizationName: `Receptionist UAT ${Date.now()}`,
        firstName: "Owner",
        email: `receptionist-uat-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    auth = { Authorization: `Bearer ${registration.body.data.tokens.accessToken}` };
    const travel = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set(auth)
      .send({
        pluginId: "travel-employee",
        configuration: { config: {}, secrets: {} },
        enable: true
      })
      .expect(201);
    travelId = travel.body.id;
    const hr = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set(auth)
      .send({
        pluginId: "hr-employee",
        configuration: { config: {}, secrets: {} },
        enable: true
      })
      .expect(201);
    hrId = hr.body.id;
    const itSupport = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set(auth)
      .send({
        pluginId: "it-support-employee",
        configuration: { config: {}, secrets: {} },
        enable: true
      })
      .expect(201);
    itSupportId = itSupport.body.id;
  }, 30_000);

  afterAll(async () => {
    if (prisma) {
      await deleteAllOrganizationScopedRows(prisma);
      await ensurePlatformOwner(prisma);
    }
    await app?.close();
  }, 30_000);

  it("returns an explicit non-crashing state for an existing organization without Receptionist", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/receptionist/front-door")
      .set(auth)
      .expect(200);
    expect(response.body).toMatchObject({
      enabled: false,
      reasonCode: "RECEPTIONIST_NOT_INSTALLED",
      installationId: null,
      pluginInstallationId: null,
      workforce: []
    });
    expect(JSON.stringify(response.body)).not.toMatch(/encryptedSecrets|systemPrompt|apiKey/);
  });

  it("installs Receptionist through the plugin lifecycle and discovers it as the web front door", async () => {
    const receptionist = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set(auth)
      .send({
        pluginId: "receptionist-employee",
        configuration: { config: { llmRoutingEnabled: false }, secrets: {} },
        enable: true
      })
      .expect(201);
    receptionistId = receptionist.body.id;
    const response = await request(app.getHttpServer())
      .get("/api/v1/receptionist/front-door")
      .set(auth)
      .expect(200);
    expect(response.body).toMatchObject({
      enabled: true,
      reasonCode: null,
      installationId: receptionistId,
      pluginInstallationId: receptionistId
    });
    expect(
      response.body.workforce.map(
        (employee: { pluginInstallationId: string }) => employee.pluginInstallationId
      )
    ).toEqual(expect.arrayContaining([travelId, hrId, receptionistId]));
    expect(JSON.stringify(response.body)).not.toMatch(/encryptedSecrets|systemPrompt|apiKey/);
  });

  it("routes a web request to Travel and persists a separate specialist conversation", async () => {
    // Identity is unknown on a brand-new conversation, so the Receptionist asks for the customer's name
    // BEFORE handing off — no handoff exists yet after this turn.
    const askName = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({
        pluginInstallationId: receptionistId,
        message: "I want to plan a trip from Delhi to Dubai for 3 adults."
      })
      .expect(201);
    receptionistConversationId = askName.body.conversationId;
    expect(askName.body.receptionist.handoff).toBeNull();
    expect(askName.body.response).toMatch(/may I know your name/i);

    // The name reply resumes the ORIGINAL trip request — the customer never has to repeat it — and the
    // specialist it hands off to must already know the name (the exact bug this correction pass fixes).
    const response = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({
        pluginInstallationId: receptionistId,
        conversationId: receptionistConversationId,
        message: "Krishna"
      })
      .expect(201);
    handoffId = response.body.receptionist.handoff.id;
    expect(response.body.status).toBe("COMPLETED");
    expect(response.body.receptionist.handoff.targetEmployeeInstallationId).toBe(travelId);
    // Fix (Travel Booking Closure Pass — Phase 14/16/19): WEB no longer repeats "Travel Employee:" in the
    // text on a new handoff — the structured `receptionist.handoff.targetDisplayName` field (checked here)
    // is what the UI's own "Connected to X" indicator already renders, so the text staying free of it is
    // the intended fix, not a regression.
    expect(response.body.receptionist.handoff.targetDisplayName).toBe("Travel Employee");
    expect(response.body.response).not.toMatch(/may I know your name/i);
    const handoff = await prisma.receptionistHandoff.findUniqueOrThrow({
      where: { id: handoffId }
    });
    expect(handoff.conversationId).toBe(receptionistConversationId);
    expect(handoff.targetConversationId).not.toBe(receptionistConversationId);
    expect(handoff.status).toBe("HANDOFF_ACTIVE");
  });

  it("keeps a short follow-up in the existing Travel handoff", async () => {
    const before = await prisma.receptionistHandoff.findUniqueOrThrow({ where: { id: handoffId } });
    const response = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({
        pluginInstallationId: receptionistId,
        conversationId: receptionistConversationId,
        message: "3 adults"
      })
      .expect(201);
    expect(response.body.receptionist.routeType).toBe("CONTINUE_HANDOFF");
    expect(response.body.receptionist.handoff.id).toBe(handoffId);
    const after = await prisma.receptionistHandoff.findUniqueOrThrow({ where: { id: handoffId } });
    expect(after.targetConversationId).toBe(before.targetConversationId);
    if (!after.targetConversationId) throw new Error("SPECIALIST_CONVERSATION_MISSING");
    expect(
      await prisma.conversationMessage.count({
        where: {
          organizationId: after.organizationId,
          conversationId: after.targetConversationId,
          role: "USER"
        }
      })
    ).toBe(2);
  });

  it("defect 1: answering Travel's ticket-delivery pending question with 'share it here' stays in the Travel handoff — never stolen by IT Support's 'it' keyword collision", async () => {
    // IT Support is installed above so the real Receptionist routing profile for IT Support ("it",
    // "technical support", "helpdesk") is present in this organization exactly as it was in the original
    // failed live UAT — without it installed, this test wouldn't reproduce the collision at all. A fresh
    // conversation is used here (not the earlier tests' shared handoff) so this regression test doesn't
    // depend on prior tests' trip state or ordering.
    let conversationId: string | undefined;
    async function say(message: string) {
      const response = await request(app.getHttpServer())
        .post("/api/v1/agents/run")
        .set(auth)
        .send({ pluginInstallationId: receptionistId, conversationId, message })
        .expect(201);
      conversationId = response.body.conversationId;
      return response.body as {
        response: string;
        receptionist?: { routeType: string; handoff: { targetEmployeeInstallationId: string } | null };
      };
    }

    // Identity is unknown, so the trip request itself is deferred behind a name prompt first — mirrors the
    // "routes a web request to Travel" test above: the ORIGINAL trip-detail text is resumed automatically
    // once the bare name reply satisfies the prompt, handing off to Travel in the same turn.
    const askName = await say(
      "Dubai, 12 August 2026, 5 days, 3 adults, round trip, budget AED 100000, from Delhi"
    );
    expect(askName.response).toMatch(/may I know your name/i);
    const handoffTurn = await say("Krishna");
    expect(handoffTurn.receptionist?.handoff?.targetEmployeeInstallationId).toBe(travelId);
    await say("book hotel and flight both");
    const optionPick = await say("Option 2");
    expect(optionPick.response).toMatch(/full name, age, and gender|each traveller's full name/i);
    const passengerDetails = await say(
      "1. Krishna Pandey, 34, Male; 2. Rekha Pandey, 31, Female; 3. Aarav Pandey, 6, Male"
    );
    expect(passengerDetails.response).toMatch(/would you like the ticket here in chat, by email, or on WhatsApp/i);

    // The exact reported defect: this reply must satisfy Travel's own pending question and stay in the
    // active Travel handoff — Receptionist domain-switch scoring must never even run, since the word "it"
    // in "share it here" is not the customer asking for the IT department.
    const shareItHere = await say("share it here");
    expect(shareItHere.receptionist?.routeType).toBe("CONTINUE_HANDOFF");
    expect(shareItHere.receptionist?.handoff?.targetEmployeeInstallationId).toBe(travelId);
    expect(shareItHere.receptionist?.handoff?.targetEmployeeInstallationId).not.toBe(itSupportId);
    expect(shareItHere.response).toMatch(/confirm your simulated booking|reply 'confirm booking'/i);
  }, 30_000);

  it("preserves direct specialist access", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({ pluginInstallationId: travelId, message: "plan a trip to Singapore" })
      .expect(201);
    expect(response.body.status).toBe("COMPLETED");
    expect(response.body.conversationId).toBeTruthy();
    expect(response.body.receptionist).toBeUndefined();
  });
});
