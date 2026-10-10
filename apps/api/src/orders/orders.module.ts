import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { FulfilmentController } from "./fulfilment.controller";
import { FulfilmentService } from "./fulfilment.service";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { ShortagesController } from "./shortages.controller";

@Module({
  imports: [InventoryModule],
  controllers: [OrdersController, FulfilmentController, ShortagesController],
  providers: [OrdersService, FulfilmentService],
  exports: [OrdersService, FulfilmentService],
})
export class OrdersModule {}
