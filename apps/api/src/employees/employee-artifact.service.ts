import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { generateLeadReference } from "../conversation/conversation-completion";

/** Everything needed to persist one domain employee's artifact (HrTicket, SalesLead, ...). */
export interface CreateEmployeeArtifactInput {
  organizationId: string;
  pluginInstallationId: string;
  conversationId: string;
  customerName?: string | null;
  phoneNumber: string;
  email?: string | null;
  conversationSummary: string;
  /** Optional domain-specific fields (topic, category, amount, ...) mapped to Prisma columns. */
  fields?: Record<string, unknown>;
  /** Caller-supplied reference (kept in sync with a customer-facing confirmation); generated when omitted. */
  reference?: string | null;
}

export interface EmployeeArtifactRow {
  id: string;
  reference: string;
  organizationId: string;
}

/** The Prisma delegate union each employee artifact model satisfies (create / findUnique / findFirst). */
type ArtifactDelegate = {
  create(args: unknown): Promise<unknown>;
  findUnique(args: unknown): Promise<unknown>;
  findFirst(args: unknown): Promise<unknown>;
};

/** How the model names the captured contact person: "customerName" or "employeeName". */
export type ArtifactNameField = "customerName" | "employeeName";

/**
 * Single, shared, always-on persistence path for every non-Travel domain employee's artifact. Each
 * employee module wires its own Prisma delegate + reference prefix into this one service (see the per
 * employee artifact services), so the idempotency key contract, consent stamping, and P2002 race handling
 * behave identically across HR / Finance / IT / Sales / Marketing / Legal / Customer Support.
 */
@Injectable()
export class EmployeeArtifactService {
  /** Tenant-scoped idempotency key: same org + conversation always resolves to the same artifact. */
  buildIdempotencyKey(organizationId: string, conversationId: string, prefix: string): string {
    return `${organizationId}:${conversationId}:${prefix}:ARTIFACT_CAPTURE`;
  }

  async createInternal(
    delegate: ArtifactDelegate,
    nameField: ArtifactNameField,
    prefix: string,
    input: CreateEmployeeArtifactInput
  ): Promise<EmployeeArtifactRow> {
    const idempotencyKey = this.buildIdempotencyKey(
      input.organizationId,
      input.conversationId,
      prefix
    );
    const existing = (await delegate.findUnique({ where: { idempotencyKey } })) as
      | (EmployeeArtifactRow & { organizationId: string })
      | null;
    // Tenant isolation: never hand back a row belonging to a different organization.
    if (existing && existing.organizationId === input.organizationId) return existing;

    const data = {
      organizationId: input.organizationId,
      pluginInstallationId: input.pluginInstallationId,
      conversationId: input.conversationId,
      [nameField]: input.customerName ?? null,
      phoneNumber: input.phoneNumber,
      email: input.email ?? null,
      conversationSummary: input.conversationSummary,
      consentGivenAt: new Date(),
      idempotencyKey,
      ...(input.fields ?? {})
    };
    const reference = input.reference ?? generateLeadReference(prefix);
    try {
      return (await delegate.create({ data: { ...data, reference } })) as EmployeeArtifactRow;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const target = error.meta?.target;
        const targetsIdempotencyKey = Array.isArray(target)
          ? target.includes("idempotency_key")
          : typeof target === "string" && target.includes("idempotency_key");
        if (targetsIdempotencyKey) {
          const winner = (await delegate.findUnique({ where: { idempotencyKey } })) as
            | (EmployeeArtifactRow & { organizationId: string })
            | null;
          if (winner) return winner;
        }
        // A short random reference collided — one retry with a fresh reference clears it.
        return (await delegate.create({
          data: { ...data, reference: generateLeadReference(prefix) }
        })) as EmployeeArtifactRow;
      }
      throw error;
    }
  }
}
