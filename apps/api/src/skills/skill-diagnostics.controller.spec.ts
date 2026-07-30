import { GUARDS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { PERMISSION_METADATA } from "../identity/presentation/http/permission.decorators";
import { SkillDiagnosticsController } from "./skill-diagnostics.controller";

describe("SkillDiagnosticsController protection", () => {
  it.each([
    "summary",
    "execution",
    "createReviewSession",
    "reviewSession",
    "startReviewSession",
    "completeReviewSession",
    "archiveReviewSession",
    "reviewReport"
  ] as const)("protects %s with the existing execution-history permission", (method) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      SkillDiagnosticsController.prototype,
      method
    );
    expect(Reflect.getMetadata(PERMISSION_METADATA, descriptor?.value)).toEqual({
      mode: "all",
      permissions: ["agents.executions.read"]
    });
    expect(Reflect.getMetadata(GUARDS_METADATA, SkillDiagnosticsController)).toHaveLength(2);
  });
});
