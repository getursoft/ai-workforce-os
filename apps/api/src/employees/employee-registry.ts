import type {
  EmployeeDomainSpec,
  EmployeeRuntimeConfig
} from "./employee-runtime";
import type { EmployeeConfigDelegate } from "./employee.service";
import type { ArtifactNameField } from "./employee-artifact.service";
import {
  DEFAULT_HR_EMPLOYEE_CONFIG,
  HR_DOMAIN_SPEC,
  HR_EMPLOYEE_PLUGIN_SLUG,
  HR_REFERENCE_PREFIX
} from "../hr/hr.runtime";
import {
  DEFAULT_FINANCE_EMPLOYEE_CONFIG,
  FINANCE_DOMAIN_SPEC,
  FINANCE_EMPLOYEE_PLUGIN_SLUG,
  FINANCE_REFERENCE_PREFIX
} from "../finance/finance.runtime";
import {
  DEFAULT_IT_SUPPORT_EMPLOYEE_CONFIG,
  IT_SUPPORT_DOMAIN_SPEC,
  IT_SUPPORT_EMPLOYEE_PLUGIN_SLUG,
  IT_SUPPORT_REFERENCE_PREFIX
} from "../it-support/it-support.runtime";
import {
  DEFAULT_SALES_EMPLOYEE_CONFIG,
  SALES_DOMAIN_SPEC,
  SALES_EMPLOYEE_PLUGIN_SLUG,
  SALES_REFERENCE_PREFIX
} from "../sales/sales.runtime";
import {
  DEFAULT_MARKETING_EMPLOYEE_CONFIG,
  MARKETING_DOMAIN_SPEC,
  MARKETING_EMPLOYEE_PLUGIN_SLUG,
  MARKETING_REFERENCE_PREFIX
} from "../marketing/marketing.runtime";
import {
  DEFAULT_LEGAL_EMPLOYEE_CONFIG,
  LEGAL_DOMAIN_SPEC,
  LEGAL_EMPLOYEE_PLUGIN_SLUG,
  LEGAL_REFERENCE_PREFIX
} from "../legal/legal.runtime";
import {
  CUSTOMER_SUPPORT_DOMAIN_SPEC,
  CUSTOMER_SUPPORT_EMPLOYEE_PLUGIN_SLUG,
  CUSTOMER_SUPPORT_REFERENCE_PREFIX,
  DEFAULT_CUSTOMER_SUPPORT_EMPLOYEE_CONFIG
} from "../customer-support/customer-support.runtime";

/** Maps the captured artifact payload's domain fields onto a Prisma model's columns. */
export type EmployeeArtifactFieldMapper = (input: Record<string, unknown>) => Record<string, unknown>;

export interface EmployeeDomainDescriptor {
  slug: string;
  memoryKey: string;
  spec: EmployeeDomainSpec;
  defaults: EmployeeRuntimeConfig;
  referencePrefix: string;
  artifactNoun: string;
  artifactToolName: string;
  escalateToolName: string;
  nameField: ArtifactNameField;
  configModel: (prisma: unknown) => EmployeeConfigDelegate;
  artifactDelegate: (prisma: unknown) => { create(args: unknown): Promise<unknown>; findUnique(args: unknown): Promise<unknown>; findFirst(args: unknown): Promise<unknown> };
  mapFields: EmployeeArtifactFieldMapper;
  /** The domain field keys the engine emits in the create-artifact payload (topic, details, category, ...)
   *  — added to the tool's input schema so AJV validation accepts them alongside the universal fields. */
  artifactFieldKeys: readonly string[];
}

/** Every non-Travel domain AI Employee, keyed by plugin slug. The shared engine in `employee-runtime.ts`
 *  drives all of them with identical logic; only vocabulary and artifact shape differ. */
