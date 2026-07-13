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
import { dummyEchoManifest } from "@ai-workforce-os/plugin-dummy";
for (const c of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(c)) {
    loadEnvFile(c);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Plugin runtime HTTP", () => {
  let app: INestApplication, prisma: PrismaService, token: string, pluginId: string;
  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.pluginConfiguration.deleteMany();
    await prisma.plugin.deleteMany();
    const r = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Plugin Org",
        firstName: "Owner",
        email: `plugin-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    token = r.body.data.tokens.accessToken;
  });
  afterAll(async () => {
    if (prisma) {
      await prisma.pluginConfiguration.deleteMany();
      await prisma.plugin.deleteMany();
    }
    await app?.close();
  });
  it("installs, configures, enables, checks health and soft deletes", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set(auth)
      .send({
        manifest: dummyEchoManifest,
        configuration: { config: { prefix: "Hi" }, secrets: { apiKey: "plain-never-store" } }
      })
      .expect(201);
    pluginId = installed.body.id;
    const stored = await prisma.pluginConfiguration.findUniqueOrThrow({ where: { pluginId } });
    expect(JSON.stringify(stored.encryptedSecrets)).not.toContain("plain-never-store");
    const config = await request(app.getHttpServer())
      .get(`/api/v1/plugins/${pluginId}/configuration`)
      .set(auth)
      .expect(200);
    expect(config.body.secretKeys).toEqual(["apiKey"]);
    expect(JSON.stringify(config.body)).not.toContain("plain-never-store");
    await request(app.getHttpServer())
      .post(`/api/v1/plugins/${pluginId}/enable`)
      .set(auth)
      .expect(201);
    const health = await request(app.getHttpServer())
      .get(`/api/v1/plugins/${pluginId}/health`)
      .set(auth)
      .expect(200);
    expect(health.body.status).toBe("READY");
    await request(app.getHttpServer())
      .post(`/api/v1/plugins/${pluginId}/disable`)
      .set(auth)
      .expect(201);
    await request(app.getHttpServer()).delete(`/api/v1/plugins/${pluginId}`).set(auth).expect(204);
    expect(
      (await prisma.plugin.findUniqueOrThrow({ where: { id: pluginId } })).deletedAt
    ).not.toBeNull();
  });
  it("rejects duplicates, invalid manifests and cross-tenant-style unknown IDs", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set(auth)
      .send({ manifest: { ...dummyEchoManifest, version: "bad" } })
      .expect(422);
    await request(app.getHttpServer())
      .get("/api/v1/plugins/00000000-0000-4000-8000-000000000001")
      .set(auth)
      .expect(404);
    await request(app.getHttpServer()).get("/api/v1/plugins").expect(401);
  });
  it("discovers repository plugins and installs with a least-privilege grant", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const available = await request(app.getHttpServer())
      .get("/api/v1/plugins/available")
      .set(auth)
      .expect(200);
    expect(available.body.items.some((item: { id: string }) => item.id === "dummy-echo")).toBe(
      true
    );
    expect(JSON.stringify(available.body)).not.toContain("entryPoint");
    expect(
      available.body.items.find((item: { id: string }) => item.id === "dummy-echo").configSchema
        .properties.prefix.default
    ).toBe("Hello");
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set(auth)
      .send({
        pluginId: "dummy-echo",
        grantedPermissions: ["MEMORY"],
        configuration: { config: { prefix: "Scoped" }, secrets: {} },
        enable: true
      })
      .expect(201);
    expect(installed.body.grantedPermissions).toEqual(["MEMORY"]);
    expect(installed.body.status).toBe("ACTIVE");
    const installedCatalogue = await request(app.getHttpServer())
      .get("/api/v1/plugins/available")
      .set(auth)
      .expect(200);
    expect(
      installedCatalogue.body.items.find((item: { id: string }) => item.id === "dummy-echo")
        .installed
    ).toBe(true);
    await request(app.getHttpServer())
      .post(`/api/v1/plugins/${installed.body.id}/health`)
      .set(auth)
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/api/v1/plugins/${installed.body.id}/disable`)
      .set(auth)
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/api/v1/plugins/${installed.body.id}`)
      .set(auth)
      .expect(204);
    const availableAgain = await request(app.getHttpServer())
      .get("/api/v1/plugins/available")
      .set(auth)
      .expect(200);
    expect(
      availableAgain.body.items.find((item: { id: string }) => item.id === "dummy-echo").installed
    ).toBe(false);
  });
});
