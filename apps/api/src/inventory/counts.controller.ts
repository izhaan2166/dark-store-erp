import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import type { AuthUser } from "../auth/auth.service";
import { CurrentUser, RequirePermission } from "../auth/decorators";
import { idParam, requireIdempotencyKey } from "../common/http";
import { CountsService, type SubmitCountRequest } from "./counts.service";

const actorFor = (user: AuthUser, storeId: string, key: string | undefined) => ({
  storeId,
  actorUserId: user.userId,
  idempotencyKey: requireIdempotencyKey(key),
});

@Controller("stores/:storeId/stock-counts")
export class CountsController {
  constructor(@Inject(CountsService) private readonly counts: CountsService) {}

  @Post()
  @RequirePermission("inventory.count")
  submit(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: SubmitCountRequest,
  ) {
    return this.counts.submitCount(actorFor(user, storeId, key), body);
  }

  @Get()
  @RequirePermission("inventory.view")
  list(@Param("storeId") storeId: string, @Query() query: Record<string, string>) {
    return this.counts.listCounts(storeId, query);
  }

  @Get(":stockCountId")
  @RequirePermission("inventory.view")
  get(@Param("storeId") storeId: string, @Param("stockCountId") id: string) {
    return this.counts.getCount(storeId, idParam(id, "Count"));
  }

  @Post(":stockCountId/approve")
  @HttpCode(200)
  @RequirePermission("inventory.approve_count")
  approve(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("stockCountId") id: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: { reason?: string },
  ) {
    return this.counts.approveCount(actorFor(user, storeId, key), idParam(id, "Count"), body?.reason ?? "");
  }

  @Post(":stockCountId/reject")
  @HttpCode(200)
  @RequirePermission("inventory.approve_count")
  reject(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("stockCountId") id: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: { reason?: string },
  ) {
    return this.counts.rejectCount(actorFor(user, storeId, key), idParam(id, "Count"), body?.reason ?? "");
  }
}
