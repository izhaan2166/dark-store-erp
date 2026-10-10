import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLogs, inventoryBalances, inventoryMovements, products } from "@dse/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { receivingNeedsApproval } from "../src/receiving/receiving.service";
import { actor, createContext, createProduct, createStore, orderRef, type TestContext, type TestStore } from "./support/fixtures";

let ctx: TestContext;
let store: TestStore;
let supplierId: string;

beforeAll(async () => {
  ctx = createContext(20);
  store = await createStore(ctx);
  supplierId = (await ctx.purchasing.createSupplier(actor(store), { code: `SUP-${randomUUID().slice(0, 6)}`, name: "Fresh Farms" }))
    .supplierId;
});
afterAll(() => ctx.handle.close());

async function purchaseOrder(lines: { productId: string; quantity: number; unitCostPaise?: number }[]) {
  return ctx.purchasing.createPurchaseOrder(actor(store), {
    supplierId,
    poNumber: `PO-${randomUUID().slice(0, 8)}`,
    lines: lines.map((l) => ({ unitCostPaise: 1000, ...l })),
  });
}

async function balances(productId: string) {
  return ctx.handle.db
    .select({
      locationId: inventoryBalances.locationId,
      status: inventoryBalances.status,
      onHand: inventoryBalances.onHand,
    })
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.storeId, store.storeId), eq(inventoryBalances.productId, productId)));
}

const onHand = async (productId: string, status: string) =>
  (await balances(productId)).filter((b) => b.status === status).reduce((n, b) => n + b.onHand, 0);

async function expectReconciled() {
  const report = await ctx.reconciliation.run(store.storeId);
  expect(report).toMatchObject({ ok: true });
}

describe("receiving tolerance rule", () => {
  it("allows up to 5% either way and flags anything beyond", () => {
    expect(receivingNeedsApproval(100, 95, 5)).toBe(false);
    expect(receivingNeedsApproval(100, 105, 5)).toBe(false);
    expect(receivingNeedsApproval(100, 94, 5)).toBe(true);
    expect(receivingNeedsApproval(100, 106, 5)).toBe(true);
    expect(receivingNeedsApproval(3, 2, 5)).toBe(true);
  });

  it("needs approval for any accepted units when nothing was expected", () => {
    expect(receivingNeedsApproval(0, 1, 5)).toBe(true);
    expect(receivingNeedsApproval(0, 0, 5)).toBe(false);
  });
});

