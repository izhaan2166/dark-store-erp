import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { DbHandle } from "@dse/db";
import { Public } from "../auth/decorators";
import { DB_HANDLE } from "../database/database.tokens";

@Controller("health")
export class HealthController {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  @Public()
  @Get()
  async check(): Promise<{ status: "ok"; database: "up" }> {
    try {
      await this.handle.db.execute(sql`select 1`);
    } catch {
      throw new ServiceUnavailableException({ status: "error", database: "down" });
    }
    return { status: "ok", database: "up" };
  }
}
