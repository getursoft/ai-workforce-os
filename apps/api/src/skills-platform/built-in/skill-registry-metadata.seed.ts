/**
 * Sprint 6.1B Feature 8 — Registry metadata for built-in skills: tags, industry, license, required
 * connectors, and supported employee types. Deliberately NOT part of the SkillManifest/SkillAdapter
 * SDK contract (Sprint 6.1A's manifest shape is not touched) — this is sibling, additive catalog
 * metadata merged into the existing `Skill.metadataJson` column (added in Sprint 6.1A, unused until
 * now) by SkillRegistryMetadataService after every publish sync.
 */
export interface SkillRegistryMetadataEntry {
  tags: string[];
  industry: string[];
  license: string;
  requiredConnectors: string[];
  supportedEmployees: string[];
}

export const SKILL_REGISTRY_METADATA: Readonly<Record<string, SkillRegistryMetadataEntry>> = {
  "document-reader": {
    tags: ["document", "pdf", "extraction", "parsing", "ocr-adjacent"],
    industry: ["general", "legal", "finance", "hr"],
    license: "proprietary-platform",
    requiredConnectors: [],
    supportedEmployees: ["hr-employee", "travel-employee", "finance-employee", "legal-employee"]
  },
  "text-summarization": {
    tags: ["summarization", "nlp", "text"],
    industry: ["general"],
    license: "proprietary-platform",
    requiredConnectors: [],
    supportedEmployees: ["hr-employee", "travel-employee", "finance-employee", "legal-employee", "sales-employee"]
  },
  "entity-extraction": {
    tags: ["entities", "nlp", "extraction", "classification-adjacent"],
    industry: ["general", "finance", "legal"],
    license: "proprietary-platform",
    requiredConnectors: [],
    supportedEmployees: ["hr-employee", "finance-employee", "legal-employee"]
  },
  translation: {
    tags: ["translation", "language", "nlp"],
    industry: ["general", "travel"],
    license: "proprietary-platform",
    requiredConnectors: [],
    supportedEmployees: ["travel-employee", "hr-employee", "sales-employee"]
  },
  "file-validation": {
    tags: ["security", "validation", "upload-safety"],
    industry: ["general"],
    license: "proprietary-platform",
    requiredConnectors: [],
    supportedEmployees: ["hr-employee", "travel-employee", "finance-employee", "legal-employee", "sales-employee"]
  }
};
