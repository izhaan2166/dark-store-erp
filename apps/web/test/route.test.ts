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
      { screen: "putaway", storeId: "s1" },
      { screen: "count", storeId: "s1" },
      { screen: "shelf", storeId: "s1", locationId: "a1" },
    ] as const;
    for (const route of routes) expect(parseRoute(href(route))).toEqual(route);
  });

  it("falls back to the jobs screen for anything unknown", () => {
    expect(parseRoute("#/stores/s1/teleport")).toEqual({ screen: "stores" });
    expect(parseRoute("#/stores/s1/putaway/x")).toEqual({ screen: "stores" });
    expect(parseRoute("#/stores/s1/receive/po1/extra")).toEqual({ screen: "stores" });
  });

  it("names the permission each screen needs", () => {
    expect(permissionFor({ screen: "stores" })).toBeNull();
    expect(permissionFor({ screen: "order", job: "pack", storeId: "s1", orderId: "o1" })).toBe("orders.pack");
    expect(permissionFor({ screen: "receipt", storeId: "s1", purchaseOrderId: "po1" })).toBe("receiving.record");
    expect(permissionFor({ screen: "putaway", storeId: "s1" })).toBe("inventory.putaway");
    expect(permissionFor({ screen: "shelf", storeId: "s1", locationId: "a1" })).toBe("inventory.count");
  });
});
