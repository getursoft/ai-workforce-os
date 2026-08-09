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

suite("Platform owner security protocol", () => {
  let app: INestApplication,
    prisma: PrismaService,
    ownerToken: string,
    ownerToken2: string,
    regularOwnerToken: string,
    memberToken: string,
    createdOrgId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    // Guarantee the universal owner exists — another spec's cleanup may have removed it.
    await ensurePlatformOwner(prisma);

    const loginOwner = async (email: string, password: string, organizationName: string) => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ email, password, organizationName })
        .expect(200);
      return res.body.data.tokens.accessToken as string;
    };
    ownerToken = await loginOwner(OWNER_EMAIL, OWNER_PASSWORD, "Krevia.ai Platform");

    // A throwaway org owned by a regular user — used to verify the platform owner can switch into it
    // and that non-owner/non-member users are restricted.
    const regularOrgName = `Regular Org ${Date.now()}`;
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: regularOrgName,
        firstName: "Regular",
        email: `regular-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    const regularOrgId = registered.body.data.organization.id;
    regularOwnerToken = registered.body.data.tokens.accessToken;

    // Create a Member in the regular org (via the org's Owner), then log in as that Member.
    const roles = await request(app.getHttpServer())
      .get("/api/v1/roles")
      .set("Authorization", `Bearer ${regularOwnerToken}`)
      .expect(200);
    const memberRole = (roles.body as Array<{ id: string; name: string }>).find(
      (role) => role.name === "Member"
    );
    const memberEmail = `member-${Date.now()}@example.com`;
    const created = await request(app.getHttpServer())
      .post("/api/v1/users")
      .set("Authorization", `Bearer ${regularOwnerToken}`)
      .send({
        firstName: "Member",
        email: memberEmail,
        password: "StrongPassword@123",
        roleIds: memberRole ? [memberRole.id] : []
      })
      .expect(201);
    expect(created.body.id).toBeDefined();
    memberToken = await loginOwner(memberEmail, "StrongPassword@123", regularOrgName);
    void regularOrgId;
  });

  afterAll(async () => {
    if (prisma) await deleteAllOrganizationScopedRows(prisma);
    await app?.close();
  });

  it("lets the platform owner list and create organizations", async () => {
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const list = await request(app.getHttpServer())
      .get("/api/v1/platform/organizations")
      .set(auth)
      .expect(200);
    expect(Array.isArray(list.body.data)).toBe(true);
    expect(
      list.body.data.some((org: { slug: string }) => org.slug === "ai-workforce-os-platform")
    ).toBe(true);

    const created = await request(app.getHttpServer())
      .post("/api/v1/platform/organizations")
      .set(auth)
      .send({ name: `Owner Created Org ${Date.now()}` })
      .expect(201);
    expect(created.body.data.organization.id).toBeDefined();
    expect(created.body.data.organization.status).toBe("ACTIVE");
    createdOrgId = created.body.data.organization.id;
  });

  it("lets the platform owner switch into any organization and operate there", async () => {
    const switched = await request(app.getHttpServer())
      .post(`/api/v1/platform/organizations/${createdOrgId}/switch`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(201);
    ownerToken2 = switched.body.data.tokens.accessToken;
    expect(switched.body.data.organization.id).toBe(createdOrgId);
    expect(switched.body.data.user.isPlatformOwner).toBe(true);

    const me = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${ownerToken2}`)
      .expect(200);
    expect(me.body.data.organization.id).toBe(createdOrgId);

    // Superadmin bypass: the owner has no membership row there but still reads users / manages.
    const users = await request(app.getHttpServer())
      .get("/api/v1/users")
      .set("Authorization", `Bearer ${ownerToken2}`)
      .expect(200);
    expect(users.body.items).toBeDefined();

    // Refreshing a switched session stays in the switched organization.
    const refresh = await request(app.getHttpServer())
      .post("/api/v1/auth/refresh")
      .set("Authorization", `Bearer ${ownerToken2}`)
      .send({
        refreshToken: switched.body.data.tokens.refreshToken
      })
      .expect(200);
    expect(refresh.body.data.organization.id).toBe(createdOrgId);
  });

  it("rejects platform-owner routes for everyone else", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/platform/organizations")
      .set("Authorization", `Bearer ${regularOwnerToken}`)
      .send({ name: "Nope" })
      .expect(403);
    await request(app.getHttpServer())
      .get("/api/v1/platform/organizations")
      .set("Authorization", `Bearer ${memberToken}`)
      .expect(403);
  });

  it("restricts non-owner visibility: users and roles are owner-only; plugin read-only visibility is not", async () => {
    const memberAuth = { Authorization: `Bearer ${memberToken}` };
    await request(app.getHttpServer()).get("/api/v1/users").set(memberAuth).expect(403);
    await request(app.getHttpServer()).get("/api/v1/roles").set(memberAuth).expect(403);
    // The seeded "Member" role grants plugin.read (see prisma/seed) so members can see which
    // plugins/channels are installed — a normal, read-only working permission, not a privilege leak.
    // Mutating plugin operations (install/update/delete/enable/disable) require plugin.install/
    // plugin.update/plugin.delete, which members do not have.
    await request(app.getHttpServer()).get("/api/v1/plugins").set(memberAuth).expect(200);
    // Members can still reach knowledge (a normal working permission) — returns an empty page, not 403.
    const knowledge = await request(app.getHttpServer())
      .get("/api/v1/knowledge/employees/00000000-0000-4000-8000-000000000000/documents")
      .set(memberAuth)
      .expect(200);
    expect(knowledge.body).toBeDefined();
  });

  it("keeps signup enabled outside production for the test suite, with the owner flagged", async () => {
    // The register flow above already worked; assert the registered owner is NOT the platform owner.
    const me = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${regularOwnerToken}`)
      .expect(200);
    expect(me.body.data.user.isPlatformOwner).toBe(false);
    const ownerMe = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(ownerMe.body.data.user.isPlatformOwner).toBe(true);
  });
});
