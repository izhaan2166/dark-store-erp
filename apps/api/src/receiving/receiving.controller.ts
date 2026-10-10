import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import type { AuthUser } from "../auth/auth.service";
import { CurrentUser, RequirePermission } from "../auth/decorators";
import { idParam, requireIdempotencyKey } from "../common/http";
import { type CreatePurchaseOrderRequest, type CreateSupplierRequest, PurchasingService } from "./purchasing.service";
import { type PutawayRequest, type RecordReceiptRequest, ReceivingService } from "./receiving.service";

const actorFor = (user: AuthUser, storeId: string, key: string | undefined) => ({
  storeId,
  actorUserId: user.userId,
  idempotencyKey: requireIdempotencyKey(key),
});

@Controller("stores/:storeId")
export class ReceivingController {
  constructor(
    @Inject(PurchasingService) private readonly purchasing: PurchasingService,
    @Inject(ReceivingService) private readonly receiving: ReceivingService,
  ) {}

  @Post("suppliers")
  @RequirePermission("purchasing.manage")
  createSupplier(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: CreateSupplierRequest,
  ) {
    return this.purchasing.createSupplier(actorFor(user, storeId, key), body);
  }

  @Post("purchase-orders")
  @RequirePermission("purchasing.manage")
  createPurchaseOrder(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: CreatePurchaseOrderRequest,
  ) {
    return this.purchasing.createPurchaseOrder(actorFor(user, storeId, key), body);
  }

  @Get("purchase-orders")
  @RequirePermission("purchasing.view")
  listPurchaseOrders(@Param("storeId") storeId: string, @Query() query: Record<string, string>) {
    return this.purchasing.listPurchaseOrders(storeId, query);
  }

  @Get("purchase-orders/:purchaseOrderId")
  @RequirePermission("purchasing.view")
  getPurchaseOrder(@Param("storeId") storeId: string, @Param("purchaseOrderId") id: string) {
    return this.purchasing.getPurchaseOrder(storeId, idParam(id, "Purchase order"));
  }

  @Post("goods-receipts")
  @RequirePermission("receiving.record")
  recordReceipt(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: RecordReceiptRequest,
  ) {
    return this.receiving.recordReceipt(actorFor(user, storeId, key), body);
  }

  @Get("goods-receipts/:goodsReceiptId")
  @RequirePermission("purchasing.view")
  getReceipt(@Param("storeId") storeId: string, @Param("goodsReceiptId") id: string) {
    return this.receiving.getReceipt(storeId, idParam(id, "Goods receipt"));
  }

  @Post("goods-receipts/:goodsReceiptId/approve")
  @HttpCode(200)
  @RequirePermission("receiving.approve")
  approveReceipt(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("goodsReceiptId") id: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: { reason?: string },
  ) {
    return this.receiving.approveReceipt(actorFor(user, storeId, key), idParam(id, "Goods receipt"), body?.reason ?? "");
  }

  @Post("goods-receipts/:goodsReceiptId/cancel")
  @HttpCode(200)
  @RequirePermission("receiving.approve")
  cancelReceipt(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("goodsReceiptId") id: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: { reason?: string },
  ) {
    return this.receiving.cancelReceipt(actorFor(user, storeId, key), idParam(id, "Goods receipt"), body?.reason ?? "");
  }

  @Post("putaways")
  @RequirePermission("inventory.putaway")
  putaway(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: PutawayRequest,
  ) {
    return this.receiving.putaway(actorFor(user, storeId, key), body);
  }
}
