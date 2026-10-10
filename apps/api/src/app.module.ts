import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { InventoryModule } from "./inventory/inventory.module";
import { OrdersModule } from "./orders/orders.module";
import { ReceivingModule } from "./receiving/receiving.module";

@Module({
  imports: [DatabaseModule, AuthModule, InventoryModule, OrdersModule, ReceivingModule],
  controllers: [HealthController],
})
export class AppModule {}
