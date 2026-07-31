import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../../app.module";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { deleteAllOrganizationScopedRows } from "../../../test/cleanup";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../../infrastructure/security/security-config";
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

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testDatabaseName = testDatabaseUrl ? new URL(testDatabaseUrl).pathname.slice(1) : null;
if (testDatabaseUrl && testDatabaseName !== "ai_workforce_os_test") {
  throw new Error("HTTP E2E tests refuse to run outside ai_workforce_os_test");
}
if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: string[];
    requestId: string;
    timestamp: string;
  };
}

interface AuthenticationEnvelope {
  data: {
    organization: { id: string; name: string; slug: string; status: string };
    user: { id: string; organizationId: string; email: string; role: string; status: string };
    tokens: { accessToken: string; refreshToken: string };
  };
}

const suite = testDatabaseUrl ? describe : describe.skip;

function expectError(body: ErrorEnvelope, code: string): void {
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(Array.isArray(body.error.details)).toBe(true);
  expect(body.error.requestId.length).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(body.error.timestamp))).toBe(false);
}

suite("Identity HTTP API", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const registration = {
    organizationName: "Getursoft",
    firstName: "Krishna",
    lastName: "Pandey",
    email: "admin@getursoft.com",
    password: "StrongPassword@123"
  };

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    const securityConfig = app.get<SecurityConfig>(SECURITY_CONFIG);
    app.enableCors({
      origin: securityConfig.webAppUrl,
      credentials: true,
      exposedHeaders: ["x-request-id"],
      methods: ["GET", "POST", "DELETE", "OPTIONS"]
    });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        stopAtFirstError: false
      })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await deleteAllOrganizationScopedRows(prisma);
  });

  afterAll(async () => {
    if (prisma) {
      await deleteAllOrganizationScopedRows(prisma);
    }
    await app?.close();
  });

  it("runs the complete registration, me, login, rotation, replay, and logout flow", async () => {
    const agent = request.agent(app.getHttpServer());

    const registered = await agent
      .post("/api/v1/auth/register")
      .set("x-request-id", "sprint1-e2e-register")
      .send(registration)
      .expect(201)
      .expect("x-request-id", "sprint1-e2e-register");
    const registeredBody = registered.body as AuthenticationEnvelope;
    expect(registeredBody.data.organization).toMatchObject({
      name: "Getursoft",
      slug: "getursoft",
      status: "ACTIVE"
    });
    expect(registeredBody.data.user).toMatchObject({
      email: "admin@getursoft.com",
      role: "OWNER",
      status: "ACTIVE"
    });
    expect(JSON.stringify(registeredBody)).not.toMatch(/passwordHash|tokenHash/);
    expect(registered.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("aiwos_refresh_token=")])
    );
    expect(registered.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("HttpOnly")])
    );

    const me = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("authorization", `Bearer ${registeredBody.data.tokens.accessToken}`)
      .expect(200);
    expect(me.body).toMatchObject({ data: { user: { email: registration.email } } });
    expect(JSON.stringify(me.body)).not.toMatch(/password|token|session/);

    const loggedIn = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "ADMIN@Getursoft.com", password: registration.password })
      .expect(200);
    const loggedInBody = loggedIn.body as AuthenticationEnvelope;
    expect(loggedInBody.data.user.email).toBe(registration.email);
    expect(loggedIn.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("aiwos_refresh_token=")])
    );

    const refreshed = await agent.post("/api/v1/auth/refresh").send({}).expect(200);
    const refreshedBody = refreshed.body as AuthenticationEnvelope;
    expect(refreshed.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("aiwos_refresh_token=")])
    );
    expect(refreshedBody.data.tokens.refreshToken).not.toBe(
      registeredBody.data.tokens.refreshToken
    );

    const replay = await request(app.getHttpServer())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: registeredBody.data.tokens.refreshToken })
      .expect(401);
    expectError(replay.body as ErrorEnvelope, "REFRESH_TOKEN_REUSED");

    const revokedFamily = await request(app.getHttpServer())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: refreshedBody.data.tokens.refreshToken })
      .expect(401);
    expectError(revokedFamily.body as ErrorEnvelope, "REFRESH_TOKEN_REUSED");

    const logoutLogin = await agent
      .post("/api/v1/auth/login")
      .send({ email: registration.email, password: registration.password })
      .expect(200);
    const logoutTokens = (logoutLogin.body as AuthenticationEnvelope).data.tokens;
    await agent
      .post("/api/v1/auth/logout")
      .send({})
      .expect(200, { data: { success: true } });
    await request(app.getHttpServer())
      .post("/api/v1/auth/logout")
      .send({ refreshToken: logoutTokens.refreshToken })
      .expect(200, { data: { success: true } });
    const afterLogout = await request(app.getHttpServer())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: logoutTokens.refreshToken })
      .expect(401);
    expectError(afterLogout.body as ErrorEnvelope, "REFRESH_TOKEN_REUSED");
  });

  it("returns safe standard errors for duplicate, authentication, DTO, and bearer failures", async () => {
    const cases = [
      await request(app.getHttpServer())
        .post("/api/v1/auth/register")
        .send(registration)
        .expect(409),
      await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ email: registration.email, password: "IncorrectPassword@123" })
        .expect(401),
      await request(app.getHttpServer()).get("/api/v1/auth/me").expect(401),
      await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("authorization", "Bearer invalid")
        .expect(401),
      await request(app.getHttpServer())
        .post("/api/v1/auth/register")
        .send({ ...registration, email: "unknown@getursoft.com", unknown: true })
        .expect(400),
      await request(app.getHttpServer())
        .post("/api/v1/auth/register")
        .send({ ...registration, email: "weak@getursoft.com", password: "weakpassword" })
        .expect(400),
      await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: "malformed" })
        .expect(401)
    ];
    const expectedCodes = [
      "EMAIL_ALREADY_EXISTS",
      "AUTHENTICATION_FAILED",
      "AUTHENTICATION_FAILED",
      "AUTHENTICATION_FAILED",
      "VALIDATION_ERROR",
      "VALIDATION_ERROR",
      "INVALID_REFRESH_TOKEN"
    ];
    cases.forEach((response, index) =>
      expectError(response.body as ErrorEnvelope, expectedCodes[index] ?? "")
    );
    expect((cases[1]?.body as ErrorEnvelope).error.message).toBe("Invalid email or password.");
  });

  it("emits browser CORS headers for the configured frontend origin", async () => {
    const response = await request(app.getHttpServer())
      .options("/api/v1/auth/me")
      .set("origin", "http://localhost:3000")
      .expect(204);

    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("rejects unsafe incoming request IDs and returns a bounded generated ID", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("x-request-id", "unsafe request id with spaces".repeat(10))
      .expect(401);
    const body = response.body as ErrorEnvelope;
    expect(body.error.requestId).not.toContain("unsafe request");
    expect(body.error.requestId.length).toBeLessThanOrEqual(64);
    expect(response.headers["x-request-id"]).toBe(body.error.requestId);
  });

  it("supports organization profile and settings management for authenticated users", async () => {
    const agent = request.agent(app.getHttpServer());
    const orgRegistration = {
      ...registration,
      organizationName: "Widget Systems",
      email: "organization-admin@widgetsystems.com"
    };
    const registered = await agent.post("/api/v1/auth/register").send(orgRegistration).expect(201);
    const accessToken = (registered.body as AuthenticationEnvelope).data.tokens.accessToken;
    const organizationSlug = (registered.body as AuthenticationEnvelope).data.organization.slug;

    const currentOrganization = await agent
      .get("/api/v1/organizations/me")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(currentOrganization.body).toMatchObject({
      data: {
        organization: {
          name: "Widget Systems",
          slug: organizationSlug,
          status: "ACTIVE"
        }
      }
    });

    const defaultSettings = await agent
      .get("/api/v1/organizations/me/settings")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(defaultSettings.body).toMatchObject({
      data: {
        organizationSetting: {
          timezone: "UTC",
          currency: "USD",
          locale: "en-US"
        }
      }
    });

    const updatedOrganization = await agent
      .patch("/api/v1/organizations/me")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ name: "Updated Widget Systems" })
      .expect(200);
    expect(updatedOrganization.body).toMatchObject({
      data: {
        organization: {
          name: "Updated Widget Systems",
          slug: organizationSlug,
          status: "ACTIVE"
        }
      }
    });

    const updatedSettings = await agent
      .patch("/api/v1/organizations/me/settings")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ timezone: "America/New_York", currency: "EUR", locale: "de-DE" })
      .expect(200);
    expect(updatedSettings.body).toMatchObject({
      data: {
        organizationSetting: {
          timezone: "America/New_York",
          currency: "EUR",
          locale: "de-DE"
        }
      }
    });

    await request(app.getHttpServer())
      .patch("/api/v1/organizations/me")
      .send({ name: "No auth" })
      .expect(401);
    await request(app.getHttpServer())
      .patch("/api/v1/organizations/me/settings")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ timezone: "Invalid/Zone" })
      .expect(400);
    await request(app.getHttpServer())
      .patch("/api/v1/organizations/me/settings")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ currency: "EURO" })
      .expect(400);
    await request(app.getHttpServer())
      .patch("/api/v1/organizations/me/settings")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ locale: "not-a-locale" })
      .expect(400);
  });

  it("rejects forbidden organization access when the authenticated user is suspended", async () => {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        ...registration,
        email: "forbidden@getursoft.com"
      })
      .expect(201);
    const accessToken = (registered.body as AuthenticationEnvelope).data.tokens.accessToken;
    const userId = (registered.body as AuthenticationEnvelope).data.user.id;
    await prisma.user.update({
      where: { id: userId },
      data: { status: "SUSPENDED" }
    });

    const response = await request(app.getHttpServer())
      .get("/api/v1/organizations/me")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(403);
    expect((response.body as ErrorEnvelope).error.code).toBe("USER_INACTIVE");
  });
});
