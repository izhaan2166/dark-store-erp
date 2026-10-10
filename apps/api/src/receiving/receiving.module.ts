import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { PurchasingService } from "./purchasing.service";
import { ReceivingController } from "./receiving.controller";
import { ReceivingService } from "./receiving.service";

@Module({
  imports: [InventoryModule],
  controllers: [ReceivingController],
  providers: [PurchasingService, ReceivingService],
  exports: [PurchasingService, ReceivingService],
})
export class ReceivingModule {}
