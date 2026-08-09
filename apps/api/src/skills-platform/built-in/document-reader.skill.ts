import { Injectable } from "@nestjs/common";
import * as XLSX from "xlsx";
import type {
  SkillAdapter,
  SkillExecutionContext,
  SkillExecutionResult,
  SkillHealthResult,
  SkillManifest
} from "@ai-workforce-os/skill-sdk";
import { healthySkillHealth } from "@ai-workforce-os/skill-sdk";
import { SkillError } from "../skill-error";
import { KnowledgeExtractorRegistry } from "../../knowledge/knowledge.extractors";
import { normalizeKnowledgeText } from "../../knowledge/knowledge.extractors";

export interface DocumentReaderInput {
  fileName?: string;
  mimeType: string;
  /** Object storage key to read bytes from (requires object.read capability). */
  objectKey?: string;
  /** Base64-encoded file content (used by callers that already hold bytes). */
  content?: string;
  /** Plain text input for text-native formats (txt/md/csv/json/xml). */
  text?: string;
}

export interface DocumentReaderOutput {
  fileName: string | null;
  mimeType: string;
  text: string;
  markdown: string;
  sections: Array<{ title: string; text: string }>;
  tables: Array<{ name: string | null; rows: string[][] }>;
  sheets: Array<{ name: string; rows: string[][] }>;
  metadata: Record<string, unknown>;
  warnings: string[];
}

const MANIFEST: SkillManifest = {
  key: "document-reader",
  name: "Document Reader",
  description:
    "Extracts structured text, tables and metadata from PDF, DOCX, XLSX, CSV, TXT, Markdown, JSON, XML and ZIP documents. Reuses the platform knowledge extractors; does not upload anything to Knowledge.",
  category: "Document Processing",
  version: "1.0.0",
  author: "Krevia.ai",
  visibility: "PUBLIC",
  supportedMimeTypes: [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
    "text/plain",
    "text/markdown",
    "application/json",
    "application/xml",
    "text/xml",
    "application/zip"
  ],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["mimeType"],
    properties: {
      fileName: { type: "string", maxLength: 255 },
      mimeType: { type: "string", maxLength: 160 },
      objectKey: { type: "string", maxLength: 500 },
      content: { type: "string", maxLength: 50_000_000 },
      text: { type: "string", maxLength: 5_000_000 }
    }
  },
  outputSchema: {
    type: "object",
    required: ["fileName", "mimeType", "text"],
    properties: {
      fileName: { type: ["string", "null"] },
      mimeType: { type: "string" },
      text: { type: "string" },
      markdown: { type: "string" },
      sections: { type: "array" },
      tables: { type: "array" },
      sheets: { type: "array" },
      metadata: { type: "object" },
      warnings: { type: "array", items: { type: "string" } }
    }
  },
  requiredPermissions: ["skill.execute"],
  requiredCapabilities: ["object.read"],
  dependencies: [],
  billingCategory: "DETERMINISTIC",
  timeoutMs: 60_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0 },
  statefulness: "STATELESS",
  capabilitySummary: ["Read PDF", "Read Word documents", "Read Excel spreadsheets", "Read CSV", "Read text/markdown", "Read JSON/XML", "Read ZIP archives"]
};

@Injectable()
export class DocumentReaderSkill implements SkillAdapter<DocumentReaderInput, DocumentReaderOutput> {
  readonly manifest = MANIFEST;

  constructor(private readonly knowledge: KnowledgeExtractorRegistry) {}

  async validate(input: DocumentReaderInput): Promise<void> {
    const hasBytes = Boolean(input.objectKey || input.content);
    const hasText = Boolean(input.text);
    if (!hasBytes && !hasText) throw new SkillError("SKILL_INPUT_INVALID", "Provide objectKey, content or text");
    if (!SUPPORTED.has(input.mimeType))
      throw new SkillError("SKILL_INPUT_INVALID", `Unsupported MIME type: ${input.mimeType}`);
    if (input.content && !/^[A-Za-z0-9+/=]+$/.test(input.content))
      throw new SkillError("SKILL_INPUT_INVALID", "content must be base64");
  }

  async execute(
    input: DocumentReaderInput,
    context: SkillExecutionContext
  ): Promise<SkillExecutionResult<DocumentReaderOutput>> {
    const warnings: string[] = [];
    let buffer: Buffer | null = null;
    if (input.objectKey) {
      buffer = (await context.capabilities.object?.read({
        organizationId: context.organizationId,
        key: input.objectKey
      })) ?? null;
      if (!buffer) throw new SkillError("SKILL_ENTITLEMENT_DENIED", "object.read capability unavailable");
    } else if (input.content) {
      buffer = Buffer.from(input.content, "base64");
    }

    if (buffer && buffer.byteLength > MAX_BYTES) {
      throw new SkillError("SKILL_PAYLOAD_TOO_LARGE", "Document exceeds the size limit");
    }

    let output: DocumentReaderOutput;
    if (input.mimeType === "text/csv") {
      output = this.readCsv(input, buffer);
    } else if (input.mimeType === "application/json") {
      output = this.readJson(input, buffer);
    } else if (input.mimeType === "application/xml" || input.mimeType === "text/xml") {
      output = this.readXml(input, buffer);
    } else if (buffer) {
      output = await this.readWithKnowledgeExtractor(input, buffer, warnings);
    } else {
      output = this.readPlain(input);
    }

    return { data: output, warnings: output.warnings };
  }

