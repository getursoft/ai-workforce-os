import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../../app.module";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { deleteAllOrganizationScopedRows } from "../../../test/cleanup";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../../infrastructure/security/security-config";
import { ApiExceptionFilter } from "./api-exception.filter";
import { EmailService } from "../../../notifications/email.service";

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

// This file's tests do real Argon2id hashing (register/login/reset, several per test) over several
// sequential HTTP round-trips against a real server + Postgres. Vitest's 5000ms default is tight for
// that even in isolation, and gets tighter under normal system load (e.g. a `pnpm dev` running
// alongside). 20s gives real headroom without masking an actual hang.
vi.setConfig({ testTimeout: 20_000 });

suite("Identity HTTP API", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let emailService: EmailService;
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
    emailService = app.get(EmailService);
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
      .send({
        email: "ADMIN@Getursoft.com",
        password: registration.password,
        organizationName: registration.organizationName
      })
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
      .send({
        email: registration.email,
        password: registration.password,
        organizationName: registration.organizationName
      })
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
        .send({
          email: registration.email,
          password: "IncorrectPassword@123",
          organizationName: registration.organizationName
        })
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

  it("issues an email-verification token on registration and confirms it exactly once", async () => {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ ...registration, organizationName: "GetursoftVerify", email: "verify-flow@getursoft.com" })
      .expect(201);
    const body = registered.body as AuthenticationEnvelope & {
      data: { emailVerificationToken?: string };
    };
    const token = body.data.emailVerificationToken;
    expect(typeof token).toBe("string");
    expect((token ?? "").length).toBeGreaterThan(0);

    const userId = body.data.user.id;
    const beforeConfirm = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(beforeConfirm.emailVerifiedAt).toBeNull();

    await request(app.getHttpServer())
      .post("/api/v1/auth/verify-email")
      .send({ token })
      .expect(200, { data: { success: true } });

    const afterConfirm = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(afterConfirm.emailVerifiedAt).not.toBeNull();

    const replay = await request(app.getHttpServer())
      .post("/api/v1/auth/verify-email")
      .send({ token })
      .expect(400);
    expectError(replay.body as ErrorEnvelope, "VALIDATION_ERROR");
  });

  it("resend-verification issues a fresh token for the authenticated user", async () => {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ ...registration, organizationName: "GetursoftResend", email: "resend-flow@getursoft.com" })
      .expect(201);
    const registeredBody = registered.body as AuthenticationEnvelope;
    const accessToken = registeredBody.data.tokens.accessToken;

    const resent = await request(app.getHttpServer())
      .post("/api/v1/auth/resend-verification")
      .set("authorization", `Bearer ${accessToken}`)
      .send({})
      .expect(200);
    const resentToken = (resent.body as { data: { emailVerificationToken?: string } }).data
      .emailVerificationToken;
    expect(typeof resentToken).toBe("string");
    expect((resentToken ?? "").length).toBeGreaterThan(0);

    await request(app.getHttpServer())
      .post("/api/v1/auth/verify-email")
      .send({ token: resentToken })
      .expect(200, { data: { success: true } });
  });

  it("locks the account after repeated failed logins and rejects even the correct password until it expires", async () => {
    const registration2 = {
      ...registration,
      organizationName: "GetursoftLockout",
      email: "lockout-flow@getursoft.com"
    };
    await request(app.getHttpServer()).post("/api/v1/auth/register").send(registration2).expect(201);

    for (let i = 0; i < 5; i++) {
      const attempt = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          email: registration2.email,
          password: "TotallyWrongPassword@123",
          organizationName: registration2.organizationName
        })
        .expect(401);
      expectError(attempt.body as ErrorEnvelope, "AUTHENTICATION_FAILED");
    }

    const lockedOut = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({
        email: registration2.email,
        password: registration2.password,
        organizationName: registration2.organizationName
      })
      .expect(429);
    expectError(lockedOut.body as ErrorEnvelope, "ACCOUNT_LOCKED");

    const user = await prisma.user.findFirstOrThrow({
      where: { normalizedEmail: registration2.email }
    });
    expect(user.failedLoginAttempts).toBe(5);
    expect(user.lockedUntil).not.toBeNull();
  });

  describe("Forgot / reset password", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function registerUser(suffix: string) {
      const org = {
        ...registration,
        organizationName: `GetursoftReset${suffix}`,
        email: `reset-${suffix}@getursoft.com`.toLowerCase()
      };
      await request(app.getHttpServer()).post("/api/v1/auth/register").send(org).expect(201);
      return org;
    }

    it("issues a reset token for a known email, normalizes the email, and never stores the raw token", async () => {
      const org = await registerUser("known");

      const response = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email: `  ${org.email.toUpperCase()}  ` })
        .expect(200);
      const body = response.body as { data: { email: string; resetToken?: string } };
      expect(body.data.email).toBe(org.email);
      // Exactly an 8-digit numeric OTP — easy to read from an email and type in, unlike the previous
      // long opaque token.
      expect(body.data.resetToken).toMatch(/^\d{8}$/);

      const user = await prisma.user.findFirstOrThrow({ where: { normalizedEmail: org.email } });
      const record = await prisma.passwordResetToken.findFirstOrThrow({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" }
      });
      expect(record.tokenHash).not.toBe(body.data.resetToken);
      expect(record.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(record.usedAt).toBeNull();
      expect(record.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("returns an identical response shape for an email that does not belong to any account", async () => {
      const known = await registerUser("enum-known");
      const knownResponse = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email: known.email })
        .expect(200);
      const unknownResponse = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email: "definitely-not-registered@getursoft.com" })
        .expect(200);

      const knownBody = knownResponse.body as { data: { email: string; resetToken?: string } };
      const unknownBody = unknownResponse.body as { data: { email: string; resetToken?: string } };
      // Same HTTP status, same top-level shape, same field types — only the token value legitimately
      // differs (real token vs empty string, both are `string`, so `typeof` matches for both).
      expect(knownResponse.status).toBe(unknownResponse.status);
      expect(Object.keys(knownBody.data).sort()).toEqual(Object.keys(unknownBody.data).sort());
      expect(typeof knownBody.data.resetToken).toBe(typeof unknownBody.data.resetToken);
      expect(unknownBody.data.resetToken).toBe("");
    });

    it("returns the same non-enumerating response for a suspended account as for an unknown email", async () => {
      const org = await registerUser("suspended");
      await prisma.user.updateMany({ where: { normalizedEmail: org.email }, data: { status: "SUSPENDED" } });

      const response = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email: org.email })
        .expect(200);
      const body = response.body as { data: { email: string; resetToken?: string } };
      expect(body.data.resetToken).toBe("");

      const user = await prisma.user.findFirstOrThrow({ where: { normalizedEmail: org.email } });
      const tokenCount = await prisma.passwordResetToken.count({ where: { userId: user.id } });
      expect(tokenCount).toBe(0);
    });

    it("completes the full reset flow: old password stops working, new password works, the token is single-use, sessions are revoked, and lockout counters clear", async () => {
      const org = await registerUser("full-flow");
      const newPassword = "BrandNewPassword@456";

      // Log in once so there is a real refresh token / session to prove gets revoked by the reset.
      const loggedIn = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ email: org.email, password: org.password, organizationName: org.organizationName })
        .expect(200);
      const oldRefreshToken = (loggedIn.body as { data: { tokens: { refreshToken: string } } }).data.tokens
        .refreshToken;

      const requested = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email: org.email })
        .expect(200);
      const token = (requested.body as { data: { resetToken?: string } }).data.resetToken as string;
      expect(token.length).toBeGreaterThan(0);

      await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ email: org.email, token, newPassword })
        .expect(200, { data: { success: true } });

      // Old password must fail now.
      const oldPasswordAttempt = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ email: org.email, password: org.password, organizationName: org.organizationName })
        .expect(401);
      expectError(oldPasswordAttempt.body as ErrorEnvelope, "AUTHENTICATION_FAILED");

      // New password must work.
      await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ email: org.email, password: newPassword, organizationName: org.organizationName })
        .expect(200);

      // The reset token must not be reusable a second time.
      const replay = await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ email: org.email, token, newPassword: "AnotherNewPassword@789" })
        .expect(400);
      expectError(replay.body as ErrorEnvelope, "VALIDATION_ERROR");

      // The pre-reset refresh token must no longer mint a new access token.
      await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: oldRefreshToken })
        .expect(401);

      // Lockout counters were reset even though there was nothing to reset here — asserted via a
      // dedicated lockout-then-reset test below for the meaningful (non-zero) case.
      const user = await prisma.user.findFirstOrThrow({ where: { normalizedEmail: org.email } });
      expect(user.failedLoginAttempts).toBe(0);
      expect(user.lockedUntil).toBeNull();
    });

    it("clears a real account lockout once the password is successfully reset", async () => {
      const org = await registerUser("lockout-then-reset");
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post("/api/v1/auth/login")
          .send({ email: org.email, password: "WrongPassword@123", organizationName: org.organizationName })
          .expect(401);
      }
      const lockedUser = await prisma.user.findFirstOrThrow({ where: { normalizedEmail: org.email } });
      expect(lockedUser.lockedUntil).not.toBeNull();

      const requested = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email: org.email })
        .expect(200);
      const token = (requested.body as { data: { resetToken?: string } }).data.resetToken as string;

      await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ email: org.email, token, newPassword: "UnlockedPassword@321" })
        .expect(200);

      const unlockedUser = await prisma.user.findFirstOrThrow({ where: { normalizedEmail: org.email } });
      expect(unlockedUser.lockedUntil).toBeNull();
      expect(unlockedUser.failedLoginAttempts).toBe(0);

      // And the account can actually log in again immediately, proving the lock was really lifted.
      await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ email: org.email, password: "UnlockedPassword@321", organizationName: org.organizationName })
        .expect(200);
    });

    it("rejects an expired reset token", async () => {
      const org = await registerUser("expired");
      const requested = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email: org.email })
        .expect(200);
      const token = (requested.body as { data: { resetToken?: string } }).data.resetToken as string;

      const user = await prisma.user.findFirstOrThrow({ where: { normalizedEmail: org.email } });
      await prisma.passwordResetToken.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) }
      });

      const attempt = await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ email: org.email, token, newPassword: "ShouldNotWork@123" })
        .expect(400);
      expectError(attempt.body as ErrorEnvelope, "VALIDATION_ERROR");
    });

    it("rejects a garbage/invalid token without leaking whether the email exists", async () => {
      const org = await registerUser("garbage-token");
      const attempt = await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ email: org.email, token: "not-a-real-token", newPassword: "ShouldNotWork@123" })
        .expect(400);
      expectError(attempt.body as ErrorEnvelope, "VALIDATION_ERROR");

      const unknownAttempt = await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ email: "nobody-here@getursoft.com", token: "not-a-real-token", newPassword: "ShouldNotWork@123" })
        .expect(400);
      // Same error code for "wrong token, real account" and "wrong token, no account" — no signal to
      // distinguish the two.
      expect((attempt.body as ErrorEnvelope).error.code).toBe(
        (unknownAttempt.body as ErrorEnvelope).error.code
      );
    });

    it("invalidates a previously issued token once a new reset is requested for the same account", async () => {
      const org = await registerUser("superseded");
      const first = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email: org.email })
        .expect(200);
      const firstToken = (first.body as { data: { resetToken?: string } }).data.resetToken as string;

      const second = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email: org.email })
        .expect(200);
      const secondToken = (second.body as { data: { resetToken?: string } }).data.resetToken as string;
      expect(secondToken).not.toBe(firstToken);

      const oldTokenAttempt = await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ email: org.email, token: firstToken, newPassword: "ShouldNotWork@123" })
        .expect(400);
      expectError(oldTokenAttempt.body as ErrorEnvelope, "VALIDATION_ERROR");

      await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ email: org.email, token: secondToken, newPassword: "ShouldWork@123" })
        .expect(200);
    });

    it("enforces the existing password policy on the new password", async () => {
      const org = await registerUser("weak-password");
      const requested = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email: org.email })
        .expect(200);
      const token = (requested.body as { data: { resetToken?: string } }).data.resetToken as string;

      const attempt = await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ email: org.email, token, newPassword: "short" })
        .expect(400);
      expectError(attempt.body as ErrorEnvelope, "VALIDATION_ERROR");
    });

    it("sends a real email through EmailService when SMTP is configured, addressed to the account and containing the configured webAppUrl", async () => {
      const org = await registerUser("smtp-sent");
      const sendMailSpy = vi.spyOn(emailService, "sendMail").mockResolvedValue({ messageId: "test-msg-1" });
      const isConfiguredSpy = vi.spyOn(emailService, "isConfigured").mockReturnValue(true);
      const securityConfig = app.get<SecurityConfig>(SECURITY_CONFIG);

      const response = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email: org.email })
        .expect(200);
      // Lets the dashboard tell "a real email genuinely sent" apart from "dev mode returned a code
      // because nothing is configured" instead of always claiming delivery is unconfigured.
      expect((response.body as { data: { emailSent?: boolean } }).data.emailSent).toBe(true);

      expect(sendMailSpy).toHaveBeenCalledTimes(1);
      const call = sendMailSpy.mock.calls[0]?.[0];
      expect(call?.to).toBe(org.email);
      expect(call?.subject).toBe("Reset your Krevia.ai password");
      expect(call?.text).toContain(securityConfig.webAppUrl);
      expect(call?.html).toContain("Reset Password");
      isConfiguredSpy.mockRestore();
      sendMailSpy.mockRestore();
    });

    it("never sends an email and never fails the request when SMTP is not configured", async () => {
      const org = await registerUser("smtp-unconfigured");
      const sendMailSpy = vi.spyOn(emailService, "sendMail");
      const isConfiguredSpy = vi.spyOn(emailService, "isConfigured").mockReturnValue(false);

      const response = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email: org.email })
        .expect(200);
      expect((response.body as { data: { emailSent?: boolean } }).data.emailSent).toBe(false);

      expect(sendMailSpy).not.toHaveBeenCalled();
      isConfiguredSpy.mockRestore();
      sendMailSpy.mockRestore();
    });

    it("never fails the forgot-password request even when the configured SMTP transport itself fails to send", async () => {
      const org = await registerUser("smtp-failure");
      const isConfiguredSpy = vi.spyOn(emailService, "isConfigured").mockReturnValue(true);
      const sendMailSpy = vi
        .spyOn(emailService, "sendMail")
        .mockRejectedValue(new Error("ECONNREFUSED: could not reach smtp.gmail.com"));

      const response = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email: org.email })
        .expect(200);
      const body = response.body as { data: { email: string; resetToken?: string; emailSent?: boolean } };
      expect(body.data.email).toBe(org.email);
      // The reset token is still issued and usable even though email delivery failed — the account
      // owner isn't locked out of resetting their password just because Gmail was unreachable.
      expect((body.data.resetToken ?? "").length).toBeGreaterThan(0);
      expect(body.data.emailSent).toBe(false);

      isConfiguredSpy.mockRestore();
      sendMailSpy.mockRestore();
    });
  });
});
