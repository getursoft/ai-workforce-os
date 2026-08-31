/**
 * Sprint 6.3 — Conversational Intelligence, Identity Continuity & Customer Experience Hardening.
 *
 * Real runtime regression coverage driven against a real NestFactory app + real Postgres (via
 * TEST_DATABASE_URL) + the real HTTP surface (`POST /api/v1/agents/run`, the real ticket-PDF download
 * endpoint) — not a mock of business logic anywhere in this file.
 *
 * Part 12 — cross-employee identity continuity: Travel, HR, Finance, IT Support, Sales, Marketing, Legal,
 * Customer Support all receive the same Receptionist-captured customer name; none re-asks for it.
 *
 * Part 13 — regression items A-L (M/N — voice/WhatsApp response contract — are channel-presentation unit
 * tests, not reachable through the public HTTP API today; see conversational-response-policy.spec.ts and
 * receptionist-handoff-presentation.spec.ts for those):
 *   A-C. Receptionist -> {Travel, HR, Finance} -> identity transfer (subset of Part 12, asserted directly).
 *   D. Active Travel handoff + budget discussion does not reroute to Finance.
 *   E. An explicit domain switch away from an active handoff still works.
 *   F. Completed booking -> "share the pdf" returns the SAME booking's attachment.
 *   G. Completed booking -> "what is my PNR?" answers from stored booking data.
 *   H. Completed booking -> "what was the hotel?" answers from stored booking data.
 *   I. Completed booking -> "I want another trip" starts a fresh planning flow without touching the
 *      already-confirmed booking.
 *   J. Reloading the conversation (a fresh `GET` of its messages) still shows the booking-context answers.
 *   K. PDF attachment authorization: 401 unauthenticated, 200 authenticated.
 *   L. Cross-tenant PDF access remains blocked (a second organization's token gets 403/404).
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

const NAME_ASK_PATTERN = /may I know your name|what is your name|could you (?:please )?tell me your name/i;

suite("Sprint 6.3: conversational intelligence, identity continuity & customer experience hardening", () => {
  let app: INestApplication;
  let token: string;
  let organizationId: string;
  let receptionistId: string;

  async function register(orgSuffix: string) {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Sprint63 ${orgSuffix} ${Date.now()}`,
        firstName: "Owner",
        email: `sprint63-${orgSuffix}-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    return {
      token: registered.body.data.tokens.accessToken as string,
      organizationId: registered.body.data.organization.id as string
    };
  }

  async function install(authToken: string, pluginId: string) {
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ pluginId, configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    return installed.body.id as string;
  }

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    const registered = await register("main");
    token = registered.token;
    organizationId = registered.organizationId;
    receptionistId = await install(token, "receptionist-employee");
    await Promise.all(
      [
        "travel-employee",
        "hr-employee",
        "finance-employee",
        "it-support-employee",
        "sales-employee",
        "marketing-employee",
        "legal-employee",
        "customer-support-employee"
      ].map((slug) => install(token, slug))
    );
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  async function say(authToken: string, pluginInstallationId: string, message: string, conversationId?: string) {
    const response = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ pluginInstallationId, ...(conversationId ? { conversationId } : {}), message })
      .expect(201);
    return response.body as {
      response: string;
      conversationId: string;
      attachments?: Array<{ type: string; bookingId?: string; url?: string }>;
      receptionist?: { routeType: string; handoff: { targetDisplayName: string } | null };
    };
  }

  describe("Part 12: cross-employee identity continuity (no specialist re-asks for a name the Receptionist already captured)", () => {
    const cases: Array<{ label: string; trigger: string; targetDisplayName: string }> = [
      { label: "Travel", trigger: "I want to plan a trip to Dubai", targetDisplayName: "Travel Employee" },
      { label: "HR", trigger: "I need leave next week", targetDisplayName: "HR Employee" },
      { label: "Finance", trigger: "check this invoice", targetDisplayName: "Finance Employee" },
      { label: "IT Support", trigger: "my VPN is not working", targetDisplayName: "IT Support Employee" },
      { label: "Sales", trigger: "I need a quote for your product", targetDisplayName: "Sales Employee" },
      { label: "Marketing", trigger: "plan an email campaign", targetDisplayName: "Marketing Employee" },
      { label: "Legal", trigger: "review this contract", targetDisplayName: "Legal Employee" },
      { label: "Customer Support", trigger: "where is my order", targetDisplayName: "Customer Support Employee" }
    ];

    for (const { label, trigger, targetDisplayName } of cases) {
      it(`${label}: receives the Receptionist-captured name and never re-asks for it`, async () => {
        const askName = await say(token, receptionistId, trigger);
        expect(askName.response).toMatch(NAME_ASK_PATTERN);
        expect(askName.receptionist?.handoff).toBeNull();

        const handoff = await say(token, receptionistId, "Krishna", askName.conversationId);
        expect(handoff.receptionist?.handoff?.targetDisplayName).toBe(targetDisplayName);
        // The specialist's very first reply must never ask for the name again — it was just given.
        expect(handoff.response).not.toMatch(NAME_ASK_PATTERN);
      });
    }
  });

  describe("Part 13: regression suite", () => {
    let conversationId: string | undefined;
    let bookingId: string;
    let organizationIdForBooking: string;

    it("A-D, F-I: full booking flow — identity, active-handoff routing priority, post-booking PDF + Q&A, new-trip reset", async () => {
      organizationIdForBooking = organizationId;

      // A: Receptionist -> Travel -> identity transfer.
      const askName = await say(token, receptionistId, "I want to plan a trip to Dubai");
      expect(askName.response).toMatch(NAME_ASK_PATTERN);
      const handoff = await say(token, receptionistId, "Krishna", askName.conversationId);
      conversationId = handoff.conversationId;
      expect(handoff.receptionist?.handoff?.targetDisplayName).toBe("Travel Employee");
      expect(handoff.response).not.toMatch(NAME_ASK_PATTERN);

      const tripDetails = await say(
        token,
        receptionistId,
        "Dubai, 12 August 2026, 5 days, 3 adults, round trip, budget AED 100000, from Delhi",
        conversationId
      );
      expect(tripDetails.response).not.toMatch(NAME_ASK_PATTERN);

      // D: active Travel handoff + a budget question must NOT reroute to Finance.
      const budgetFollowUp = await say(
        token,
        receptionistId,
        "Can you show me options above my budget?",
        conversationId
      );
      expect(budgetFollowUp.receptionist?.handoff?.targetDisplayName).toBe("Travel Employee");
      expect(budgetFollowUp.receptionist?.routeType).toBe("CONTINUE_HANDOFF");

      await say(token, receptionistId, "book hotel and flight both", conversationId);
      await say(token, receptionistId, "Option 2", conversationId);
      await say(
        token,
        receptionistId,
        "1. Krishna Pandey, 34, Male; 2. Rekha Pandey, 31, Female; 3. Aarav Pandey, 6, Male",
        conversationId
      );
      await say(token, receptionistId, "share it here", conversationId);
      const confirmed = await say(token, receptionistId, "Confirm booking", conversationId);
      expect(confirmed.response).toMatch(/booking is confirmed/i);
      expect(confirmed.response).toMatch(/PNR/);
      expect(confirmed.attachments?.[0]?.type).toBe("PDF_TICKET");
      bookingId = confirmed.attachments![0]!.bookingId!;
      expect(bookingId).toBeTruthy();

      // F: "share the pdf" returns the SAME booking's attachment, never restarts planning.
      const sharePdf = await say(token, receptionistId, "share the pdf", conversationId);
      expect(sharePdf.attachments?.[0]?.bookingId).toBe(bookingId);
      expect(sharePdf.response).not.toMatch(/where would you like to travel|value, recommended, or premium/i);

      // G: "what is my PNR?" answers from stored booking data.
      const pnrAnswer = await say(token, receptionistId, "what is my PNR?", conversationId);
      expect(pnrAnswer.response).toMatch(/PNR is/i);
      expect(pnrAnswer.response).not.toMatch(/where would you like to travel/i);

      // H: "what was the hotel?" answers from stored booking data.
      const hotelAnswer = await say(token, receptionistId, "what was the hotel?", conversationId);
      expect(hotelAnswer.response).toMatch(/hotel/i);
      expect(hotelAnswer.response).not.toMatch(/where would you like to travel/i);

      // Farewell must use the REAL name, not a corrupted one derived from an earlier short reply
      // ("share it here"/"share the pdf") — the exact regression this session found and fixed.
      const thanks = await say(token, receptionistId, "thanks", conversationId);
      expect(thanks.response).toMatch(/krishna/i);
      expect(thanks.response).not.toMatch(/share it here|share the pdf/i);

      // I: "I want another trip" starts fresh planning — never re-asks the name, never re-offers to
      // book/adjust the OLD (already-confirmed) trip.
      const anotherTrip = await say(token, receptionistId, "I want another trip", conversationId);
      expect(anotherTrip.response).not.toMatch(NAME_ASK_PATTERN);
      expect(anotherTrip.response).not.toMatch(/go ahead and book this|adjust.*hotel, flights, budget/i);
      expect(anotherTrip.response).toMatch(/where would you like to go/i);
    }, 60_000);

    it("E: an explicit domain switch away from an active Travel handoff still works", async () => {
      let conv: string | undefined;
      const askName = await say(token, receptionistId, "I want to plan a trip to Singapore");
      const handoff = await say(token, receptionistId, "Krishna", askName.conversationId);
      conv = handoff.conversationId;
      expect(handoff.receptionist?.handoff?.targetDisplayName).toBe("Travel Employee");

      const switched = await say(token, receptionistId, "Forget the trip. I want to check my salary.", conv);
      expect(switched.receptionist?.handoff?.targetDisplayName).toBe("HR Employee");
    });

    it("J: reloading the conversation (fresh message fetch) still reflects the booking-context answers", async () => {
      expect(conversationId).toBeTruthy();
      const messages = await request(app.getHttpServer())
        .get(`/api/v1/conversations/${conversationId}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const items = (messages.body.items ?? messages.body) as Array<{ role: string; content: string }>;
      const assistantText = items
        .filter((message) => message.role === "ASSISTANT")
        .map((message) => message.content)
        .join("\n");
      expect(assistantText).toMatch(/PNR is/i);
      expect(assistantText).toMatch(/booking is confirmed/i);
    });

    it("K: PDF attachment authorization — 401 unauthenticated, 200 authenticated with real PDF bytes", async () => {
      expect(bookingId).toBeTruthy();
      await request(app.getHttpServer()).get(`/api/v1/travel/bookings/${bookingId}/ticket.pdf`).expect(401);
      const pdf = await request(app.getHttpServer())
        .get(`/api/v1/travel/bookings/${bookingId}/ticket.pdf`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(pdf.headers["content-type"]).toBe("application/pdf");
      const bytes = pdf.body as Buffer;
      expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    });

    it("L: cross-tenant PDF access remains blocked", async () => {
      expect(bookingId).toBeTruthy();
      const other = await register("other-tenant");
      const response = await request(app.getHttpServer())
        .get(`/api/v1/travel/bookings/${bookingId}/ticket.pdf`)
        .set("Authorization", `Bearer ${other.token}`);
      expect([403, 404]).toContain(response.status);
      expect(other.organizationId).not.toBe(organizationIdForBooking);
    });
  });
});
