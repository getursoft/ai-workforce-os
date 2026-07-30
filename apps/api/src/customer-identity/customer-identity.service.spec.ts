import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { CustomerIdentityService } from "./customer-identity.service";
import { isKnownCustomerIdentity, resolveCustomerIdentity } from "./customer-identity.types";

describe("resolveCustomerIdentity (pure)", () => {
  it("maps each known hint source to its identity type, carrying the external id through unchanged", () => {
    expect(resolveCustomerIdentity({ source: "CHANNEL_PHONE", phone: "+15550001111" })).toEqual({
      type: "PHONE",
      externalId: "+15550001111"
    });
    expect(resolveCustomerIdentity({ source: "CRM_RECORD", crmCustomerId: "lead-42" })).toEqual({
      type: "CRM_ID",
      externalId: "lead-42"
    });
    expect(resolveCustomerIdentity({ source: "PORTAL_USER", portalUserId: "user-9" })).toEqual({
      type: "PORTAL_USER",
      externalId: "user-9"
    });
  });

  it("resolves UNKNOWN to ANONYMOUS — the only variant with no durable external id", () => {
    expect(resolveCustomerIdentity({ source: "UNKNOWN" })).toEqual({ type: "ANONYMOUS" });
  });
});

describe("isKnownCustomerIdentity", () => {
  it("is false only for ANONYMOUS", () => {
    expect(isKnownCustomerIdentity({ type: "ANONYMOUS" })).toBe(false);
    expect(isKnownCustomerIdentity({ type: "PHONE", externalId: "+1" })).toBe(true);
    expect(isKnownCustomerIdentity({ type: "CRM_ID", externalId: "lead-1" })).toBe(true);
    expect(isKnownCustomerIdentity({ type: "PORTAL_USER", externalId: "user-1" })).toBe(true);
  });
});

describe("CustomerIdentityService", () => {
  it("loadProfile never touches the database for an ANONYMOUS identity, and always returns null", async () => {
    const findFirst = vi.fn();
    const service = new CustomerIdentityService({
      customerProfile: { findFirst }
    } as unknown as PrismaService);
    const result = await service.loadProfile("org-1", { type: "ANONYMOUS" });
    expect(result).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("loadProfile looks up by organization + identity type + external id, and returns null when not found", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new CustomerIdentityService({
      customerProfile: { findFirst }
    } as unknown as PrismaService);
    const result = await service.loadProfile("org-1", { type: "PHONE", externalId: "+15550001111" });
    expect(result).toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        identityType: "PHONE",
        externalId: "+15550001111",
        deletedAt: null
      }
    });
  });

  it("rememberName is a no-op for ANONYMOUS — there is nothing durable to attach a name to", async () => {
    const upsert = vi.fn();
    const service = new CustomerIdentityService({
      customerProfile: { upsert }
    } as unknown as PrismaService);
    const result = await service.rememberName("org-1", { type: "ANONYMOUS" }, "Krishna");
    expect(result).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rememberName upserts the profile for a known identity and returns the resulting snapshot", async () => {
    const upsert = vi.fn().mockResolvedValue({
      id: "profile-1",
      identityType: "PHONE",
      externalId: "+15550001111",
      displayName: "Krishna Pandey",
      preferences: {},
      currency: null,
      language: null
    });
    const service = new CustomerIdentityService({
      customerProfile: { upsert }
    } as unknown as PrismaService);
    const result = await service.rememberName(
      "org-1",
      { type: "PHONE", externalId: "+15550001111" },
      "Krishna Pandey"
    );
    expect(result).toMatchObject({ id: "profile-1", displayName: "Krishna Pandey" });
    expect(upsert).toHaveBeenCalledWith({
      where: {
        organizationId_identityType_externalId: {
          organizationId: "org-1",
          identityType: "PHONE",
          externalId: "+15550001111"
        }
      },
      create: {
        organizationId: "org-1",
        identityType: "PHONE",
        externalId: "+15550001111",
        displayName: "Krishna Pandey"
      },
      update: { displayName: "Krishna Pandey", deletedAt: null }
    });
  });
});
