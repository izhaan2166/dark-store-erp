import { useEffect, useState } from "react";

/**
 * Screens live in the URL hash (#/stores/<id>/pick/<orderId>, …/pack/<orderId>) so a refresh or
 * the back button keeps the picker where they were.
 */
export type Job = "pick" | "pack";

export type Route =
  | { screen: "stores" }
  | { screen: "queue"; job: Job; storeId: string }
  | { screen: "order"; job: Job; storeId: string; orderId: string }
  | { screen: "shortages"; storeId: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const job = parts[2];
  if (parts[0] === "stores" && parts[1] && job === "shortages" && !parts[3]) return { screen: "shortages", storeId: parts[1] };
  if (parts[0] === "stores" && parts[1] && (job === "pick" || job === "pack")) {
    return parts[3]
      ? { screen: "order", job, storeId: parts[1], orderId: parts[3] }
      : { screen: "queue", job, storeId: parts[1] };
  }
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
