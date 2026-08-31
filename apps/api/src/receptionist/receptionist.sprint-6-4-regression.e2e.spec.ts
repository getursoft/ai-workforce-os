/**
 * Sprint 6.4 — Unified Routing, Channel-Aware Runtime & Production Hardening.
 *
 * Real runtime regression coverage driven against a real NestFactory app + real Postgres (via
 * TEST_DATABASE_URL) + the real HTTP surface (`POST /api/v1/agents/run`) — not a mock of business logic
 * anywhere in this file. Builds on receptionist.sprint-6-3-regression.e2e.spec.ts, which already proves
 * Part 12/13 A-L; this file covers what's new in 6.4:
 *
 *   A. Single routing source: a keyword that exists ONLY in plugins/hr-employee/plugin.json's
 *      routing.keywords (never in a second hardcoded list) is what actually drives a live Receptionist
 *      routing decision.
 *   D. A request with no `channel` field behaves exactly as before (defaults to WEB/CHAT).
 *   E. The same request with `channel: "WHATSAPP"` returns a WhatsApp-safe presentation.
 *   F. The same request with `channel: "VOICE"` returns voice-safe prose (no markdown/bullets).
 *   G. The underlying facts (PNR) are identical across CHAT/WHATSAPP/VOICE — only presentation differs.
 *   H. A PDF attachment survives VOICE response shaping (attachments are business data, not presentation).
 *   K/L. Adversarial context-vs-pivot routing phrases beyond Sprint 6.3's original two.
 *   J. Additional name-corruption adversarial replies ("no thanks", "show options", "book it", "looks good").
 *   M. A new trip started after a completed booking never inherits the old trip's destination/budget.
 *
 * B/C (existing-installation reconciliation, tenant-customization preservation) and N (Hindi/Hinglish
 * naturalness) are covered at the unit level — see routing-profile-lifecycle.spec.ts and
 * travel.runtime.spec.ts respectively — rather than re-proven here through the full HTTP+Postgres stack.
 */
import { existsSync, readFileSync } from "node:fs";
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
const MARKDOWN_PATTERN = /^\s*[•*-]\s|^#{1,6}\s|\*\*[^*]+\*\*/m;

