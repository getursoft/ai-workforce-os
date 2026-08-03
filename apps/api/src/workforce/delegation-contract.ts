import { Injectable } from "@nestjs/common";
import Ajv, { type ValidateFunction } from "ajv";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";

/**
 * Sprint 4.6 Phase 5 — the structured delegation contract. A source employee never delegates through
 * free-form prose alone; every delegation is this validated shape. `input`/`expectedOutput` are
 * intentionally untyped JSON objects — their concrete shape is task-type-specific and is not something the
 * platform can know in advance — but the envelope around them is fixed and always validated.
 */
export interface DelegationContract {
  taskType: string;
  targetCapability?: string;
  objective: string;
  input: Record<string, unknown>;
  expectedOutput?: Record<string, unknown>;
  constraints?: {
    readOnly?: boolean;
    requiresApproval?: boolean;
    timeoutMs?: number;
  };
  /** Phase 8/9 least-privilege memory sharing — the SOURCE explicitly names which memory categories it
   *  wants shared with the target (e.g. ["TRAVEL_PREFERENCES"]). The platform still filters this request
   *  by tenant/employee-scope/sensitivity/org policy before anything is actually shared — naming a
   *  category here is a request, not a grant. */
  requestedMemoryCategories?: string[];
}

/** Hard ceiling on the serialized size of a delegation contract — rejects oversized payloads per Phase 5. */
export const MAX_DELEGATION_CONTRACT_BYTES = 32_000;

const CONTRACT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["taskType", "objective", "input"],
  properties: {
    taskType: { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_.-]+$" },
    targetCapability: { type: "string", minLength: 1, maxLength: 80 },
    objective: { type: "string", minLength: 1, maxLength: 2000 },
    input: { type: "object" },
    expectedOutput: { type: "object" },
    requestedMemoryCategories: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 80 } },
    constraints: {
      type: "object",
      additionalProperties: false,
      properties: {
        readOnly: { type: "boolean" },
        requiresApproval: { type: "boolean" },
        timeoutMs: { type: "integer", minimum: 100, maximum: 120_000 }
      }
    }
  }
} as const;

@Injectable()
export class DelegationContractValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: true });
  private readonly validateContract: ValidateFunction = this.ajv.compile(CONTRACT_JSON_SCHEMA);

  /** Structural validation only — task-type existence, target capability match, and tenant/permission
   *  checks happen in EmployeeCollaborationRouter and WorkforceOrchestratorService, which have the
   *  registry context this validator deliberately does not depend on. */
  validate(payload: unknown): DelegationContract {
    const size = Buffer.byteLength(JSON.stringify(payload ?? {}), "utf-8");
    if (size > MAX_DELEGATION_CONTRACT_BYTES) {
      throw new IdentityApplicationError(
        "TASK_SCHEMA_INVALID",
        "Delegated task payload exceeds the maximum allowed size.",
        [`payload is ${size} bytes, maximum is ${MAX_DELEGATION_CONTRACT_BYTES}`]
      );
    }
    if (!this.validateContract(payload)) {
      const details = (this.validateContract.errors ?? []).map(
        (error) => `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`
      );
      throw new IdentityApplicationError(
        "TASK_SCHEMA_INVALID",
        "Delegated task does not match the required contract shape.",
        details
      );
    }
    return payload as DelegationContract;
  }

  /** Validates a target employee's returned result against the contract's declared expectedOutput schema,
   *  when one was declared. A contract with no expectedOutput accepts any object result. */
  validateResult(result: unknown, expectedOutputSchema: Record<string, unknown> | null | undefined): void {
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new IdentityApplicationError(
        "RESULT_SCHEMA_INVALID",
        "Delegated task result must be a JSON object."
      );
    }
    if (!expectedOutputSchema || Object.keys(expectedOutputSchema).length === 0) return;
    const requiredKeys = Object.keys(expectedOutputSchema);
    const missing = requiredKeys.filter((key) => !(key in (result as Record<string, unknown>)));
    if (missing.length > 0) {
      throw new IdentityApplicationError(
        "RESULT_SCHEMA_INVALID",
        "Delegated task result is missing fields declared in expectedOutput.",
        missing.map((key) => `missing field: ${key}`)
      );
    }
  }
}
