import { Controller, Get, Inject, Param } from "@nestjs/common";
import { RequirePermission } from "../auth/decorators";
import { FulfilmentService } from "./fulfilment.service";

@Controller("stores/:storeId/shortages")
export class ShortagesController {
  constructor(@Inject(FulfilmentService) private readonly fulfilment: FulfilmentService) {}

  /** Open shortages across the store, escalated ones first. */
  @Get()
  @RequirePermission("orders.view")
  list(@Param("storeId") storeId: string) {
    return this.fulfilment.openShortages(storeId);
  }
}
