import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { MockSmsProvider } from "../interaction/sms/mock-sms.provider";
for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** Test-setup shortcut for the identity-verification gate (2026-10-18) — equivalent to a user having
 * already completed the real phone/email + OTP flow (covered separately by its own dedicated test
 * below), so the recruitment tool tests can exercise the tools themselves without re-proving the gate
 * every time. */
async function verifyRecruitmentIdentity(
  prisma: PrismaService,
  organizationId: string,
  userId: string,
  pluginInstallationId: string
): Promise<void> {
  await prisma.recruitmentChatIdentityVerification.create({
    data: {
      organizationId,
      userId,
      pluginInstallationId,
      status: "VERIFIED",
      verifiedAt: new Date(),
      contactMethod: "PHONE",
      contactValue: "+10000000000"
    }
  });
}

suite("Agent runtime HTTP", () => {
  let app: INestApplication,
    prisma: PrismaService,
    token: string,
    pluginId: string,
    conversationId: string;
  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.conversationMessage.deleteMany();
    await prisma.agentToolExecution.deleteMany();
    await prisma.agentExecution.deleteMany();
    await prisma.agentMemory.deleteMany();
    await prisma.conversation.deleteMany();
    await prisma.pluginAiConfiguration.deleteMany();
    await prisma.pluginConfiguration.deleteMany();
    await prisma.plugin.deleteMany();
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Agent Org",
        firstName: "Owner",
        email: `agent-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    token = registered.body.data.tokens.accessToken;
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
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
    if (prisma) {
      await prisma.conversationMessage.deleteMany();
      await prisma.agentToolExecution.deleteMany();
      await prisma.agentExecution.deleteMany();
      await prisma.agentMemory.deleteMany();
      await prisma.conversation.deleteMany();
      await prisma.pluginAiConfiguration.deleteMany();
      await prisma.pluginConfiguration.deleteMany();
      await prisma.plugin.deleteMany();
    }
    await app?.close();
  });
  it("runs the deterministic tool loop and persists conversation, execution, tool and memory", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({
        pluginInstallationId: pluginId,
        message:
          "Plan a 5-day Dubai trip for next month and remember that I prefer vegetarian food."
      })
      .expect(201);
    expect(run.body.status).toBe("COMPLETED");
    expect(run.body.response).toContain("five-day Dubai");
    conversationId = run.body.conversationId;
    expect(
      await prisma.agentToolExecution.count({
        where: { executionId: run.body.executionId, status: "COMPLETED" }
      })
    ).toBe(1);
    expect(
      await prisma.agentMemory.count({
        where: {
          organizationId: (await prisma.plugin.findUniqueOrThrow({ where: { id: pluginId } }))
            .organizationId,
          key: "preference.food"
        }
      })
    ).toBe(1);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/executions/${run.body.executionId}`)
      .set(auth)
      .expect(200);
    expect(detail.body.toolExecutions[0].toolName).toBe("platform.memory.save");
  });
  it("continues a conversation and returns ordered messages", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({
        pluginInstallationId: pluginId,
        conversationId,
        message: "What did I ask you to remember?"
      })
      .expect(201);
    const messages = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set(auth)
      .expect(200);
    expect(messages.body.filter((x: { role: string }) => x.role === "USER")).toHaveLength(2);
    await request(app.getHttpServer()).get("/api/v1/executions").set(auth).expect(200);
  });
  it("rejects invalid, disabled and unauthenticated requests", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({ pluginInstallationId: "bad", message: "x" })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/api/v1/plugins/${pluginId}/disable`)
      .set(auth)
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({ pluginInstallationId: pluginId, message: "hello" })
      .expect(409);
    await request(app.getHttpServer()).get("/api/v1/conversations").expect(401);
  });

  // --- Generic plugin (not Travel, not Legal, not in EMPLOYEE_DOMAIN_REGISTRY) with NO AI provider
  // configured at all: previously this path threw BadRequestException("AI_PROVIDER_NOT_CONFIGURED")
  // uncaught, surfacing as an opaque "Agent execution failed" with no indication of what's actually
  // missing (live UAT finding against the AI Recruitment Consultant's own dashboard chat). ----------
  it("a generic employee with no AI provider configured replies with a clear, honest message instead of a crash", async () => {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `No Provider Org ${Date.now()}`,
        firstName: "Owner",
        email: `no-provider-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    const noProviderToken = registered.body.data.tokens.accessToken as string;
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${noProviderToken}`)
      .send({ pluginId: "recruitment-consultant", configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    const noProviderPluginId = installed.body.id as string;
    await verifyRecruitmentIdentity(prisma, registered.body.data.organization.id, registered.body.data.user.id, noProviderPluginId);

    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${noProviderToken}`)
      .send({ pluginInstallationId: noProviderPluginId, message: "Hi" })
      .expect(201);
    expect(run.body.status).toBe("COMPLETED");
    expect(run.body.response).toContain("no AI provider has been configured");
    expect(run.body.response).toContain("AI Recruitment Consultant");

    // The turn completed normally — a real conversation/message/execution row, not a silently-dropped
    // error path — so the dashboard's chat history behaves exactly as it would for a working employee.
    const messages = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${run.body.conversationId}/messages`)
      .set("Authorization", `Bearer ${noProviderToken}`)
      .expect(200);
    expect(messages.body.some((m: { role: string }) => m.role === "USER")).toBe(true);
    expect(messages.body.some((m: { role: string }) => m.role === "ASSISTANT")).toBe(true);
  });

  // --- Recruitment Consultant dashboard/iOS chat tools (follow-up to the dashboard-chat UAT) — the chat
  // now has real tool access to the same RecruitmentJobService/RecruitmentCandidateQueryService/
  // RecruitmentResumeService the website forms and the WhatsApp menu already go through. -------------
  it("Recruitment Consultant's chat actually calls recruitment.list_jobs and returns real job data, not a canned non-answer", async () => {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Recruitment Tools Org ${Date.now()}`,
        firstName: "Owner",
        email: `recruitment-tools-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    const token = registered.body.data.tokens.accessToken as string;
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "recruitment-consultant", configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    const recruitmentPluginId = installed.body.id as string;

    const plugin = await prisma.plugin.findUniqueOrThrow({ where: { id: recruitmentPluginId } });
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId: plugin.organizationId } });
    const encryption = app.get(PluginSecretsEncryptionService);
    await prisma.pluginAiConfiguration.create({
      data: {
        organizationId: plugin.organizationId,
        pluginInstallationId: recruitmentPluginId,
        providerType: "DETERMINISTIC",
        configuration: { timeoutMs: 30000 },
        encryptedSecrets: encryption.encrypt({}) as unknown as Prisma.InputJsonValue,
        updatedBy: owner.id
      }
    });
    await verifyRecruitmentIdentity(prisma, plugin.organizationId, owner.id, recruitmentPluginId);

    const createdJob = await request(app.getHttpServer())
      .post("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Agent-Tool Test Job",
        description: "x",
        requiredCriteria: { mandatorySkills: ["Python"] },
        scoringConfig: { mandatorySkillWeight: 35, preferredSkillWeight: 15, experienceWeight: 25, projectExperienceWeight: 15, certificationWeight: 10 }
      })
      .expect(201);
    expect(createdJob.body.status).toBe("OPEN");

    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginInstallationId: recruitmentPluginId, message: "Can you list the current job openings?" })
      .expect(201);
    expect(run.body.status).toBe("COMPLETED");
    expect(run.body.response).toContain("Agent-Tool Test Job");

    // Real proof the tool actually executed against the real database, not a hallucinated title: a
    // genuine AgentToolExecution row for recruitment.list_jobs, COMPLETED.
    const toolExecution = await prisma.agentToolExecution.findFirst({
      where: { executionId: run.body.executionId, toolName: "recruitment.list_jobs" }
    });
    expect(toolExecution?.status).toBe("COMPLETED");
  });

  it("Recruitment Consultant's chat can upload an attached resume against a job, a real file end to end", async () => {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Recruitment Upload Org ${Date.now()}`,
        firstName: "Owner",
        email: `recruitment-upload-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    const token = registered.body.data.tokens.accessToken as string;
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "recruitment-consultant", configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    const recruitmentPluginId = installed.body.id as string;

    const plugin = await prisma.plugin.findUniqueOrThrow({ where: { id: recruitmentPluginId } });
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId: plugin.organizationId } });
    const encryption = app.get(PluginSecretsEncryptionService);
    await prisma.pluginAiConfiguration.create({
      data: {
        organizationId: plugin.organizationId,
        pluginInstallationId: recruitmentPluginId,
        providerType: "DETERMINISTIC",
        configuration: { timeoutMs: 30000 },
        encryptedSecrets: encryption.encrypt({}) as unknown as Prisma.InputJsonValue,
        updatedBy: owner.id
      }
    });
    await verifyRecruitmentIdentity(prisma, plugin.organizationId, owner.id, recruitmentPluginId);

    const createdJob = await request(app.getHttpServer())
      .post("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Upload Tool Test Job",
        description: "x",
        requiredCriteria: { mandatorySkills: ["Python"] },
        scoringConfig: { mandatorySkillWeight: 35, preferredSkillWeight: 15, experienceWeight: 25, projectExperienceWeight: 15, certificationWeight: 10 }
      })
      .expect(201);
    const jobCode = createdJob.body.jobCode as string;

    // A real conversation needs to exist before an attachment can be uploaded to it.
    const greeting = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginInstallationId: recruitmentPluginId, message: "Hi" })
      .expect(201);
    const conversationId = greeting.body.conversationId as string;

    const RESUME_PDF = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 90>>stream\nBT /F1 14 Tf 72 720 Td (Jane Doe. Python developer, 6 years experience. Skills: Python, SQL. jane@example.com) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n0000000227 00000 n \n0000000336 00000 n \ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n407\n%%EOF\n",
      "latin1"
    );
    const uploaded = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", RESUME_PDF, { filename: "resume.pdf", contentType: "application/pdf" })
      .expect(201);
    const attachmentId = uploaded.body.id as string;

    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pluginInstallationId: recruitmentPluginId,
        conversationId,
        message: `Please upload this resume for ${jobCode}`,
        attachmentIds: [attachmentId]
      })
      .expect(201);
    expect(run.body.status).toBe("COMPLETED");
    expect(run.body.response).toContain("Resume uploaded");

    const toolExecution = await prisma.agentToolExecution.findFirst({
      where: { executionId: run.body.executionId, toolName: "recruitment.upload_resume" }
    });
    expect(toolExecution?.status).toBe("COMPLETED");

    // Real proof: an actual RecruitmentResume + RecruitmentApplication row now exists against this job,
    // created by the tool reading the real attached file bytes — not a hallucinated confirmation.
    const application = await prisma.recruitmentApplication.findFirst({
      where: { jobId: createdJob.body.id },
      include: { resume: true }
    });
    expect(application).not.toBeNull();
    expect(application?.resume.fileName).toBe("resume.pdf");
  });

  it("a tool call referencing a non-existent id (e.g. a hallucinated/stale applicationId) is recovered, not a crash", async () => {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Recruitment NotFound Org ${Date.now()}`,
        firstName: "Owner",
        email: `recruitment-notfound-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    const token = registered.body.data.tokens.accessToken as string;
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "recruitment-consultant", configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    const recruitmentPluginId = installed.body.id as string;

    const plugin = await prisma.plugin.findUniqueOrThrow({ where: { id: recruitmentPluginId } });
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId: plugin.organizationId } });
    const encryption = app.get(PluginSecretsEncryptionService);
    await prisma.pluginAiConfiguration.create({
      data: {
        organizationId: plugin.organizationId,
        pluginInstallationId: recruitmentPluginId,
        providerType: "DETERMINISTIC",
        configuration: { timeoutMs: 30000 },
        encryptedSecrets: encryption.encrypt({}) as unknown as Prisma.InputJsonValue,
        updatedBy: owner.id
      }
    });
    await verifyRecruitmentIdentity(prisma, plugin.organizationId, owner.id, recruitmentPluginId);

    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginInstallationId: recruitmentPluginId, message: "shortlist that candidate" })
      .expect(201);
    expect(run.body.status).toBe("COMPLETED");
    expect(run.body.response).toContain("couldn't find that candidate");

    const toolExecution = await prisma.agentToolExecution.findFirst({
      where: { executionId: run.body.executionId, toolName: "recruitment.shortlist_candidate" }
    });
    expect(toolExecution?.status).toBe("FAILED");
    expect(toolExecution?.errorCode).toBe("RECRUITMENT_APPLICATION_NOT_FOUND");
  });

  // --- Sprint 7.17 follow-up (2026-10-18) — the identity-verification gate itself: a brand-new user's
  // very first message to Recruitment Consultant must NOT reach any tool or AI provider until they've
  // proven a phone number via a one-time code, exactly as requested for the dashboard/iOS chat surfaces
  // (WhatsApp already had its own equivalent via RecruitmentWhatsAppLinkService). ----------------------
  it("a brand-new user must verify a phone number via OTP before Recruitment Consultant chat does anything real", async () => {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Recruitment OTP Org ${Date.now()}`,
        firstName: "Owner",
        email: `recruitment-otp-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    const token = registered.body.data.tokens.accessToken as string;
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "recruitment-consultant", configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    const recruitmentPluginId = installed.body.id as string;

    const plugin = await prisma.plugin.findUniqueOrThrow({ where: { id: recruitmentPluginId } });
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId: plugin.organizationId } });
    const encryption = app.get(PluginSecretsEncryptionService);
    await prisma.pluginAiConfiguration.create({
      data: {
        organizationId: plugin.organizationId,
        pluginInstallationId: recruitmentPluginId,
        providerType: "DETERMINISTIC",
        configuration: { timeoutMs: 30000 },
        encryptedSecrets: encryption.encrypt({}) as unknown as Prisma.InputJsonValue,
        updatedBy: owner.id
      }
    });
    await request(app.getHttpServer())
      .post("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "OTP Flow Test Job",
        description: "x",
        requiredCriteria: { mandatorySkills: ["Python"] },
        scoringConfig: { mandatorySkillWeight: 35, preferredSkillWeight: 15, experienceWeight: 25, projectExperienceWeight: 15, certificationWeight: 10 }
      })
      .expect(201);

    // Turn 1: first contact — a welcome message asking for a phone/email, not a tool call or AI reply.
    const greeting = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginInstallationId: recruitmentPluginId, message: "Hi" })
      .expect(201);
    expect(greeting.body.status).toBe("COMPLETED");
    expect(greeting.body.response).toContain("Welcome to the Krevia Recruitment team");
    expect(greeting.body.response).toContain("mobile number or email");
    const conversationId = greeting.body.conversationId as string;
    const unverified = await prisma.recruitmentChatIdentityVerification.findUnique({
      where: {
        organizationId_userId_pluginInstallationId: {
          organizationId: plugin.organizationId,
          userId: owner.id,
          pluginInstallationId: recruitmentPluginId
        }
      }
    });
    expect(unverified?.status).toBe("PENDING_CONTACT");

    // Turn 2: user supplies a phone number — an OTP is generated, hashed into the DB (never stored in
    // plaintext) and handed to the SMS provider; the live code is only recoverable here because the test
    // double records what it was asked to send (see MockSmsProvider.lastSent), exactly the way a real
    // test double should expose state instead of the production path ever persisting the plaintext code.
    const phoneTurn = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginInstallationId: recruitmentPluginId, conversationId, message: "+15551234567" })
      .expect(201);
    expect(phoneTurn.body.response).toContain("verification code");
    const mockSms = app.get(MockSmsProvider);
    const sentMessage = mockSms.lastSent?.message ?? "";
    const otpMatch = /\b(\d{6})\b/.exec(sentMessage);
    expect(otpMatch).not.toBeNull();
    const otpCode = otpMatch![1];
    const pendingOtp = await prisma.recruitmentChatIdentityVerification.findUnique({
      where: {
        organizationId_userId_pluginInstallationId: {
          organizationId: plugin.organizationId,
          userId: owner.id,
          pluginInstallationId: recruitmentPluginId
        }
      }
    });
    expect(pendingOtp?.status).toBe("PENDING_OTP");
    expect(pendingOtp?.otpHash).not.toBeNull();

    // Turn 3: a wrong code is rejected but still counted as handled (no tool/AI reply, no crash).
    const wrongCode = otpCode === "000000" ? "111111" : "000000";
    const wrongTurn = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginInstallationId: recruitmentPluginId, conversationId, message: wrongCode })
      .expect(201);
    expect(wrongTurn.body.response).toContain("wasn't right");

    // Turn 4: the correct code verifies the user — permanently, for this (org, user, installation).
    const verifyTurn = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginInstallationId: recruitmentPluginId, conversationId, message: otpCode })
      .expect(201);
    expect(verifyTurn.body.response).toContain("verified");
    const verified = await prisma.recruitmentChatIdentityVerification.findUnique({
      where: {
        organizationId_userId_pluginInstallationId: {
          organizationId: plugin.organizationId,
          userId: owner.id,
          pluginInstallationId: recruitmentPluginId
        }
      }
    });
    expect(verified?.status).toBe("VERIFIED");
    expect(verified?.otpHash).toBeNull();

    // Turn 5: now that the gate is passed, a real message reaches the real tool pipeline — proof the
    // gate only blocked unverified turns and never interfered with normal chat/tool behavior afterward.
    const toolTurn = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginInstallationId: recruitmentPluginId, conversationId, message: "Can you list the current job openings?" })
      .expect(201);
    expect(toolTurn.body.status).toBe("COMPLETED");
    expect(toolTurn.body.response).toContain("OTP Flow Test Job");
    const toolExecution = await prisma.agentToolExecution.findFirst({
      where: { executionId: toolTurn.body.executionId, toolName: "recruitment.list_jobs" }
    });
    expect(toolExecution?.status).toBe("COMPLETED");
  });
});
