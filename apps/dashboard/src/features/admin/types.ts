export type UserStatus = "ACTIVE" | "INVITED" | "SUSPENDED" | "DISABLED";
export interface Permission {
  id: string;
  key: string;
  description: string | null;
}
export interface RolePermission {
  permission: Permission;
}
export interface Role {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
  permissions: RolePermission[];
  _count?: { users: number };
}
export interface UserRoleAssignment {
  roleId: string;
  assignedAt: string;
  role: Omit<Role, "permissions" | "_count"> & { permissions?: RolePermission[] };
}
export interface ManagedUser {
  id: string;
  organizationId: string;
  firstName: string;
  lastName: string | null;
  email: string;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  userRoles: UserRoleAssignment[];
}
export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}
export interface UserPage {
  items: ManagedUser[];
  pagination: Pagination;
}
export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  roleIds: string[];
  invitedById: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface UserQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: UserStatus;
}
export interface CreateUserInput {
  firstName: string;
  lastName?: string;
  email: string;
  password: string;
  roleIds: string[];
}
export interface UpdateUserInput {
  firstName?: string;
  lastName?: string;
  status?: UserStatus;
}
export interface CreateRoleInput {
  name: string;
  description?: string;
  permissionIds?: string[];
}
export interface CreateInvitationInput {
  email: string;
  roleIds: string[];
}
