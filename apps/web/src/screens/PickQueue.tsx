import { useCallback, useEffect, useState } from "react";
import { type Api, ApiError, type OrderSummary } from "../api";
import { href } from "../route";

const REFRESH_MS = 15_000;

/** Orders waiting to be picked, oldest first. Refreshes itself. */
export function PickQueue(props: { api: Api; storeId: string }) {
  const { api, storeId } = props;
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOrders(await api.orders(storeId, "accepted,picking"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load orders");
    }
  }, [api, storeId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <main>
      <header className="bar">
        <a href={href({ screen: "stores" })}>‹ Jobs</a>
        <h1>Orders to pick</h1>
        <button onClick={() => void load()}>Refresh</button>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {orders === null && !error && <p className="muted">Loading…</p>}
      {orders?.length === 0 && <p className="muted">Nothing to pick right now.</p>}
      <ul className="list">
        {orders?.map((order) => (
          <li key={order.orderId}>
            <a className="row" href={href({ screen: "pick", storeId, orderId: order.orderId })}>
              <strong>{order.externalRef}</strong>
              <span>
                {order.pickedUnits}/{order.requestedUnits} units · {order.lineCount} {order.lineCount === 1 ? "item" : "items"}
              </span>
              {order.status === "picking" && <span className="tag">In progress</span>}
              {order.openShortages > 0 && <span className="tag warn">Missing items</span>}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
