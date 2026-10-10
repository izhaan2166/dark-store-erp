import type { userRole } from "@dse/db";

export type Role = (typeof userRole.enumValues)[number];

export type Permission = "orders.view" | "orders.create" | "orders.cancel";

const ALL: readonly Permission[] = ["orders.view", "orders.create", "orders.cancel"];

/**
 * What each role may do. The backend enforces this on every request; the
 * screens only hide what a user cannot use. Add permissions as modules land.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: ALL,
  store_manager: ["orders.view", "orders.create", "orders.cancel"],
  inventory_manager: ["orders.view"],
  receiving_staff: [],
  picker: ["orders.view"],
  packer: ["orders.view"],
  auditor: ["orders.view"],
};

export function rolesGrant(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}
