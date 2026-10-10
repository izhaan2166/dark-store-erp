import { Module } from "@nestjs/common";
import { CountsController } from "./counts.controller";
import { CountsService } from "./counts.service";
import { InventoryController } from "./inventory.controller";
import { LedgerService } from "./ledger.service";
import { ReconciliationService } from "./reconciliation.service";
import { StockControlController } from "./stock-control.controller";
import { StockControlService } from "./stock-control.service";
import { StockQueryService } from "./stock-query.service";

@Module({
  controllers: [InventoryController, CountsController, StockControlController],
  providers: [LedgerService, ReconciliationService, StockQueryService, CountsService, StockControlService],
  exports: [LedgerService, ReconciliationService, StockQueryService, CountsService, StockControlService],
})
export class InventoryModule {}
