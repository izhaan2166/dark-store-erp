import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { auditLogs, locations, productBarcodes, products, type DbExecutor, type DbHandle } from "@dse/db";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { ConflictError, NotFoundError, ValidationError } from "../common/errors";
import { runIdempotent } from "../common/idempotency";
import { pgConstraint, pgErrorCode } from "../common/retry";
import { parse } from "../common/validation";
import { DB_HANDLE } from "../database/database.tokens";

const barcode = z.string().trim().min(4).max(64).regex(/^[0-9A-Za-z\-.]+$/, "Letters, digits, - and . only");

export const createProductSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  unitOfMeasure: z.string().trim().min(1).max(20).default("each"),
  batchTracked: z.boolean().default(false),
  barcodes: z.array(barcode).max(20).default([]),
});
export type CreateProductRequest = z.input<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    category: z.string().trim().min(1).max(100),
    unitOfMeasure: z.string().trim().min(1).max(20),
    status: z.enum(["active", "inactive"]),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });
export type UpdateProductRequest = z.input<typeof updateProductSchema>;

export const addBarcodeSchema = z.object({ barcode });

export const productSearchSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createLocationSchema = z.object({
  code: z.string().trim().min(1).max(50),
  kind: z.enum(["zone", "rack", "shelf", "bin"]),
  purpose: z.enum(["storage", "receiving", "packing", "quarantine"]).default("storage"),
  parentId: z.string().uuid().optional(),
  /** Whether stock here can be reserved for orders. Only storage locations can be. */
  allocatable: z.boolean().optional(),
});
export type CreateLocationRequest = z.input<typeof createLocationSchema>;

export const updateLocationSchema = z
  .object({ status: z.enum(["active", "inactive"]), allocatable: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });
export type UpdateLocationRequest = z.input<typeof updateLocationSchema>;

export interface ProductView {
  productId: string;
  sku: string;
  name: string;
  category: string;
  unitOfMeasure: string;
  batchTracked: boolean;
  status: "active" | "inactive";
  avgUnitCostPaise: number | null;
  barcodes: string[];
}

export type LocationView = {
  locationId: string;
  code: string;
  kind: string;
  purpose: string;
  parentId: string | null;
  allocatable: boolean;
  status: string;
};

/**
 * Products, barcodes and storage locations.
 *
 * The catalogue is shared by every store of the operator, so products carry
 * no store id; routes still sit under a store for permission checks.
 * Locations belong to one store.
 */
@Injectable()
export class CatalogService {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async createProduct(actor: Actor, request: CreateProductRequest): Promise<ProductView> {
    const body = parse(createProductSchema, request, "Invalid product");
    const productId = await this.write(actor, "products.create", body, async (tx) => {
      const [row] = await tx
        .insert(products)
        .values({
          sku: body.sku,
          name: body.name,
          category: body.category,
          unitOfMeasure: body.unitOfMeasure,
          batchTracked: body.batchTracked,
        })
        .returning({ id: products.id });
      const codes = [...new Set(body.barcodes)];
      if (codes.length) await tx.insert(productBarcodes).values(codes.map((code) => ({ barcode: code, productId: row!.id })));
      await this.audit(tx, actor, "product.create", "product", row!.id, null, body);
      return row!.id;
    });
    return this.getProduct(productId);
  }

  async updateProduct(actor: Actor, productId: string, request: UpdateProductRequest): Promise<ProductView> {
    const body = parse(updateProductSchema, request, "Invalid product change");
    await this.write(actor, "products.update", { productId, ...body }, async (tx) => {
      const [before] = await tx.select().from(products).where(eq(products.id, productId)).for("update");
      if (!before) throw new NotFoundError("Product not found", { productId });
      await tx.update(products).set(body).where(eq(products.id, productId));
      const changed = Object.fromEntries(Object.keys(body).map((k) => [k, before[k as keyof typeof before]]));
      await this.audit(tx, actor, "product.update", "product", productId, changed, body);
      return productId;
    });
    return this.getProduct(productId);
  }

