import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import type { SkillExecutionContext } from "@ai-workforce-os/skill-sdk";
import { FileValidationSkill } from "./file-validation.skill";

function makeContext(configuration: Record<string, unknown> = {}): SkillExecutionContext {
  return {
    organizationId: "org-1",
    grantedPermissions: new Set(["skill.execute"]),
    grantedCapabilities: new Set(),
    configuration,
    idempotencyKey: "test-key",
    capabilities: {}
  };
}

describe("FileValidationSkill", () => {
  const skill = new FileValidationSkill();

  it("passes a well-formed, correctly-typed small text file", async () => {
    const content = Buffer.from("hello world").toString("base64");
    const result = await skill.execute(
      { fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 11, content },
      makeContext()
    );
    expect(result.data.valid).toBe(true);
    expect(result.data.errors).toEqual([]);
  });

  it("flags a MIME type that does not match the declared extension", async () => {
    const result = await skill.execute(
      { fileName: "report.pdf", mimeType: "text/plain", sizeBytes: 3 },
      makeContext()
    );
    expect(result.data.valid).toBe(false);
    expect(result.data.checks.mimeTypeConsistentWithExtension).toBe(false);
  });

  it("flags a disallowed extension", async () => {
    const result = await skill.execute(
      { fileName: "payload.exe", mimeType: "application/octet-stream", sizeBytes: 3 },
      makeContext()
    );
    expect(result.data.valid).toBe(false);
    expect(result.data.checks.extensionAllowed).toBe(false);
  });

  it("flags a file exceeding the configured max size", async () => {
    const result = await skill.execute(
      { fileName: "big.txt", mimeType: "text/plain", sizeBytes: 200 },
      makeContext({ maxSizeBytes: 100 })
    );
    expect(result.data.valid).toBe(false);
    expect(result.data.checks.sizeWithinLimit).toBe(false);
  });

  it("verifies a matching checksum and rejects a mismatched one", async () => {
    const buffer = Buffer.from("checksum me");
    const correctChecksum = createHash("sha256").update(buffer).digest("hex");
    const content = buffer.toString("base64");

    const ok = await skill.execute(
      { fileName: "a.txt", mimeType: "text/plain", sizeBytes: buffer.byteLength, content, expectedChecksumSha256: correctChecksum },
      makeContext()
    );
    expect(ok.data.checks.checksumVerified).toBe(true);

    const bad = await skill.execute(
      {
        fileName: "a.txt",
        mimeType: "text/plain",
        sizeBytes: buffer.byteLength,
        content,
        expectedChecksumSha256: "0".repeat(64)
      },
      makeContext()
    );
    expect(bad.data.checks.checksumVerified).toBe(false);
    expect(bad.data.valid).toBe(false);
  });

  it("rejects a path-traversal file name", async () => {
    const result = await skill.execute(
      { fileName: "../../etc/passwd", mimeType: "text/plain", sizeBytes: 3 },
      makeContext()
    );
    expect(result.data.valid).toBe(false);
    expect(result.data.checks.pathSafe).toBe(false);
  });

  it("accepts a well-formed small ZIP archive as archive-safe", async () => {
    const zip = new JSZip();
    zip.file("readme.txt", "hello");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await skill.execute(
      { fileName: "bundle.zip", mimeType: "application/zip", sizeBytes: buffer.byteLength, content: buffer.toString("base64") },
      makeContext()
    );
    expect(result.data.checks.archiveSafe).toBe(true);
    expect(result.data.valid).toBe(true);
  });

  it("rejects a ZIP archive containing a path-traversal entry (zip-slip defense)", async () => {
    const zip = new JSZip();
    zip.file("../../evil.txt", "gotcha");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await skill.execute(
      { fileName: "bundle.zip", mimeType: "application/zip", sizeBytes: buffer.byteLength, content: buffer.toString("base64") },
      makeContext()
    );
    expect(result.data.checks.archiveSafe).toBe(false);
    expect(result.data.valid).toBe(false);
  });

  it("rejects a ZIP archive with too many entries (zip-bomb entry-count defense)", async () => {
    const zip = new JSZip();
    for (let i = 0; i < 210; i++) zip.file(`file-${i}.txt`, "x");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await skill.execute(
      { fileName: "bundle.zip", mimeType: "application/zip", sizeBytes: buffer.byteLength, content: buffer.toString("base64") },
      makeContext()
    );
    expect(result.data.checks.archiveSafe).toBe(false);
    expect(result.data.errors.some((e) => e.includes("too many entries"))).toBe(true);
  });

  it("honors a configured allowedExtensions allowlist narrower than the default set", async () => {
    const result = await skill.execute(
      { fileName: "sheet.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 3 },
      makeContext({ allowedExtensions: [".txt"] })
    );
    expect(result.data.checks.extensionAllowed).toBe(false);
  });

  it("health reports HEALTHY", async () => {
    const health = await skill.health();
    expect(health.status).toBe("HEALTHY");
  });
});
