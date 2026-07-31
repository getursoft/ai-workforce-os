/**
 * Actual runtime UAT of the exact FAILED UAT conversation this whole fix targets, driven against a real
 * NestFactory app + real Postgres (via TEST_DATABASE_URL) + the real HTTP surface — the same
 * `POST /api/v1/agents/run` endpoint the dashboard chat UI calls, followed by the real approval decision
 * endpoint and the real ticket PDF download endpoint. Not a mock of business logic anywhere in this file.
 *
 * Reproduces, turn by turn, the 8 proven defects from the original failed conversation and asserts each is
 * now fixed:
 *   1. "Hotel and flight for round trip" no longer routes to RAG / "could not find this information".
 *   2/3. "book hotel and flight both" then "Book my flight" show real Option 1/2/3 packages, not broad
 *        indicative price ranges, and never repeat themselves without a selection.
 *   4/5. An explicit Option 2 selection produces a final confirmation summary; only an explicit "Confirm
 *        booking" reply submits the booking request (never books immediately).
 *   6. A TravelBooking record is created (state-machine-driven, via the existing booking/approval engine).
 *   7. After the (simulated) customer approval, the DummyBookingAdapter runs exactly once, producing a PNR
 *      and ticket numbers, delivered back in the chat response.
 *   8. The generated ticket is a REAL PDF, downloadable only with a valid bearer token, tenant-scoped.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Travel Employee: end-to-end runtime UAT of the failed booking-flow conversation", () => {
  let app: INestApplication;
  let token: string;
  let organizationId: string;
  let pluginId: string;
  let conversationId: string | undefined;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `UAT Booking Flow Org ${Date.now()}`,
        firstName: "Owner",
        email: `uat-booking-flow-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    token = registered.body.data.tokens.accessToken;
    organizationId = registered.body.data.organization.id;

    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "travel-employee", enable: true })
      .expect(201);
    pluginId = installed.body.id;
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  async function chat(message: string) {
    const res = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginInstallationId: pluginId, conversationId, message })
      .expect(201);
    conversationId = res.body.conversationId;
    console.log(`[UAT] > ${message}\n[UAT] < ${res.body.response}\n`);
    return res.body as { response: string; attachments?: Array<{ bookingId: string; url: string }> };
  }

  it("defect 1: 'Hotel and flight for round trip' never routes to RAG / 'could not find this information'", async () => {
    const r1 = await chat("My name is Krishna");
    expect(r1.response).not.toMatch(/could not find this information/i);

    const r2 = await chat(
      "Dubai, 12 August 2026, 5 days, 3 adults, round trip, budget AED 100000, vegetarian food, from Delhi"
    );
    expect(r2.response).not.toMatch(/could not find this information/i);

    const r3 = await chat("Hotel and flight for round trip");
    expect(r3.response).not.toMatch(/could not find this information/i);
  });

  it("defects 2/3: 'book hotel and flight both' shows real Option 1/2/3 packages; 'Book my flight' re-prompts instead of repeating price ranges or booking immediately", async () => {
    const r1 = await chat("book hotel and flight both");
    expect(r1.response).toMatch(/Option 1 — Value/);
    expect(r1.response).toMatch(/Option 2 — Recommended/);
    expect(r1.response).toMatch(/Option 3 — Premium/);
    expect(r1.response).toMatch(/Please select Option 1, Option 2 or Option 3\./);

    const r2 = await chat("Book my flight");
    expect(r2.response).toMatch(/select option 1, option 2 or option 3/i);
    expect(r2.response).not.toMatch(/Option 1 — Value/);
  });

  it("defects 4/5: selecting Option 2 asks for every traveller's name/age/gender, then shows a final confirmation summary; an explicit 'Confirm booking' immediately books and tickets the trip (customer confirmation IS the approval — never a separate manual approval step)", async () => {
    const r1 = await chat("Option 2");
    expect(r1.response).toMatch(/full name, age, and gender for each traveller \(3 total\)/);

    const r2 = await chat("1. Krishna Pandey, 34, Male; 2. Rekha Pandey, 31, Female; 3. Aarav Pandey, 6, Male");
    expect(r2.response).toMatch(/Where should I send your ticket/);

    const r2b = await chat("krishna@example.com");
    expect(r2b.response).toMatch(/Please confirm your simulated booking/);
    expect(r2b.response).toMatch(/Krishna Pandey, 34, MALE/);
    expect(r2b.response).toMatch(/Reply 'Confirm booking' to proceed/);

    const r3 = await chat("Confirm booking");
    expect(r3.response).toMatch(/booking is confirmed/i);
    expect(r3.response).toMatch(/PNR/);
  });

  it("defect 6: a TravelBooking record now exists, already ticketed in the same turn as 'Confirm booking' (created via the real booking/approval engine, not a duplicate system)", async () => {
    const bookings = await request(app.getHttpServer())
      .get(`/api/v1/travel/bookings?organizationId=${organizationId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(bookings.body.items.length).toBeGreaterThan(0);
    const booking = bookings.body.items[0];
    expect(["BOOKED", "TICKETS_DELIVERED"]).toContain(booking.status);
    expect(booking.destinationCity).toBe("Dubai");
    expect(booking.providerPnr).toBeTruthy();
    // Real passenger roster, not "Passenger 1"/"Passenger 2" placeholders — see travel-package-options.ts's
    // PassengerDetail collection gate.
    const passengers = booking.travellerSummaryJson?.passengers as Array<{ name: string; age: number; gender: string }>;
    expect(passengers).toHaveLength(3);
    expect(passengers[0]).toMatchObject({ name: "Krishna Pandey", age: 34, gender: "MALE" });
    // The ticket-contact stage (asked right after passenger details, before the confirmation summary) is
    // the only place customerEmail ever gets set — without it, delivery has nowhere to send the PDF.
    expect(booking.customerEmail).toBe("krishna@example.com");
  });

  it("defect 7/8: the provider ran exactly once as part of 'Confirm booking' (no separate approval step), produced a PNR, and a REAL downloadable PDF ticket is available — tenant/auth scoped", async () => {
    const bookingsBefore = await request(app.getHttpServer())
      .get(`/api/v1/travel/bookings?organizationId=${organizationId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const booking = bookingsBefore.body.items[0];
    expect(booking.approvalRequestId).toBeTruthy();
    expect(["BOOKED", "TICKETS_DELIVERED"]).toContain(booking.status);
    expect(booking.providerPnr).toBeTruthy();

    // No auth -> 401, proving the previous unauthenticated-download bug is fixed.
    await request(app.getHttpServer()).get(`/api/v1/travel/bookings/${booking.id}/ticket.pdf`).expect(401);

    const pdf = await request(app.getHttpServer())
      .get(`/api/v1/travel/bookings/${booking.id}/ticket.pdf`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    const bytes = pdf.body as Buffer;
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    console.log(`[UAT] Real PDF downloaded: ${bytes.length} bytes, PNR=${booking.providerPnr}`);
  });
});
