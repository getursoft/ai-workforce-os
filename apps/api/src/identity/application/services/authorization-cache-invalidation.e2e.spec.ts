/**
 * Krevia Phase 5.1 — Authorization cache invalidation audit.
 *
 * Krevia_Sprint_7.17_Export_Revocation_UAT flagged this as a residual risk: "the existing 5-minute
 * AuthorizationService permission cache may retain stale authorization if a future revocation path
 * bypasses ManagementService." Tracing every permission-revocation / organization-membership-removal path
 * in the repository (see the matching report's cache-invalidation inventory) found that ManagementService
 * IS already the sole authoritative mutation boundary for Role/UserRole/RolePermission/User.status writes
 * (grepped for every other prisma.userRole/rolePermission/role mutation and prisma.user.update with a
 * status change outside this file — there are none in production code) — with exactly one gap inside that
 * boundary itself: updateUser() could flip a user's status (e.g. ACTIVE -> SUSPENDED) without calling
 * AuthorizationService.invalidateUser, unlike every sibling mutation in this file. Fixed in
 * management.service.ts's updateUser(). This file proves, against the REAL cache (not a mock), that every
 * revocation path now clears stale authorization IMMEDIATELY — not merely "eventually, after the 5-minute
 * TTL expires," which a less careful test could mistake for success.
 *
 * Real NestFactory app + real Postgres (TEST_DATABASE_URL only), synthetic data, cleaned up after.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { UserStatus } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../../app.module";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { AuthorizationService } from "./authorization.service";
import { ManagementService } from "./management.service";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Phase 5.1 — authorization cache invalidation on every revocation path", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authorization: AuthorizationService;
  let management: ManagementService;

  let orgId: string;
  let ownerId: string;
  const createdOrgIds: string[] = [];

  async function freshUserWithPermission(permissionKey: string) {
    const email = `cache-audit-${randomUUID()}@example.invalid`;
    const user = await prisma.user.create({
      data: { organizationId: orgId, firstName: "Cache", lastName: "Audit", email, normalizedEmail: email, passwordHash: "not-a-real-hash", role: "MEMBER", status: "ACTIVE" }
    });
    const permission = await prisma.permission.findUniqueOrThrow({ where: { key: permissionKey } });
    const role = await prisma.role.create({ data: { organizationId: orgId, name: `Cache Audit ${randomUUID().slice(0, 8)}`, isSystem: false } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    authorization.invalidateUser(user.id, orgId); // start each test from a known-clean cache state
    return { userId: user.id, roleId: role.id, permissionId: permission.id };
  }

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
    app.setGlobalPrefix("api/v1");
    await app.init();
    prisma = app.get(PrismaService);
    authorization = app.get(AuthorizationService);
    management = app.get(ManagementService);

    const res = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ organizationName: `Cache Invalidation Audit ${Date.now()}`, firstName: "Owner", email: `cache-audit-owner-${Date.now()}@example.invalid`, password: "StrongPassword@123" })
      .expect(201);
    orgId = res.body.data.organization.id;
    ownerId = res.body.data.user.id;
    createdOrgIds.push(orgId);
  }, 60_000);

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.user.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
    if (app) await app.close();
  }, 30_000);

  it("CACHE-001 assignRoles (removing a user's roles) clears the cached grant immediately, not just after the 5-minute TTL", async () => {
    const { userId } = await freshUserWithPermission("users.read");
    expect(await authorization.hasPermission(userId, orgId, "users.read")).toBe(true); // warms the cache
    await management.assignRoles(orgId, userId, ownerId, []);
    expect(await authorization.hasPermission(userId, orgId, "users.read")).toBe(false); // immediately, same tick
  });

  it("CACHE-002 deleteUser clears the cached grant immediately and canAccessOrganization reflects the soft-delete immediately", async () => {
    const { userId } = await freshUserWithPermission("users.read");
    expect(await authorization.hasPermission(userId, orgId, "users.read")).toBe(true);
    expect(await authorization.canAccessOrganization(userId, orgId)).toBe(true);
    await management.deleteUser(orgId, userId, ownerId);
    expect(await authorization.hasPermission(userId, orgId, "users.read")).toBe(false);
    expect(await authorization.canAccessOrganization(userId, orgId)).toBe(false);
  });

  it("CACHE-003 (the fix) updateUser suspending a user clears the cached grant immediately — this is the exact path that was missing invalidation before Phase 5.1", async () => {
    const { userId } = await freshUserWithPermission("users.read");
    expect(await authorization.hasPermission(userId, orgId, "users.read")).toBe(true); // warms the cache
    await management.updateUser(orgId, userId, ownerId, { status: UserStatus.SUSPENDED });
    // Before the Phase 5.1 fix, this would have returned true for up to 5 more minutes — updateUser never
    // called invalidateUser, so the cache entry warmed above would still have served the stale grant.
    expect(await authorization.hasPermission(userId, orgId, "users.read")).toBe(false);
  });

  it("CACHE-004 updateUser disabling a user: canAccessOrganization (never cached) reflects it immediately regardless of the cache fix", async () => {
    const { userId } = await freshUserWithPermission("users.read");
    expect(await authorization.canAccessOrganization(userId, orgId)).toBe(true);
    await management.updateUser(orgId, userId, ownerId, { status: UserStatus.DISABLED });
    expect(await authorization.canAccessOrganization(userId, orgId)).toBe(false);
  });

  it("CACHE-005 deleteRole clears the cached grant immediately via its org-wide invalidation", async () => {
    const { userId, roleId } = await freshUserWithPermission("users.read");
    expect(await authorization.hasPermission(userId, orgId, "users.read")).toBe(true); // warms the cache
    // deleteRole refuses a role still assigned to a user — remove the assignment directly via Prisma
    // (not via management.assignRoles, which would invalidate the cache itself and confound what this
    // test is isolating: deleteRole's OWN invalidateOrganization call).
    await prisma.userRole.deleteMany({ where: { roleId } });
    await management.deleteRole(orgId, roleId);
    expect(await authorization.hasPermission(userId, orgId, "users.read")).toBe(false);
  });

  it("CACHE-006 assignPermissions (stripping a role's permissions) clears the cached grant immediately for every user holding that role", async () => {
    const { userId, roleId } = await freshUserWithPermission("users.read");
    expect(await authorization.hasPermission(userId, orgId, "users.read")).toBe(true); // warms the cache
    await management.assignPermissions(orgId, roleId, []);
    expect(await authorization.hasPermission(userId, orgId, "users.read")).toBe(false);
  });
});
