import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import type { AuthUser } from "../auth/auth.service";
import { CurrentUser, RequirePermission } from "../auth/decorators";
import { idParam, requireIdempotencyKey } from "../common/http";
import {
  CatalogService,
  type CreateLocationRequest,
  type CreateProductRequest,
  type UpdateLocationRequest,
  type UpdateProductRequest,
} from "./catalog.service";

const actorFor = (user: AuthUser, storeId: string, key: string | undefined) => ({
  storeId,
  actorUserId: user.userId,
  idempotencyKey: requireIdempotencyKey(key),
});

@Controller("stores/:storeId")
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get("products")
  @RequirePermission("catalog.view")
  search(@Query() query: Record<string, string>) {
    return this.catalog.searchProducts(query);
  }

  @Post("products")
  @RequirePermission("catalog.manage")
  create(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: CreateProductRequest,
  ) {
    return this.catalog.createProduct(actorFor(user, storeId, key), body);
  }

  @Get("products/:productId")
  @RequirePermission("catalog.view")
  get(@Param("productId") productId: string) {
    return this.catalog.getProduct(idParam(productId, "Product"));
  }

  @Patch("products/:productId")
  @RequirePermission("catalog.manage")
  update(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("productId") productId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: UpdateProductRequest,
  ) {
    return this.catalog.updateProduct(actorFor(user, storeId, key), idParam(productId, "Product"), body);
  }

  @Post("products/:productId/barcodes")
  @RequirePermission("catalog.manage")
  addBarcode(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("productId") productId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: { barcode?: string },
  ) {
    return this.catalog.addBarcode(actorFor(user, storeId, key), idParam(productId, "Product"), body);
  }

  @Get("barcodes/:barcode")
  @RequirePermission("catalog.view")
  scan(@Param("barcode") barcode: string) {
    return this.catalog.findByBarcode(barcode);
  }

  @Get("locations")
  @RequirePermission("catalog.view")
  locations(@Param("storeId") storeId: string) {
    return this.catalog.listLocations(storeId);
  }

  @Post("locations")
  @RequirePermission("locations.manage")
  createLocation(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: CreateLocationRequest,
  ) {
    return this.catalog.createLocation(actorFor(user, storeId, key), body);
  }

  @Patch("locations/:locationId")
  @RequirePermission("locations.manage")
  updateLocation(
    @CurrentUser() user: AuthUser,
    @Param("storeId") storeId: string,
    @Param("locationId") locationId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: UpdateLocationRequest,
  ) {
    return this.catalog.updateLocation(actorFor(user, storeId, key), idParam(locationId, "Location"), body);
  }
}
