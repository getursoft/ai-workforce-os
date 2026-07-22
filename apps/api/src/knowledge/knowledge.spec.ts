import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { KnowledgeChunkingService } from "./knowledge.chunking";
import {
  DocxKnowledgeTextExtractor,
  normalizeKnowledgeText,
  PdfKnowledgeTextExtractor,
  PlainKnowledgeTextExtractor
} from "./knowledge.extractors";
import { DeterministicEmbeddingProvider } from "./knowledge.embedding";
import { cosine, KnowledgeSearchService } from "./knowledge.search";

describe("knowledge processing primitives", () => {
  it("extracts and normalizes TXT and Markdown without null bytes", async () => {
    const extractor = new PlainKnowledgeTextExtractor();
    expect(extractor.supports("text/plain")).toBe(true);
    expect(extractor.supports("text/markdown")).toBe(true);
    await expect(
      extractor.extract(Buffer.from("# Policy\0\r\n\r\n  Business class"))
    ).resolves.toEqual({ text: "# Policy\n\n Business class" });
    expect(normalizeKnowledgeText("a   b\n\n\nc")).toBe("a b\n\nc");
  });

  it("extracts page-aware text from a small PDF fixture", async () => {
    const result = await new PdfKnowledgeTextExtractor().extract(
      smallPdf("Travel policy permits business class")
    );
    expect(result.text).toContain("Travel policy permits business class");
    expect(result.pages?.[0]).toMatchObject({ pageNumber: 1 });
  });

  it("extracts text from a small DOCX fixture", async () => {
    const result = await new DocxKnowledgeTextExtractor().extract(
      await smallDocx("UAE visa processing policy")
    );
    expect(result.text).toContain("UAE visa processing policy");
  });

  it("chunks deterministically with overlap and no empty chunks", () => {
    const chunker = new KnowledgeChunkingService(100, 20, 10);
    const text = Array.from({ length: 230 }, (_, index) => `word-${index}`).join(" ");
    const first = chunker.chunk({ text });
    const second = chunker.chunk({ text });
    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    expect(first.every((chunk) => chunk.content && chunk.tokenCount > 0)).toBe(true);
    expect(first[0]?.content.split(" ").slice(-20)).toEqual(
      first[1]?.content.split(" ").slice(0, 20)
    );
    expect(chunker.chunk({ text: "" })).toEqual([]);
  });

  it("creates stable deterministic embeddings with useful lexical similarity", async () => {
    const provider = new DeterministicEmbeddingProvider(64);
    const one = await provider.embedTexts({
      organizationId: "org-a",
      texts: ["business class travel policy", "hotel cancellation rules"]
    });
    const two = await provider.embedTexts({
      organizationId: "org-a",
      texts: ["business class travel policy"]
    });
    expect(one.vectors[0]).toEqual(two.vectors[0]);
    expect(one.dimensions).toBe(64);
    expect(cosine(one.vectors.at(0) ?? [], two.vectors.at(0) ?? [])).toBeCloseTo(1);
  });
});

function smallPdf(text: string): Buffer {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const content = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

async function smallDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip
    .folder("_rels")
    ?.file(
      ".rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    );
  zip
    .folder("word")
    ?.file(
      "document.xml",
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
    );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("KnowledgeSearchService", () => {
  it("ranks, thresholds, filters and remains tenant scoped", async () => {
    const query = [1, 0];
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "chunk-low",
        documentId: "doc-a",
        chunkIndex: 1,
        content: "low",
        pageNumber: null,
        sectionTitle: null,
        embeddingJson: [0.5, 0.5],
        document: { id: "doc-a", title: "A" }
      },
      {
        id: "chunk-high",
        documentId: "doc-a",
        chunkIndex: 0,
        content: "high",
        pageNumber: 2,
        sectionTitle: null,
        embeddingJson: [1, 0],
        document: { id: "doc-a", title: "A" }
      }
    ]);
    const service = new KnowledgeSearchService(
      {
        knowledgeDocument: { count: vi.fn().mockResolvedValue(1) },
        knowledgeChunk: { findMany }
      } as never,
      { embed: vi.fn().mockResolvedValue({ vectors: [query] }) } as never,
      100
    );
    const result = await service.search("org-a", {
      query: "policy",
      topK: 1,
      scoreThreshold: 0.5,
      documentIds: ["00000000-0000-4000-8000-000000000001"]
    });
    expect(result.map((item) => item.chunkId)).toEqual(["chunk-high"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org-a" }),
        take: 100
      })
    );
  });

  it("does not call the embedding provider when the tenant has no indexed documents", async () => {
    const embed = vi.fn();
    const service = new KnowledgeSearchService(
      {
        knowledgeDocument: { count: vi.fn().mockResolvedValue(0) }
      } as never,
      { embed } as never
    );
    await expect(
      service.search("org-a", { query: "policy", topK: 5, scoreThreshold: 0.2 })
    ).resolves.toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });
});
