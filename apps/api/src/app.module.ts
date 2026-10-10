import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { InventoryModule } from "./inventory/inventory.module";
import { OrdersModule } from "./orders/orders.module";

@Module({
  imports: [DatabaseModule, AuthModule, InventoryModule, OrdersModule],
  controllers: [HealthController],
})
export class AppModule {}
