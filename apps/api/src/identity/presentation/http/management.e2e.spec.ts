import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../../app.module";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { ApiExceptionFilter } from "./api-exception.filter";

for (const candidate of [
  resolve(process.cwd(), ".env.test"),
  resolve(process.cwd(), "../../.env.test")
]) {
  if (existsSync(candidate)) {
    loadEnvFile(candidate);
    break;
  }
}
const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) process.env.DATABASE_URL = testUrl;
const suite = testUrl ? describe : describe.skip;

suite("Sprint 2.2 management HTTP API", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let ownerId: string;
  let organizationId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await clean(prisma);
    const response = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Sprint 22",
        firstName: "Owner",
        lastName: "User",
        email: "owner22@example.com",
        password: "StrongPassword@123"
      })
      .expect(201);
    ownerToken = response.body.data.tokens.accessToken as string;
    ownerId = response.body.data.user.id as string;
    organizationId = response.body.data.organization.id as string;
  });

  afterAll(async () => {
    if (prisma) await clean(prisma);
    await app?.close();
  });

  it("provisions all system roles, permissions, and the initial Owner atomically", async () => {
    const roles = await prisma.role.findMany({
      where: { organizationId },
      include: { users: true, permissions: true }
    });
    expect(roles.map(({ name }) => name).sort()).toEqual([
      "Admin",
      "Manager",
      "Member",
      "Owner",
      "Viewer"
    ]);
    expect(
      roles.find(({ name }) => name === "Owner")?.users.some(({ userId }) => userId === ownerId)
    ).toBe(true);
    expect(roles.find(({ name }) => name === "Owner")?.permissions).toHaveLength(49);
  });

  it("supports custom roles, multi-role users, filtering, and system-role protection", async () => {
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const permissions = await request(app.getHttpServer())
      .get("/api/v1/permissions")
      .set(auth)
      .expect(200);
    const readId = permissions.body.find((item: { key: string }) => item.key === "users.read")
      .id as string;
    const custom = await request(app.getHttpServer())
      .post("/api/v1/roles")
      .set(auth)
      .send({ name: "Auditor", permissionIds: [readId] })
      .expect(201);
    const viewer = await prisma.role.findFirstOrThrow({
      where: { organizationId, name: "Viewer" }
    });
    const user = await request(app.getHttpServer())
      .post("/api/v1/users")
      .set(auth)
      .send({
        firstName: "Multi",
        lastName: "Role",
        email: "multi@example.com",
        password: "StrongPassword@123",
        roleIds: [custom.body.id, viewer.id]
      })
      .expect(201);
    expect(user.body.userRoles).toHaveLength(2);
    const listed = await request(app.getHttpServer())
      .get("/api/v1/users?page=1&pageSize=1&search=multi")
      .set(auth)
      .expect(200);
    expect(listed.body.pagination).toMatchObject({ page: 1, pageSize: 1, total: 1 });
    const ownerRole = await prisma.role.findFirstOrThrow({
      where: { organizationId, name: "Owner" }
    });
    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${ownerRole.id}`)
      .set(auth)
      .send({ name: "Renamed" })
      .expect(403);
    await request(app.getHttpServer()).delete(`/api/v1/users/${ownerId}`).set(auth).expect(403);
    await request(app.getHttpServer())
      .delete(`/api/v1/roles/${custom.body.id}`)
      .set(auth)
      .expect(409);
  });

  it("handles invitation resend, revoke, acceptance, replay, and tenant role isolation", async () => {
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const member = await prisma.role.findFirstOrThrow({
      where: { organizationId, name: "Member" }
    });
    const first = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set(auth)
      .send({ email: "invited@example.com", roleIds: [member.id] })
      .expect(201);
    expect(first.body.token).toHaveLength(43);
    expect(first.body.invitation.tokenHash).not.toBe(first.body.token);
    const resent = await request(app.getHttpServer())
      .post(`/api/v1/invitations/${first.body.invitation.id}/resend`)
      .set(auth)
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({ token: first.body.token, firstName: "Old", password: "StrongPassword@123" })
      .expect(400);
    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({ token: resent.body.token, firstName: "New", password: "StrongPassword@123" })
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({ token: resent.body.token, firstName: "Replay", password: "StrongPassword@123" })
      .expect(400);

    const other = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Other Tenant",
        firstName: "Other",
        email: "other@example.com",
        password: "StrongPassword@123"
      })
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/v1/users")
      .set({ Authorization: `Bearer ${other.body.data.tokens.accessToken}` })
      .send({
        firstName: "Cross",
        email: "cross@example.com",
        password: "StrongPassword@123",
        roleIds: [member.id]
      })
      .expect(400);

    const revoked = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set(auth)
      .send({ email: "revoked@example.com", roleIds: [member.id] })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/invitations/${revoked.body.invitation.id}/revoke`)
      .set(auth)
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({ token: revoked.body.token, firstName: "No", password: "StrongPassword@123" })
      .expect(400);
  });
});

async function clean(prisma: PrismaService): Promise<void> {
  await prisma.invitation.deleteMany();
  await prisma.authenticationSession.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}
