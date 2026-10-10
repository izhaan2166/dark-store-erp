import { Module } from "@nestjs/common";
import { LedgerService } from "./ledger.service";
import { ReconciliationService } from "./reconciliation.service";

@Module({
  providers: [LedgerService, ReconciliationService],
  exports: [LedgerService, ReconciliationService],
})
export class InventoryModule {}
