import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import type { AuthUser } from "../auth/auth.service";
import { CurrentUser, RequirePermission } from "../auth/decorators";
import { NotFoundError, ValidationError } from "../common/errors";
import { type AcceptOrderRequest, OrdersService } from "./orders.service";

const cancelSchema = z.object({ reason: z.string().trim().min(1).max(500) });
const uuid = z.string().uuid();

function orderIdParam(orderId: string): string {
  if (!uuid.safeParse(orderId).success) throw new NotFoundError("Order not found", { orderId });
  return orderId;
}

function idempotencyKey(key: string | undefined): string {
  if (!key) throw new ValidationError("The Idempotency-Key header is required");
  return key;
}

@Controller("stores/:storeId/orders")
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Post()
  @RequirePermission("orders.create")
  accept(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: AcceptOrderRequest,
  ) {
    return this.orders.acceptOrder({ storeId, actorUserId: user.userId, idempotencyKey: idempotencyKey(key) }, body);
  }

  @Get(":orderId")
  @RequirePermission("orders.view")
  get(@Param("storeId") storeId: string, @Param("orderId") orderId: string) {
    return this.orders.getOrder(storeId, orderIdParam(orderId));
  }

  @Post(":orderId/cancel")
  @HttpCode(200)
  @RequirePermission("orders.cancel")
  cancel(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: unknown,
  ) {
    const parsed = cancelSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("A cancellation reason is required");
    return this.orders.cancelOrder(
      { storeId, actorUserId: user.userId, idempotencyKey: idempotencyKey(key) },
      orderIdParam(orderId),
      parsed.data.reason,
    );
  }
}
