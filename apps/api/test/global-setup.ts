import { Client } from "pg";
import { runMigrations } from "@dse/db";
import { TEST_DATABASE_URL } from "./support/env";

/** Recreates the test database schema from the migrations before the suite. */
export default async function setup(): Promise<void> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
  await runMigrations(TEST_DATABASE_URL);
}
