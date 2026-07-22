import { Injectable } from "@nestjs/common";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import type { ExtractedKnowledgeDocument, KnowledgeTextExtractor } from "./knowledge.types";

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
