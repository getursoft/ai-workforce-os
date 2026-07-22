import { BadRequestException, Injectable } from "@nestjs/common";
import { KnowledgeDocumentStatus } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { KnowledgeSearchDto } from "./knowledge.dto";
import { KnowledgeEmbeddingService } from "./knowledge.embedding";
import type { KnowledgeSource } from "./knowledge.types";

@Injectable()
export class KnowledgeSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: KnowledgeEmbeddingService,
    private readonly candidateLimit = 1000
  ) {}
  async search(organizationId: string, input: KnowledgeSearchDto): Promise<KnowledgeSource[]> {
    if (!input.query.trim()) throw new BadRequestException("KNOWLEDGE_SEARCH_QUERY_REQUIRED");
    const eligible = await this.prisma.knowledgeDocument.count({
      where: {
        organizationId,
        status: KnowledgeDocumentStatus.INDEXED,
        deletedAt: null,
        ...(input.documentIds?.length ? { id: { in: input.documentIds } } : {})
      }
    });
    if (!eligible) return [];
    const query = (await this.embeddings.embed(organizationId, [input.query])).vectors[0];
    if (!query) throw new BadRequestException("EMBEDDING_PROVIDER_RESPONSE_INVALID");
    const rows = await this.prisma.knowledgeChunk.findMany({
      where: {
        organizationId,
        embeddingJson: { not: PrismaJsonNull },
        document: {
          organizationId,
          status: KnowledgeDocumentStatus.INDEXED,
          deletedAt: null,
          ...(input.documentIds?.length ? { id: { in: input.documentIds } } : {})
        }
      },
      include: { document: { select: { id: true, title: true } } },
      orderBy: { createdAt: "desc" },
      take: this.candidateLimit
    });
    return rows
      .flatMap((row) => {
        const vector = numberArray(row.embeddingJson);
        if (!vector || vector.length !== query.length) return [];
        const score = cosine(query, vector);
        return score >= input.scoreThreshold
          ? [
              {
                chunkId: row.id,
                documentId: row.document.id,
                title: row.document.title,
                content: row.content,
                chunkIndex: row.chunkIndex,
                pageNumber: row.pageNumber,
                sectionTitle: row.sectionTitle,
                score
              }
            ]
          : [];
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, input.topK);
  }
}

const PrismaJsonNull = { equals: null } as never;
export function cosine(left: number[], right: number[]): number {
  let dot = 0,
    leftMagnitude = 0,
    rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index] ?? 0,
      b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  return leftMagnitude && rightMagnitude ? dot / Math.sqrt(leftMagnitude * rightMagnitude) : 0;
}
function numberArray(value: unknown): number[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "number") ? value : null;
}
