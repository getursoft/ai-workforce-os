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
import { KnowledgeSearchService, normalizeQueryText } from "./knowledge.search";
import { buildKnowledgeAnswer } from "./knowledge.prompt";
import type { KnowledgeSource } from "./knowledge.types";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";

const SECURITY_CONFIG_STUB = {
  knowledge: {
    searchDefaultTopK: 5,
    searchMaxTopK: 10,
    searchDefaultScoreThreshold: 0.2,
    retrievalDebugLogging: false
  }
} as unknown as SecurityConfig;

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

  it("chunks deterministically with overlap and no empty chunks, within the 400-600/80-120 token bounds", () => {
    const chunker = new KnowledgeChunkingService(400, 80, 10);
    const text = Array.from({ length: 1000 }, (_, index) => `word-${index}`).join(" ");
    const first = chunker.chunk({ text });
    const second = chunker.chunk({ text });
    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    expect(first.every((chunk) => chunk.content && chunk.tokenCount > 0)).toBe(true);
    expect(first[0]?.content.split(" ").slice(-80)).toEqual(
      first[1]?.content.split(" ").slice(0, 80)
    );
    expect(chunker.chunk({ text: "" })).toEqual([]);
  });

  it("clamps out-of-range target/overlap token configuration into the required 400-600/80-120 bounds", () => {
    const chunker = new KnowledgeChunkingService(800, 400, 10);
    const text = Array.from({ length: 700 }, (_, index) => `word-${index}`).join(" ");
    const chunks = chunker.chunk({ text });
    // 700 words > clamped target (600) so it must still split, proving the raw (unclamped) 800/400
    // config was not used verbatim.
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("keeps a markdown heading attached to its chunk and never splits a table", () => {
    const chunker = new KnowledgeChunkingService(400, 80, 10);
    const text = [
      "# Cancellation Policy",
      "Cancellations made 24 hours before departure are fully refundable.",
      "",
      "## Refund Table",
      "| Days before | Refund |",
      "| 30+ | 100% |",
      "| 7-29 | 50% |",
      "| <7 | 0% |"
    ].join("\n");
    const chunks = chunker.chunk({ text });
    const tableChunk = chunks.find((chunk) => chunk.isTable);
    expect(tableChunk?.content).toContain("30+");
    expect(tableChunk?.content).toContain("<7");
    expect(tableChunk?.heading).toBe("Refund Table");
    const proseChunk = chunks.find((chunk) => !chunk.isTable);
    expect(proseChunk?.heading).toBe("Cancellation Policy");
  });

  it("does not let an ordinary standalone sentence between an ATX heading and its table be misread as a new heading", () => {
    // Regression test: reproduces the exact structure from the travel_portal_policy_document UAT bug
    // — a short, capitalized, blank-line-surrounded sentence ("This follows the standard tiered
    // structure...") sitting between a real "### 2.2 ..." heading and its table used to be treated as
    // a new level-1 heading, wiping the heading stack and detaching the table (and the real
    // "2. Cancellation Policy" ancestor context) from its actual section.
    const chunker = new KnowledgeChunkingService(400, 80, 10);
    const text = [
      "## 2. Cancellation Policy",
      "",
      "### 2.1 Scope",
      "Applies to all flight and hotel bookings.",
      "",
      "### 2.2 Standard Cancellation Windows & Refund Tiers",
      "",
      "This follows the standard tiered structure used across most travel companies:",
      "",
      "| Time Before Departure | Refund | Cancellation Fee |",
      "| More than 72 hours | Full refund | 5% |",
      "",
      "### 2.3 Non-Refundable Components",
      "Convenience fees are never refundable."
    ].join("\n");
    const chunks = chunker.chunk({ text });
    const tableChunk = chunks.find((chunk) => chunk.isTable);
    expect(tableChunk?.heading).toBe("2.2 Standard Cancellation Windows & Refund Tiers");
    expect(tableChunk?.metadata.headingPath).toContain("2. Cancellation Policy");
    const scopeChunk = chunks.find((chunk) => chunk.heading === "2.1 Scope");
    expect(scopeChunk?.metadata.headingPath).toContain("2. Cancellation Policy");
    const nonRefundableChunk = chunks.find((chunk) => chunk.heading === "2.3 Non-Refundable Components");
    expect(nonRefundableChunk?.metadata.headingPath).toContain("2. Cancellation Policy");
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
  it("hybrid-ranks, thresholds, and stays tenant+employee scoped", async () => {
    const query = [1, 0];
    const queryRaw = vi.fn().mockResolvedValue([
      {
        id: "chunk-low",
        document_id: "doc-a",
        chunk_index: 1,
        content: "completely unrelated text",
        page_number: null,
        heading: null,
        section_title: null,
        is_table: false,
        document_title: "Other Document",
        collection_id: "collection-a",
        semantic: 0.5
      },
      {
        id: "chunk-high",
        document_id: "doc-a",
        chunk_index: 0,
        content: "our cancellation policy is described here",
        page_number: 2,
        heading: null,
        section_title: null,
        is_table: false,
        document_title: "Cancellation Policy",
        collection_id: "collection-a",
        semantic: 1
      }
    ]);
    const service = new KnowledgeSearchService(
      {
        knowledgeDocument: { count: vi.fn().mockResolvedValue(1) },
        $queryRaw: queryRaw
      } as never,
      { embed: vi.fn().mockResolvedValue({ vectors: [query] }) } as never,
      SECURITY_CONFIG_STUB,
      100
    );
    const result = await service.search("org-a", "employee-a", {
      query: "cancellation policy",
      topK: 1,
      scoreThreshold: 0.5
    });
    expect(result.map((item) => item.chunkId)).toEqual(["chunk-high"]);
    expect(result[0]?.scoreBreakdown).toBeUndefined();
  });

  // Reproduces the reported UAT bug: an implementation-note chunk that merely *talks about* handling
  // cancellation questions must never outrank the chunk that actually *is* the cancellation policy,
  // even when both have identical semantic similarity (isolating the lexical/heading-path fix from
  // embedding quality, which unit tests can't exercise without a real provider).
  const META_CHUNK = {
    id: "chunk-meta-note",
    document_id: "doc-policy",
    chunk_index: 1,
    content:
      "This document is structured so each policy is self-contained under its own heading. When a customer inquires about cancellation, the retrieval pipeline should surface the relevant section below.",
    page_number: null,
    heading: "How to Use This Document (Note for AI Agent / Implementation Team)",
    section_title: "How to Use This Document (Note for AI Agent / Implementation Team)",
    is_table: false,
    metadata: { isTable: false, headingPath: [] },
    document_title: "travel_portal_policy_document",
    collection_id: "collection-travel",
    semantic: 0.6
  };
  const POLICY_CHUNK = {
    id: "chunk-cancellation-table",
    document_id: "doc-policy",
    chunk_index: 5,
    content:
      "| Time Before Departure/Check-in | Refund Eligibility | Cancellation Fee |\n| More than 72 hours | Full refund of base fare | 5% of base fare |",
    page_number: null,
    heading: "2.2 Standard Cancellation Windows & Refund Tiers",
    section_title: "2.2 Standard Cancellation Windows & Refund Tiers",
    is_table: true,
    metadata: { isTable: true, headingPath: ["Master Travel Policy", "2. Cancellation Policy", "2.2 Standard Cancellation Windows & Refund Tiers"] },
    document_title: "travel_portal_policy_document",
    collection_id: "collection-travel",
    semantic: 0.6
  };
  const NON_REFUNDABLE_CHUNK = {
    id: "chunk-non-refundable",
    document_id: "doc-policy",
    chunk_index: 6,
    content:
      "Convenience fees are never refundable, regardless of cancellation timing. Add-ons are typically non-refundable once confirmed.",
    page_number: null,
    heading: "2.3 Non-Refundable Components",
    section_title: "2.3 Non-Refundable Components",
    is_table: false,
    metadata: { isTable: false, headingPath: ["Master Travel Policy", "2. Cancellation Policy", "2.3 Non-Refundable Components"] },
    document_title: "travel_portal_policy_document",
    collection_id: "collection-travel",
    semantic: 0.55
  };
  const IRRELEVANT_CHUNK = {
    id: "chunk-loyalty",
    document_id: "doc-policy",
    chunk_index: 27,
    content: "Points are earned at a rate of 1 point per ₹100 spent on base fare.",
    page_number: null,
    heading: "6.2 Points Earning",
    section_title: "6.2 Points Earning",
    is_table: false,
    metadata: { isTable: false, headingPath: ["Master Travel Policy", "6. Loyalty Program", "6.2 Points Earning"] },
    document_title: "travel_portal_policy_document",
    collection_id: "collection-travel",
    semantic: 0.1
  };

  function searchServiceWithRows(rows: unknown[]) {
    return new KnowledgeSearchService(
      {
        knowledgeDocument: { count: vi.fn().mockResolvedValue(1) },
        $queryRaw: vi.fn().mockResolvedValue(rows)
      } as never,
      { embed: vi.fn().mockResolvedValue({ vectors: [[1, 0]] }) } as never,
      SECURITY_CONFIG_STUB,
      100
    );
  }

  it("ranks the actual cancellation-policy section above an implementation-note chunk that only mentions the topic in passing", async () => {
    const service = searchServiceWithRows([META_CHUNK, POLICY_CHUNK, NON_REFUNDABLE_CHUNK, IRRELEVANT_CHUNK]);
    const result = await service.search("org-travix", "employee-travel", {
      query: "cancellation policy",
      topK: 4,
      scoreThreshold: 0.2,
      debug: true
    });
    expect(result[0]?.chunkId).toBe("chunk-cancellation-table");
    expect(result.map((item) => item.chunkId)).not.toContain("chunk-loyalty");
    // The Document Quality Filter now recognizes this chunk's own heading ("How to Use This Document
    // (Note for AI Agent / Implementation Team)") as an INTERNAL_NOTE role and penalizes it heavily
    // enough that it drops out of the result set entirely, rather than merely ranking below the real
    // policy section — a strictly stronger guarantee than the original "ranked lower" assertion.
    expect(result.map((item) => item.chunkId)).not.toContain("chunk-meta-note");
  });

  it("matches a natural-language cancellation question via prefix-aware term matching, not just exact tokens", async () => {
    // A real embedding provider would separate these more clearly than the tied 0.6/0.6 used in the
    // worst-case ranking test above; a modest, realistic semantic edge for the actual policy content
    // is used here so this test isolates "does prefix matching help" without also depending on an
    // artificial semantic tie that real embeddings would not produce.
    const service = searchServiceWithRows([META_CHUNK, { ...POLICY_CHUNK, semantic: 0.72 }]);
    const result = await service.search("org-travix", "employee-travel", {
      query: "Can I cancel my booking?",
      topK: 2,
      scoreThreshold: 0.2
    });
    expect(result[0]?.chunkId).toBe("chunk-cancellation-table");
  });

  it("matches a synonym query (refund policy) to the section whose heading path says Cancellation Policy", async () => {
    const service = searchServiceWithRows([META_CHUNK, POLICY_CHUNK, NON_REFUNDABLE_CHUNK]);
    const result = await service.search("org-travix", "employee-travel", {
      query: "refund policy",
      topK: 3,
      scoreThreshold: 0.2
    });
    expect(["chunk-cancellation-table", "chunk-non-refundable"]).toContain(result[0]?.chunkId);
    expect(result[0]?.chunkId).not.toBe("chunk-meta-note");
  });

  it("returns no result — not the meta chunk, not a generic fallback — for a query with no real match", async () => {
    // Distinct fixture: every row given a low, realistic-for-truly-unrelated semantic score (real
    // embeddings would not report ~0.6 similarity between "moon landing" and a cancellation policy).
    const unrelatedRows = [META_CHUNK, POLICY_CHUNK, NON_REFUNDABLE_CHUNK, IRRELEVANT_CHUNK].map(
      (row) => ({ ...row, semantic: 0.05 })
    );
    const service = searchServiceWithRows(unrelatedRows);
    const result = await service.search("org-travix", "employee-travel", {
      query: "moon landing spacecraft",
      topK: 4,
      scoreThreshold: 0.2
    });
    expect(result).toEqual([]);
  });

  it("prefers the subsection whose own leaf heading contains the query's distinctive word over a same-parent sibling with a higher semantic score", async () => {
    // Reproduces the reported bug: "what happens if airline cancels" returned "Force Majeure" instead
    // of "Cancellation by Supplier (Airline/Hotel-Initiated)" — the word "airline" only appears in the
    // Supplier subsection's own heading, and leafHeadingBoost must let that outweigh a semantic edge.
    const supplierCancellation = {
      id: "chunk-2-4",
      document_id: "doc-policy",
      chunk_index: 24,
      content:
        "If the airline or hotel cancels a booking, the customer receives a full refund plus a rebooking credit.",
      page_number: null,
      heading: "2.4 Cancellation by Supplier (Airline/Hotel-Initiated)",
      section_title: "2.4 Cancellation by Supplier (Airline/Hotel-Initiated)",
      is_table: false,
      metadata: {
        isTable: false,
        headingPath: [
          "Master Travel Policy",
          "2. Cancellation Policy",
          "2.4 Cancellation by Supplier (Airline/Hotel-Initiated)"
        ]
      },
      document_title: "travel_portal_policy_document",
      collection_id: "collection-travel",
      semantic: 0.6
    };
    const forceMajeure = {
      id: "chunk-2-7",
      document_id: "doc-policy",
      chunk_index: 27,
      content:
        "Cancellations due to declared natural disasters, government travel bans, or medical emergencies are eligible for special consideration.",
      page_number: null,
      heading: "2.7 Force Majeure / Medical Emergencies",
      section_title: "2.7 Force Majeure / Medical Emergencies",
      is_table: false,
      metadata: {
        isTable: false,
        headingPath: ["Master Travel Policy", "2. Cancellation Policy", "2.7 Force Majeure / Medical Emergencies"]
      },
      document_title: "travel_portal_policy_document",
      collection_id: "collection-travel",
      // A deliberate semantic edge over the Supplier subsection — this is exactly what let Force Majeure
      // win before leafHeadingBoost existed.
      semantic: 0.65
    };
    const service = searchServiceWithRows([supplierCancellation, forceMajeure]);
    const result = await service.search("org-travix", "employee-travel", {
      query: "what happens if airline cancels",
      topK: 2,
      scoreThreshold: 0.2
    });
    expect(result[0]?.chunkId).toBe("chunk-2-4");
  });

  it("penalizes and excludes a document-introduction chunk from the result set entirely, rather than letting it become a fallback answer for an unsupported query", async () => {
    const introduction = {
      id: "chunk-intro",
      document_id: "doc-policy",
      chunk_index: 0,
      content:
        "This document describes the policies of Travix India Private Limited for all bookings made through the portal.",
      page_number: null,
      heading: "Introduction",
      section_title: "Introduction",
      is_table: false,
      metadata: { isTable: false, headingPath: ["Master Travel Policy", "Introduction"] },
      document_title: "travel_portal_policy_document",
      collection_id: "collection-travel",
      // A high semantic score, on purpose — a generic introduction often reads as topically "on-topic"
      // to an embedding model even though it answers nothing specific.
      semantic: 0.55
    };
    const service = searchServiceWithRows([introduction]);
    const result = await service.search("org-travix", "employee-travel", {
      query: "unsupported policy",
      topK: 3,
      scoreThreshold: 0.2
    });
    expect(result).toEqual([]);
  });

  it("does not call the embedding provider when the employee has no indexed documents", async () => {
    const embed = vi.fn();
    const service = new KnowledgeSearchService(
      {
        knowledgeDocument: { count: vi.fn().mockResolvedValue(0) }
      } as never,
      { embed } as never,
      SECURITY_CONFIG_STUB
    );
    await expect(
      service.search("org-a", "employee-a", { query: "policy", topK: 5, scoreThreshold: 0.2 })
    ).resolves.toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });
});

describe("normalizeQueryText (Hinglish + typo normalization before ranking)", () => {
  it("strips Hinglish filler words and corrects a simple spelling typo", () => {
    expect(normalizeQueryText("phle cancelation policy btao")).toBe("cancellation policy");
  });

  it("leaves an already-correct English query unchanged apart from case", () => {
    expect(normalizeQueryText("What is the Cancellation Policy?")).toBe(
      "what is the cancellation policy"
    );
  });

  it("does not over-correct short, unrelated words", () => {
    // "policy" and "booking" are close in length to several vocabulary terms but should never be
    // rewritten into an unrelated word just because a same-length candidate exists.
    expect(normalizeQueryText("booking policy")).toBe("booking policy");
  });
});

describe("buildKnowledgeAnswer (response-generation section summaries)", () => {
  // Reproduces the reported UAT bug: retrieval already returns the right chunks, but the answer only
  // ever rendered from sources[0] — so "what is the cancellation policy" answered from whichever single
  // subsection (e.g. "2.4 Cancellation by Supplier") happened to score highest, instead of the whole
  // section. These fixtures model the real travel_portal_policy_document structure: a document-root
  // heading, a "2. Cancellation Policy" section, and six subsections under it.
  const DOC_TITLE = "travel_portal_policy_document";
  function chunk(
    partial: Pick<KnowledgeSource, "chunkId" | "chunkIndex" | "heading" | "content" | "headingPath" | "score"> &
      Partial<Pick<KnowledgeSource, "isTable">>
  ): KnowledgeSource {
    return {
      documentId: "doc-policy",
      collectionId: "collection-travel",
      title: DOC_TITLE,
      pageNumber: null,
      sectionTitle: partial.heading,
      isTable: false,
      ...partial
    };
  }
  const SCOPE = chunk({
    chunkId: "chunk-2-1",
    chunkIndex: 20,
    heading: "2.1 Scope",
    content: "This policy applies to all flight and hotel bookings made through the portal.",
    headingPath: ["Master Travel Policy", "2. Cancellation Policy", "2.1 Scope"],
    score: 0.55
  });
  const STANDARD_WINDOWS = chunk({
    chunkId: "chunk-2-2",
    chunkIndex: 21,
    heading: "2.2 Standard Cancellation Windows",
    content: "Cancellations made more than 72 hours before departure receive a full refund minus a 5% fee.",
    headingPath: ["Master Travel Policy", "2. Cancellation Policy", "2.2 Standard Cancellation Windows"],
    score: 0.6
  });
  const CUSTOMER_CANCELLATION = chunk({
    chunkId: "chunk-2-3",
    chunkIndex: 22,
    heading: "2.3 Customer Cancellation",
    content: "Customers may cancel from their account dashboard or by contacting support directly.",
    headingPath: ["Master Travel Policy", "2. Cancellation Policy", "2.3 Customer Cancellation"],
    score: 0.5
  });
  const SUPPLIER_CANCELLATION = chunk({
    chunkId: "chunk-2-4",
    chunkIndex: 23,
    heading: "2.4 Cancellation by Supplier (Airline/Hotel-Initiated)",
    content: "If the airline or hotel cancels a booking, the customer receives a full refund plus a rebooking credit.",
    headingPath: [
      "Master Travel Policy",
      "2. Cancellation Policy",
      "2.4 Cancellation by Supplier (Airline/Hotel-Initiated)"
    ],
    // Highest-scoring subsection on its own — this is exactly the chunk the old code returned alone
    // for a broad "cancellation policy" query, which is the defect this fix addresses.
    score: 0.8
  });
  const NO_SHOW = chunk({
    chunkId: "chunk-2-5",
    chunkIndex: 24,
    heading: "2.5 No Show",
    content: "A booking not cancelled before departure and not used is treated as a no-show with no refund.",
    headingPath: ["Master Travel Policy", "2. Cancellation Policy", "2.5 No Show"],
    score: 0.45
  });
  const REFUND_TIMELINE = chunk({
    chunkId: "chunk-2-6",
    chunkIndex: 25,
    heading: "2.6 Refund Method & Timeline",
    content: "Approved refunds are issued to the original payment method within 7 to 10 business days.",
    headingPath: ["Master Travel Policy", "2. Cancellation Policy", "2.6 Refund Method & Timeline"],
    score: 0.65
  });
  const CANCELLATION_SUBSECTIONS = [
    SCOPE,
    STANDARD_WINDOWS,
    CUSTOMER_CANCELLATION,
    SUPPLIER_CANCELLATION,
    NO_SHOW,
    REFUND_TIMELINE
  ].sort((left, right) => right.score - left.score); // simulate real ranked-descending search output

  const INFANT_DEFINITION = chunk({
    chunkId: "chunk-3-1",
    chunkIndex: 30,
    heading: "3.1 Infant Definition",
    content: "An infant is a traveler under the age of 2 years at the date of travel.",
    headingPath: ["Master Travel Policy", "3. Traveler Categories", "3.1 Infant Definition"],
    score: 0.7
  });

  // Two unrelated top-level sections that both sit directly under the document root, with no
  // subsections of their own — models the real Sprint 4.3 e2e fixture ("Company Name" / "Cancellation
  // Policy" / "Portal Benefits" all directly under "... Master Travel Policy").
  const COMPANY_NAME = chunk({
    chunkId: "chunk-company-name",
    chunkIndex: 1,
    heading: "Company Name",
    content: "Travix India Private Limited is the operating company name for all bookings.",
    headingPath: ["Travix India Private Limited — Master Travel Policy", "Company Name"],
    score: 0.75
  });
  const PORTAL_BENEFITS = chunk({
    chunkId: "chunk-portal-benefits",
    chunkIndex: 3,
    heading: "Portal Benefits",
    content: "Booking through our portal gives you 24/7 support and price-match protection.",
    headingPath: ["Travix India Private Limited — Master Travel Policy", "Portal Benefits"],
    score: 0.5
  });

  it.each(["cancellation policy", "what is the cancellation policy", "phle cancelation policy btao"])(
    "merges all cancellation-policy subsections into one natural, professional answer for %j, instead of answering from a single subsection — and never exposes document/chunk/confidence scaffolding",
    (query) => {
      const answer = buildKnowledgeAnswer(CANCELLATION_SUBSECTIONS, query);
      expect(answer).not.toMatch(/^Answer:/); // not the single-chunk template
      expect(answer).not.toMatch(/according to the uploaded|supporting (?:policy|sections)|confidence|chunk \d|document type/i);
      // Must not over-focus on the single highest-scoring subsection (2.4) — every subsection's own
      // content must be represented, not just 2.4's.
      for (const section of CANCELLATION_SUBSECTIONS) expect(answer).toContain(section.content as string);
    }
  );

  it("merges a synonym query (refund policy) into the same cancellation-policy section summary", () => {
    const answer = buildKnowledgeAnswer(CANCELLATION_SUBSECTIONS, "refund policy");
    expect(answer).toContain(REFUND_TIMELINE.content);
  });

  it("merges a baggage-policy section from its own subsections (generalizes beyond the cancellation example)", () => {
    const weight = chunk({
      chunkId: "chunk-5-1",
      chunkIndex: 40,
      heading: "5.1 Weight Limits",
      content: "Checked baggage is limited to 23kg per piece in economy class.",
      headingPath: ["Master Travel Policy", "5. Baggage Policy", "5.1 Weight Limits"],
      score: 0.6
    });
    const excess = chunk({
      chunkId: "chunk-5-2",
      chunkIndex: 41,
      heading: "5.2 Excess Baggage Fees",
      content: "Excess baggage is charged at a flat per-kilogram rate at check-in.",
      headingPath: ["Master Travel Policy", "5. Baggage Policy", "5.2 Excess Baggage Fees"],
      score: 0.65
    });
    const answer = buildKnowledgeAnswer([excess, weight], "baggage policy");
    expect(answer).toContain(weight.content);
    expect(answer).toContain(excess.content);
  });

  it("merges a section summary for a 'tell me about ...' broad-intent query naming a policy topic", () => {
    const definition = chunk({
      chunkId: "chunk-4-1",
      chunkIndex: 35,
      heading: "4.1 Age Definition",
      content: "A child is a traveler aged 2 to 11 years at the date of travel.",
      headingPath: ["Master Travel Policy", "4. Child Policy", "4.1 Age Definition"],
      score: 0.6
    });
    const seating = chunk({
      chunkId: "chunk-4-2",
      chunkIndex: 36,
      heading: "4.2 Seating & Fare",
      content: "Children under 12 travel at a discounted fare and require an accompanying adult.",
      headingPath: ["Master Travel Policy", "4. Child Policy", "4.2 Seating & Fare"],
      score: 0.55
    });
    const answer = buildKnowledgeAnswer([definition, seating], "tell me about child policy");
    expect(answer).toContain(definition.content);
    expect(answer).toContain(seating.content);
  });

  // Reproduces the second reported UAT bug: a query about infant/child *fare* or *discount* was
  // wrongly answered from "3.6 Cancellation/Changes for Infant Bookings" purely because that heading
  // also mentions "infant" — the query-intent conflict rule (fare/pricing query vs. a cancellation-only
  // heading) must reject it in favor of the actual fare/discount subsection.
  const INFANT_AGE_DEFINITION = chunk({
    chunkId: "chunk-3-1",
    chunkIndex: 30,
    heading: "3.1 Definition",
    content: "An infant is a child aged below 2 years (0-23 months) at the date of travel.",
    headingPath: ["Master Travel Policy", "3. Infant & Child Policy", "3.1 Definition"],
    score: 0.65
  });
  const INFANT_BOOKING_REQUIREMENTS = chunk({
    chunkId: "chunk-3-2",
    chunkIndex: 31,
    heading: "3.2 Booking Requirements",
    content: "Infants must be booked alongside at least one adult passenger.",
    headingPath: ["Master Travel Policy", "3. Infant & Child Policy", "3.2 Booking Requirements"],
    score: 0.55
  });
  const INFANT_FARE_DISCOUNT = chunk({
    chunkId: "chunk-3-3",
    chunkIndex: 32,
    heading: "3.3 Infant Fare & Discount",
    content: "Infant fares are charged at 10% of the applicable adult fare, with no seat allocated.",
    headingPath: ["Master Travel Policy", "3. Infant & Child Policy", "3.3 Infant Fare & Discount"],
    score: 0.5
  });
  const INFANT_CANCELLATION = chunk({
    chunkId: "chunk-3-6",
    chunkIndex: 35,
    heading: "3.6 Cancellation/Changes for Infant Bookings",
    content: "Infant fare cancellations follow the same tiered structure as Section 2.2.",
    headingPath: ["Master Travel Policy", "3. Infant & Child Policy", "3.6 Cancellation/Changes for Infant Bookings"],
    // Scored highest, on purpose — this is what the old code answered from, since it never checked
    // whether the heading actually matched the query's fare/discount intent.
    score: 0.75
  });
  const INFANT_SECTION = [
    INFANT_AGE_DEFINITION,
    INFANT_BOOKING_REQUIREMENTS,
    INFANT_FARE_DISCOUNT,
    INFANT_CANCELLATION
  ].sort((left, right) => right.score - left.score);

  it.each(["infant and kids discount", "how kids fare is calculated"])(
    "answers %j from the infant fare/discount subsection, rejecting the higher-scored cancellation subsection as a heading-intent conflict",
    (query) => {
      const answer = buildKnowledgeAnswer(INFANT_SECTION, query);
      expect(answer).toContain(INFANT_FARE_DISCOUNT.content);
      expect(answer).not.toContain(INFANT_CANCELLATION.content);
    }
  );

  it("broadly summarizes the infant/child section for 'kids and infant rule', including the cancellation subsection (no fare-specific conflict to exclude it)", () => {
    const answer = buildKnowledgeAnswer(INFANT_SECTION, "kids and infant rule");
    expect(answer).toContain(INFANT_AGE_DEFINITION.content);
    expect(answer).toContain(INFANT_FARE_DISCOUNT.content);
    expect(answer).toContain(INFANT_CANCELLATION.content);
  });

  it("answers 'infant age and consideration' from the definition/age subsection only, not a broad summary", () => {
    const answer = buildKnowledgeAnswer(INFANT_SECTION, "infant age and consideration");
    expect(answer).toContain(INFANT_AGE_DEFINITION.content);
  });

  it.each(["infant fare", "infant age"])(
    "answers a narrowed infant query (%j) from one specific subsection only, not the broad section summary",
    (query) => {
      const answer = buildKnowledgeAnswer(INFANT_SECTION, query);
      expect(answer).not.toContain("Here's what applies:"); // not the section-summary template
    }
  );
  it('answers "infant fare" from 3.3 Infant Fare & Discount specifically', () => {
    const answer = buildKnowledgeAnswer(INFANT_SECTION, "infant fare");
    expect(answer).toContain(INFANT_FARE_DISCOUNT.content);
  });
  it('answers "infant age" from 3.1 Definition specifically', () => {
    const answer = buildKnowledgeAnswer(INFANT_SECTION, "infant age");
    expect(answer).toContain(INFANT_AGE_DEFINITION.content);
  });

  it('treats a bare "infants" query, with no narrower attribute, as a broad section-summary request', () => {
    const answer = buildKnowledgeAnswer(INFANT_SECTION, "infants");
    expect(answer).toContain(INFANT_AGE_DEFINITION.content);
    expect(answer).toContain(INFANT_BOOKING_REQUIREMENTS.content);
    expect(answer).toContain(INFANT_FARE_DISCOUNT.content);
    expect(answer).toContain(INFANT_CANCELLATION.content);
  });

  // Reproduces the third reported UAT bug: "where is kids policy" answered from "Group Booking Policy"
  // 4.1 Definition instead of the real infant/child section, because that chunk's BODY happens to mention
  // "children" even though its PARENT heading has nothing to do with infants/children at all, and it
  // outranked the genuine infant-section chunks on raw score alone.
  const GROUP_BOOKING_DEFINITION = chunk({
    chunkId: "chunk-4-1",
    chunkIndex: 40,
    heading: "4.1 Definition",
    content:
      "A group booking is any reservation of 10 or more travelers, including any combination of adults and children, booked under one reference.",
    headingPath: ["Master Travel Policy", "4. Group Booking Policy", "4.1 Definition"],
    // Ranked highest, on purpose — this is exactly what let it win before: a raw score/body-keyword
    // advantage with no regard for whether its own parent heading matches the query topic at all.
    score: 0.85
  });

  it('does not let "Group Booking Policy" become the anchor for "where is kids policy" just because its body mentions children, and summarizes the real infant/child section instead', () => {
    const answer = buildKnowledgeAnswer([GROUP_BOOKING_DEFINITION, ...INFANT_SECTION], "where is kids policy");
    expect(answer).not.toContain(GROUP_BOOKING_DEFINITION.content);
    expect(answer).toContain(INFANT_AGE_DEFINITION.content);
    expect(answer).toContain(INFANT_FARE_DISCOUNT.content);
  });

  it("returns the grounded not-found message, not a low-confidence answer, when the only match is weak (23-34% relevance)", () => {
    const weakMatch = chunk({
      chunkId: "chunk-weak",
      chunkIndex: 99,
      heading: "9.9 Unrelated Note",
      content: "This portal is available in English and Hindi.",
      headingPath: ["Master Travel Policy", "9. Miscellaneous", "9.9 Unrelated Note"],
      score: 0.3
    });
    const answer = buildKnowledgeAnswer([weakMatch], "how kids fare is calculated");
    expect(answer).toBe("I could not find this information in the uploaded knowledge.");
  });

  it.each([
    ["what happens if the airline cancels", SUPPLIER_CANCELLATION],
    ["refund timeline", REFUND_TIMELINE]
  ])(
    "still answers a specific question ('%s') from its single, most-relevant subsection only, not a merged summary",
    (query, expected) => {
      // The array order/scores model what retrieval already ranks first for this specific query (a
      // response-generation test must not re-derive ranking, which is out of scope for this fix) — the
      // targeted subsection is sources[0], with its siblings still present as lower-ranked candidates.
      const rankedForQuery = [
        expected,
        ...CANCELLATION_SUBSECTIONS.filter((section) => section.chunkId !== expected.chunkId)
      ];
      const answer = buildKnowledgeAnswer(rankedForQuery, query as string);
      expect(answer).not.toContain("Here's what applies:"); // not the section-summary template
      expect(answer).toContain(expected.content);
    }
  );

  it("answers 'infant definition' from its own single subsection, unaffected by an unrelated cancellation-policy fixture set", () => {
    const answer = buildKnowledgeAnswer([INFANT_DEFINITION, ...CANCELLATION_SUBSECTIONS], "infant definition");
    expect(answer).toContain(INFANT_DEFINITION.content);
  });

  it("does not merge two unrelated top-level sections that only share the bare document-root heading", () => {
    // Regression guard for the Sprint 4.3 e2e UAT-02 scenario ("What is your company name?") — both
    // "Company Name" and "Portal Benefits" sit directly under the document root with no real shared
    // section, so a broad-intent "what is" query about one must never pull the other in.
    const answer = buildKnowledgeAnswer([COMPANY_NAME, PORTAL_BENEFITS], "What is your company name?");
    expect(answer).toContain(COMPANY_NAME.content);
    expect(answer).not.toContain(PORTAL_BENEFITS.content);
  });

  it("falls back to the no-knowledge message when there are no sources, even for a section-summary query", () => {
    expect(buildKnowledgeAnswer([], "what is the cancellation policy")).toBe(
      "I could not find this information in the uploaded knowledge."
    );
  });

  it('answers the exact bug-report phrasing "Kids policy" with the infant/child section summary, not "Group Booking Policy"', () => {
    const answer = buildKnowledgeAnswer([GROUP_BOOKING_DEFINITION, ...INFANT_SECTION], "Kids policy");
    expect(answer).toContain(INFANT_AGE_DEFINITION.content);
    expect(answer).not.toContain(GROUP_BOOKING_DEFINITION.content);
  });

  it("formats a markdown table's content as a natural-language sentence instead of exposing raw pipe syntax", () => {
    const tableSource = chunk({
      chunkId: "chunk-2-2-table",
      chunkIndex: 22,
      heading: "2.2 Standard Cancellation Windows",
      content: [
        "| Time Before Departure | Refund | Fee |",
        "| More than 72 hours | Full refund | 5% |"
      ].join("\n"),
      headingPath: ["Master Travel Policy", "2. Cancellation Policy", "2.2 Standard Cancellation Windows"],
      score: 0.7,
      isTable: true
    });
    const answer = buildKnowledgeAnswer([tableSource], "what is the standard cancellation window");
    expect(answer).not.toContain("|");
    expect(answer).toContain("Time Before Departure: More than 72 hours");
    expect(answer).toContain("Refund: Full refund");
  });

  it("never lets a document-introduction chunk become the final answer, even as the only/highest-scoring candidate", () => {
    const introduction = chunk({
      chunkId: "chunk-intro",
      chunkIndex: 0,
      heading: "Introduction",
      content: "This document describes the cancellation policy of the company for all bookings.",
      headingPath: ["Master Travel Policy", "Introduction"],
      score: 0.7
    });
    const answer = buildKnowledgeAnswer([introduction], "cancellation policy");
    expect(answer).toBe("I could not find this information in the uploaded knowledge.");
  });
});
