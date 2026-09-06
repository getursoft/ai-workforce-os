import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PERMISSION_METADATA, type PermissionRequirement } from "../identity/presentation/http/permission.decorators";
import { VoiceCallHistoryController } from "./voice-call-history.controller";

function permissionFor(method: keyof VoiceCallHistoryController): PermissionRequirement | undefined {
  return Reflect.getMetadata(PERMISSION_METADATA, VoiceCallHistoryController.prototype[method] as object);
}

describe("VoiceCallHistoryController RBAC wiring (Sprint 7.11 STEP 4)", () => {
  it("requires channel.message.read for list and get", () => {
    expect(permissionFor("list")).toEqual({ mode: "all", permissions: ["channel.message.read"] });
    expect(permissionFor("get")).toEqual({ mode: "all", permissions: ["channel.message.read"] });
  });
  it("requires the dedicated channel.voice.transcript.read permission for the transcript endpoint", () => {
    expect(permissionFor("transcript")).toEqual({ mode: "all", permissions: ["channel.voice.transcript.read"] });
  });
});
