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

suite("AI Configuration HTTP: RBAC and tenant isolation", () => {
  let app: INestApplication, prisma: PrismaService;
  let orgAAuth: Record<string, string>, orgBAuth: Record<string, string>;
  let orgAConnectionId: string, orgAProfileId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    // The full AppModule cold boot (queue/scheduler/observability wiring included) can exceed
    // vitest's default 10s hook timeout on a loaded dev machine — matches the pattern other large
    // e2e suites in this codebase rely on when run standalone rather than as part of the full run.
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);

    const suffix = Date.now();
    const a = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `AI Config Org A ${suffix}`,
        firstName: "Owner",
        email: `ai-config-a-${suffix}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    orgAAuth = { Authorization: `Bearer ${a.body.data.tokens.accessToken}` };

    const b = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `AI Config Org B ${suffix}`,
        firstName: "Owner",
        email: `ai-config-b-${suffix}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    orgBAuth = { Authorization: `Bearer ${b.body.data.tokens.accessToken}` };
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  it("Owner can create a provider connection, and the credential never appears in the response", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/ai-configuration/connections")
      .set(orgAAuth)
      .send({
        name: "OpenAI Production",
        providerType: "OPENAI_COMPATIBLE",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-e2e-tenant-isolation-secret"
      })
      .expect(201);
    orgAConnectionId = created.body.id;
    expect(created.body.credentialConfigured).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain("sk-e2e-tenant-isolation-secret");
    expect(JSON.stringify(created.body)).not.toContain("encryptedCredentialJson");

    // The DB row is genuinely encrypted, not just hidden by the response shape.
    const stored = await prisma.aiProviderConnection.findUniqueOrThrow({ where: { id: orgAConnectionId } });
    expect(JSON.stringify(stored.encryptedCredentialJson)).not.toContain("sk-e2e-tenant-isolation-secret");
  });

  it("Owner can create a model profile referencing that connection", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/ai-configuration/profiles")
      .set(orgAAuth)
      .send({
        name: "Standard GPT-4.1",
        providerConnectionId: orgAConnectionId,
        purpose: "DEFAULT",
        model: "gpt-4.1"
      })
      .expect(201);
    orgAProfileId = created.body.id;
    expect(created.body.model).toBe("gpt-4.1");
  });

  it("cross-tenant: organization B cannot read organization A's connection", async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/ai-configuration/connections/${orgAConnectionId}`)
      .set(orgBAuth)
      .expect(404);
  });

  it("cross-tenant: organization B's connection list never includes organization A's connection", async () => {
    const list = await request(app.getHttpServer())
      .get("/api/v1/ai-configuration/connections")
      .set(orgBAuth)
      .expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).not.toContain(orgAConnectionId);
  });

  it("cross-tenant: organization B cannot update organization A's connection", async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/ai-configuration/connections/${orgAConnectionId}`)
      .set(orgBAuth)
      .send({ name: "Hijacked" })
      .expect(404);
  });

  it("cross-tenant: organization B cannot test-connect organization A's connection", async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/ai-configuration/connections/${orgAConnectionId}/test`)
      .set(orgBAuth)
      .expect(404);
  });

  it("cross-tenant: organization B cannot delete organization A's connection", async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/ai-configuration/connections/${orgAConnectionId}`)
      .set(orgBAuth)
      .expect(404);
    // Still there afterward, confirmed from org A's own side.
    await request(app.getHttpServer())
      .get(`/api/v1/ai-configuration/connections/${orgAConnectionId}`)
      .set(orgAAuth)
      .expect(200);
  });

  it("cross-tenant: organization B cannot create a profile referencing organization A's connection", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/ai-configuration/profiles")
      .set(orgBAuth)
      .send({
        name: "Cross-tenant profile",
        providerConnectionId: orgAConnectionId,
        purpose: "DEFAULT",
        model: "gpt-4.1"
      })
      .expect(400);
  });

  it("cross-tenant: organization B cannot set organization A's profile as its own organization default", async () => {
    await request(app.getHttpServer())
      .patch("/api/v1/ai-configuration/organization-defaults")
      .set(orgBAuth)
      .send({ defaultProfileId: orgAProfileId })
      .expect(400);
  });

  it("unauthenticated requests are rejected", async () => {
    await request(app.getHttpServer()).get("/api/v1/ai-configuration/connections").expect(401);
  });

  it("a user without ai.provider.manage cannot create a connection", async () => {
    // AuthorizationService.getEffectivePermissions caches per (org, user) for 5 minutes, and grants
    // every permission via a temporary bypass whenever a user has zero real UserRole assignments
    // yet (pre-materialization). A user who has already made requests in this test file (org A/B's
    // owners) would have that bypass cached from their very first call, long before this test could
    // revoke anything — so this needs a THIRD, never-before-used user whose limited role/grant is
    // seeded directly in the DB before their first ever authenticated request, guaranteeing the
    // bypass is never triggered and the cache is primed with the real (empty) grant from the start.
    const suffix = `${Date.now()}-limited`;
    const c = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `AI Config Org C ${suffix}`,
        firstName: "Limited",
        email: `ai-config-c-${suffix}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    const organizationId = c.body.data.organization.id;
    const userId = c.body.data.user.id;
    const limitedRole = await prisma.role.create({
      data: { organizationId, name: `No AI Access ${suffix}`, isSystem: false }
    });
    await prisma.userRole.deleteMany({ where: { userId } });
    await prisma.userRole.create({ data: { userId, roleId: limitedRole.id } });
    const limitedAuth = { Authorization: `Bearer ${c.body.data.tokens.accessToken}` };

    await request(app.getHttpServer())
      .post("/api/v1/ai-configuration/connections")
      .set(limitedAuth)
      .send({ name: "Should be denied", providerType: "OPENAI_COMPATIBLE", apiKey: "sk-denied" })
      .expect(403);
  }, 15000);
});
