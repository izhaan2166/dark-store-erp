import { useCallback, useEffect, useState } from "react";
import { type Api, ApiError, type OrderSummary } from "../api";
import { href, type Job } from "../route";

const REFRESH_MS = 15_000;

const JOBS: Record<Job, { title: string; statuses: string; empty: string }> = {
  pick: { title: "Orders to pick", statuses: "accepted,picking", empty: "Nothing to pick right now." },
  pack: { title: "Orders to pack", statuses: "packing,ready_for_handover", empty: "Nothing to pack right now." },
};

const STATUS_TAGS: Record<string, string> = {
  picking: "Picking",
  ready_for_handover: "Ready to hand over",
};

/** Orders waiting for this job, oldest first. Refreshes itself. */
export function OrderQueue(props: { api: Api; storeId: string; job: Job }) {
  const { api, storeId, job } = props;
  const config = JOBS[job];
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOrders(await api.orders(storeId, config.statuses));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load orders");
    }
  }, [api, storeId, config.statuses]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <main>
      <header className="bar">
        <a href={href({ screen: "stores" })}>‹ Jobs</a>
        <h1>{config.title}</h1>
        <button onClick={() => void load()}>Refresh</button>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {orders === null && !error && <p className="muted">Loading…</p>}
      {orders?.length === 0 && <p className="muted">{config.empty}</p>}
      <ul className="list">
        {orders?.map((order) => (
          <li key={order.orderId}>
            <a className="row" href={href({ screen: "order", job, storeId, orderId: order.orderId })}>
              <strong>{order.externalRef}</strong>
              <span>
                {job === "pick" ? `${order.pickedUnits}/${order.requestedUnits} units` : `${order.pickedUnits} units`} ·{" "}
                {order.lineCount} {order.lineCount === 1 ? "item" : "items"}
              </span>
              {STATUS_TAGS[order.status] && <span className="tag">{STATUS_TAGS[order.status]}</span>}
              {order.openShortages > 0 && <span className="tag warn">Missing items</span>}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
