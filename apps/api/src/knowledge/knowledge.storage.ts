import { Injectable } from "@nestjs/common";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { KnowledgeFileStorage, KnowledgeVirusScanner } from "./knowledge.types";

@Injectable()
export class LocalKnowledgeFileStorage implements KnowledgeFileStorage {
  private readonly root: string;
  constructor(storagePath: string) {
    this.root = resolve(storagePath);
  }
  async save(input: {
    organizationId: string;
    documentId: string;
    extension: string;
    buffer: Buffer;
  }) {
    const storageKey = `${input.organizationId}/${input.documentId}${input.extension}`;
    const path = this.path(storageKey);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, input.buffer, { mode: 0o600 });
    return { storageKey };
  }
  read(storageKey: string) {
    return readFile(this.path(storageKey));
  }
  async delete(storageKey: string) {
    await rm(this.path(storageKey), { force: true });
  }
  private path(storageKey: string) {
    const path = resolve(this.root, storageKey);
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`))
      throw new Error("KNOWLEDGE_STORAGE_KEY_INVALID");
    return path;
  }
}

/** Extension point only: this implementation does not claim to scan uploads. */
@Injectable()
export class NoopKnowledgeVirusScanner implements KnowledgeVirusScanner {
  async scan(buffer: Buffer): Promise<void> {
    void buffer;
  }
}
