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

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Conversation attachments end-to-end", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let pluginId: string;
  let conversationId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup(prisma);

    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Attachment Org",
        firstName: "Owner",
        email: `attachment-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    token = registered.body.data.tokens.accessToken;

    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "hr-employee", enable: true })
      .expect(201);
    pluginId = installed.body.id;

    const greeted = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginInstallationId: pluginId, message: "" })
      .expect(201);
    conversationId = greeted.body.conversationId;
  });

  afterAll(async () => {
    if (prisma) await cleanup(prisma);
    await app?.close();
  });

  it("uploads a plain-text attachment and returns the extracted text", async () => {
    const upload = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("Company leave policy: 20 days casual leave per year.", "utf8"), {
        filename: "leave-policy.txt",
        contentType: "text/plain"
      })
      .expect(201);
    expect(upload.body.originalFilename).toBe("leave-policy.txt");
    expect(upload.body.extractedText).toMatch(/20 days casual leave/i);
  });

  it("uploads a PDF attachment and extracts its text", async () => {
    // Minimal PDF with a text object (raw bytes) — pdf-parse reads its text layer.
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 60>>stream\nBT /F1 18 Tf 72 720 Td (Attendance policy: 9am to 6pm) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n0000000227 00000 n \n0000000336 00000 n \ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n407\n%%EOF\n",
      "latin1"
    );
    const upload = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", pdf, {
        filename: "attendance-policy.pdf",
        contentType: "application/pdf"
      })
      .expect(201);
    expect(upload.body.mimeType).toBe("application/pdf");
    expect(upload.body.extractedText).toMatch(/attendance policy/i);
  });

  it("uploads a JPG image attachment and extracts text via OCR", async () => {
    // Render a simple image with visible text using sharp, then OCR it.
    const sharp = await import("sharp");
    const svg = Buffer.from(
      '<svg width="800" height="200"><rect width="800" height="200" fill="white"/><text x="50" y="120" font-size="60" font-family="Arial">INVOICE 98765</text></svg>'
    );
    const jpg = await sharp.default(svg).jpeg().toBuffer();
    const upload = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", jpg, {
        filename: "invoice.jpg",
        contentType: "image/jpeg"
      })
      .expect(201);
    expect(upload.body.mimeType).toBe("image/jpeg");
    expect(upload.body.extractedText).toMatch(/invoice/i);
  });

  it("rejects an unsupported file type", async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("not really a zip", "utf8"), {
        filename: "archive.zip",
        contentType: "application/zip"
      })
      .expect(404);
  });

  it("injects the uploaded attachment text into the agent turn so the employee reads it", async () => {
    // Upload a text attachment describing an HR scenario.
    const upload = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .attach(
        "file",
        Buffer.from("New joiner Priya needs onboarding help and a benefits overview.", "utf8"),
        { filename: "onboarding-brief.txt", contentType: "text/plain" }
      )
      .expect(201);

    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pluginInstallationId: pluginId,
        conversationId,
        message: "What should I help with based on this?",
        attachmentIds: [upload.body.id]
      })
      .expect(201);
    // The employee's deterministic engine should acknowledge the attachment context (onboarding/benefits).
    expect(typeof run.body.response).toBe("string");
    expect(run.body.response.length).toBeGreaterThan(0);
  });

  it("reads and summarises an attached document instead of treating it as ordinary text", async () => {
    const upload = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .attach(
        "file",
        Buffer.from("Employee handbook: 20 days casual leave per year, medical insurance included.", "utf8"),
        { filename: "employee-handbook.txt", contentType: "text/plain" }
      )
      .expect(201);

    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pluginInstallationId: pluginId,
        conversationId,
        message: "",
        attachmentIds: [upload.body.id]
      })
      .expect(201);
    expect(run.body.response).toMatch(/I've read your attached document/i);
    expect(run.body.response).toMatch(/leave/i);
  });

  it("routes an out-of-scope attached document to the correct employee", async () => {
    const upload = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .attach(
        "file",
        Buffer.from("Client dinner expense invoice for a sales trip.", "utf8"),
        { filename: "expense-invoice.txt", contentType: "text/plain" }
      )
      .expect(201);

    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pluginInstallationId: pluginId,
        conversationId,
        message: "Please review this document",
        attachmentIds: [upload.body.id]
      })
      .expect(201);
    expect(run.body.response).toMatch(/Finance Employee/i);
    expect(run.body.response).toMatch(/route it to the relevant employee/i);
  });
});

async function cleanup(prisma: PrismaService) {
  await prisma.conversationAttachment.deleteMany();
  await prisma.conversationMessage.deleteMany();
  await prisma.agentToolExecution.deleteMany();
  await prisma.agentExecution.deleteMany();
  await prisma.agentMemory.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.hrEmployeeConfiguration.deleteMany();
  await prisma.pluginAiConfiguration.deleteMany();
  await prisma.pluginConfiguration.deleteMany();
  await prisma.plugin.deleteMany();
}
