import { describe, expect, it } from "vitest";
import { href, parseRoute } from "../src/route";

describe("routes", () => {
  it("round-trips every screen through the URL hash", () => {
    const routes = [
      { screen: "stores" },
      { screen: "queue", job: "pick", storeId: "s1" },
      { screen: "queue", job: "pack", storeId: "s1" },
      { screen: "order", job: "pack", storeId: "s1", orderId: "o1" },
      { screen: "shortages", storeId: "s1" },
    ] as const;
    for (const route of routes) expect(parseRoute(href(route))).toEqual(route);
  });

  it("falls back to the jobs screen for anything unknown", () => {
    expect(parseRoute("#/stores/s1/teleport")).toEqual({ screen: "stores" });
  });
});