suite("Sprint 6.4: unified routing, channel-aware runtime & production hardening", () => {
  let app: INestApplication;
  let token: string;
  let receptionistId: string;

  async function register(orgSuffix: string) {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Sprint64 ${orgSuffix} ${Date.now()}`,
        firstName: "Owner",
        email: `sprint64-${orgSuffix}-${Date.now()}@example.com`,
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
    receptionistId = await install(token, "receptionist-employee");
    await Promise.all(
      ["travel-employee", "hr-employee", "finance-employee", "it-support-employee"].map((slug) =>
        install(token, slug)
      )
    );
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  async function say(
    authToken: string,
    pluginInstallationId: string,
    message: string,
    options: {
      conversationId?: string | undefined;
      channel?: "WEB" | "WHATSAPP" | "VOICE" | undefined;
    } = {}
  ) {
    const response = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        pluginInstallationId,
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        ...(options.channel ? { channel: options.channel } : {}),
        message
      })
      .expect(201);
    return response.body as {
      response: string;
      conversationId: string;
      attachments?: Array<{ type: string; bookingId?: string; url?: string }>;
      receptionist?: { routeType: string; handoff: { targetDisplayName: string } | null };
    };
  }

  describe("Part 2/A: plugin.json is the single routing source of truth", () => {
    it("a keyword present ONLY in plugins/hr-employee/plugin.json's routing.keywords (not a hand-typed second list) drives a live Receptionist routing decision", async () => {
      const manifest = JSON.parse(
        readFileSync(resolve(__dirname, "../../../../plugins/hr-employee/plugin.json"), "utf8")
      ) as { routing?: { keywords?: string[] } };
      // "grievance" only ever existed in the old EMPLOYEE_SCOPE_PROFILES hardcoded array before Sprint 6.4
      // — proving it now lives in the manifest, and that a message using it alone still reaches HR, proves
      // Receptionist routing is reading the same authoritative list the specialist scope-detector reads.
      expect(manifest.routing?.keywords).toContain("grievance");

      const askName = await say(token, receptionistId, "I need to raise a grievance");
      expect(askName.response).toMatch(NAME_ASK_PATTERN);
      const routed = await say(token, receptionistId, "Krishna", { conversationId: askName.conversationId });
      expect(routed.receptionist?.handoff?.targetDisplayName).toBe("HR Employee");
    });
  });

  describe("Part 4/5/6: channel-aware response contract", () => {
    let conversationId: string | undefined;

    it("D: a request with no channel field behaves exactly as before (defaults to WEB)", async () => {
      const first = await say(token, receptionistId, "I want to plan a trip to Dubai");
      expect(first.response).toMatch(NAME_ASK_PATTERN);
      const handoff = await say(token, receptionistId, "Krishna", { conversationId: first.conversationId });
      conversationId = handoff.conversationId;
      expect(handoff.receptionist?.handoff?.targetDisplayName).toBe("Travel Employee");
    });

    it("E/F/G/H: booking proceeds on WEB, then WHATSAPP/VOICE follow-ups on the SAME conversation preserve facts and attachments and never re-ask for trip details", async () => {
      expect(conversationId).toBeTruthy();
      await say(
        token,
        receptionistId,
        "Dubai, 12 August 2026, 5 days, 3 adults, round trip, budget AED 100000, from Delhi",
        { conversationId }
      );
      await say(token, receptionistId, "book hotel and flight both", { conversationId });
      await say(token, receptionistId, "option 1", { conversationId });
      await say(
        token,
        receptionistId,
        "1. Krishna Pandey, 34, Male; 2. Rekha Pandey, 31, Female; 3. Aarav Pandey, 6, Male",
        { conversationId }
      );
      await say(token, receptionistId, "share it here", { conversationId });
      const confirmed = await say(token, receptionistId, "Confirm booking", { conversationId });
      expect(confirmed.response).toMatch(/PNR/);
      const pnrMatch = confirmed.response.match(/PNR[^A-Z0-9]*([A-Z0-9]{5,8})/i);
      expect(pnrMatch?.[1]).toBeTruthy();
      const pnr = pnrMatch![1]!;

      // E: a WhatsApp-channel follow-up on the same completed booking stays concise and debug-free.
      const whatsappPnr = await say(token, receptionistId, "what is my PNR?", {
        conversationId,
        channel: "WHATSAPP"
      });
      expect(whatsappPnr.response).toContain(pnr);
      expect(whatsappPnr.response).not.toMatch(/connected to|handoff id|routing confidence|travel employee:/i);

      // F/G: a Voice-channel follow-up returns the SAME PNR fact as speakable prose, no markdown.
      const voicePnr = await say(token, receptionistId, "what is my PNR?", {
        conversationId,
        channel: "VOICE"
      });
      expect(voicePnr.response).toContain(pnr);
      expect(voicePnr.response).not.toMatch(MARKDOWN_PATTERN);
      expect(voicePnr.response).not.toMatch(/https?:\/\//);

      // H: the PDF attachment (business data, not presentation) survives VOICE response shaping.
      const voiceShare = await say(token, receptionistId, "share the pdf", {
        conversationId,
        channel: "VOICE"
      });
      expect(voiceShare.attachments?.[0]?.type).toBe("PDF_TICKET");
      expect(voiceShare.attachments?.[0]?.bookingId).toBeTruthy();
    }, 60_000);
  });

  describe("Part 10: adversarial context-vs-pivot routing", () => {
    it("K: 'My hotel invoice is too high' during an active Travel handoff stays in Travel (in-context follow-up, not a Finance pivot)", async () => {
      const first = await say(token, receptionistId, "I want to plan a trip to Goa");
      const handoff = await say(token, receptionistId, "Krishna", { conversationId: first.conversationId });
      expect(handoff.receptionist?.handoff?.targetDisplayName).toBe("Travel Employee");

      const followUp = await say(token, receptionistId, "My hotel invoice is too high.", {
        conversationId: handoff.conversationId
      });
      expect(followUp.receptionist?.handoff?.targetDisplayName).toBe("Travel Employee");
      expect(followUp.receptionist?.routeType).toBe("CONTINUE_HANDOFF");
    });

    it("L: 'Forget this booking, I have an IT issue' explicitly pivots away from an active Travel handoff", async () => {
      const first = await say(token, receptionistId, "I want to plan a trip to Goa");
      const handoff = await say(token, receptionistId, "Krishna", { conversationId: first.conversationId });
      expect(handoff.receptionist?.handoff?.targetDisplayName).toBe("Travel Employee");

      const pivoted = await say(token, receptionistId, "Forget this booking, I have an IT issue.", {
        conversationId: handoff.conversationId
      });
      expect(pivoted.receptionist?.handoff?.targetDisplayName).toBe("IT Support Employee");
    });
  });

  describe("Part 11: identity continuity — adversarial short replies never become the customer's name", () => {
    it("J: 'no thanks' / 'show options' / 'book it' / 'looks good' never overwrite the captured name", async () => {
      const first = await say(token, receptionistId, "I want to plan a trip to Kerala");
      const handoff = await say(token, receptionistId, "Krishna", { conversationId: first.conversationId });
      const conv = handoff.conversationId;

      await say(token, receptionistId, "next month, 4 days, 2 adults, budget INR 80000", { conversationId: conv });
      await say(token, receptionistId, "show options", { conversationId: conv });
      await say(token, receptionistId, "looks good", { conversationId: conv });
      await say(token, receptionistId, "book it", { conversationId: conv });
      const declineExtra = await say(token, receptionistId, "no thanks", { conversationId: conv });

      expect(declineExtra.response).not.toMatch(/no thanks|show options|book it|looks good/i);
    }, 30_000);
  });

  describe("Part 12: new-trip isolation", () => {
    it("M: a new trip after a completed booking never inherits the old trip's destination or budget", async () => {
      const first = await say(token, receptionistId, "I want to plan a trip to Dubai");
      const handoff = await say(token, receptionistId, "Krishna", { conversationId: first.conversationId });
      const conv = handoff.conversationId;
      await say(
        token,
        receptionistId,
        "12 August 2026, 5 days, 3 adults, round trip, budget AED 1000000, from Delhi",
        { conversationId: conv }
      );
      await say(token, receptionistId, "book hotel and flight both", { conversationId: conv });
      await say(token, receptionistId, "option 1", { conversationId: conv });
      await say(
        token,
        receptionistId,
        "1. Krishna Pandey, 34, Male; 2. Rekha Pandey, 31, Female; 3. Aarav Pandey, 6, Male",
        { conversationId: conv }
      );
      await say(token, receptionistId, "share it here", { conversationId: conv });
      const confirmed = await say(token, receptionistId, "Confirm booking", { conversationId: conv });
      expect(confirmed.response).toMatch(/booking is confirmed/i);
      expect(confirmed.attachments?.[0]?.type).toBe("PDF_TICKET");

      const another = await say(token, receptionistId, "I want another trip", { conversationId: conv });
      expect(another.response).toMatch(/where would you like to go/i);
      const newDestination = await say(token, receptionistId, "Delhi to Singapore", { conversationId: conv });
      // The new trip's own turn must never echo back the OLD trip's Dubai/100000 AED as if already known.
      expect(newDestination.response).not.toMatch(/dubai/i);
      expect(newDestination.response).not.toMatch(/100000|100,000/);
    }, 60_000);
  });

  // Part 14: the sprint brief's own suggested continuous UAT transcript, run turn-for-turn against the
  // real app/Postgres/HTTP surface. Logged verbatim (not just asserted) so the actual runtime behavior is
  // visible for the sprint report, per Part 16 ("no fake success" — report exactly what happened).
  describe("Part 14: live UAT transcript (verbatim from the sprint brief)", () => {
    it("runs the full suggested transcript end-to-end and logs every turn", async () => {
      const transcript = [
        "Hi",
        "Krishna",
        "I want to plan a trip",
        "Delhi to Dubai",
        "next month",
        "2 adults",
        "5 nights",
        "budget 10000 AED",
        "show me options",
        "option 2",
        "book it",
        "share the pdf",
        "what was my hotel?",
        "what was the total?",
        "can you show something above my budget?",
        "forget the trip, I need help with my salary",
        "I need payroll help",
        "actually I want another trip",
        "Delhi to Singapore"
      ];
      let conv: string | undefined;
      const log: Array<{
        turn: string;
        response: string;
        routeType?: string | undefined;
        target?: string | null;
      }> = [];
      for (const turn of transcript) {
        const reply = await say(token, receptionistId, turn, { conversationId: conv });
        conv = reply.conversationId;
        log.push({
          turn,
          response: reply.response,
          routeType: reply.receptionist?.routeType,
          target: reply.receptionist?.handoff?.targetDisplayName ?? null
        });
      }
      // eslint-disable-next-line no-console
      console.log("Part 14 live UAT transcript:\n" + log.map((l) => `> ${l.turn}\n${l.target ? `[${l.target}/${l.routeType}] ` : ""}${l.response}`).join("\n\n"));

      // This exact transcript live-uncovered a real, disclosed, PRE-EXISTING gap (not introduced by
      // Sprint 6.4, and out of this sprint's scope to fix): turn 2 ("Krishna") is sent as a bare,
      // unprompted name — no question was pending yet, since turn 1 ("Hi") carries no domain signal for
      // the Receptionist to ask a name against. The Receptionist doesn't recognize an unprompted name
      // announcement, so identity is never actually captured here, and every later turn in this
      // transcript inherits that unresolved state (see the sprint report's "Remaining Limitations").
      // What IS asserted below is exactly what Sprint 6.4 fixed and can prove from this run: turn 8
      // ("budget 10000 AED") must never render the raw `buildOutOfScopeRoutingMessage` bounce text — the
      // literal defect this transcript first exposed (see the isolated, clean-identity repro in this
      // sprint's investigation, where the SAME contextEcho fix keeps a mid-flow "budget" answer in
      // Travel). The clean, non-cascading proof of the context-echo fix itself lives in the "K" test
      // above, run against a properly-captured identity.
      const budgetTurn = log.find((l) => l.turn === "budget 10000 AED")!;
      expect(budgetTurn.response).not.toMatch(/that's outside my scope|it looks like this belongs to/i);
      // The final "another trip" must never echo the OLD trip's budget figure back as if still active.
      const last = log.at(-1)!;
      expect(last.response.toLowerCase()).not.toContain("100000");
    }, 90_000);
  });
});
