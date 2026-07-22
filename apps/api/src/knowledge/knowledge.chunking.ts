import { Injectable } from "@nestjs/common";
import type { ExtractedKnowledgeDocument } from "./knowledge.types";

export interface KnowledgeChunkInput {
  content: string;
  tokenCount: number;
  pageNumber?: number;
  sectionTitle?: string;
}

@Injectable()
export class KnowledgeChunkingService {
  constructor(
    private readonly targetTokens = 800,
    private readonly overlapTokens = 100,
    private readonly minimumTokens = 50
  ) {
    if (overlapTokens >= targetTokens) throw new Error("KNOWLEDGE_CHUNK_CONFIG_INVALID");
  }
  chunk(document: ExtractedKnowledgeDocument): KnowledgeChunkInput[] {
    const sections: Array<{ text: string; pageNumber?: number }> = document.pages?.length
      ? document.pages.map((page) => ({ text: page.text, pageNumber: page.pageNumber }))
      : [{ text: document.text }];
    return sections.flatMap((section) =>
      this.split(section.text).map((content) => ({
        content,
        tokenCount: estimateTokens(content),
        ...(section.pageNumber ? { pageNumber: section.pageNumber } : {})
      }))
    );
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

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.trim().length / 4));
}
