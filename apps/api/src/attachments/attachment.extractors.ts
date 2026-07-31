import { createWorker, type Worker } from "tesseract.js";

/** Unified attachment text extraction — text, PDF, Word, and JPG/PNG images. PDF/DOCX/TXT reuse the
 *  knowledge extractors (same parsing code as the knowledge base); images go through tesseract.js OCR. */

export interface ExtractedAttachmentText {
  text: string;
}

export interface AttachmentTextExtractor {
  supports(mimeType: string): boolean;
  extract(buffer: Buffer): Promise<ExtractedAttachmentText>;
}

export function normalizeAttachmentText(value: string): string {
  return value
    .replaceAll("\0", "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class PlainAttachmentTextExtractor implements AttachmentTextExtractor {
  supports(mimeType: string) {
    return mimeType === "text/plain" || mimeType === "text/markdown" || mimeType === "text/csv";
  }
  async extract(buffer: Buffer): Promise<ExtractedAttachmentText> {
    return { text: normalizeAttachmentText(buffer.toString("utf8")) };
  }
}

export class PdfAttachmentTextExtractor implements AttachmentTextExtractor {
  supports(mimeType: string) {
    return mimeType === "application/pdf";
  }
  async extract(buffer: Buffer): Promise<ExtractedAttachmentText> {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return { text: normalizeAttachmentText(result.text) };
    } finally {
      await parser.destroy();
    }
  }
}

export class DocxAttachmentTextExtractor implements AttachmentTextExtractor {
  supports(mimeType: string) {
    return (
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      mimeType === "application/msword"
    );
  }
  async extract(buffer: Buffer): Promise<ExtractedAttachmentText> {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return { text: normalizeAttachmentText(result.value) };
  }
}

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/gif"
]);

/** OCR-based text extraction for images (JPG/PNG/WebP/BMP/GIF) via tesseract.js. The worker is created
 *  lazily and reused; language data is fetched on first use (or from cache afterwards). */
export class ImageAttachmentTextExtractor implements AttachmentTextExtractor {
  private worker: Worker | null = null;
  private readonly language: string;

  constructor(language = "eng") {
    this.language = language;
  }

  supports(mimeType: string) {
    return IMAGE_MIME_TYPES.has(mimeType);
  }

  async extract(buffer: Buffer): Promise<ExtractedAttachmentText> {
    if (!this.worker) this.worker = await createWorker(this.language);
    const { data } = await this.worker.recognize(buffer);
    return { text: normalizeAttachmentText(data.text) };
  }

  async destroy(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}

export class AttachmentExtractorRegistry {
  constructor(private readonly extractors: readonly AttachmentTextExtractor[]) {}

  supports(mimeType: string): boolean {
    return this.extractors.some((extractor) => extractor.supports(mimeType));
  }

  async extract(mimeType: string, buffer: Buffer): Promise<ExtractedAttachmentText> {
    const extractor = this.extractors.find((item) => item.supports(mimeType));
    if (!extractor) throw new Error("ATTACHMENT_FILE_TYPE_UNSUPPORTED");
    const result = await extractor.extract(buffer);
    if (!result.text.trim()) throw new Error("ATTACHMENT_TEXT_NOT_EXTRACTABLE");
    return result;
  }
}