  async health(): Promise<SkillHealthResult> {
    return healthySkillHealth([
      { name: "adapter-registered", status: "HEALTHY" },
      { name: "knowledge-extractors", status: "HEALTHY" }
    ]);
  }

  private async readWithKnowledgeExtractor(
    input: DocumentReaderInput,
    buffer: Buffer,
    warnings: string[]
  ): Promise<DocumentReaderOutput> {
    try {
      const extracted = await this.knowledge.extract(input.mimeType, buffer);
      const sections = extracted.pages?.map((page) => ({
        title: `Page ${page.pageNumber}`,
        text: page.text
      })) ?? [];
      return {
        fileName: input.fileName ?? null,
        mimeType: input.mimeType,
        text: extracted.text,
        markdown: extracted.text,
        sections,
        tables: [],
        sheets: [],
        metadata: { pageCount: extracted.pages?.length ?? null },
        warnings
      };
    } catch {
      warnings.push("Knowledge extraction produced no text for this document");
      return {
        fileName: input.fileName ?? null,
        mimeType: input.mimeType,
        text: "",
        markdown: "",
        sections: [],
        tables: [],
        sheets: [],
        metadata: {},
        warnings
      };
    }
  }

  private readPlain(input: DocumentReaderInput): DocumentReaderOutput {
    const text = normalizeKnowledgeText(input.text ?? "");
    return {
      fileName: input.fileName ?? null,
      mimeType: input.mimeType,
      text,
      markdown: text,
      sections: [],
      tables: [],
      sheets: [],
      metadata: {},
      warnings: []
    };
  }

  private readCsv(input: DocumentReaderInput, buffer: Buffer | null): DocumentReaderOutput {
    const raw = buffer ? buffer.toString("utf8") : (input.text ?? "");
    const rows: string[][] = [];
    try {
      const workbook = XLSX.read(raw, { type: "string" });
      const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
      if (sheet) {
        for (const row of XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false })) {
          rows.push((row as unknown[]).map(String));
        }
      }
    } catch {
      // fall back to naive line splitting
      rows.push(...raw.split(/\r?\n/).map((line) => line.split(",").map((cell) => cell.trim())));
    }
    const text = rows.map((row) => row.join(",")).join("\n");
    return {
      fileName: input.fileName ?? null,
      mimeType: input.mimeType,
      text,
      markdown: rowsToMarkdown(rows),
      sections: [],
      tables: [{ name: input.fileName ?? "csv", rows }],
      sheets: [],
      metadata: { rowCount: rows.length },
      warnings: []
    };
  }

  private readJson(input: DocumentReaderInput, buffer: Buffer | null): DocumentReaderOutput {
    const raw = buffer ? buffer.toString("utf8") : (input.text ?? "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const text = parsed === null ? raw : JSON.stringify(parsed, null, 2);
    return {
      fileName: input.fileName ?? null,
      mimeType: input.mimeType,
      text,
      markdown: "```json\n" + text.slice(0, 50_000) + "\n```",
      sections: [],
      tables: [],
      sheets: [],
      metadata: { validJson: parsed !== null },
      warnings: parsed === null ? ["JSON could not be parsed"] : []
    };
  }

  private readXml(input: DocumentReaderInput, buffer: Buffer | null): DocumentReaderOutput {
    const raw = buffer ? buffer.toString("utf8") : (input.text ?? "");
    const text = stripXmlTags(raw);
    return {
      fileName: input.fileName ?? null,
      mimeType: input.mimeType,
      text: normalizeKnowledgeText(text),
      markdown: normalizeKnowledgeText(text),
      sections: [],
      tables: [],
      sheets: [],
      metadata: { characterCount: raw.length },
      warnings: []
    };
  }
}

const MAX_BYTES = 50 * 1024 * 1024;
const SUPPORTED = new Set<string>(MANIFEST.supportedMimeTypes);

function rowsToMarkdown(rows: string[][]): string {
  if (rows.length === 0) return "";
  const header = rows[0] ?? [];
  const lines = [
    "| " + header.join(" | ") + " |",
    "| " + header.map(() => "---").join(" | ") + " |"
  ];
  for (const row of rows.slice(1)) {
    lines.push("| " + (row.length ? row : [""]).join(" | ") + " |");
  }
  return lines.join("\n");
}

function stripXmlTags(value: string): string {
  return value
    .replace(/<\?xml[^>]*\?>/gi, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
