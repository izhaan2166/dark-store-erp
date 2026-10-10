import type { userRole } from "@dse/db";

export type Role = (typeof userRole.enumValues)[number];

export const PERMISSIONS = [
  "catalog.view",
  "catalog.manage",
  "locations.manage",
  "inventory.view",
  "orders.view",
  "orders.create",
  "orders.cancel",
  "purchasing.view",
  "purchasing.manage",
  "receiving.record",
  "receiving.approve",
  "inventory.putaway",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * What each role may do. The backend enforces this on every request; the
 * screens only hide what a user cannot use. Add permissions as modules land.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: PERMISSIONS,
  store_manager: PERMISSIONS,
  inventory_manager: [
    "catalog.view",
    "catalog.manage",
    "locations.manage",
    "inventory.view",
    "orders.view",
    "purchasing.view",
    "purchasing.manage",
    "receiving.record",
    "inventory.putaway",
  ],
  receiving_staff: ["catalog.view", "inventory.view", "purchasing.view", "receiving.record", "inventory.putaway"],
  picker: ["catalog.view", "inventory.view", "orders.view"],
  packer: ["catalog.view", "inventory.view", "orders.view"],
  auditor: ["catalog.view", "inventory.view", "orders.view", "purchasing.view"],
};

export function rolesGrant(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}
