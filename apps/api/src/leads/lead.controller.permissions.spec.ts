import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  PERMISSION_METADATA,
  type PermissionRequirement
} from "../identity/presentation/http/permission.decorators";
import { LeadController } from "./lead.controller";

function permissionFor(method: keyof LeadController): PermissionRequirement | undefined {
  return Reflect.getMetadata(PERMISSION_METADATA, LeadController.prototype[method] as object);
}

describe("LeadController (Krevia CRM) RBAC wiring", () => {
  it("requires leads.read for summary", () => {
    expect(permissionFor("summary")).toEqual({ mode: "all", permissions: ["leads.read"] });
  });
  it("requires leads.read for listing leads", () => {
    expect(permissionFor("list")).toEqual({ mode: "all", permissions: ["leads.read"] });
  });
  it("requires leads.read for reading a lead by reference", () => {
    expect(permissionFor("getByReference")).toEqual({ mode: "all", permissions: ["leads.read"] });
  });
  it("requires leads.read for reading a single lead", () => {
    expect(permissionFor("get")).toEqual({ mode: "all", permissions: ["leads.read"] });
  });
  it("requires leads.read for reading a lead's activity timeline", () => {
    expect(permissionFor("activity")).toEqual({ mode: "all", permissions: ["leads.read"] });
  });
  it("requires leads.create for manually creating a lead", () => {
    expect(permissionFor("create")).toEqual({ mode: "all", permissions: ["leads.create"] });
  });
  it("requires leads.update for updating a lead", () => {
    expect(permissionFor("update")).toEqual({ mode: "all", permissions: ["leads.update"] });
  });
  it("requires leads.notes for adding a note", () => {
    expect(permissionFor("addNote")).toEqual({ mode: "all", permissions: ["leads.notes"] });
  });
  it("requires leads.assign for assigning a lead", () => {
    expect(permissionFor("assign")).toEqual({ mode: "all", permissions: ["leads.assign"] });
  });
});
