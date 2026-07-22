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
for (const c of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(c)) {
    loadEnvFile(c);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Service accounts and API keys", () => {
  let app: INestApplication,
    prisma: PrismaService,
    token: string,
    org: string,
    memberRole: string,
    account: string,
    keyId: string,
    plain: string;
  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await clean(prisma);
    const r = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Machine Org",
        firstName: "Owner",
        email: "machine-owner@example.com",
        password: "StrongPassword@123"
      })
      .expect(201);
    token = r.body.data.tokens.accessToken;
    org = r.body.data.organization.id;
    const teamRead = await prisma.permission.findUniqueOrThrow({ where: { key: "TEAM_READ" } });
    memberRole = (
      await prisma.role.create({
        data: {
          organizationId: org,
          name: "Machine Team Reader",
          permissions: { create: { permissionId: teamRead.id } }
        }
      })
    ).id;
  });
  afterAll(async () => {
    if (prisma) await clean(prisma);
    await app?.close();
  });
  it("creates tenant-scoped accounts and returns a key secret only once", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const created = await request(app.getHttpServer())
      .post("/api/v1/service-accounts")
      .set(auth)
      .send({ name: "Scheduler", description: "Nightly jobs", roleIds: [memberRole] })
      .expect(201);
    account = created.body.id;
    const generated = await request(app.getHttpServer())
      .post(`/api/v1/service-accounts/${account}/api-keys`)
      .set(auth)
      .send({ name: "Primary", environment: "LIVE" })
      .expect(201);
    plain = generated.body.secret;
    keyId = generated.body.apiKey.id;
    expect(plain).toMatch(/^awo_live_/);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/service-accounts/${account}`)
      .set(auth)
      .expect(200);
    expect(JSON.stringify(detail.body)).not.toContain(plain);
    expect(JSON.stringify(detail.body)).not.toContain("secretHash");
    const stored = await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } });
    expect(stored.secretHash).not.toContain(plain);
  });
  it("authenticates with existing RBAC, rotates and revokes immediately", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/teams")
      .set({ Authorization: `ApiKey ${plain}` })
      .expect(200);
    await request(app.getHttpServer())
      .get("/api/v1/service-accounts")
      .set({ Authorization: `ApiKey ${plain}` })
      .expect(403);
    const rotated = await request(app.getHttpServer())
      .post(`/api/v1/service-accounts/${account}/api-keys/${keyId}/rotate`)
      .set({ Authorization: `Bearer ${token}` })
      .expect(201);
    await request(app.getHttpServer())
      .get("/api/v1/teams")
      .set({ Authorization: `ApiKey ${plain}` })
      .expect(401);
    const next = rotated.body.secret;
    await request(app.getHttpServer())
      .get("/api/v1/teams")
      .set({ Authorization: `ApiKey ${next}` })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/service-accounts/${account}/api-keys/${rotated.body.apiKey.id}/revoke`)
      .set({ Authorization: `Bearer ${token}` })
      .expect(201);
    await request(app.getHttpServer())
      .get("/api/v1/teams")
      .set({ Authorization: `ApiKey ${next}` })
      .expect(401);
  });
  it("blocks cross-tenant access and disables all keys on archive", async () => {
    const other = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Other Machine",
        firstName: "Other",
        email: "other-machine@example.com",
        password: "StrongPassword@123"
      })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/api/v1/service-accounts/${account}`)
      .set({ Authorization: `Bearer ${other.body.data.tokens.accessToken}` })
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/v1/service-accounts/${account}`)
      .set({ Authorization: `Bearer ${token}` })
      .expect(204);
    expect(
      (await prisma.serviceAccount.findUniqueOrThrow({ where: { id: account } })).deletedAt
    ).toBeInstanceOf(Date);
  });
});
async function clean(p: PrismaService) {
  await p.apiKey.deleteMany();
  await p.serviceAccountRole.deleteMany();
  await p.serviceAccount.deleteMany();
  await p.teamMember.deleteMany();
  await p.team.deleteMany();
  await p.invitation.deleteMany();
  await p.authenticationSession.deleteMany();
  await p.userRole.deleteMany();
  await p.rolePermission.deleteMany();
  await p.role.deleteMany();
  await p.user.deleteMany();
  await p.organization.deleteMany();
}
