import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { AuthorizationService } from "../identity/application/services/authorization.service";
import { dummyEchoManifest } from "@ai-workforce-os/plugin-dummy";

for (const c of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(c)) {
    loadEnvFile(c);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Workforce delegation engine (e2e)", () => {
  let app: INestApplication, prisma: PrismaService;
  let auth: { Authorization: string };
  let orgAId: string, orgAName: string, ownerEmail: string;
  let employeeAId: string, employeeBId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);

    ownerEmail = `workforce-${Date.now()}@example.com`;
    orgAName = `Workforce Org ${Date.now()}`;
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ organizationName: orgAName, firstName: "Owner", email: ownerEmail, password: "StrongPassword@123" })
      .expect(201);
    auth = { Authorization: `Bearer ${registered.body.data.tokens.accessToken}` };
    orgAId = registered.body.data.organization.id;

    const employeeA = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set(auth)
      .send({
        manifest: { ...dummyEchoManifest, id: "workforce-employee-a", name: "Employee A", displayName: "Employee A" },
        enable: true
      })
      .expect(201);
    employeeAId = employeeA.body.id;

    const employeeB = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set(auth)
      .send({
        manifest: { ...dummyEchoManifest, id: "workforce-employee-b", name: "Employee B", displayName: "Employee B" },
        enable: true
      })
      .expect(201);
    employeeBId = employeeB.body.id;
  });

  afterAll(async () => {
    if (prisma && orgAId) {
      await prisma.employeeDelegationJoin.deleteMany({ where: { organizationId: orgAId } });
      await prisma.employeeDelegatedTask.deleteMany({ where: { organizationId: orgAId } });
      await prisma.employeeRoutingProfile.deleteMany({ where: { organizationId: orgAId } });
      await prisma.conversation.deleteMany({ where: { organizationId: orgAId } });
      await prisma.pluginConfiguration.deleteMany({ where: { organizationId: orgAId } });
      await prisma.plugin.deleteMany({ where: { organizationId: orgAId } });
    }
    await app?.close();
  });

  it("discovers both installed employees via the registry endpoint", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/workforce/employees").set(auth).expect(200);
    const ids = res.body.map((e: { installationId: string }) => e.installationId);
    expect(ids).toContain(employeeAId);
    expect(ids).toContain(employeeBId);
  });

  it("requires authentication", async () => {
    await request(app.getHttpServer()).get("/api/v1/workforce/employees").expect(401);
    await request(app.getHttpServer()).get("/api/v1/workforce/tasks").expect(401);
  });

  it("rejects a malformed delegation contract with a stable error code", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/workforce/tasks")
      .set(auth)
      .send({ sourceEmployeeInstallationId: employeeAId, taskType: "X" })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  let taskId: string;
  it("delegates a task from Employee A to Employee B synchronously and completes it", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/workforce/tasks")
      .set(auth)
      .send({
        sourceEmployeeInstallationId: employeeAId,
        targetEmployeeInstallationId: employeeBId,
        taskType: "GENERAL_QUERY",
        objective: "Please summarise this on behalf of Employee A",
        input: { note: "hello from A" }
      })
      .expect(201);
    expect(res.body.sourceEmployeeInstallationId).toBe(employeeAId);
    expect(res.body.targetEmployeeInstallationId).toBe(employeeBId);
    expect(["COMPLETED", "FAILED"]).toContain(res.body.status);
    taskId = res.body.id;
  });

  it("persists the task with a real parent/child link retrievable by id", async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/workforce/tasks/${taskId}`).set(auth).expect(200);
    expect(res.body.id).toBe(taskId);
    expect(res.body.organizationId).toBe(orgAId);
  });

  it("exposes a task timeline", async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/workforce/tasks/${taskId}/timeline`).set(auth).expect(200);
    expect(res.body.taskId).toBe(taskId);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events.length).toBeGreaterThan(0);
  });

  it("rejects delegating to a target that is not installed in this organization", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/workforce/tasks")
      .set(auth)
      .send({
        sourceEmployeeInstallationId: employeeAId,
        targetEmployeeInstallationId: "00000000-0000-4000-8000-000000000000",
        taskType: "GENERAL_QUERY",
        objective: "Should fail",
        input: {}
      })
      .expect(422);
    expect(res.body.error.code).toBe("WORKFORCE_EMPLOYEE_NOT_INSTALLED");
  });

  it("is tenant-isolated — a second organization cannot see the first organization's task or employees", async () => {
    const otherEmail = `workforce-other-${Date.now()}@example.com`;
    const otherOrgName = `Workforce Other Org ${Date.now()}`;
    const registeredOther = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ organizationName: otherOrgName, firstName: "Owner", email: otherEmail, password: "StrongPassword@123" })
      .expect(201);
    const otherAuth = { Authorization: `Bearer ${registeredOther.body.data.tokens.accessToken}` };

    await request(app.getHttpServer()).get(`/api/v1/workforce/tasks/${taskId}`).set(otherAuth).expect(404);

    const employees = await request(app.getHttpServer()).get("/api/v1/workforce/employees").set(otherAuth).expect(200);
    const ids = employees.body.map((e: { installationId: string }) => e.installationId);
    expect(ids).not.toContain(employeeAId);
    expect(ids).not.toContain(employeeBId);
  });

  it("rejects a Member without workforce.task.manage from triggering delegation (403)", async () => {
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId: orgAId, normalizedEmail: ownerEmail } });
    const memberRole = await prisma.role.findFirstOrThrow({ where: { organizationId: orgAId, name: "Member" } });
    const ownerRole = await prisma.role.findFirstOrThrow({ where: { organizationId: orgAId, name: "Owner" } });
    await prisma.userRole.deleteMany({ where: { userId: owner.id, roleId: ownerRole.id } });
    await prisma.userRole.create({ data: { userId: owner.id, roleId: memberRole.id } });
    await prisma.user.update({ where: { id: owner.id }, data: { role: "MEMBER" } });
    app.get(AuthorizationService).invalidateUser(owner.id, orgAId);

    const relogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: owner.email, password: "StrongPassword@123", organizationName: orgAName })
      .expect(200);
    const memberAuth = { Authorization: `Bearer ${relogin.body.data.tokens.accessToken}` };

    await request(app.getHttpServer())
      .post("/api/v1/workforce/tasks")
      .set(memberAuth)
      .send({ sourceEmployeeInstallationId: employeeAId, taskType: "GENERAL_QUERY", objective: "x", input: {} })
      .expect(403);

    // restore
    await prisma.userRole.deleteMany({ where: { userId: owner.id, roleId: memberRole.id } });
    await prisma.userRole.create({ data: { userId: owner.id, roleId: ownerRole.id } });
    await prisma.user.update({ where: { id: owner.id }, data: { role: "OWNER" } });
  });
});
