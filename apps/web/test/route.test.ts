import { describe, expect, it } from "vitest";
import { href, parseRoute, permissionFor } from "../src/route";

describe("routes", () => {
  it("round-trips every screen through the URL hash", () => {
    const routes = [
      { screen: "stores" },
      { screen: "queue", job: "pick", storeId: "s1" },
      { screen: "queue", job: "pack", storeId: "s1" },
      { screen: "order", job: "pack", storeId: "s1", orderId: "o1" },
      { screen: "shortages", storeId: "s1" },
      { screen: "receive", storeId: "s1" },
      { screen: "receipt", storeId: "s1", purchaseOrderId: "po1" },
      { screen: "new-purchase-order", storeId: "s1" },
      { screen: "putaway", storeId: "s1" },
      { screen: "count", storeId: "s1" },
      { screen: "approvals", storeId: "s1" },
      { screen: "stock", storeId: "s1" },
      { screen: "shelf", storeId: "s1", locationId: "a1" },
      { screen: "products", storeId: "s1" },
      { screen: "shelves", storeId: "s1" },
      { screen: "dashboard", storeId: "s1" },
      { screen: "orders", storeId: "s1" },
      { screen: "new-order", storeId: "s1" },
      { screen: "opening-stock", storeId: "s1" },
    ] as const;
    for (const route of routes) expect(parseRoute(href(route))).toEqual(route);
  });

  it("falls back to the jobs screen for anything unknown", () => {
    expect(parseRoute("#/stores/s1/teleport")).toEqual({ screen: "stores" });
    expect(parseRoute("#/stores/s1/putaway/x")).toEqual({ screen: "stores" });
    expect(parseRoute("#/stores/s1/receive/po1/extra")).toEqual({ screen: "stores" });
    expect(parseRoute("#/stores/s1/orders/o1")).toEqual({ screen: "stores" });
  });

  it("names the permission each screen needs", () => {
    expect(permissionFor({ screen: "stores" })).toBeNull();
    expect(permissionFor({ screen: "order", job: "pack", storeId: "s1", orderId: "o1" })).toBe("orders.pack");
    expect(permissionFor({ screen: "receipt", storeId: "s1", purchaseOrderId: "po1" })).toBe("receiving.record");
    expect(permissionFor({ screen: "putaway", storeId: "s1" })).toBe("inventory.putaway");
    expect(permissionFor({ screen: "new-purchase-order", storeId: "s1" })).toBe("purchasing.manage");
    expect(permissionFor({ screen: "shelf", storeId: "s1", locationId: "a1" })).toBe("inventory.count");
    expect(permissionFor({ screen: "approvals", storeId: "s1" })).toBe("inventory.approve_request");
    expect(permissionFor({ screen: "stock", storeId: "s1" })).toBe("inventory.adjust");
    expect(permissionFor({ screen: "products", storeId: "s1" })).toBe("catalog.manage");
    expect(permissionFor({ screen: "shelves", storeId: "s1" })).toBe("locations.manage");
    expect(permissionFor({ screen: "dashboard", storeId: "s1" })).toBe("dashboard.view");
    expect(permissionFor({ screen: "new-order", storeId: "s1" })).toBe("orders.create");
    expect(permissionFor({ screen: "opening-stock", storeId: "s1" })).toBe("inventory.opening_stock");
  });
});
