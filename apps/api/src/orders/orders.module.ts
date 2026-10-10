import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { FulfilmentController } from "./fulfilment.controller";
import { FulfilmentService } from "./fulfilment.service";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({
  imports: [InventoryModule],
  controllers: [OrdersController, FulfilmentController],
  providers: [OrdersService, FulfilmentService],
  exports: [OrdersService, FulfilmentService],
})
export class OrdersModule {}