export const EMPLOYEE_DOMAIN_REGISTRY: readonly EmployeeDomainDescriptor[] = [
  {
    slug: HR_EMPLOYEE_PLUGIN_SLUG,
    memoryKey: "hr.ticket_state",
    spec: HR_DOMAIN_SPEC,
    defaults: DEFAULT_HR_EMPLOYEE_CONFIG,
    referencePrefix: HR_REFERENCE_PREFIX,
    artifactNoun: "HR request",
    artifactToolName: "hr.create_ticket",
    artifactFieldKeys: ["topic", "details"],
    escalateToolName: "hr.escalate",
    nameField: "employeeName",
    configModel: (prisma) => (prisma as { hrEmployeeConfiguration: EmployeeConfigDelegate }).hrEmployeeConfiguration,
    artifactDelegate: (prisma) => (prisma as { hrTicket: unknown }).hrTicket as never,
    mapFields: (input) => ({
      ...(input.topic ? { topic: input.topic } : {}),
      ...(input.details ? { details: input.details } : {})
    })
  },
  {
    slug: FINANCE_EMPLOYEE_PLUGIN_SLUG,
    memoryKey: "finance.record_state",
    spec: FINANCE_DOMAIN_SPEC,
    defaults: DEFAULT_FINANCE_EMPLOYEE_CONFIG,
    referencePrefix: FINANCE_REFERENCE_PREFIX,
    artifactNoun: "finance request",
    artifactToolName: "finance.create_record",
    artifactFieldKeys: ["topic", "amount", "details"],
    escalateToolName: "finance.escalate",
    nameField: "customerName",
    configModel: (prisma) => (prisma as { financeEmployeeConfiguration: EmployeeConfigDelegate }).financeEmployeeConfiguration,
    artifactDelegate: (prisma) => (prisma as { financeRecord: unknown }).financeRecord as never,
    mapFields: (input) => ({
      ...(input.topic ? { topic: input.topic } : {}),
      ...(input.amount ? { amount: input.amount } : {}),
      ...(input.details ? { details: input.details } : {})
    })
  },
  {
    slug: IT_SUPPORT_EMPLOYEE_PLUGIN_SLUG,
    memoryKey: "it.ticket_state",
    spec: IT_SUPPORT_DOMAIN_SPEC,
    defaults: DEFAULT_IT_SUPPORT_EMPLOYEE_CONFIG,
    referencePrefix: IT_SUPPORT_REFERENCE_PREFIX,
    artifactNoun: "IT support ticket",
    artifactToolName: "it.create_ticket",
    artifactFieldKeys: ["category", "description"],
    escalateToolName: "it.escalate",
    nameField: "employeeName",
    configModel: (prisma) => (prisma as { itSupportEmployeeConfiguration: EmployeeConfigDelegate }).itSupportEmployeeConfiguration,
    artifactDelegate: (prisma) => (prisma as { itSupportTicket: unknown }).itSupportTicket as never,
    mapFields: (input) => ({
      ...(input.category ? { category: input.category } : {}),
      ...(input.description ? { description: input.description } : {})
    })
  },
  {
    slug: SALES_EMPLOYEE_PLUGIN_SLUG,
    memoryKey: "sales.lead_state",
    spec: SALES_DOMAIN_SPEC,
    defaults: DEFAULT_SALES_EMPLOYEE_CONFIG,
    referencePrefix: SALES_REFERENCE_PREFIX,
    artifactNoun: "sales lead",
    artifactToolName: "sales.create_lead",
    artifactFieldKeys: ["interest", "notes"],
    escalateToolName: "sales.escalate",
    nameField: "customerName",
    configModel: (prisma) => (prisma as { salesEmployeeConfiguration: EmployeeConfigDelegate }).salesEmployeeConfiguration,
    artifactDelegate: (prisma) => (prisma as { salesLead: unknown }).salesLead as never,
    mapFields: (input) => ({
      ...(input.interest ? { interest: input.interest } : {}),
      ...(input.notes ? { notes: input.notes } : {})
    })
  },
  {
    slug: MARKETING_EMPLOYEE_PLUGIN_SLUG,
    memoryKey: "marketing.campaign_state",
    spec: MARKETING_DOMAIN_SPEC,
    defaults: DEFAULT_MARKETING_EMPLOYEE_CONFIG,
    referencePrefix: MARKETING_REFERENCE_PREFIX,
    artifactNoun: "campaign brief",
    artifactToolName: "marketing.create_campaign",
    artifactFieldKeys: ["campaignName", "channel", "goals"],
    escalateToolName: "marketing.escalate",
    nameField: "customerName",
    configModel: (prisma) => (prisma as { marketingEmployeeConfiguration: EmployeeConfigDelegate }).marketingEmployeeConfiguration,
    artifactDelegate: (prisma) => (prisma as { marketingCampaign: unknown }).marketingCampaign as never,
    mapFields: (input) => ({
      ...(input.campaignName ? { campaignName: input.campaignName } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.goals ? { goals: input.goals } : {})
    })
  },
  {
    slug: LEGAL_EMPLOYEE_PLUGIN_SLUG,
    memoryKey: "legal.notice_state",
    spec: LEGAL_DOMAIN_SPEC,
    defaults: DEFAULT_LEGAL_EMPLOYEE_CONFIG,
    referencePrefix: LEGAL_REFERENCE_PREFIX,
    artifactNoun: "legal notice record",
    artifactToolName: "legal.create_notice",
    artifactFieldKeys: ["noticeType", "deadline", "summary"],
    escalateToolName: "legal.escalate",
    nameField: "customerName",
    configModel: (prisma) => (prisma as { legalEmployeeConfiguration: EmployeeConfigDelegate }).legalEmployeeConfiguration,
    artifactDelegate: (prisma) => (prisma as { legalNotice: unknown }).legalNotice as never,
    mapFields: (input) => ({
      ...(input.noticeType ? { noticeType: input.noticeType } : {}),
      ...(input.deadline ? { deadline: input.deadline } : {}),
      ...(input.summary ? { summary: input.summary } : {})
    })
  },
  {
    slug: CUSTOMER_SUPPORT_EMPLOYEE_PLUGIN_SLUG,
    memoryKey: "support.ticket_state",
    spec: CUSTOMER_SUPPORT_DOMAIN_SPEC,
    defaults: DEFAULT_CUSTOMER_SUPPORT_EMPLOYEE_CONFIG,
    referencePrefix: CUSTOMER_SUPPORT_REFERENCE_PREFIX,
    artifactNoun: "support ticket",
    artifactToolName: "support.create_ticket",
    artifactFieldKeys: ["topic", "description"],
    escalateToolName: "support.escalate",
    nameField: "customerName",
    configModel: (prisma) => (prisma as { customerSupportEmployeeConfiguration: EmployeeConfigDelegate }).customerSupportEmployeeConfiguration,
    artifactDelegate: (prisma) => (prisma as { customerSupportTicket: unknown }).customerSupportTicket as never,
    mapFields: (input) => ({
      ...(input.topic ? { topic: input.topic } : {}),
      ...(input.description ? { description: input.description } : {})
    })
  }
];

/** Returns the domain descriptor for a plugin slug, or null when it's not a domain employee. */
export function findEmployeeDomain(slug: string): EmployeeDomainDescriptor | null {
  return EMPLOYEE_DOMAIN_REGISTRY.find((domain) => domain.slug === slug) ?? null;
}
