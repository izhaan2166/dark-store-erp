import { Module } from "@nestjs/common";
import { InventoryController } from "./inventory.controller";
import { LedgerService } from "./ledger.service";
import { ReconciliationService } from "./reconciliation.service";
import { StockQueryService } from "./stock-query.service";

@Module({
  controllers: [InventoryController],
  providers: [LedgerService, ReconciliationService, StockQueryService],
  exports: [LedgerService, ReconciliationService, StockQueryService],
})
export class InventoryModule {}
