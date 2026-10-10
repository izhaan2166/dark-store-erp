import { useCallback, useEffect, useState } from "react";
import { type Api, ApiError, type PurchaseOrderSummary } from "../api";
import { href } from "../route";

const REFRESH_MS = 30_000;

/** Purchase orders still expected, oldest first. The receiver opens the one being delivered. */
export function ReceiveList(props: { api: Api; storeId: string; canOrder?: boolean }) {
  const { api, storeId } = props;
  const [orders, setOrders] = useState<PurchaseOrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOrders(await api.purchaseOrders(storeId));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load deliveries");
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
        <h1>Deliveries</h1>
        {props.canOrder ? (
          <a className="button" href={href({ screen: "new-purchase-order", storeId })}>
            New purchase order
          </a>
        ) : (
          <button onClick={() => void load()}>Refresh</button>
        )}
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {orders === null && !error && <p className="muted">Loading…</p>}
      {orders?.length === 0 && <p className="muted">No deliveries are expected.</p>}
      <ul className="list">
        {orders?.map((po) => (
          <li key={po.purchaseOrderId}>
            <a className="row" href={href({ screen: "receipt", storeId, purchaseOrderId: po.purchaseOrderId })}>
              <strong>
                {po.poNumber} · {po.supplierName}
              </strong>
              <span>
                {po.outstandingUnits} of {po.orderedUnits} units to come · {po.lineCount} {po.lineCount === 1 ? "item" : "items"}
              </span>
              {po.pendingReceipts > 0 && <span className="tag warn">Waiting for approval</span>}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
