import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { ReminderComposer } from "./reminder-composer";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("ReminderComposer (autonomous decision + memory dedup)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let composer: ReminderComposer;
  let orgId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    await app.init();
    prisma = app.get(PrismaService);
    composer = app.get(ReminderComposer);
    await prisma.memoryRecord.deleteMany();
    const res = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Composer Org",
        firstName: "Owner",
        email: `composer-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    orgId = res.body.data.organization.id;
  });

  afterAll(async () => {
    if (prisma) await prisma.memoryRecord.deleteMany();
    await app?.close();
  });

  it("decides SEND for a fresh reminder and composes a contextual message", async () => {
    const decision = await composer.decide({
      organizationId: orgId,
      employeeId: null,
      definitionKey: "travel.reminder.pre_travel",
      kind: "travel.pre_travel",
      entityId: "booking-42",
      recipientName: "Krishna",
      payload: { travelDates: "12-15 Aug", destinationCity: "London" }
    });
    expect(decision.shouldSend).toBe(true);
    expect(decision.reason).toBe("SEND");
    expect(decision.message).toContain("Hi Krishna");
    expect(decision.message).toContain("London");
  });

  it("never sends the same reminder for the same entity twice (memory dedup)", async () => {
    const base = {
      organizationId: orgId,
      employeeId: null,
      definitionKey: "travel.reminder.approval_pending",
      kind: "travel.approval_pending",
      entityId: "approval-7",
      payload: {}
    };
    const first = await composer.decide(base);
    expect(first.shouldSend).toBe(true);
    await composer.markSent(base, first.dedupeKey);
    const second = await composer.decide(base);
    expect(second.shouldSend).toBe(false);
    expect(second.reason).toBe("ALREADY_SENT");
  });

  it("skips when the entity is already resolved", async () => {
    const decision = await composer.decide({
      organizationId: orgId,
      employeeId: null,
      definitionKey: "travel.reminder.booking_reminder",
      kind: "travel.booking_reminder",
      entityId: "booking-resolved",
      entityStatus: "RESOLVED",
      payload: {}
    });
    expect(decision.shouldSend).toBe(false);
    expect(decision.reason).toBe("ENTITY_RESOLVED");
  });

  it("respects business hours (OUTSIDE_BUSINESS_HOURS outside the window)", async () => {
    // Compute a UTC window that starts 2 minutes in the future and lasts 1 minute — the current
    // instant is never inside it, so the reminder is always gated regardless of wall-clock time.
    const now = new Date();
    const minutesOfDay = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;
    const start = (Math.floor(minutesOfDay) + 2) % (24 * 60);
    const end = (start + 1) % (24 * 60);
    const startTime = `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
    const endTime = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
    const decision = await composer.decide({
      organizationId: orgId,
      employeeId: null,
      definitionKey: "finance.reminder.invoice",
      kind: "finance.invoice",
      entityId: "invoice-1",
      businessHours: { timezone: "UTC", start: startTime, end: endTime },
      payload: {}
    });
    expect(decision.shouldSend).toBe(false);
    expect(decision.reason).toBe("OUTSIDE_BUSINESS_HOURS");
  });
});