describe("goods receipts", () => {
  it("receiving 10 accepted units adds 10 to stock and creates a traceable GRN", async () => {
    const productId = await createProduct(ctx);
    const po = await purchaseOrder([{ productId, quantity: 10, unitCostPaise: 2500 }]);
    const grn = await ctx.receiving.recordReceipt(actor(store), {
      purchaseOrderId: po.purchaseOrderId,
      receivingLocationId: store.receiving,
      lines: [{ productId, acceptedQty: 10 }],
    });

    expect(grn.status).toBe("posted");
    expect(grn.discrepancies).toEqual([]);
    expect(await onHand(productId, "receiving")).toBe(10);
    expect(await onHand(productId, "available")).toBe(0);

    const movements = await ctx.handle.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.sourceId, grn.goodsReceiptId));
    expect(movements).toMatchObject([{ movementType: "receipt", sourceType: "goods_receipt", quantity: 10 }]);

    const after = await ctx.purchasing.getPurchaseOrder(store.storeId, po.purchaseOrderId);
    expect(after.status).toBe("received");
    expect(after.lines[0]).toMatchObject({ receivedQty: 10, outstandingQty: 0 });
    await expectReconciled();
  });

  it("posts a small shortfall at once and records it", async () => {
    const productId = await createProduct(ctx);
    const po = await purchaseOrder([{ productId, quantity: 100 }]);
    const grn = await ctx.receiving.recordReceipt(actor(store), {
      purchaseOrderId: po.purchaseOrderId,
      receivingLocationId: store.receiving,
      lines: [{ productId, acceptedQty: 97 }],
    });
    expect(grn.status).toBe("posted");
    expect(grn.discrepancies).toMatchObject([{ kind: "short", quantity: 3 }]);
    expect((await ctx.purchasing.getPurchaseOrder(store.storeId, po.purchaseOrderId)).status).toBe("open");
  });

  it("holds a receipt outside tolerance until a manager approves it with a reason", async () => {
    const productId = await createProduct(ctx);
    const po = await purchaseOrder([{ productId, quantity: 100 }]);
    const grn = await ctx.receiving.recordReceipt(actor(store), {
      purchaseOrderId: po.purchaseOrderId,
      receivingLocationId: store.receiving,
      lines: [{ productId, acceptedQty: 90 }],
    });
    expect(grn.status).toBe("pending_approval");
    expect(grn.lines[0]).toMatchObject({ expectedQty: 100, needsApproval: true });
    expect(await balances(productId)).toEqual([]);

    await expect(ctx.receiving.approveReceipt(actor(store), grn.goodsReceiptId, "  ")).rejects.toThrow(/reason/);

    const approved = await ctx.receiving.approveReceipt(actor(store), grn.goodsReceiptId, "Supplier confirmed short shipment");
    expect(approved).toMatchObject({ status: "posted", decisionReason: "Supplier confirmed short shipment" });
    expect(await onHand(productId, "receiving")).toBe(90);

    const [audit] = await ctx.handle.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, grn.goodsReceiptId), eq(auditLogs.action, "goods_receipt.approve")));
    expect(audit!.after).toMatchObject({ status: "posted", reason: "Supplier confirmed short shipment" });

    await expect(ctx.receiving.approveReceipt(actor(store), grn.goodsReceiptId, "again")).rejects.toThrow(
      /not waiting for approval/,
    );
    await expectReconciled();
  });

  it("moves no stock when a manager cancels a held receipt", async () => {
    const productId = await createProduct(ctx);
    const po = await purchaseOrder([{ productId, quantity: 100 }]);
    const grn = await ctx.receiving.recordReceipt(actor(store), {
      purchaseOrderId: po.purchaseOrderId,
      receivingLocationId: store.receiving,
      lines: [{ productId, acceptedQty: 120 }],
    });
    expect(grn.discrepancies).toMatchObject([{ kind: "excess", quantity: 20 }]);
    const cancelled = await ctx.receiving.cancelReceipt(actor(store), grn.goodsReceiptId, "Wrong delivery");
    expect(cancelled.status).toBe("cancelled");
    expect(await balances(productId)).toEqual([]);
    expect((await ctx.purchasing.getPurchaseOrder(store.storeId, po.purchaseOrderId)).lines[0]!.receivedQty).toBe(0);
  });

  it("always holds ad hoc receipts and unordered items for approval", async () => {
    const productId = await createProduct(ctx);
    const adHoc = await ctx.receiving.recordReceipt(actor(store), {
      supplierId,
      receivingLocationId: store.receiving,
      lines: [{ productId, acceptedQty: 1, unitCostPaise: 500 }],
    });
    expect(adHoc.status).toBe("pending_approval");
    expect(adHoc.discrepancies).toMatchObject([{ kind: "unordered", quantity: 1 }]);

    const ordered = await createProduct(ctx);
    const po = await purchaseOrder([{ productId: ordered, quantity: 10 }]);
    const mixed = await ctx.receiving.recordReceipt(actor(store), {
      purchaseOrderId: po.purchaseOrderId,
      receivingLocationId: store.receiving,
      lines: [{ productId: ordered, acceptedQty: 10 }, { productId, acceptedQty: 2, unitCostPaise: 500 }],
    });
    expect(mixed.status).toBe("pending_approval");
    expect(mixed.lines.map((l) => l.needsApproval)).toEqual([false, true]);

    await expect(
      ctx.receiving.recordReceipt(actor(store), {
        supplierId,
        receivingLocationId: store.receiving,
        lines: [{ productId, acceptedQty: 1 }],
      }),
    ).rejects.toThrow(/unit cost is required/);
  });

  it("keeps damaged units out of sellable stock and never takes in rejected ones", async () => {
    const productId = await createProduct(ctx);
    const po = await purchaseOrder([{ productId, quantity: 10 }]);
    const grn = await ctx.receiving.recordReceipt(actor(store), {
      purchaseOrderId: po.purchaseOrderId,
      receivingLocationId: store.receiving,
      lines: [{ productId, acceptedQty: 8, damagedQty: 1, rejectedQty: 1, note: "Crushed carton" }],
    });
    // Damaged and rejected units lower the accepted quantity: 8 of 10 is 20% short.
    expect(grn.status).toBe("pending_approval");
    expect(grn.discrepancies.map((d) => [d.kind, d.quantity]).sort()).toEqual([
      ["damaged", 1],
      ["rejected", 1],
      ["short", 2],
    ]);
    await ctx.receiving.approveReceipt(actor(store), grn.goodsReceiptId, "Accept 8, return the rest");

    expect(await onHand(productId, "receiving")).toBe(8);
    expect(await onHand(productId, "damaged")).toBe(1);
    expect((await balances(productId)).find((b) => b.status === "damaged")!.locationId).toBe(store.quarantine);
    expect(await onHand(productId, "available")).toBe(0);
    await expectReconciled();
  });

  it("records lot and expiry for batch-tracked products and refuses expired goods", async () => {
    const productId = await createProduct(ctx, { batchTracked: true });
    const po = await purchaseOrder([{ productId, quantity: 10 }]);
    const base = { purchaseOrderId: po.purchaseOrderId, receivingLocationId: store.receiving };

    await expect(ctx.receiving.recordReceipt(actor(store), { ...base, lines: [{ productId, acceptedQty: 10 }] })).rejects.toThrow(
      /Lot code and expiry date are required/,
    );
    await expect(
      ctx.receiving.recordReceipt(actor(store), {
        ...base,
        lines: [{ productId, acceptedQty: 10, lotCode: "L-OLD", expiryDate: "2020-01-01" }],
      }),
    ).rejects.toThrow(/Expired goods cannot be accepted/);

    const grn = await ctx.receiving.recordReceipt(actor(store), {
      ...base,
      lines: [
        { productId, acceptedQty: 6, lotCode: "L-1", expiryDate: "2099-01-31" },
        { productId, acceptedQty: 4, lotCode: "L-2", expiryDate: "2099-03-31" },
      ],
    });
    // The two lots together match the purchase order line exactly.
    expect(grn.status).toBe("posted");
    expect(new Set(grn.lines.map((l) => l.batchId)).size).toBe(2);
    expect(await onHand(productId, "receiving")).toBe(10);
  });

  it("keeps a moving weighted-average unit cost", async () => {
    const productId = await createProduct(ctx);
    const cost = async () =>
      (await ctx.handle.db.select({ c: products.avgUnitCostPaise }).from(products).where(eq(products.id, productId)))[0]!.c;

    const first = await purchaseOrder([{ productId, quantity: 10, unitCostPaise: 1000 }]);
    await ctx.receiving.recordReceipt(actor(store), {
      purchaseOrderId: first.purchaseOrderId,
      receivingLocationId: store.receiving,
      lines: [{ productId, acceptedQty: 10 }],
    });
    expect(await cost()).toBe(1000);

    const second = await purchaseOrder([{ productId, quantity: 30, unitCostPaise: 2000 }]);
    await ctx.receiving.recordReceipt(actor(store), {
      purchaseOrderId: second.purchaseOrderId,
      receivingLocationId: store.receiving,
      lines: [{ productId, acceptedQty: 30 }],
    });
    // (10 × 1000 + 30 × 2000) / 40
    expect(await cost()).toBe(1750);
  });

  it("does not let two simultaneous receipts both claim the same outstanding quantity", async () => {
    const productId = await createProduct(ctx);
    const po = await purchaseOrder([{ productId, quantity: 100 }]);
    const receipts = await Promise.all(
      [1, 2, 3].map(() =>
        ctx.receiving.recordReceipt(actor(store), {
          purchaseOrderId: po.purchaseOrderId,
          receivingLocationId: store.receiving,
          lines: [{ productId, acceptedQty: 100 }],
        }),
      ),
    );
    // Exactly one matches the order; the others find nothing outstanding and wait for approval.
    expect(receipts.map((r) => r.status).sort()).toEqual(["pending_approval", "pending_approval", "posted"]);
    expect(await onHand(productId, "receiving")).toBe(100);
    await expectReconciled();
  });

  it("refuses receipts into a location that is not a receiving area", async () => {
    const productId = await createProduct(ctx);
    const po = await purchaseOrder([{ productId, quantity: 1 }]);
    await expect(
      ctx.receiving.recordReceipt(actor(store), {
        purchaseOrderId: po.purchaseOrderId,
        receivingLocationId: store.binA,
        lines: [{ productId, acceptedQty: 1 }],
      }),
    ).rejects.toThrow(/active receiving location/);
  });
});

