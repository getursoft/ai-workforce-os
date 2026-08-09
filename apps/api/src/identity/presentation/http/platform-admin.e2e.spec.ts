import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../../app.module";
import { ApiExceptionFilter } from "./api-exception.filter";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { deleteAllOrganizationScopedRows, ensurePlatformOwner } from "../../../test/cleanup";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const OWNER_EMAIL = process.env.PLATFORM_OWNER_EMAIL?.toLowerCase() || "krpandey25646@gmail.com";
const OWNER_PASSWORD = process.env.PLATFORM_OWNER_PASSWORD || "PlatformOwner@25646";

// Sprint 5.0 Phase 13: platform-admin console — suspend/reactivate, support notes, operational summary.
suite("Platform admin console", () => {
  let app: INestApplication, prisma: PrismaService, ownerToken: string, orgId: string;
  let orgOwnerEmail: string;
  const orgOwnerPassword = "StrongPassword@123";
  const orgName = `Platform Admin Org ${Date.now()}`;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await ensurePlatformOwner(prisma);

    const ownerLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, organizationName: "Krevia.ai Platform" })
      .expect(200);
    ownerToken = ownerLogin.body.data.tokens.accessToken;

    orgOwnerEmail = `admin-console-owner-${Date.now()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ organizationName: orgName, firstName: "Org", email: orgOwnerEmail, password: orgOwnerPassword })
      .expect(201);
    orgId = registered.body.data.organization.id;
  });

  afterAll(async () => {
    if (prisma) await deleteAllOrganizationScopedRows(prisma);
    await app?.close();
  });

  it("returns a tenant-safe operational summary — counts only, never raw content", async () => {
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const res = await request(app.getHttpServer())
      .get(`/api/v1/platform/organizations/${orgId}/summary`)
      .set(auth)
      .expect(200);
    expect(res.body.data.organization.id).toBe(orgId);
    expect(res.body.data).toMatchObject({
      activeEmployees: expect.any(Number),
      users: expect.any(Number),
      channels: expect.any(Number),
      failedExecutionsLast24h: expect.any(Number),
      openAlerts: expect.any(Number),
      supportNotes: expect.any(Number)
    });
    // No subscription was created for this throwaway org — summary must degrade to null, not throw.
    expect(res.body.data.subscription).toBeNull();
  });

  it("adds and lists support notes", async () => {
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const added = await request(app.getHttpServer())
      .post(`/api/v1/platform/organizations/${orgId}/support-notes`)
      .set(auth)
      .send({ body: "Customer reported a slow dashboard load — investigating." })
      .expect(201);
    expect(added.body.data.body).toContain("slow dashboard load");

    const listed = await request(app.getHttpServer())
      .get(`/api/v1/platform/organizations/${orgId}/support-notes`)
      .set(auth)
      .expect(200);
    expect(listed.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("suspending an organization blocks login for its users, reactivating restores it", async () => {
    const auth = { Authorization: `Bearer ${ownerToken}` };

    const suspended = await request(app.getHttpServer())
      .post(`/api/v1/platform/organizations/${orgId}/suspend`)
      .set(auth)
      .send({ reason: "Non-payment — automated test" })
      .expect(201);
    expect(suspended.body.data.status).toBe("SUSPENDED");

    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: orgOwnerEmail, password: orgOwnerPassword, organizationName: orgName })
      .expect(401);

    const notes = await request(app.getHttpServer())
      .get(`/api/v1/platform/organizations/${orgId}/support-notes`)
      .set(auth)
      .expect(200);
    expect(notes.body.data.some((n: { body: string }) => n.body.includes("Organization suspended"))).toBe(true);

    const reactivated = await request(app.getHttpServer())
      .post(`/api/v1/platform/organizations/${orgId}/reactivate`)
      .set(auth)
      .expect(201);
    expect(reactivated.body.data.status).toBe("ACTIVE");

    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: orgOwnerEmail, password: orgOwnerPassword, organizationName: orgName })
      .expect(200);
  });

  it("denies every platform-admin route to a non-platform-owner", async () => {
    const regularOwnerLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: orgOwnerEmail, password: orgOwnerPassword, organizationName: orgName })
      .expect(200);
    const auth = { Authorization: `Bearer ${regularOwnerLogin.body.data.tokens.accessToken}` };

    await request(app.getHttpServer()).get(`/api/v1/platform/organizations/${orgId}/summary`).set(auth).expect(403);
    await request(app.getHttpServer()).post(`/api/v1/platform/organizations/${orgId}/suspend`).set(auth).send({}).expect(403);
    await request(app.getHttpServer()).post(`/api/v1/platform/organizations/${orgId}/support-notes`).set(auth).send({ body: "x" }).expect(403);
  });
});
