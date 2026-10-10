import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from "@nestjs/common";
import type { AuthUser } from "../auth/auth.service";
import { CurrentUser, RequirePermission } from "../auth/decorators";
import { idParam, requireIdempotencyKey } from "../common/http";
import {
  FulfilmentService,
  type PackRequest,
  type PickRequest,
  type ResolveShortageRequest,
  type ShortPickRequest,
} from "./fulfilment.service";

const actorFor = (user: AuthUser, storeId: string, key: string | undefined) => ({
  storeId,
  actorUserId: user.userId,
  idempotencyKey: requireIdempotencyKey(key),
});
const order = (id: string) => idParam(id, "Order");

@Controller("stores/:storeId/orders/:orderId")
export class FulfilmentController {
  constructor(@Inject(FulfilmentService) private readonly fulfilment: FulfilmentService) {}

  @Get("fulfilment")
  @RequirePermission("orders.view")
  view(@Param("storeId") storeId: string, @Param("orderId") orderId: string) {
    return this.fulfilment.view(storeId, order(orderId));
  }

  @Post("start-picking")
  @HttpCode(200)
  @RequirePermission("orders.pick")
  startPicking(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Headers("idempotency-key") key: string | undefined,
  ) {
    return this.fulfilment.startPicking(actorFor(user, storeId, key), order(orderId));
  }

  @Post("picks")
  @HttpCode(200)
  @RequirePermission("orders.pick")
  pick(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: PickRequest,
  ) {
    return this.fulfilment.pick(actorFor(user, storeId, key), order(orderId), body);
  }

  @Post("short-picks")
  @HttpCode(200)
  @RequirePermission("orders.pick")
  shortPick(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: ShortPickRequest,
  ) {
    return this.fulfilment.shortPick(actorFor(user, storeId, key), order(orderId), body);
  }

  @Post("complete-picking")
  @HttpCode(200)
  @RequirePermission("orders.pick")
  completePicking(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Headers("idempotency-key") key: string | undefined,
  ) {
    return this.fulfilment.completePicking(actorFor(user, storeId, key), order(orderId));
  }

  @Post("shortages/:shortageId/resolve")
  @HttpCode(200)
  @RequirePermission("orders.resolve_shortage")
  resolveShortage(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Param("shortageId") shortageId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: ResolveShortageRequest,
  ) {
    return this.fulfilment.resolveShortage(
      actorFor(user, storeId, key),
      order(orderId),
      idParam(shortageId, "Shortage"),
      body,
    );
  }

  @Post("pack")
  @HttpCode(200)
  @RequirePermission("orders.pack")
  pack(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: PackRequest,
  ) {
    return this.fulfilment.pack(actorFor(user, storeId, key), order(orderId), body);
  }

  @Post("handover")
  @HttpCode(200)
  @RequirePermission("orders.pack")
  handover(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Headers("idempotency-key") key: string | undefined,
  ) {
    return this.fulfilment.handover(actorFor(user, storeId, key), order(orderId));
  }
}
