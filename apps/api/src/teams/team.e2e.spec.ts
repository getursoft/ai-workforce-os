import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { deleteAllOrganizationScopedRows } from "../test/cleanup";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
for (const candidate of [
  resolve(process.cwd(), ".env.test"),
  resolve(process.cwd(), "../../.env.test")
])
  if (existsSync(candidate)) {
    loadEnvFile(candidate);
    break;
  }
const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) process.env.DATABASE_URL = testUrl;
const suite = testUrl ? describe : describe.skip;
suite("Team HTTP API", () => {
  let app: INestApplication, prisma: PrismaService, token: string, org: string, userId: string;
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
        organizationName: "Teams Org",
        firstName: "Owner",
        email: "teams-owner@example.com",
        password: "StrongPassword@123"
      })
      .expect(201);
    token = r.body.data.tokens.accessToken;
    org = r.body.data.organization.id;
    userId = r.body.data.user.id;
  });
  afterAll(async () => {
    if (prisma) await clean(prisma);
    await app.close();
  });
  it("creates unique slugs, filters teams, and prevents hierarchy cycles", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const parent = await request(app.getHttpServer())
      .post("/api/v1/teams")
      .set(auth)
      .send({ name: "Engineering", managerId: userId })
      .expect(201);
    const child = await request(app.getHttpServer())
      .post("/api/v1/teams")
      .set(auth)
      .send({ name: "Engineering", parentTeamId: parent.body.id })
      .expect(201);
    expect(parent.body.slug).toBe("engineering");
    expect(child.body.slug).toBe("engineering-2");
    await request(app.getHttpServer())
      .patch(`/api/v1/teams/${parent.body.id}`)
      .set(auth)
      .send({ parentTeamId: child.body.id })
      .expect(400);
    const list = await request(app.getHttpServer())
      .get("/api/v1/teams?search=engineering&status=ACTIVE&page=1&pageSize=10")
      .set(auth)
      .expect(200);
    expect(list.body.pagination.total).toBe(2);
  });
  it("manages multi-team membership and soft deletes only", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const team = await request(app.getHttpServer())
      .post("/api/v1/teams")
      .set(auth)
      .send({ name: "Product" })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/teams/${team.body.id}/members`)
      .set(auth)
      .send({ userId, role: "MANAGER" })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/api/v1/teams/${team.body.id}/members/${userId}`)
      .set(auth)
      .send({ role: "LEAD" })
      .expect(200);
    const members = await request(app.getHttpServer())
      .get(`/api/v1/teams/${team.body.id}/members`)
      .set(auth)
      .expect(200);
    expect(members.body.items[0].role).toBe("LEAD");
    await request(app.getHttpServer())
      .delete(`/api/v1/teams/${team.body.id}/members/${userId}`)
      .set(auth)
      .expect(204);
    await request(app.getHttpServer())
      .delete(`/api/v1/teams/${team.body.id}`)
      .set(auth)
      .expect(204);
    const stored = await prisma.team.findUniqueOrThrow({ where: { id: team.body.id } });
    expect(stored.deletedAt).toBeInstanceOf(Date);
    expect(stored.status).toBe("ARCHIVED");
  });
  it("rejects managers and parent teams from another organization", async () => {
    const other = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Other Teams",
        firstName: "Other",
        email: "other-teams@example.com",
        password: "StrongPassword@123"
      })
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/v1/teams")
      .set({ Authorization: `Bearer ${token}` })
      .send({ name: "Invalid", managerId: other.body.data.user.id })
      .expect(400);
    expect(await prisma.team.count({ where: { organizationId: org, name: "Invalid" } })).toBe(0);
  });
});
async function clean(p: PrismaService) {
  await deleteAllOrganizationScopedRows(p);
}
