import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { OrdersService } from "./orders.service";

@Module({
  imports: [InventoryModule],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
