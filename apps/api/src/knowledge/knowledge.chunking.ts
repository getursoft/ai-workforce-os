import { Injectable } from "@nestjs/common";
import type { ExtractedKnowledgeDocument } from "./knowledge.types";

export interface KnowledgeChunkInput {
  content: string;
  tokenCount: number;
  pageNumber?: number;
  heading?: string;
  sectionTitle?: string;
  isTable?: boolean;
  metadata: Record<string, unknown>;
}

interface KnowledgeBlock {
  kind: "text" | "table";
  heading: string | null;
  headingPath: string[];
  pageNumber?: number;
  lines: string[];
}

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
/** Lines with 2+ pipes are treated as markdown table rows (the only table structure that survives
 * text extraction — see knowledge.extractors.ts, which collapses PDF/DOCX layout to plain text). */
const TABLE_ROW = /\|.*\|/;
/** A short, punctuation-free standalone line surrounded by blank lines reads as a heading in plain
 * text/PDF/DOCX output that has no markdown markup left after extraction. */
const PLAIN_HEADING = /^(?:[0-9]+[.)]\s*)?[A-Z][A-Za-z0-9 ,&'/()-]{2,90}:?$/;

const MIN_TARGET_TOKENS = 400;
const MAX_TARGET_TOKENS = 600;
const MIN_OVERLAP_TOKENS = 80;
const MAX_OVERLAP_TOKENS = 120;

@Injectable()
export class KnowledgeChunkingService {
  private readonly targetTokens: number;
  private readonly overlapTokens: number;
  constructor(
    targetTokens = 500,
    overlapTokens = 100,
    private readonly minimumTokens = 50
  ) {
    this.targetTokens = clamp(targetTokens, MIN_TARGET_TOKENS, MAX_TARGET_TOKENS);
    this.overlapTokens = clamp(overlapTokens, MIN_OVERLAP_TOKENS, MAX_OVERLAP_TOKENS);
    if (this.overlapTokens >= this.targetTokens) throw new Error("KNOWLEDGE_CHUNK_CONFIG_INVALID");
  }
  chunk(document: ExtractedKnowledgeDocument): KnowledgeChunkInput[] {
    const sections: Array<{ text: string; pageNumber?: number }> = document.pages?.length
      ? document.pages.map((page) => ({ text: page.text, pageNumber: page.pageNumber }))
      : [{ text: document.text }];
    // Scoped to this single chunk() call (never a field on the service instance, which is a shared
    // singleton) so one document's markdown structure can never leak into another's chunking pass.
    const structure = { sawAtxHeading: false };
    return sections.flatMap((section) =>
      this.blocksFor(section.text, section.pageNumber, structure).flatMap((block) =>
        block.kind === "table" ? [this.tableChunk(block)] : this.splitTextBlock(block)
      )
    );
  }
  private blocksFor(
    text: string,
    pageNumber: number | undefined,
    structure: { sawAtxHeading: boolean }
  ): KnowledgeBlock[] {
    const lines = text.split("\n");
    const blocks: KnowledgeBlock[] = [];
    const headingStack: string[] = [];
    let current: KnowledgeBlock | null = null;
    const flush = () => {
      if (current && current.lines.some((line) => line.trim())) blocks.push(current);
      current = null;
    };
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      const trimmed = line.trim();
      if (!trimmed) continue;
      const atx = ATX_HEADING.exec(trimmed);
      if (atx) structure.sawAtxHeading = true;
      // The PLAIN_HEADING heuristic exists only for plain-text/PDF/DOCX output that has no markdown
      // markup left after extraction (see knowledge.extractors.ts). Once a document has demonstrated
      // real ATX heading structure, trust that structure exclusively — otherwise an ordinary short,
      // capitalized, standalone sentence (e.g. "This follows the standard tiered structure used
      // across most travel companies:") is misread as a new, level-1 heading, which truncates
      // headingStack back to empty (see below) and silently detaches every subsequent chunk — table
      // rows included — from its real section heading (e.g. "2.2 Standard Cancellation Windows &
      // Refund Tiers"). This was corrupting retrieval ranking for real policy documents.
      const isPlainHeading =
        !atx &&
        !structure.sawAtxHeading &&
        PLAIN_HEADING.test(trimmed) &&
        !(lines[index - 1] ?? "").trim() &&
        !(lines[index + 1] ?? "").trim();
      if (atx || isPlainHeading) {
        flush();
        const level = atx ? (atx[1]?.length ?? 1) : 1;
        const text = atx ? (atx[2] ?? trimmed) : trimmed.replace(/:$/, "");
        headingStack.length = Math.min(headingStack.length, level - 1);
        headingStack[level - 1] = text;
        continue;
      }
      const isTableRow = TABLE_ROW.test(trimmed);
      if (isTableRow && current?.kind === "table") {
        current.lines.push(trimmed);
        continue;
      }
      if (isTableRow) {
        flush();
        current = {
          kind: "table",
          heading: headingStack.at(-1) ?? null,
          headingPath: headingStack.filter(Boolean),
          ...(pageNumber ? { pageNumber } : {}),
          lines: [trimmed]
        };
        continue;
      }
      if (current?.kind !== "text") {
        flush();
        current = {
          kind: "text",
          heading: headingStack.at(-1) ?? null,
          headingPath: headingStack.filter(Boolean),
          ...(pageNumber ? { pageNumber } : {}),
          lines: []
        };
      }
      current.lines.push(trimmed);
    }
    flush();
    return blocks;
  }
  private tableChunk(block: KnowledgeBlock): KnowledgeChunkInput {
    const content = block.lines.join("\n");
    return {
      content,
      tokenCount: estimateTokens(content),
      ...(block.pageNumber ? { pageNumber: block.pageNumber } : {}),
      ...(block.heading ? { heading: block.heading, sectionTitle: block.heading } : {}),
      isTable: true,
      metadata: { isTable: true, headingPath: block.headingPath }
    };
  }
  private splitTextBlock(block: KnowledgeBlock): KnowledgeChunkInput[] {
    return this.split(block.lines.join(" ")).map((content) => ({
      content,
      tokenCount: estimateTokens(content),
      ...(block.pageNumber ? { pageNumber: block.pageNumber } : {}),
      ...(block.heading ? { heading: block.heading, sectionTitle: block.heading } : {}),
      isTable: false,
      metadata: { isTable: false, headingPath: block.headingPath }
    }));
  }
  private split(text: string): string[] {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    if (words.length <= this.targetTokens) return [words.join(" ")];
    const chunks: string[] = [];
    const step = this.targetTokens - this.overlapTokens;
    for (let start = 0; start < words.length; start += step) {
      const value = words
        .slice(start, start + this.targetTokens)
        .join(" ")
        .trim();
      if (!value) continue;
      if (estimateTokens(value) < this.minimumTokens && chunks.length) {
        chunks[chunks.length - 1] = `${chunks.at(-1)} ${value}`;
      } else chunks.push(value);
      if (start + this.targetTokens >= words.length) break;
    }
    return chunks;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.trim().length / 4));
}
