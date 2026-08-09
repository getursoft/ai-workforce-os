import JSZip from "jszip";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import {
  DocxKnowledgeTextExtractor,
  KnowledgeExtractorRegistry,
  PdfKnowledgeTextExtractor,
  PlainKnowledgeTextExtractor,
  XlsxKnowledgeTextExtractor,
  ZipKnowledgeTextExtractor
} from "./knowledge.extractors";

function buildXlsxBuffer(sheets: Record<string, string[][]>): Buffer {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("XlsxKnowledgeTextExtractor", () => {
  const extractor = new XlsxKnowledgeTextExtractor();

  it("supports only the xlsx mime type", () => {
    expect(extractor.supports("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(
      true
    );
    expect(extractor.supports("application/pdf")).toBe(false);
  });

  it("extracts cell content from every sheet, headed by sheet name", async () => {
    const buffer = buildXlsxBuffer({
      Policy: [
        ["Route", "Refund"],
        ["Domestic", "80%"]
      ],
      Notes: [["Internal use only"]]
    });
    const result = await extractor.extract(buffer);
    expect(result.text).toContain("## Policy");
    expect(result.text).toContain("Route,Refund");
    expect(result.text).toContain("Domestic,80%");
    expect(result.text).toContain("## Notes");
    expect(result.text).toContain("Internal use only");
  });

  it("skips genuinely empty sheets without producing a bare heading", async () => {
    const buffer = buildXlsxBuffer({ Empty: [[]], Real: [["hello"]] });
    const result = await extractor.extract(buffer);
    expect(result.text).not.toContain("## Empty");
    expect(result.text).toContain("## Real");
  });
});

describe("ZipKnowledgeTextExtractor", () => {
  const inner = [new PlainKnowledgeTextExtractor(), new XlsxKnowledgeTextExtractor()];
  const extractor = new ZipKnowledgeTextExtractor(inner);

  it("supports only the zip mime type", () => {
    expect(extractor.supports("application/zip")).toBe(true);
    expect(extractor.supports("application/pdf")).toBe(false);
  });

  it("extracts and concatenates every supported entry, headed by filename", async () => {
    const zip = new JSZip();
    zip.file("notes.txt", "first file content");
    zip.file("policy.md", "# Policy\nsecond file content");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await extractor.extract(buffer);
    expect(result.text).toContain("## notes.txt");
    expect(result.text).toContain("first file content");
    expect(result.text).toContain("## policy.md");
    expect(result.text).toContain("second file content");
  });

  it("silently skips entries with an unsupported extension instead of failing the whole archive", async () => {
    const zip = new JSZip();
    zip.file("readme.txt", "kept");
    zip.file("logo.png", Buffer.from([0, 1, 2, 3]));
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await extractor.extract(buffer);
    expect(result.text).toContain("kept");
    expect(result.text).not.toContain("logo.png");
  });

  it("skips directory entries", async () => {
    const zip = new JSZip();
    zip.folder("docs");
    zip.file("docs/readme.txt", "inside a folder");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await extractor.extract(buffer);
    expect(result.text).toContain("inside a folder");
  });

  it("rejects an archive with more entries than the configured limit", async () => {
    const zip = new JSZip();
    for (let i = 0; i < 201; i++) zip.file(`file-${i}.txt`, "x");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    await expect(extractor.extract(buffer)).rejects.toThrow("KNOWLEDGE_ZIP_TOO_MANY_ENTRIES");
  });

  it("rejects an archive whose total uncompressed content exceeds the size guard (zip-bomb defense)", async () => {
    const zip = new JSZip();
    // Highly compressible content so the zip file itself stays small while uncompressed content is huge.
    zip.file("huge.txt", "a".repeat(101 * 1024 * 1024), { compression: "DEFLATE" });
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    await expect(extractor.extract(buffer)).rejects.toThrow("KNOWLEDGE_ZIP_TOO_LARGE");
  });

  it("does not include a nested zip's contents (no zip-in-zip recursion)", async () => {
    const innerZip = new JSZip();
    innerZip.file("secret.txt", "nested content");
    const innerBuffer = await innerZip.generateAsync({ type: "nodebuffer" });
    const outerZip = new JSZip();
    outerZip.file("inner.zip", innerBuffer);
    outerZip.file("visible.txt", "outer content");
    const buffer = await outerZip.generateAsync({ type: "nodebuffer" });
    const result = await extractor.extract(buffer);
    expect(result.text).toContain("outer content");
    expect(result.text).not.toContain("nested content");
  });
});

describe("KnowledgeExtractorRegistry with all five extractors registered", () => {
  const registry = new KnowledgeExtractorRegistry([
    new PlainKnowledgeTextExtractor(),
    new PdfKnowledgeTextExtractor(),
    new DocxKnowledgeTextExtractor(),
    new XlsxKnowledgeTextExtractor(),
    new ZipKnowledgeTextExtractor([new PlainKnowledgeTextExtractor(), new XlsxKnowledgeTextExtractor()])
  ]);

  it("routes an xlsx buffer to XlsxKnowledgeTextExtractor", async () => {
    const buffer = buildXlsxBuffer({ Sheet1: [["hello world"]] });
    const result = await registry.extract(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer
    );
    expect(result.text).toContain("hello world");
  });

  it("routes a zip buffer to ZipKnowledgeTextExtractor", async () => {
    const zip = new JSZip();
    zip.file("a.txt", "zip routed correctly");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await registry.extract("application/zip", buffer);
    expect(result.text).toContain("zip routed correctly");
  });

  it("still throws KNOWLEDGE_TEXT_NOT_EXTRACTABLE for a zip whose only entries are unsupported", async () => {
    const zip = new JSZip();
    zip.file("image.png", Buffer.from([0, 1, 2]));
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    await expect(registry.extract("application/zip", buffer)).rejects.toThrow(
      "KNOWLEDGE_TEXT_NOT_EXTRACTABLE"
    );
  });
});
