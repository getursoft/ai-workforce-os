import { Injectable } from "@nestjs/common";
import type { CustomerProfile } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import {
  isKnownCustomerIdentity,
  resolveCustomerIdentity,
  type CustomerIdentity,
  type CustomerIdentityHint,
  type CustomerProfileSnapshot
} from "./customer-identity.types";

function toSnapshot(row: CustomerProfile): CustomerProfileSnapshot {
  return {
    id: row.id,
    identityType: row.identityType as CustomerProfileSnapshot["identityType"],
    externalId: row.externalId,
    displayName: row.displayName,
    preferences: (row.preferences ?? {}) as Record<string, unknown>,
    currency: row.currency,
    language: row.language
  };
}

/**
 * Resolves a conversation's customer identity and loads/persists the durable `CustomerProfile` it
 * belongs to. Every AI Employee shares this service instead of rolling its own "who is this customer"
 * logic: a `Conversation` is one interaction, a `CustomerProfile` is the customer across all of them —
 * this service is the only place that's allowed to link the two.
 */
@Injectable()
export class CustomerIdentityService {
  constructor(private readonly prisma: PrismaService) {}

  resolve(hint: CustomerIdentityHint): CustomerIdentity {
    return resolveCustomerIdentity(hint);
  }

  /** Looks up an existing profile for a known identity. Never creates one, and always returns null for
   * `ANONYMOUS` — an anonymous conversation must never accidentally resolve to somebody else's profile. */
  async loadProfile(
    organizationId: string,
    identity: CustomerIdentity
  ): Promise<CustomerProfileSnapshot | null> {
    if (!isKnownCustomerIdentity(identity)) return null;
    const row = await this.prisma.customerProfile.findFirst({
      where: {
        organizationId,
        identityType: identity.type,
        externalId: identity.externalId,
        deletedAt: null
      }
    });
    return row ? toSnapshot(row) : null;
  }

  /** Persists a customer's name against their durable identity once captured in conversation (e.g. the
   * Travel Employee's onboarding). Creates the profile on first contact, updates it on return visits.
   * A no-op for `ANONYMOUS` — there is nothing durable to attach a name to. This is the exact plug point
   * a future WhatsApp/portal integration uses; no channel-specific code needed on top of it. */
  async rememberName(
    organizationId: string,
    identity: CustomerIdentity,
    displayName: string
  ): Promise<CustomerProfileSnapshot | null> {
    if (!isKnownCustomerIdentity(identity)) return null;
    const row = await this.prisma.customerProfile.upsert({
      where: {
        organizationId_identityType_externalId: {
          organizationId,
          identityType: identity.type,
          externalId: identity.externalId
        }
      },
      create: {
        organizationId,
        identityType: identity.type,
        externalId: identity.externalId,
        displayName
      },
      update: { displayName, deletedAt: null }
    });
    return toSnapshot(row);
  }
}
