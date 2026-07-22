import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("separates process liveness from dependency readiness", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      connectorDefinition: { count: vi.fn().mockResolvedValue(2) }
    } as unknown as PrismaService;
    const controller = new HealthController(prisma);
    expect(controller.live()).toMatchObject({ status: "live" });
    await expect(controller.ready()).resolves.toMatchObject({
      status: "ready",
      checks: { database: "up", schema: "compatible" }
    });
  });

  it("fails readiness without exposing database details", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockRejectedValue(new Error("secret database detail"))
    } as unknown as PrismaService;
    await expect(new HealthController(prisma).ready()).rejects.toMatchObject({
      code: "PRODUCTION_CONFIGURATION_INVALID",
      message: "The application is not ready."
    });
  });
});
