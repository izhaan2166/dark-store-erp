import { Body, Controller, Headers, Inject, Param, Post } from "@nestjs/common";
import type { AuthUser } from "../auth/auth.service";
import { CurrentUser, RequirePermission } from "../auth/decorators";
import { requireIdempotencyKey } from "../common/http";
import { OpeningStockService, type OpeningStockRequest } from "./opening-stock.service";

@Controller("stores/:storeId/opening-stock")
export class OpeningStockController {
  constructor(@Inject(OpeningStockService) private readonly opening: OpeningStockService) {}

  @Post()
  @RequirePermission("inventory.opening_stock")
  load(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: OpeningStockRequest,
  ) {
    return this.opening.load({ storeId, actorUserId: user.userId, idempotencyKey: requireIdempotencyKey(key) }, body);
  }
}
