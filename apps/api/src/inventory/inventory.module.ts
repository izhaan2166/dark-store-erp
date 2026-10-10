import { Module } from "@nestjs/common";
import { CountsController } from "./counts.controller";
import { CountsService } from "./counts.service";
import { InventoryController } from "./inventory.controller";
import { LedgerService } from "./ledger.service";
import { ReconciliationService } from "./reconciliation.service";
import { StockQueryService } from "./stock-query.service";

@Module({
  controllers: [InventoryController, CountsController],
  providers: [LedgerService, ReconciliationService, StockQueryService, CountsService],
  exports: [LedgerService, ReconciliationService, StockQueryService, CountsService],
})
export class InventoryModule {}
