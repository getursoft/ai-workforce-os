import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
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
});
