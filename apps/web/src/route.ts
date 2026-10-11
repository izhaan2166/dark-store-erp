import { useEffect, useState } from "react";

/**
 * Screens live in the URL hash (#/stores/<id>/pick/<orderId>, …/receive/<purchaseOrderId>, …) so a
 * refresh or the back button keeps the worker where they were.
 */
export type Job = "pick" | "pack";

export type Route =
  | { screen: "stores" }
  | { screen: "queue"; job: Job; storeId: string }
  | { screen: "order"; job: Job; storeId: string; orderId: string }
  | { screen: "shortages"; storeId: string }
  | { screen: "receive"; storeId: string }
  | { screen: "receipt"; storeId: string; purchaseOrderId: string }
  | { screen: "new-purchase-order"; storeId: string }
  | { screen: "putaway"; storeId: string }
  | { screen: "count"; storeId: string }
  | { screen: "approvals"; storeId: string }
  | { screen: "stock"; storeId: string }
  | { screen: "products"; storeId: string }
  | { screen: "dashboard"; storeId: string }
  | { screen: "shelves"; storeId: string }
  | { screen: "orders"; storeId: string }
  | { screen: "new-order"; storeId: string }
  | { screen: "opening-stock"; storeId: string }
  | { screen: "staff"; storeId: string }
  | { screen: "shelf"; storeId: string; locationId: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [root, storeId, job, id, extra] = parts;
  if (root !== "stores" || !storeId || extra) return { screen: "stores" };
  if (job === "pick" || job === "pack") return id ? { screen: "order", job, storeId, orderId: id } : { screen: "queue", job, storeId };
  if (job === "count") return id ? { screen: "shelf", storeId, locationId: id } : { screen: "count", storeId };
  if (job === "orders") return id === "new" ? { screen: "new-order", storeId } : id ? { screen: "stores" } : { screen: "orders", storeId };
  if (job === "receive") return id === "new" ? { screen: "new-purchase-order", storeId } : id ? { screen: "receipt", storeId, purchaseOrderId: id } : { screen: "receive", storeId };
  if (job === "opening-stock" && !id) return { screen: "opening-stock", storeId };
  if ((job === "shortages" || job === "putaway" || job === "approvals" || job === "stock" || job === "products" || job === "shelves" || job === "dashboard" || job === "staff") && !id) return { screen: job, storeId };
  return { screen: "stores" };
}

export function href(route: Route): string {
  switch (route.screen) {
    case "stores":
      return "#/";
    case "queue":
      return `#/stores/${route.storeId}/${route.job}`;
    case "order":
      return `#/stores/${route.storeId}/${route.job}/${route.orderId}`;
    case "shortages":
      return `#/stores/${route.storeId}/shortages`;
    case "receive":
      return `#/stores/${route.storeId}/receive`;
    case "receipt":
      return `#/stores/${route.storeId}/receive/${route.purchaseOrderId}`;
    case "new-purchase-order":
      return `#/stores/${route.storeId}/receive/new`;
    case "putaway":
      return `#/stores/${route.storeId}/putaway`;
    case "count":
      return `#/stores/${route.storeId}/count`;
    case "approvals":
      return `#/stores/${route.storeId}/approvals`;
    case "stock":
      return `#/stores/${route.storeId}/stock`;
    case "products":
      return `#/stores/${route.storeId}/products`;
    case "dashboard":
      return `#/stores/${route.storeId}/dashboard`;
    case "shelves":
      return `#/stores/${route.storeId}/shelves`;
    case "shelf":
      return `#/stores/${route.storeId}/count/${route.locationId}`;
    case "orders":
      return `#/stores/${route.storeId}/orders`;
    case "new-order":
      return `#/stores/${route.storeId}/orders/new`;
    case "opening-stock":
      return `#/stores/${route.storeId}/opening-stock`;
    case "staff":
      return `#/stores/${route.storeId}/staff`;
  }
}

/** The permission a screen needs; the jobs screen needs none. */
export function permissionFor(route: Route): string | null {
  switch (route.screen) {
    case "stores":
      return null;
    case "queue":
    case "order":
      return route.job === "pick" ? "orders.pick" : "orders.pack";
    case "shortages":
      return "orders.resolve_shortage";
    case "receive":
    case "receipt":
      return "receiving.record";
    case "new-purchase-order":
      return "purchasing.manage";
    case "putaway":
      return "inventory.putaway";
    case "count":
    case "shelf":
      return "inventory.count";
    case "approvals":
      return "inventory.approve_request";
    case "stock":
      return "inventory.adjust";
    case "products":
      return "catalog.manage";
    case "dashboard":
      return "dashboard.view";
    case "shelves":
      return "locations.manage";
    case "orders":
    case "new-order":
      return "orders.create";
    case "opening-stock":
      return "inventory.opening_stock";
    case "staff":
      return "staff.manage";
  }
}

export function go(route: Route): void {
  window.location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
