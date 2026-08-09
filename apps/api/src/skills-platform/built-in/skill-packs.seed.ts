/**
 * Sprint 6.1B Feature 5 — built-in Skill Pack definitions. Every item references a real, implemented
 * built-in skill key (document-reader, text-summarization, entity-extraction, translation,
 * file-validation) — no fictional skills (e.g. "OCR", "SAP Connector") are declared here since no
 * such adapters exist in this sprint. Packs are seeded idempotently by SkillPackPublisherService,
 * mirroring SkillPublisherService's pattern for built-in skills themselves.
 */
export interface SkillPackSeedItem {
  skillKey: string;
  versionConstraint: string;
  required: boolean;
  order: number;
}

export interface SkillPackSeed {
  key: string;
  name: string;
  description: string;
  category: string;
  industry: string;
  author: string;
  version: string;
  items: SkillPackSeedItem[];
}

export const SKILL_PACK_SEEDS: readonly SkillPackSeed[] = [
  {
    key: "document-intelligence-pack",
    name: "Document Intelligence Pack",
    description:
      "A full document-processing chain: validate the upload, read its contents, pull out structured entities, translate if needed, and summarize the result.",
    category: "Document Processing",
    industry: "general",
    author: "Krevia.ai",
    version: "1.0.0",
    items: [
      { skillKey: "file-validation", versionConstraint: "^1.0.0", required: true, order: 1 },
      { skillKey: "document-reader", versionConstraint: "^1.0.0", required: true, order: 2 },
      { skillKey: "entity-extraction", versionConstraint: "^1.0.0", required: true, order: 3 },
      { skillKey: "translation", versionConstraint: "^1.0.0", required: false, order: 4 },
      { skillKey: "text-summarization", versionConstraint: "^1.0.0", required: false, order: 5 }
    ]
  },
  {
    key: "text-insights-pack",
    name: "Text Insights Pack",
    description: "Lightweight text-only chain for employees that only need to summarize, extract entities from, and translate free text (no file upload required).",
    category: "Text Processing",
    industry: "general",
    author: "Krevia.ai",
    version: "1.0.0",
    items: [
      { skillKey: "text-summarization", versionConstraint: "^1.0.0", required: true, order: 1 },
      { skillKey: "entity-extraction", versionConstraint: "^1.0.0", required: false, order: 2 },
      { skillKey: "translation", versionConstraint: "^1.0.0", required: false, order: 3 }
    ]
  }
];
