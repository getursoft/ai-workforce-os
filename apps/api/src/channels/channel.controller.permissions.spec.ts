import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PERMISSION_METADATA, type PermissionRequirement } from "../identity/presentation/http/permission.decorators";
import { ChannelController } from "./channel.controller";

function permissionFor(method: keyof ChannelController): PermissionRequirement | undefined {
  return Reflect.getMetadata(PERMISSION_METADATA, ChannelController.prototype[method] as object);
}

describe("ChannelController RBAC wiring", () => {
  it("requires channel.read for list/get", () => {
    expect(permissionFor("list")).toEqual({ mode: "all", permissions: ["channel.read"] });
    expect(permissionFor("get")).toEqual({ mode: "all", permissions: ["channel.read"] });
  });
  it("requires channel.create for creation", () => {
    expect(permissionFor("create")).toEqual({ mode: "all", permissions: ["channel.create"] });
  });
  it("requires channel.update for update, enable and disable", () => {
    expect(permissionFor("update")).toEqual({ mode: "all", permissions: ["channel.update"] });
    expect(permissionFor("enable")).toEqual({ mode: "all", permissions: ["channel.update"] });
    expect(permissionFor("disable")).toEqual({ mode: "all", permissions: ["channel.update"] });
  });
  it("requires channel.delete for removal", () => {
    expect(permissionFor("remove")).toEqual({ mode: "all", permissions: ["channel.delete"] });
  });
  it("requires channel.test for connection tests", () => {
    expect(permissionFor("test")).toEqual({ mode: "all", permissions: ["channel.test"] });
  });
  it("requires channel.message.read for conversations and messages", () => {
    expect(permissionFor("conversations")).toEqual({
      mode: "all",
      permissions: ["channel.message.read"]
    });
    expect(permissionFor("messages")).toEqual({
      mode: "all",
      permissions: ["channel.message.read"]
    });
  });
});
