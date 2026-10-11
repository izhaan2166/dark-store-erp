import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put } from "@nestjs/common";
import { idParam, requireIdempotencyKey } from "../common/http";
import type { AuthUser } from "./auth.service";
import { CurrentUser, RequirePermission } from "./decorators";
import { type AddStaffRequest, StaffService } from "./staff.service";

const actorFor = (user: AuthUser, storeId: string, key: string | undefined) => ({
  storeId,
  actorUserId: user.userId,
  idempotencyKey: requireIdempotencyKey(key),
});
const person = (id: string) => idParam(id, "User");

@Controller("stores/:storeId/staff")
export class StaffController {
  constructor(@Inject(StaffService) private readonly staff: StaffService) {}

  @Get()
  @RequirePermission("staff.manage")
  list(@CurrentUser() user: AuthUser, @Param("storeId") storeId: string) {
    return this.staff.list(storeId, user.userId);
  }

  @Post()
  @RequirePermission("staff.manage")
  add(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: AddStaffRequest,
  ) {
    return this.staff.add(actorFor(user, storeId, key), body);
  }

  @Put(":userId/roles")
  @RequirePermission("staff.manage")
  async setRoles(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("userId") userId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: unknown,
  ) {
    return { member: await this.staff.setRoles(actorFor(user, storeId, key), person(userId), body) };
  }

  @Post(":userId/password")
  @HttpCode(200)
  @RequirePermission("staff.manage")
  setPassword(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("userId") userId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.staff.setPassword(actorFor(user, storeId, key), person(userId), body);
  }
}
