import { Injectable } from "@nestjs/common";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { extname } from "node:path";
import type { ExtractedKnowledgeDocument, KnowledgeTextExtractor } from "./knowledge.types";
import { KNOWLEDGE_MIME_TYPES } from "./knowledge.types";

export function normalizeKnowledgeText(value: string): string {
  return value
    .replaceAll("\0", "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

@Injectable()
export class PlainKnowledgeTextExtractor implements KnowledgeTextExtractor {
  supports(mimeType: string) {
    return mimeType === "text/plain" || mimeType === "text/markdown";
  }
  async extract(buffer: Buffer): Promise<ExtractedKnowledgeDocument> {
    return { text: normalizeKnowledgeText(buffer.toString("utf8")) };
  }
}

@Injectable()
export class PdfKnowledgeTextExtractor implements KnowledgeTextExtractor {
  supports(mimeType: string) {
    return mimeType === "application/pdf";
  }
  async extract(buffer: Buffer): Promise<ExtractedKnowledgeDocument> {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const pages = result.pages
        .map((page) => ({ pageNumber: page.num, text: normalizeKnowledgeText(page.text) }))
        .filter((page) => page.text);
      return { text: normalizeKnowledgeText(result.text), pages };
    } finally {
      await parser.destroy();
    }
  }
}

@Injectable()
export class DocxKnowledgeTextExtractor implements KnowledgeTextExtractor {
  supports(mimeType: string) {
    return mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  async extract(buffer: Buffer): Promise<ExtractedKnowledgeDocument> {
    const result = await mammoth.extractRawText({ buffer });
    return { text: normalizeKnowledgeText(result.value) };
  }
}

@Injectable()
export class XlsxKnowledgeTextExtractor implements KnowledgeTextExtractor {
  supports(mimeType: string) {
    return mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  async extract(buffer: Buffer): Promise<ExtractedKnowledgeDocument> {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheets = workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const csv = sheet ? XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim() : "";
      return csv ? `## ${name}\n${csv}` : "";
    }).filter(Boolean);
    return { text: normalizeKnowledgeText(sheets.join("\n\n")) };
  }
}

// A zip bomb (a small compressed file that expands to gigabytes) is a real DoS vector once JSZip
// decompresses entries into memory — this bounds total uncompressed bytes read from any one archive,
// independent of the (already-enforced) compressed upload size limit.
const ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 200;

@Injectable()
export class ZipKnowledgeTextExtractor implements KnowledgeTextExtractor {
  // The extractors a zip's own entries may be processed with — deliberately excludes this class itself
  // (no nested zip-in-zip support, which would need its own recursion-depth/decompression-ratio guards
  // to stay DoS-safe; a zip containing another zip simply yields no text for that entry).
  constructor(private readonly innerExtractors: KnowledgeTextExtractor[]) {}
  supports(mimeType: string) {
    return mimeType === "application/zip";
  }
  async extract(buffer: Buffer): Promise<ExtractedKnowledgeDocument> {
    const archive = await JSZip.loadAsync(buffer);
    const entries = Object.values(archive.files).filter((entry) => !entry.dir);
    if (entries.length > ZIP_MAX_ENTRIES) throw new Error("KNOWLEDGE_ZIP_TOO_MANY_ENTRIES");
    const sections: string[] = [];
    let totalBytes = 0;
    for (const entry of entries) {
      const extension = extname(entry.name).toLowerCase() as keyof typeof KNOWLEDGE_MIME_TYPES;
      const mimeType = Object.hasOwn(KNOWLEDGE_MIME_TYPES, extension)
        ? KNOWLEDGE_MIME_TYPES[extension]
        : null;
      // Unsupported entries (images, nested zips, etc.) are silently skipped, not fatal — a zip full of
      // mixed content should still index whatever it can, matching how a folder upload would behave.
      if (!mimeType) continue;
      const extractor = this.innerExtractors.find((item) => item.supports(mimeType));
      if (!extractor) continue;
      const entryBuffer = await entry.async("nodebuffer");
      totalBytes += entryBuffer.byteLength;
      if (totalBytes > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error("KNOWLEDGE_ZIP_TOO_LARGE");
      try {
        const extracted = await extractor.extract(entryBuffer);
        if (extracted.text.trim()) sections.push(`## ${entry.name}\n${extracted.text}`);
      } catch {
        // One unreadable/corrupt entry must not fail the whole archive — its content is simply absent.
      }
    }
    return { text: normalizeKnowledgeText(sections.join("\n\n")) };
  }
}

@Injectable()
export class KnowledgeExtractorRegistry {
  constructor(private readonly extractors: KnowledgeTextExtractor[]) {}
  async extract(mimeType: string, buffer: Buffer) {
    const extractor = this.extractors.find((item) => item.supports(mimeType));
    if (!extractor) throw new Error("KNOWLEDGE_FILE_TYPE_UNSUPPORTED");
    const result = await extractor.extract(buffer);
    if (!result.text.trim()) throw new Error("KNOWLEDGE_TEXT_NOT_EXTRACTABLE");
    return result;
  }
}
