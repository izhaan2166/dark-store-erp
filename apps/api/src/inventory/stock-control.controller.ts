import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import type { AuthUser } from "../auth/auth.service";
import { CurrentUser, RequirePermission } from "../auth/decorators";
import { idParam, requireIdempotencyKey } from "../common/http";
import {
  StockControlService,
  type QuarantineRequest,
  type ReleaseRequest,
  type WriteOffRequest,
} from "./stock-control.service";

const actorFor = (user: AuthUser, storeId: string, key: string | undefined) => ({
  storeId,
  actorUserId: user.userId,
  idempotencyKey: requireIdempotencyKey(key),
});

@Controller("stores/:storeId")
export class StockControlController {
  constructor(@Inject(StockControlService) private readonly stock: StockControlService) {}

  @Post("quarantines")
  @RequirePermission("inventory.adjust")
  quarantine(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: QuarantineRequest,
  ) {
    return this.stock.quarantine(actorFor(user, storeId, key), body);
  }

  @Post("stock-requests/release")
  @RequirePermission("inventory.adjust")
  requestRelease(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: ReleaseRequest,
  ) {
    return this.stock.requestRelease(actorFor(user, storeId, key), body);
  }

  @Post("stock-requests/write-off")
  @RequirePermission("inventory.adjust")
  requestWriteOff(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: WriteOffRequest,
  ) {
    return this.stock.requestWriteOff(actorFor(user, storeId, key), body);
  }

  @Get("stock-requests")
  @RequirePermission("inventory.view")
  list(@Param("storeId") storeId: string, @Query() query: Record<string, unknown>) {
    return this.stock.listRequests(storeId, query);
  }

  @Get("stock-requests/:requestId")
  @RequirePermission("inventory.view")
  get(@Param("storeId") storeId: string, @Param("requestId") id: string) {
    return this.stock.getRequest(storeId, idParam(id, "Request"));
  }

  @Post("stock-requests/:requestId/approve")
  @HttpCode(200)
  @RequirePermission("inventory.approve_request")
  approve(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("requestId") id: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: { reason?: string },
  ) {
    return this.stock.approve(actorFor(user, storeId, key), idParam(id, "Request"), body ?? {});
  }

  @Post("stock-requests/:requestId/reject")
  @HttpCode(200)
  @RequirePermission("inventory.approve_request")
  reject(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("requestId") id: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: { reason?: string },
  ) {
    return this.stock.reject(actorFor(user, storeId, key), idParam(id, "Request"), body ?? {});
  }
}
