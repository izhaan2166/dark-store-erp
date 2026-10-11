import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { auditLogs, authSessions, userStoreRoles, users, type DbExecutor, type DbHandle } from "@dse/db";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { ConflictError, ForbiddenError, NotFoundError } from "../common/errors";
import { runIdempotent } from "../common/idempotency";
import { pgErrorCode } from "../common/retry";
import { parse } from "../common/validation";
import { DB_HANDLE } from "../database/database.tokens";
import { hashPassword } from "./passwords";
import { ROLE_PERMISSIONS, type Role } from "./permissions";

/** Roles a Store Manager can hand out. Super Admin is granted only from the server. */
export const STORE_ROLES = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) => r !== "super_admin");

const roles = z
  .array(z.enum(STORE_ROLES as [Role, ...Role[]]))
  .max(STORE_ROLES.length)
  .transform((list) => [...new Set(list)].sort());
const password = z.string().min(10, "Passwords need at least 10 characters").max(200);

export const addStaffSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(254),
  password,
  roles: roles.refine((list) => list.length > 0, "Give at least one role"),
});
export type AddStaffRequest = z.input<typeof addStaffSchema>;

export const setRolesSchema = z.object({ roles });
export const setPasswordSchema = z.object({ password });

export interface StaffMember {
  userId: string;
  name: string;
  email: string;
  roles: Role[];
  /**
   * Whether this store's managers may change the person. Not for themselves,
   * a Super Admin, or someone who also works in another store.
   */
  editable: boolean;
}

/**
 * Who works in a store and what they may do there. Roles are read fresh on
 * every request, so a change takes effect on the person's next tap; a new
 * password also ends every session they have open.
 */
@Injectable()
export class StaffService {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async list(storeId: string, actorUserId: string): Promise<StaffMember[]> {
    const rows = await this.handle.db
      .select({ userId: users.id, name: users.name, email: users.email, role: userStoreRoles.role })
      .from(userStoreRoles)
      .innerJoin(users, eq(users.id, userStoreRoles.userId))
      .where(and(eq(userStoreRoles.storeId, storeId), eq(users.status, "active")))
      .orderBy(asc(users.name), asc(users.email));
    const elsewhere = await this.workingElsewhere(this.handle.db, storeId, [...new Set(rows.map((r) => r.userId))]);
    const people = new Map<string, StaffMember>();
    for (const r of rows) {
      const person = people.get(r.userId) ?? { userId: r.userId, name: r.name, email: r.email, roles: [], editable: false };
      person.roles.push(r.role);
      people.set(r.userId, person);
    }
    for (const person of people.values()) {
      person.roles.sort();
      person.editable = person.userId !== actorUserId && !person.roles.includes("super_admin") && !elsewhere.has(person.userId);
    }
    return [...people.values()];
  }

  async add(actor: Actor, request: AddStaffRequest): Promise<StaffMember> {
    const body = parse(addStaffSchema, request, "Invalid staff member");
    // Hashed before the transaction: it is slow on purpose. The password is
    // left out of the idempotency fingerprint and the audit log.
    const passwordHash = await hashPassword(body.password);
    const fingerprint = { name: body.name, email: body.email, roles: body.roles };
    try {
      const userId = await this.handle.db.transaction((tx) =>
        runIdempotent(tx, { storeId: actor.storeId, scope: "staff.add", key: actor.idempotencyKey, request: fingerprint }, async () => {
          const [row] = await tx.insert(users).values({ name: body.name, email: body.email, passwordHash }).returning({ id: users.id });
          await tx.insert(userStoreRoles).values(body.roles.map((role) => ({ userId: row!.id, storeId: actor.storeId, role })));
          await this.audit(tx, actor, "staff.add", row!.id, null, fingerprint);
          return row!.id;
        }),
      );
      return this.member(actor, userId);
    } catch (err) {
      if (pgErrorCode(err) === "23505") throw new ConflictError("Someone with this email already has an account", { email: body.email });
      throw err;
    }
  }