  async addBarcode(actor: Actor, productId: string, request: { barcode?: string }): Promise<ProductView> {
    const body = parse(addBarcodeSchema, request, "Invalid barcode");
    await this.write(actor, "products.add_barcode", { productId, ...body }, async (tx) => {
      const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.id, productId));
      if (!product) throw new NotFoundError("Product not found", { productId });
      await tx.insert(productBarcodes).values({ barcode: body.barcode, productId });
      await this.audit(tx, actor, "product.add_barcode", "product", productId, null, body);
      return productId;
    });
    return this.getProduct(productId);
  }

  async getProduct(productId: string): Promise<ProductView> {
    const [view] = await this.productViews(eq(products.id, productId));
    if (!view) throw new NotFoundError("Product not found", { productId });
    return view;
  }

  /** What a scanner reads: an exact barcode match. */
  async findByBarcode(code: string): Promise<ProductView> {
    const [row] = await this.handle.db
      .select({ productId: productBarcodes.productId })
      .from(productBarcodes)
      .where(eq(productBarcodes.barcode, code.trim()));
    if (!row) throw new NotFoundError("No product has this barcode", { barcode: code });
    return this.getProduct(row.productId);
  }

  async searchProducts(query: unknown): Promise<{ items: ProductView[]; limit: number; offset: number }> {
    const { q, status, limit, offset } = parse(productSearchSchema, query, "Invalid search");
    const conditions = [];
    if (status) conditions.push(eq(products.status, status));
    if (q) {
      const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(
        or(
          ilike(products.sku, pattern),
          ilike(products.name, pattern),
          sql`EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = ${products.id} AND pb.barcode = ${q})`,
        ),
      );
    }
    const items = await this.productViews(and(...conditions), { limit, offset });
    return { items, limit, offset };
  }

  async createLocation(actor: Actor, request: CreateLocationRequest): Promise<LocationView> {
    const body = parse(createLocationSchema, request, "Invalid location");
    const allocatable = body.allocatable ?? body.purpose === "storage";
    if (allocatable && body.purpose !== "storage") {
      throw new ValidationError("Only storage locations can hold stock for orders");
    }
    const locationId = await this.write(actor, "locations.create", body, async (tx) => {
      if (body.parentId) {
        const [parent] = await tx
          .select({ id: locations.id })
          .from(locations)
          .where(and(eq(locations.id, body.parentId), eq(locations.storeId, actor.storeId)));
        if (!parent) throw new NotFoundError("Parent location not found", { parentId: body.parentId });
      }
      const [row] = await tx
        .insert(locations)
        .values({
          storeId: actor.storeId,
          code: body.code,
          kind: body.kind,
          purpose: body.purpose,
          parentId: body.parentId ?? null,
          allocatable,
        })
        .returning({ id: locations.id });
      await this.audit(tx, actor, "location.create", "location", row!.id, null, { ...body, allocatable });
      return row!.id;
    });
    return this.getLocation(actor.storeId, locationId);
  }

  /**
   * Deactivating a location is refused while it still holds stock. The row is
   * locked so a receipt or putaway into it cannot slip in at the same time.
   */
  async updateLocation(actor: Actor, locationId: string, request: UpdateLocationRequest): Promise<LocationView> {
    const body = parse(updateLocationSchema, request, "Invalid location change");
    await this.write(actor, "locations.update", { locationId, ...body }, async (tx) => {
      const [before] = await tx
        .select()
        .from(locations)
        .where(and(eq(locations.id, locationId), eq(locations.storeId, actor.storeId)))
        .for("update");
      if (!before) throw new NotFoundError("Location not found", { locationId });
      if (body.allocatable && before.purpose !== "storage") {
        throw new ValidationError("Only storage locations can hold stock for orders");
      }
      if (body.status === "inactive") {
        const [held] = await tx.execute<{ units: number }>(sql`
          SELECT coalesce(sum(on_hand), 0)::int AS units FROM inventory_balances WHERE location_id = ${locationId}`).then((r) => r.rows);
        if (held!.units > 0) {
          throw new ConflictError("Move the stock out before deactivating this location", { units: held!.units });
        }
      }
      await tx.update(locations).set(body).where(eq(locations.id, locationId));
      await this.audit(
        tx,
        actor,
        "location.update",
        "location",
        locationId,
        { status: before.status, allocatable: before.allocatable },
        body,
      );
      return locationId;
    });
    return this.getLocation(actor.storeId, locationId);
  }

  async listLocations(storeId: string): Promise<LocationView[]> {
    return this.locationQuery(eq(locations.storeId, storeId));
  }

  async getLocation(storeId: string, locationId: string): Promise<LocationView> {
    const [view] = await this.locationQuery(and(eq(locations.storeId, storeId), eq(locations.id, locationId)));
    if (!view) throw new NotFoundError("Location not found", { locationId });
    return view;
  }

  private locationQuery(where: ReturnType<typeof and>) {
    return this.handle.db
      .select({
        locationId: locations.id,
        code: locations.code,
        kind: locations.kind,
        purpose: locations.purpose,
        parentId: locations.parentId,
        allocatable: locations.allocatable,
        status: locations.status,
      })
      .from(locations)
      .where(where)
      .orderBy(asc(locations.code));
  }

  private async productViews(
    where: ReturnType<typeof and>,
    page: { limit: number; offset: number } = { limit: 1, offset: 0 },
  ): Promise<ProductView[]> {
    const rows = await this.handle.db
      .select()
      .from(products)
      .where(where)
      .orderBy(asc(products.sku))
      .limit(page.limit)
      .offset(page.offset);
    if (rows.length === 0) return [];
    const codes = await this.handle.db
      .select()
      .from(productBarcodes)
      .where(inArray(productBarcodes.productId, rows.map((r) => r.id)))
      .orderBy(asc(productBarcodes.barcode));
    return rows.map((p) => ({
      productId: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      unitOfMeasure: p.unitOfMeasure,
      batchTracked: p.batchTracked,
      status: p.status,
      avgUnitCostPaise: p.avgUnitCostPaise,
      barcodes: codes.filter((c) => c.productId === p.id).map((c) => c.barcode),
    }));
  }

  /** One idempotent transaction, with unique-key clashes turned into 409s. */
  private async write(actor: Actor, scope: string, request: unknown, fn: (tx: DbExecutor) => Promise<string>): Promise<string> {
    try {
      return await this.handle.db.transaction((tx) =>
        runIdempotent(tx, { storeId: actor.storeId, scope, key: actor.idempotencyKey, request }, () => fn(tx)),
      );
    } catch (err) {
      if (pgErrorCode(err) === "23505") {
        const constraint = pgConstraint(err);
        const what =
          constraint === "products_sku_unique"
            ? "A product with this SKU already exists"
            : constraint === "product_barcodes_pkey"
              ? "This barcode already belongs to a product"
              : constraint === "locations_store_code"
                ? "A location with this code already exists"
                : "This already exists";
        throw new ConflictError(what, { constraint });
      }
      throw err;
    }
  }

  private async audit(
    tx: DbExecutor,
    actor: Actor,
    action: string,
    entityType: string,
    entityId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      storeId: actor.storeId,
      actorUserId: actor.actorUserId,
      action,
      entityType,
      entityId,
      before,
      after,
    });
  }
}
