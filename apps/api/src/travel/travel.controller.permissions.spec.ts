import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  PERMISSION_METADATA,
  type PermissionRequirement
} from "../identity/presentation/http/permission.decorators";
import { TravelEmployeeController } from "./travel.controller";

function permissionFor(method: keyof TravelEmployeeController): PermissionRequirement | undefined {
  return Reflect.getMetadata(PERMISSION_METADATA, TravelEmployeeController.prototype[method] as object);
}

describe("TravelEmployeeController RBAC wiring", () => {
  it("requires travel.config.read for reading configuration", () => {
    expect(permissionFor("configuration")).toEqual({ mode: "all", permissions: ["travel.config.read"] });
  });
  it("requires travel.config.update for updating configuration", () => {
    expect(permissionFor("updateConfiguration")).toEqual({
      mode: "all",
      permissions: ["travel.config.update"]
    });
  });
  it("requires agents.conversations.read for reading conversation state", () => {
    expect(permissionFor("state")).toEqual({ mode: "all", permissions: ["agents.conversations.read"] });
  });
  it("requires travel.conversation.reset for resetting a conversation", () => {
    expect(permissionFor("resetConversation")).toEqual({
      mode: "all",
      permissions: ["travel.conversation.reset"]
    });
  });
  it("requires travel.leads.read for listing leads", () => {
    expect(permissionFor("leads")).toEqual({ mode: "all", permissions: ["travel.leads.read"] });
  });
  it("requires travel.leads.update for updating a lead's status", () => {
    expect(permissionFor("updateLeadStatus")).toEqual({ mode: "all", permissions: ["travel.leads.update"] });
  });
});
