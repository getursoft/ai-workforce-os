/**
 * Customer Identity — the shared abstraction every AI Employee (Travel, Hospital, HR, Sales, ...) uses
 * to answer "which customer is this conversation for?" without ever assuming two conversations belong
 * to the same customer just because they happened to run in the same browser session or were started by
 * the same staff member. A `Conversation` is one interaction; a `CustomerProfile` is the durable
 * customer it may (or may not) resolve back to. Deliberately decoupled from `AgentActor` (agent.runtime)
 * so this module has no dependency on the agent runtime and can be reused as-is by any future employee
 * or channel adapter — callers translate their own actor/request shape into a `CustomerIdentityHint`.
 */

/** Where a customer identity hint came from. `UNKNOWN` is the only variant that never resolves to a
 * persisted profile — every other variant carries a durable natural key. */
export type CustomerIdentityHint =
  | { source: "CHANNEL_PHONE"; phone: string }
  | { source: "CRM_RECORD"; crmCustomerId: string }
  | { source: "PORTAL_USER"; portalUserId: string }
  | { source: "UNKNOWN" };

export type KnownCustomerIdentityType = "PHONE" | "CRM_ID" | "PORTAL_USER";
export type CustomerIdentityType = KnownCustomerIdentityType | "ANONYMOUS";

/** The resolved identity for a conversation. `ANONYMOUS` carries no external id and is never persisted
 * as a `CustomerProfile` row — it always starts a conversation with a completely clean customer context. */
export type CustomerIdentity =
  | { type: KnownCustomerIdentityType; externalId: string }
  | { type: "ANONYMOUS" };

export interface CustomerProfileSnapshot {
  id: string;
  identityType: KnownCustomerIdentityType;
  externalId: string;
  displayName: string | null;
  preferences: Record<string, unknown>;
  currency: string | null;
  language: string | null;
}

export function isKnownCustomerIdentity(
  identity: CustomerIdentity
): identity is { type: KnownCustomerIdentityType; externalId: string } {
  return identity.type !== "ANONYMOUS";
}

/** Pure translation from a hint to a resolved identity — no I/O, safe to unit test and reuse anywhere. */
export function resolveCustomerIdentity(hint: CustomerIdentityHint): CustomerIdentity {
  switch (hint.source) {
    case "CHANNEL_PHONE":
      return { type: "PHONE", externalId: hint.phone };
    case "CRM_RECORD":
      return { type: "CRM_ID", externalId: hint.crmCustomerId };
    case "PORTAL_USER":
      return { type: "PORTAL_USER", externalId: hint.portalUserId };
    case "UNKNOWN":
      return { type: "ANONYMOUS" };
  }
}
