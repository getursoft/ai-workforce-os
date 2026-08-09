import { createHash } from "node:crypto";
import { extname } from "node:path";
import { Injectable } from "@nestjs/common";
import JSZip from "jszip";
import type {
  SkillAdapter,
  SkillExecutionContext,
  SkillExecutionResult,
  SkillHealthResult,
  SkillManifest
} from "@ai-workforce-os/skill-sdk";
import { healthySkillHealth } from "@ai-workforce-os/skill-sdk";
import { SkillError } from "../skill-error";

export interface FileValidationInput {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Base64-encoded content. Required to verify a checksum or inspect an archive; optional otherwise
   *  (name/extension/size/MIME checks can run on metadata alone). */
  content?: string;
  /** Expected sha256 hex digest to verify `content` against, when supplied by the caller. */
  expectedChecksumSha256?: string;
}

export interface FileValidationOutput {
  valid: boolean;
  errors: string[];
  warnings: string[];
  checks: {
    extensionAllowed: boolean;
    mimeTypeConsistentWithExtension: boolean;
    sizeWithinLimit: boolean;
    checksumVerified: boolean | null;
    archiveSafe: boolean | null;
    pathSafe: boolean | null;
  };
}

/** A small, deliberately conservative default MIME↔extension map. Organizations may narrow (never
 *  widen beyond these known-safe mappings) via `configuration.allowedExtensions`. */
const KNOWN_MIME_BY_EXTENSION: Record<string, string[]> = {
  ".pdf": ["application/pdf"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".csv": ["text/csv", "application/vnd.ms-excel"],
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/plain"],
  ".json": ["application/json"],
  ".xml": ["application/xml", "text/xml"],
  ".zip": ["application/zip", "application/x-zip-compressed", "application/octet-stream"]
};
const ARCHIVE_EXTENSIONS = new Set([".zip", ".docx", ".xlsx"]);
const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024;
const ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 200;

const MANIFEST: SkillManifest = {
  key: "file-validation",
  name: "File Validation",
  description:
    "Validates a file's MIME type, extension, size, checksum and archive safety (zip-bomb and path-traversal defense) before it is trusted. Supplements — never replaces — server-side upload security.",
  category: "Security",
  version: "1.0.0",
  author: "Krevia.ai",
  visibility: "PUBLIC",
  supportedMimeTypes: [],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["fileName", "mimeType", "sizeBytes"],
    properties: {
      fileName: { type: "string", minLength: 1, maxLength: 500 },
      mimeType: { type: "string", maxLength: 160 },
      sizeBytes: { type: "integer", minimum: 0 },
      content: { type: "string", maxLength: 70_000_000 },
      expectedChecksumSha256: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }
    }
  },
  outputSchema: {
    type: "object",
    required: ["valid", "errors", "warnings", "checks"],
    properties: {
      valid: { type: "boolean" },
      errors: { type: "array", items: { type: "string" } },
      warnings: { type: "array", items: { type: "string" } },
      checks: { type: "object" }
    }
  },
  requiredPermissions: ["skill.execute"],
  requiredCapabilities: [],
  dependencies: [],
  billingCategory: "DETERMINISTIC",
  timeoutMs: 15_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0 },
  statefulness: "STATELESS",
  configurationSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      allowedExtensions: { type: "array", items: { type: "string" } },
      maxSizeBytes: { type: "integer", minimum: 1 }
    }
  },
  capabilitySummary: ["Validate file type, size, checksum and archive safety before trusting a file"]
};

@Injectable()
export class FileValidationSkill implements SkillAdapter<FileValidationInput, FileValidationOutput> {
  readonly manifest = MANIFEST;

  async validate(input: FileValidationInput): Promise<void> {
    if (!input.fileName?.trim()) throw new SkillError("SKILL_INPUT_INVALID", "fileName is required");
    if (input.content && !/^[A-Za-z0-9+/=]*$/.test(input.content))
      throw new SkillError("SKILL_INPUT_INVALID", "content must be base64");
  }