  /** Replaces the person's roles in this store. No roles removes them from the store. */
  async setRoles(actor: Actor, userId: string, request: unknown): Promise<StaffMember | null> {
    const body = parse(setRolesSchema, request, "Invalid roles");
    await this.handle.db.transaction((tx) =>
      runIdempotent(tx, { storeId: actor.storeId, scope: "staff.roles", key: actor.idempotencyKey, request: { userId, ...body } }, async () => {
        const before = await this.lockEditable(tx, actor, userId);
        await tx.delete(userStoreRoles).where(and(eq(userStoreRoles.userId, userId), eq(userStoreRoles.storeId, actor.storeId)));
        if (body.roles.length) {
          await tx.insert(userStoreRoles).values(body.roles.map((role) => ({ userId, storeId: actor.storeId, role })));
        }
        await this.audit(tx, actor, body.roles.length ? "staff.roles" : "staff.remove", userId, { roles: before }, { roles: body.roles });
        return userId;
      }),
    );
    return body.roles.length ? this.member(actor, userId) : null;
  }

  /** Sets a new password and signs the person out everywhere. */
  async setPassword(actor: Actor, userId: string, request: unknown): Promise<{ userId: string }> {
    const body = parse(setPasswordSchema, request, "Invalid password");
    const passwordHash = await hashPassword(body.password);
    await this.handle.db.transaction((tx) =>
      runIdempotent(tx, { storeId: actor.storeId, scope: "staff.password", key: actor.idempotencyKey, request: { userId } }, async () => {
        await this.lockEditable(tx, actor, userId);
        await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
        await tx
          .update(authSessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
        await this.audit(tx, actor, "staff.password", userId, null, {});
        return userId;
      }),
    );
    return { userId };
  }

  /**
   * Locks the user row and returns their roles here. Refuses people this
   * store's managers may not change, so a manager cannot widen their own
   * access, lock themselves out, or reach into another store.
   */
  private async lockEditable(tx: DbExecutor, actor: Actor, userId: string): Promise<Role[]> {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    const held = user
      ? await tx
          .select({ role: userStoreRoles.role })
          .from(userStoreRoles)
          .where(and(eq(userStoreRoles.userId, userId), eq(userStoreRoles.storeId, actor.storeId)))
      : [];
    if (held.length === 0) throw new NotFoundError("This person does not work in this store", { userId });
    if (userId === actor.actorUserId) throw new ForbiddenError("You cannot change your own access. Ask another Store Manager.");
    const roles = held.map((r) => r.role).sort();
    if (roles.includes("super_admin") || (await this.workingElsewhere(tx, actor.storeId, [userId])).size > 0) {
      throw new ForbiddenError("This person also has access beyond this store. Ask an admin to change them.", { userId });
    }
    return roles;
  }

  /** Of the given people, those with a role in another store or as Super Admin anywhere. */
  private async workingElsewhere(db: DbExecutor, storeId: string, userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await db
      .selectDistinct({ userId: userStoreRoles.userId })
      .from(userStoreRoles)
      .where(
        and(
          inArray(userStoreRoles.userId, userIds),
          or(ne(userStoreRoles.storeId, storeId), eq(userStoreRoles.role, "super_admin")),
        ),
      );
    return new Set(rows.map((r) => r.userId));
  }

  private async member(actor: Actor, userId: string): Promise<StaffMember> {
    const person = (await this.list(actor.storeId, actor.actorUserId)).find((p) => p.userId === userId);
    if (!person) throw new NotFoundError("This person does not work in this store", { userId });
    return person;
  }

  private async audit(
    tx: DbExecutor,
    actor: Actor,
    action: string,
    userId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLogs).values({ storeId: actor.storeId, actorUserId: actor.actorUserId, action, entityType: "user", entityId: userId, before, after });
  }
}
