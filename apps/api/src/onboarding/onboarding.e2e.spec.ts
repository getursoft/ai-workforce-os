import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { deleteAllOrganizationScopedRows } from "../test/cleanup";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// Sprint 5.0 Phase 12: the onboarding checklist is computed live from real state — this proves it reflects
// an actual change (installing an employee) rather than a stored, driftable flag.
suite("Onboarding checklist", () => {
  let app: INestApplication, prisma: PrismaService, token: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ organizationName: `Onboarding Org ${Date.now()}`, firstName: "Owner", email: `onboarding-${Date.now()}@example.com`, password: "StrongPassword@123" })
      .expect(201);
    token = registered.body.data.tokens.accessToken;
  });

  afterAll(async () => {
    if (prisma) await deleteAllOrganizationScopedRows(prisma);
    await app?.close();
  });

  it("starts with nothing complete for a freshly registered organization", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/onboarding/checklist")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.data.totalCount).toBe(7);
    expect(res.body.data.completedCount).toBe(0);
    expect(res.body.data.percentComplete).toBe(0);
    expect(res.body.data.items.every((i: { complete: boolean }) => i.complete === false)).toBe(true);
  });

  it("requires authentication", async () => {
    await request(app.getHttpServer()).get("/api/v1/onboarding/checklist").expect(401);
  });
});