  async execute(
    input: FileValidationInput,
    context: SkillExecutionContext
  ): Promise<SkillExecutionResult<FileValidationOutput>> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const extension = extname(input.fileName).toLowerCase();

    const pathSafe = isPathSafe(input.fileName);
    if (!pathSafe) errors.push("File name contains an unsafe path segment");

    const configuredExtensions = readStringArray(context.configuration.allowedExtensions);
    const allowedExtensions = configuredExtensions ?? Object.keys(KNOWN_MIME_BY_EXTENSION);
    const extensionAllowed = allowedExtensions.includes(extension);
    if (!extensionAllowed) errors.push(`Extension ${extension || "(none)"} is not allowed`);

    const knownMimeTypes = KNOWN_MIME_BY_EXTENSION[extension];
    const mimeTypeConsistentWithExtension = knownMimeTypes ? knownMimeTypes.includes(input.mimeType) : false;
    if (extensionAllowed && !mimeTypeConsistentWithExtension)
      errors.push(`MIME type ${input.mimeType} does not match extension ${extension}`);

    const maxSizeBytes = readNumber(context.configuration.maxSizeBytes) ?? DEFAULT_MAX_SIZE_BYTES;
    const sizeWithinLimit = input.sizeBytes > 0 && input.sizeBytes <= maxSizeBytes;
    if (!sizeWithinLimit) errors.push(`File size ${input.sizeBytes} exceeds the ${maxSizeBytes}-byte limit`);

    let checksumVerified: boolean | null = null;
    let archiveSafe: boolean | null = null;
    let buffer: Buffer | null = null;
    if (input.content) {
      buffer = Buffer.from(input.content, "base64");
      if (buffer.byteLength !== input.sizeBytes) warnings.push("Declared sizeBytes does not match content length");

      if (input.expectedChecksumSha256) {
        const actual = createHash("sha256").update(buffer).digest("hex");
        checksumVerified = actual === input.expectedChecksumSha256;
        if (!checksumVerified) errors.push("Checksum does not match file content");
      }

      if (ARCHIVE_EXTENSIONS.has(extension)) {
        archiveSafe = await this.checkArchiveSafety(buffer, errors);
      }
    }

    const checks: FileValidationOutput["checks"] = {
      extensionAllowed,
      mimeTypeConsistentWithExtension,
      sizeWithinLimit,
      checksumVerified,
      archiveSafe,
      pathSafe
    };
    const valid = errors.length === 0;
    return { data: { valid, errors, warnings, checks } };
  }

  async health(): Promise<SkillHealthResult> {
    return healthySkillHealth([{ name: "adapter-registered", status: "HEALTHY" }]);
  }

  private async checkArchiveSafety(buffer: Buffer, errors: string[]): Promise<boolean> {
    try {
      const archive = await JSZip.loadAsync(buffer);
      const entries = Object.values(archive.files);
      if (entries.length > ZIP_MAX_ENTRIES) {
        errors.push("Archive contains too many entries");
        return false;
      }
      let totalUncompressed = 0;
      for (const entry of entries) {
        if (!isPathSafe(entry.name)) {
          errors.push(`Archive entry has an unsafe path: ${entry.name}`);
          return false;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const size = (entry as any)?._data?.uncompressedSize ?? 0;
        totalUncompressed += typeof size === "number" ? size : 0;
        if (totalUncompressed > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
          errors.push("Archive exceeds the maximum allowed uncompressed size (zip-bomb defense)");
          return false;
        }
      }
      return true;
    } catch {
      errors.push("Archive could not be read; it may be corrupt or unsafe");
      return false;
    }
  }
}

function isPathSafe(name: string): boolean {
  if (!name || name.includes("\0")) return false;
  if (name.startsWith("/") || name.startsWith("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(name)) return false;
  const segments = name.split(/[\\/]/);
  return !segments.includes("..");
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
