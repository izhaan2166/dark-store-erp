import { Controller, Get, Inject, Param } from "@nestjs/common";
import { RequirePermission } from "../auth/decorators";
import { DashboardService } from "./dashboard.service";

@Controller("stores/:storeId/dashboard")
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @Get()
  @RequirePermission("dashboard.view")
  summary(@Param("storeId") storeId: string) {
    return this.dashboard.summary(storeId);
  }

  @Get("handed-over")
  @RequirePermission("dashboard.view")
  handedOver(@Param("storeId") storeId: string) {
    return this.dashboard.handedOverToday(storeId);
  }

  @Get("out-of-stock")
  @RequirePermission("dashboard.view")
  outOfStock(@Param("storeId") storeId: string) {
    return this.dashboard.outOfStock(storeId);
  }

  @Get("expiring")
  @RequirePermission("dashboard.view")
  expiring(@Param("storeId") storeId: string) {
    return this.dashboard.expiring(storeId);
  }
}