describe("putaway", () => {
  async function received(quantity: number, opts: { batchTracked?: boolean } = {}) {
    const productId = await createProduct(ctx, opts);
    const po = await purchaseOrder([{ productId, quantity }]);
    const grn = await ctx.receiving.recordReceipt(actor(store), {
      purchaseOrderId: po.purchaseOrderId,
      receivingLocationId: store.receiving,
      lines: [
        opts.batchTracked
          ? { productId, acceptedQty: quantity, lotCode: "L-P", expiryDate: "2099-12-31" }
          : { productId, acceptedQty: quantity },
      ],
    });
    return { productId, batchId: grn.lines[0]!.batchId };
  }

  it("makes received stock sellable only once it is in a storage bin", async () => {
    const { productId } = await received(10);
    const before = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 4 }] });
    expect(before.lines[0]!.reservedQty).toBe(0);

    await ctx.receiving.putaway(actor(store), {
      productId,
      fromLocationId: store.receiving,
      toLocationId: store.binA,
      quantity: 6,
    });
    expect(await onHand(productId, "receiving")).toBe(4);
    expect(await onHand(productId, "available")).toBe(6);

    const after = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 4 }] });
    expect(after.fullyReserved).toBe(true);
    await expectReconciled();
  });

  it("cannot put away more than was received or into a non-storage location", async () => {
    const { productId, batchId } = await received(5, { batchTracked: true });
    await expect(
      ctx.receiving.putaway(actor(store), {
        productId,
        batchId,
        fromLocationId: store.receiving,
        toLocationId: store.binA,
        quantity: 6,
      }),
    ).rejects.toThrow(/Not enough stock/);
    await expect(
      ctx.receiving.putaway(actor(store), {
        productId,
        batchId,
        fromLocationId: store.receiving,
        toLocationId: store.packing,
        quantity: 1,
      }),
    ).rejects.toThrow(/active storage location/);
  });

  it("returns the same result when a putaway is retried with the same key", async () => {
    const { productId } = await received(5);
    const request = { productId, fromLocationId: store.receiving, toLocationId: store.binB, quantity: 5 };
    const key = randomUUID();
    const first = await ctx.receiving.putaway(actor(store, key), request);
    const retry = await ctx.receiving.putaway(actor(store, key), request);
    expect(retry).toEqual(first);
    expect(await onHand(productId, "available")).toBe(5);
  });
});
