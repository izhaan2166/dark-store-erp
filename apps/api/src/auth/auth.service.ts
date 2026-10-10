import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { authSessions, userStoreRoles, users, type DbHandle } from "@dse/db";
import { z } from "zod";
import { InvalidCredentialsError, UnauthenticatedError, ValidationError } from "../common/errors";
import { DB_HANDLE } from "../database/database.tokens";
import { hashPassword, verifyPassword } from "./passwords";
import type { Role } from "./permissions";

/** A session lasts one long shift; staff sign in again after it. */
export const SESSION_HOURS = 12;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginSchema>;

export interface AuthUser {
  userId: string;
  email: string;
  name: string;
  /** Roles per store id. */
  storeRoles: Map<string, Role[]>;
  tokenHash: string;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: { id: string; email: string; name: string };
  stores: { storeId: string; roles: Role[] }[];
}

// Compared against when the email is unknown, so both paths take the same time.
const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

@Injectable()
export class AuthService {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async login(request: LoginRequest): Promise<LoginResult> {
    const parsed = loginSchema.safeParse(request);
    if (!parsed.success) throw new ValidationError("Email and password are required");
    const { email, password } = parsed.data;
    const { db } = this.handle;

    const [user] = await db.select().from(users).where(eq(users.email, email));
    const valid = await verifyPassword(password, user?.passwordHash ?? (await DUMMY_HASH));
    if (!user || !user.passwordHash || !valid || user.status !== "active") {
      throw new InvalidCredentialsError("Email or password is incorrect");
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
    await db.insert(authSessions).values({ tokenHash: hashToken(token), userId: user.id, expiresAt });

    const roles = await this.storeRoles(user.id);
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: user.id, email: user.email, name: user.name },
      stores: [...roles].map(([storeId, r]) => ({ storeId, roles: r })),
    };
  }

  /** Resolves a bearer token to its user and current roles, or throws. */
  async authenticate(token: string | undefined): Promise<AuthUser> {
    if (!token) throw new UnauthenticatedError("Sign in to continue");
    const tokenHash = hashToken(token);
    const [row] = await this.handle.db
      .select({ userId: users.id, email: users.email, name: users.name })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(
        and(
          eq(authSessions.tokenHash, tokenHash),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, new Date()),
          eq(users.status, "active"),
        ),
      );
    if (!row) throw new UnauthenticatedError("Your session has ended; sign in again");
    // Roles are read on every request so a revoked role stops working at once.
    return { ...row, storeRoles: await this.storeRoles(row.userId), tokenHash };
  }

  async logout(auth: AuthUser): Promise<void> {
    await this.handle.db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.tokenHash, auth.tokenHash), isNull(authSessions.revokedAt)));
  }

  /** Creates a user who can sign in. Used by the admin CLI and tests. */
  async createUser(input: { email: string; name: string; password: string }): Promise<string> {
    if (input.password.length < 10) throw new ValidationError("Passwords need at least 10 characters");
    const [row] = await this.handle.db
      .insert(users)
      .values({
        email: input.email.trim().toLowerCase(),
        name: input.name,
        passwordHash: await hashPassword(input.password),
      })
      .returning({ id: users.id });
    return row!.id;
  }

  async grantRole(userId: string, storeId: string, role: Role): Promise<void> {
    await this.handle.db.insert(userStoreRoles).values({ userId, storeId, role }).onConflictDoNothing();
  }

  private async storeRoles(userId: string): Promise<Map<string, Role[]>> {
    const rows = await this.handle.db
      .select({ storeId: userStoreRoles.storeId, role: userStoreRoles.role })
      .from(userStoreRoles)
      .where(eq(userStoreRoles.userId, userId));
    const byStore = new Map<string, Role[]>();
    for (const { storeId, role } of rows) byStore.set(storeId, [...(byStore.get(storeId) ?? []), role]);
    return byStore;
  }
}
