import { Type } from "class-transformer";
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min
} from "class-validator";
import type { PlanTripReadinessCapabilities } from "./travel/plan-trip.skill";
import type {
  PlanTripAdapterWarning,
  PlanTripFieldCompleteness,
  SkillShadowDisagreementReason
} from "./travel/plan-trip-shadow-comparison";
import type {
  PlanTripDiagnosticReason,
  PlanTripRolloutClassification
} from "./travel/plan-trip-rollout-policy";

export const PLAN_TRIP_REVIEW_RUNTIME_MODES = ["ALL", "DETERMINISTIC", "LLM"] as const;
export type PlanTripReviewRuntimeMode = (typeof PLAN_TRIP_REVIEW_RUNTIME_MODES)[number];
export type PlanTripReviewSessionStatus = "CREATED" | "RUNNING" | "COMPLETED" | "ARCHIVED";
export type PlanTripRolloutRecommendation =
  | "NOT_READY"
  | "READY_FOR_MORE_UAT"
  | "READY_FOR_LIMITED_ROLLOUT"
  | "READY_FOR_AUTHORITATIVE_COLLECTION";

export class CreatePlanTripReviewSessionDto {
  @IsDateString() from!: string;
  @IsDateString() to!: string;
  @IsUUID() pluginInstallationId!: string;
  @IsOptional() @IsEnum(PLAN_TRIP_REVIEW_RUNTIME_MODES) runtimeMode: PlanTripReviewRuntimeMode =
    "ALL";
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) conversationCount = 100;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5000) turnCount = 1000;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export interface ReviewSessionDto {
  sessionId: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  reviewer: string;
  notes: "[REDACTED_OPERATIONAL_NOTES]" | null;
  status: PlanTripReviewSessionStatus;
  filters: {
    from: string;
    to: string;
    pluginInstallationId: string;
    runtimeMode: PlanTripReviewRuntimeMode;
    conversationCount: number;
    turnCount: number;
  };
  sampledConversationCount: number;
  sampledTurnCount: number;
}

export interface CapabilityAgreement {
  evaluated: number;
  agreements: number;
  mismatches: number;
  agreementPercentage: number;
  shadowCapabilityTrueCounts: Record<keyof PlanTripReadinessCapabilities, number>;
}

export interface BlockingIssue {
  code: PlanTripDiagnosticReason;
  classification: "BLOCKING";
  turnCount: number;
  conversationCount: number;
}

export interface PolicyIssue {
  code: PlanTripDiagnosticReason;
  classification: Exclude<PlanTripRolloutClassification, "BLOCKING">;
  turnCount: number;
  conversationCount: number;
}

export interface ExecutionSummary {
  skillExecutionId: string;
  status: string;
  revision: number;
  turnCount: number;
  pendingInputHistory: string[];
  completionPath: string[];
  revisionConflict: boolean;
  adapterWarnings: PlanTripAdapterWarning[];
  stateLoss: boolean;
  unexpectedOverwrite: boolean;
  capabilityMismatch: boolean;
}

export interface ConversationSummary {
  conversationId: string;
  runtimeMode: "DETERMINISTIC" | "LLM" | "MIXED" | "UNKNOWN";
  turnCount: number;
  agreement: boolean;
  agreementCount: number;
  disagreementCount: number;
  blockingDisagreement: boolean;
  policyDisagreement: boolean;
  expectedNonEquivalence: boolean;
  revisionConflict: boolean;
  adapterWarnings: PlanTripAdapterWarning[];
  stateLoss: boolean;
  unexpectedOverwrite: boolean;
  capabilityMismatch: boolean;
  completionPath: string[];
  pendingInputHistory: string[];
  executions: ExecutionSummary[];
}

export interface TrendSummary {
  overallAgreementPercentage: number;
  blockingPercentage: number;
  policyPercentage: number;
  adapterPercentage: number;
  revisionConflictPercentage: number;
  stateLossPercentage: number;
  overwritePercentage: number;
  runtimeModeSplit: {
    deterministicTurns: number;
    llmTurns: number;
    unknownTurns: number;
  };
  averageTurnsPerConversation: number;
  averagePendingInputsPerConversation: number;
  averageRevisionsPerConversation: number;
}

export interface RolloutSummary {
  reviewSession: ReviewSessionDto;
  conversationCount: number;
  turnCount: number;
  agreementCount: number;
  disagreementCount: number;
  blockingCount: number;
  policyCount: number;
  expectedNonEquivalenceCount: number;
  adapterWarningCount: number;
  revisionConflictCount: number;
  stateLossCount: number;
  unexpectedOverwriteCount: number;
  capabilityAgreement: CapabilityAgreement;
  blockingIssues: BlockingIssue[];
  policyIssues: PolicyIssue[];
  trends: TrendSummary;
  recommendation: PlanTripRolloutRecommendation;
  conversations: ConversationSummary[];
}

export interface ReviewTurnDiagnostic {
  agentExecutionId: string;
  conversationId: string;
  runtimeMode: "DETERMINISTIC" | "LLM" | "UNKNOWN";
  agreement: boolean;
  capabilityAgreement: boolean | null;
  shadowCapabilities: PlanTripReadinessCapabilities;
  reasonCodes: SkillShadowDisagreementReason[];
  diagnosticSignals: PlanTripDiagnosticReason[];
  adapterWarnings: PlanTripAdapterWarning[];
  pendingInput: string | null;
  persistenceExecutionId: string | null;
  persistenceStatus: string | null;
  persistenceRevision: number | null;
  fieldCompleteness: PlanTripFieldCompleteness;
}
