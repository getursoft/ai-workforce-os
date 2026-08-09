import { Injectable } from "@nestjs/common";
import type { KnowledgeVirusScanner } from "./knowledge.types";

/** Extension point only: this implementation does not claim to scan uploads. */
@Injectable()
export class NoopKnowledgeVirusScanner implements KnowledgeVirusScanner {
  async scan(buffer: Buffer): Promise<void> {
    void buffer;
  }
}
