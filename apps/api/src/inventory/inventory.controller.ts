import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { RequirePermission } from "../auth/decorators";
import { idParam } from "../common/http";
import { StockQueryService } from "./stock-query.service";

@Controller("stores/:storeId/inventory")
export class InventoryController {
  constructor(@Inject(StockQueryService) private readonly stock: StockQueryService) {}

  @Get()
  @RequirePermission("inventory.view")
  list(@Param("storeId") storeId: string, @Query() query: Record<string, string>) {
    return this.stock.listBalances(storeId, query);
  }

  @Get("products/:productId")
  @RequirePermission("inventory.view")
  product(@Param("storeId") storeId: string, @Param("productId") productId: string) {
    return this.stock.productStock(storeId, idParam(productId, "Product"));
  }
}
