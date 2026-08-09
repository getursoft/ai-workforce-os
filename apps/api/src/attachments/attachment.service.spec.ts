import { describe, expect, it, vi } from "vitest";
import { ConversationAttachmentService, InMemoryAttachmentFileStore, type UploadedAttachmentFile } from "./attachment.service";
import { AttachmentExtractorRegistry, PlainAttachmentTextExtractor } from "./attachment.extractors";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { FeatureFlagService } from "../feature-flags/feature-flag.service";
import type { SkillsRuntimeService } from "../skills-platform/skill-runtime.service";

function makePrisma() {
  return {
    conversationAttachment: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: "attachment-1", ...data })
      )
    }
  } as unknown as PrismaService;
}

function makeFile(overrides: Partial<UploadedAttachmentFile> = {}): UploadedAttachmentFile {
  return {
    originalname: "note.txt",
    mimetype: "text/plain",
    size: 5,
    buffer: Buffer.from("hello"),
    ...overrides
  };
}

function makeExtractors() {
  return new AttachmentExtractorRegistry([new PlainAttachmentTextExtractor()]);
}

describe("ConversationAttachmentService — Sprint 6.1 Phase 10 file routing", () => {
  it("falls back to the legacy extractor when SKILLS_FILE_ROUTING_ENABLED is off", async () => {
    const featureFlags = { isEnabled: vi.fn().mockResolvedValue(false) } as unknown as FeatureFlagService;
    const skillsRuntime = { skillsForEmployee: vi.fn(), execute: vi.fn() } as unknown as SkillsRuntimeService;
    const service = new ConversationAttachmentService(
      makePrisma(),
      makeExtractors(),
      new InMemoryAttachmentFileStore(),
      undefined,
      featureFlags,
      skillsRuntime
    );
    const row = await service.upload("org-1", "employee-1", "conv-1", "user-1", makeFile());
    expect(row.extractedText).toBe("hello");
    expect(skillsRuntime.skillsForEmployee).not.toHaveBeenCalled();
  });

  it("falls back to the legacy extractor when the employee has no granted skill supporting this MIME type", async () => {
    const featureFlags = { isEnabled: vi.fn().mockResolvedValue(true) } as unknown as FeatureFlagService;
    const skillsRuntime = {
      skillsForEmployee: vi.fn().mockResolvedValue([]),
      execute: vi.fn()
    } as unknown as SkillsRuntimeService;
    const service = new ConversationAttachmentService(
      makePrisma(),
      makeExtractors(),
      new InMemoryAttachmentFileStore(),
      undefined,
      featureFlags,
      skillsRuntime
    );
    const row = await service.upload("org-1", "employee-1", "conv-1", "user-1", makeFile());
    expect(row.extractedText).toBe("hello");
    expect(skillsRuntime.execute).not.toHaveBeenCalled();
  });

  it("routes through the Document Reader skill when enabled and granted, using its structured output", async () => {
    const featureFlags = { isEnabled: vi.fn().mockResolvedValue(true) } as unknown as FeatureFlagService;
    const skillsRuntime = {
      skillsForEmployee: vi.fn().mockResolvedValue([
        { skillKey: "document-reader", supportedMimeTypes: ["text/plain"] }
      ]),
      execute: vi.fn().mockResolvedValue({ data: { text: "Skill-extracted: hello" } })
    } as unknown as SkillsRuntimeService;
    const service = new ConversationAttachmentService(
      makePrisma(),
      makeExtractors(),
      new InMemoryAttachmentFileStore(),
      undefined,
      featureFlags,
      skillsRuntime
    );
    const row = await service.upload("org-1", "employee-1", "conv-1", "user-1", makeFile());
    expect(row.extractedText).toBe("Skill-extracted: hello");
    expect(skillsRuntime.execute).toHaveBeenCalledWith(
      expect.objectContaining({ skillKey: "document-reader", organizationId: "org-1", pluginInstallationId: "employee-1" })
    );
  });

  it("falls back to the legacy extractor when the skill runtime throws, never failing the upload", async () => {
    const featureFlags = { isEnabled: vi.fn().mockResolvedValue(true) } as unknown as FeatureFlagService;
    const skillsRuntime = {
      skillsForEmployee: vi.fn().mockResolvedValue([
        { skillKey: "document-reader", supportedMimeTypes: ["text/plain"] }
      ]),
      execute: vi.fn().mockRejectedValue(new Error("SKILL_NOT_INSTALLED"))
    } as unknown as SkillsRuntimeService;
    const service = new ConversationAttachmentService(
      makePrisma(),
      makeExtractors(),
      new InMemoryAttachmentFileStore(),
      undefined,
      featureFlags,
      skillsRuntime
    );
    const row = await service.upload("org-1", "employee-1", "conv-1", "user-1", makeFile());
    expect(row.extractedText).toBe("hello");
  });

  it("still rejects an unsupported file type when no skill routing is available at all", async () => {
    const service = new ConversationAttachmentService(
      makePrisma(),
      makeExtractors(),
      new InMemoryAttachmentFileStore()
    );
    await expect(
      service.upload("org-1", "employee-1", "conv-1", "user-1", makeFile({ mimetype: "application/x-unsupported" }))
    ).rejects.toThrow("ATTACHMENT_FILE_TYPE_UNSUPPORTED");
  });
});
