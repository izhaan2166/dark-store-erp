import { useEffect, useState } from "react";

/**
 * Screens live in the URL hash (#/stores/<id>/pick/<orderId>) so a refresh or
 * the back button keeps the picker where they were.
 */
export type Route =
  | { screen: "stores" }
  | { screen: "queue"; storeId: string }
  | { screen: "pick"; storeId: string; orderId: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "stores" && parts[1] && parts[2] === "pick") {
    return parts[3] ? { screen: "pick", storeId: parts[1], orderId: parts[3] } : { screen: "queue", storeId: parts[1] };
  }
  return { screen: "stores" };
}

export function href(route: Route): string {
  switch (route.screen) {
    case "stores":
      return "#/";
    case "queue":
      return `#/stores/${route.storeId}/pick`;
    case "pick":
      return `#/stores/${route.storeId}/pick/${route.orderId}`;
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
