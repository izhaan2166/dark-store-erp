import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";

export * from "./schema";
export { schema };

export type Database = NodePgDatabase<typeof schema>;
/** A transaction handle or the database itself; services accept either. */
export type DbExecutor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DbHandle {
  db: Database;
  pool: Pool;
  close(): Promise<void>;
}

export function createDb(connectionString: string, poolConfig: PoolConfig = {}): DbHandle {
  const pool = new Pool({ connectionString, max: 20, ...poolConfig });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export { runMigrations } from "./migrator";
