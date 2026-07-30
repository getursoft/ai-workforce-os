import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { AgentExecutionStatus } from "@prisma/client";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SkillExecutionService } from "./skill-execution.service";
import { decidePlanTripTurn, emptyPlanTripSkillState } from "./travel/plan-trip.skill";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Skill diagnostics HTTP", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const organizationIds: string[] = [];
  let token: string;
  let otherToken: string;
  let skillExecutionId: string;
  let pluginInstallationId: string;
  let reviewSessionId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    const staleOrganizations = await prisma.organization.findMany({
      where: { name: { in: ["Skill Diagnostics Org", "Other Diagnostics Org"] } },
      select: { id: true }
    });
    for (const stale of staleOrganizations) await cleanupOrganization(prisma, stale.id);
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Skill Diagnostics Org",
        firstName: "Owner",
        email: `skill-diagnostics-${suffix}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    token = registered.body.data.tokens.accessToken;
    const organizationId = registered.body.data.organization.id as string;
    organizationIds.push(organizationId);
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "travel-employee", enable: true })
      .expect(201);
    pluginInstallationId = installed.body.id as string;
    const conversation = await prisma.conversation.create({
      data: { organizationId, pluginInstallationId, title: "Diagnostic fixture" }
    });
    const agentExecution = await prisma.agentExecution.create({
      data: {
        organizationId,
        pluginInstallationId,
        conversationId: conversation.id,
        status: AgentExecutionStatus.COMPLETED,
        modelProvider: "travel-employee",
        requestId: "diagnostic-http-turn"
      }
    });
    const state = decidePlanTripTurn(emptyPlanTripSkillState(), {
      data: { destination: { value: "PRIVATE_CITY_VALUE", source: "USER_EXPLICIT" } }
    }).decision.state;
    const created = await new SkillExecutionService(prisma).createExecution({
      scope: {
        organizationId,
        pluginInstallationId,
        conversationId: conversation.id,
        skillId: "travel.plan-trip"
      },
      skillVersion: "1.0.0",
      schemaVersion: 1,
      state,
      pendingInput: state.pendingInput,
      agentExecutionId: agentExecution.id,
      turnId: "diagnostic-http-turn"
    });
    skillExecutionId = created.execution.id;
    await prisma.agentExecution.update({
      where: { id: agentExecution.id },
      data: {
        metadata: {
          skillShadow: {
            skillId: "travel.plan-trip",
            skillVersion: "1.0.0",
            mode: "SHADOW",
            existingDecision: "ASK_FOR_INPUT",
            shadowDecision: "ASK_FOR_INPUT",
            agreement: true,
            reasonCodes: [],
            adapterWarnings: ["DETERMINISTIC_TRANSCRIPT_DERIVED"],
            fieldCompleteness: {
              origin: false,
              destination: true,
              departureDay: false,
              departureMonth: false,
              departureYear: false,
              travellers: false,
              durationOrReturnDate: false
            },
            persistence: {
              executionId: skillExecutionId,
              status: created.execution.status,
              revision: created.execution.revision,
              applied: true,
              idempotentReplay: false,
              warning: null
            }
          }
        }
      }
    });
    const other = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Other Diagnostics Org",
        firstName: "Other",
        email: `skill-diagnostics-other-${suffix}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    otherToken = other.body.data.tokens.accessToken;
    organizationIds.push(other.body.data.organization.id as string);
  });

  afterAll(async () => {
    for (const id of organizationIds) await cleanupOrganization(prisma, id);
    await app?.close();
  });

  it("returns a protected tenant-scoped summary and redacted execution timeline", async () => {
    const summary = await request(app.getHttpServer())
      .get("/api/v1/skills/diagnostics/travel-plan-trip/summary?limit=100")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(summary.body).toMatchObject({
      totalApplicableEvaluations: 1,
      totalDistinctSkillExecutions: 1,
      agreements: 1,
      runtimeModeCounts: { deterministic: 1, llm: 0, unknown: 0 }
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/skills/diagnostics/travel-plan-trip/executions/${skillExecutionId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body).toMatchObject({
      skillExecutionId,
      pendingInput: "ORIGIN",
      timeline: [expect.objectContaining({ runtimeMode: "DETERMINISTIC", agreement: true })]
    });
    expect(JSON.stringify(detail.body)).not.toMatch(
      /PRIVATE_CITY_VALUE|originCity|destinationCity|phone|email|budget|"state"/i
    );
  });

  it("requires authentication and hides another tenant's execution", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/skills/diagnostics/travel-plan-trip/summary")
      .expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/skills/diagnostics/travel-plan-trip/executions/${skillExecutionId}`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
  });

  it("creates a bounded real-shadow review session and returns a redacted report", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/skills/diagnostics/travel-plan-trip/review-sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        from: "2026-01-01T00:00:00.000Z",
        to: "2027-01-01T00:00:00.000Z",
        pluginInstallationId,
        runtimeMode: "DETERMINISTIC",
        conversationCount: 10,
        turnCount: 20,
        notes: "PRIVATE_REVIEW_NOTE"
      })
      .expect(201);
    reviewSessionId = created.body.sessionId as string;
    expect(created.body).toMatchObject({
      status: "CREATED",
      notes: "[REDACTED_OPERATIONAL_NOTES]"
    });

    const started = await request(app.getHttpServer())
      .post(`/api/v1/skills/diagnostics/travel-plan-trip/review-sessions/${reviewSessionId}/start`)
      .set("Authorization", `Bearer ${token}`)
      .expect(201);
    expect(started.body).toMatchObject({
      status: "RUNNING",
      sampledConversationCount: 1,
      sampledTurnCount: 1
    });

    const report = await request(app.getHttpServer())
      .get(`/api/v1/skills/diagnostics/travel-plan-trip/review-sessions/${reviewSessionId}/report`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(report.body).toMatchObject({
      conversationCount: 1,
      turnCount: 1,
      agreementCount: 1,
      recommendation: "READY_FOR_MORE_UAT",
      trends: {
        runtimeModeSplit: { deterministicTurns: 1, llmTurns: 0, unknownTurns: 0 }
      }
    });
    expect(JSON.stringify(report.body)).not.toMatch(
      /PRIVATE_REVIEW_NOTE|PRIVATE_CITY_VALUE|prompt|message|destination|budget|"state"/i
    );
  });

  it("hides review sessions and reports from another tenant", async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/skills/diagnostics/travel-plan-trip/review-sessions/${reviewSessionId}`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/skills/diagnostics/travel-plan-trip/review-sessions/${reviewSessionId}/report`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
  });
});

async function cleanupOrganization(prisma: PrismaService, organizationId: string): Promise<void> {
  await prisma.skillExecution.deleteMany({ where: { organizationId } });
  await prisma.conversationMessage.deleteMany({ where: { organizationId } });
  await prisma.agentToolExecution.deleteMany({ where: { organizationId } });
  await prisma.agentExecution.deleteMany({ where: { organizationId } });
  await prisma.agentMemory.deleteMany({ where: { organizationId } });
  await prisma.conversation.deleteMany({ where: { organizationId } });
  await prisma.travelEmployeeConfiguration.deleteMany({ where: { organizationId } });
  await prisma.pluginAiConfiguration.deleteMany({ where: { organizationId } });
  await prisma.pluginConfiguration.deleteMany({ where: { organizationId } });
  await prisma.plugin.deleteMany({ where: { organizationId } });
  await prisma.teamMember.deleteMany({ where: { team: { organizationId } } });
  await prisma.team.deleteMany({ where: { organizationId } });
  await prisma.invitation.deleteMany({ where: { organizationId } });
  await prisma.authenticationSession.deleteMany({ where: { user: { organizationId } } });
  await prisma.userRole.deleteMany({ where: { user: { organizationId } } });
  await prisma.rolePermission.deleteMany({ where: { role: { organizationId } } });
  await prisma.role.deleteMany({ where: { organizationId } });
  await prisma.user.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}
