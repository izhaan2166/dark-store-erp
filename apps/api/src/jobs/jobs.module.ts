import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { InventoryModule } from "../inventory/inventory.module";
import { JobsService } from "./jobs.service";

/** Everything the worker process needs; the API does not load it. */
@Module({
  imports: [DatabaseModule, InventoryModule],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
