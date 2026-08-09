/**
 * Sprint 6.1B Feature 6 — built-in Skill Template definitions. Each template targets a real,
 * discoverable employee plugin id (verified against this codebase's employee catalog: hr-employee,
 * finance-employee, travel-employee, ...) and bundles only real, implemented built-in skills.
 * `workflowRef` is purely informational — this sprint does not build a generic declarative workflow
 * step-type system (see Sprint 6.1A's WorkflowSkillStepService for the one additive hook that exists).
 */
export interface SkillTemplateSeedItem {
  skillKey: string;
  versionConstraint: string;
  order: number;
  defaultConfiguration: Record<string, unknown>;
}

export interface SkillTemplateSeed {
  key: string;
  name: string;
  description: string;
  category: string;
  industry: string;
  author: string;
  targetPluginId: string;
  workflowRef?: string;
  version: string;
  items: SkillTemplateSeedItem[];
}

export const SKILL_TEMPLATE_SEEDS: readonly SkillTemplateSeed[] = [
  {
    key: "invoice-intelligence-template",
    name: "Invoice Processing",
    description:
      "Reads an uploaded invoice, extracts its structured entities (amounts, dates, parties), and produces a short summary — configured out of the box for a Finance employee.",
    category: "Finance",
    industry: "finance",
    author: "Krevia.ai",
    targetPluginId: "finance-employee",
    workflowRef: "finance.invoice_intake",
    version: "1.0.0",
    items: [
      { skillKey: "document-reader", versionConstraint: "^1.0.0", order: 1, defaultConfiguration: {} },
      { skillKey: "entity-extraction", versionConstraint: "^1.0.0", order: 2, defaultConfiguration: {} },
      { skillKey: "text-summarization", versionConstraint: "^1.0.0", order: 3, defaultConfiguration: {} }
    ]
  },
  {
    key: "hr-document-intake-template",
    name: "HR Document Intake",
    description: "Validates and reads uploaded HR documents (offer letters, ID proofs, policy acknowledgements) and summarizes them for the HR employee's review queue.",
    category: "HR",
    industry: "hr",
    author: "Krevia.ai",
    targetPluginId: "hr-employee",
    workflowRef: "hr.document_intake",
    version: "1.0.0",
    items: [
      { skillKey: "file-validation", versionConstraint: "^1.0.0", order: 1, defaultConfiguration: {} },
      { skillKey: "document-reader", versionConstraint: "^1.0.0", order: 2, defaultConfiguration: {} },
      { skillKey: "text-summarization", versionConstraint: "^1.0.0", order: 3, defaultConfiguration: {} }
    ]
  }
];
