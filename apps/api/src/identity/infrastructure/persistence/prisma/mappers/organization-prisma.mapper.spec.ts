import { OrganizationStatus as PrismaOrganizationStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { Organization } from "../../../../domain/organization/organization";
import { OrganizationId } from "../../../../domain/organization/organization-id";
import { OrganizationName } from "../../../../domain/organization/organization-name";
import { OrganizationSlug } from "../../../../domain/organization/organization-slug";
import { OrganizationStatus } from "../../../../domain/organization/organization-status";
import { OrganizationPrismaMapper } from "./organization-prisma.mapper";

const createdAt = new Date("2026-07-10T10:00:00.000Z");
const updatedAt = new Date("2026-07-10T11:00:00.000Z");

describe("OrganizationPrismaMapper", () => {
  it("maps domain data, enum values, and timestamps to persistence", () => {
    const organization = Organization.reconstruct({
      id: OrganizationId.from("00000000-0000-4000-8000-000000000001"),
      name: OrganizationName.create("Acme"),
      slug: OrganizationSlug.create("acme"),
      status: OrganizationStatus.SUSPENDED,
      createdAt,
      updatedAt
    });

    const record = OrganizationPrismaMapper.toPersistence(organization);
    expect(record).toMatchObject({
      id: "00000000-0000-4000-8000-000000000001",
      name: "Acme",
      slug: "acme",
      status: PrismaOrganizationStatus.SUSPENDED
    });
    expect(record.createdAt).toEqual(createdAt);
    expect(record.updatedAt).toEqual(updatedAt);
    expect(record.createdAt).not.toBe(createdAt);
  });

  it("reconstructs a domain organization without losing timestamps", () => {
    const organization = OrganizationPrismaMapper.toDomain({
      id: "00000000-0000-4000-8000-000000000001",
      name: "Acme",
      slug: "acme",
      status: PrismaOrganizationStatus.DISABLED,
      createdAt,
      updatedAt
    });

    expect(organization.status).toBe(OrganizationStatus.DISABLED);
    expect(organization.createdAt).toEqual(createdAt);
    expect(organization.updatedAt).toEqual(updatedAt);
  });
});
