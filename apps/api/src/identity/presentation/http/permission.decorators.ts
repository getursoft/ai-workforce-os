import { SetMetadata } from "@nestjs/common";

export const PERMISSION_METADATA = "identity:permissions";
export type PermissionRequirement = { mode: "all" | "any"; permissions: string[] };
export const RequirePermission = (permission: string): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_METADATA, {
    mode: "all",
    permissions: [permission]
  } satisfies PermissionRequirement);
export const RequireAnyPermission = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_METADATA, { mode: "any", permissions } satisfies PermissionRequirement);
export const RequireAllPermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_METADATA, { mode: "all", permissions } satisfies PermissionRequirement);
