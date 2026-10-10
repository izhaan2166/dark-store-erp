import { Module } from "@nestjs/common";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { InventoryModule } from "./inventory/inventory.module";
import { OrdersModule } from "./orders/orders.module";

@Module({
  imports: [DatabaseModule, InventoryModule, OrdersModule],
  controllers: [HealthController],
})
export class AppModule {}
