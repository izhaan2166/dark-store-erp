import { useCallback, useEffect, useState } from "react";
import { type Api, ApiError, type Dashboard as View, type ExpiringRow, type HandedOverRow, type OutOfStockRow } from "../api";
import { href, type Route } from "../route";

const REFRESH_MS = 60_000;

type Drill = "handed-over" | "out-of-stock" | "expiring";
type Rows = { kind: "handed-over"; rows: HandedOverRow[] } | { kind: "out-of-stock"; rows: OutOfStockRow[] } | { kind: "expiring"; rows: ExpiringRow[] };

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One thing waiting on someone, in words, with the screen that deals with it. */
export type Attention = { text: string; urgent: boolean; route: Route | null; permission: string };

/** The exceptions worth showing, most urgent first; nothing for zero counts. */
export function attentionItems(view: View, storeId: string): Attention[] {
  const e = view.exceptions;
  const items: Attention[] = [];
  if (e.openShortages > 0) {
    items.push({
      text:
        `${plural(e.openShortages, "missing item")} on orders` +
        (e.escalatedShortages > 0 ? `, ${e.escalatedShortages} waiting too long` : ""),
      urgent: e.escalatedShortages > 0,
      route: { screen: "shortages", storeId },
      permission: "orders.resolve_shortage",
    });
  }
  const approvals = e.receiptsAwaitingApproval + e.countsAwaitingApproval + e.requestsAwaitingApproval;
  if (approvals > 0) {
    const parts = [
      e.receiptsAwaitingApproval && plural(e.receiptsAwaitingApproval, "delivery", "deliveries"),
      e.countsAwaitingApproval && plural(e.countsAwaitingApproval, "count"),
      e.requestsAwaitingApproval && plural(e.requestsAwaitingApproval, "write-off or release", "write-offs or releases"),
    ].filter(Boolean);
    items.push({ text: `Waiting for approval: ${parts.join(", ")}`, urgent: false, route: { screen: "approvals", storeId }, permission: "inventory.approve_request" });
  }
  if (e.unitsAwaitingPutaway > 0) {
    items.push({
      text: `${plural(e.unitsAwaitingPutaway, "unit")} in the unloading area to put away`,
      urgent: false,
      route: { screen: "putaway", storeId },
      permission: "inventory.putaway",
    });
  }
  if (e.problemOrders > 0) {
    items.push({ text: `${plural(e.problemOrders, "order")} stuck with a problem`, urgent: true, route: null, permission: "orders.view" });
  }
  return items.sort((a, b) => Number(b.urgent) - Number(a.urgent));
}

/**
 * The Store Manager's view of today: four numbers and what is waiting on
 * someone. Tapping a number lists exactly the records it counted.
 */
export function Dashboard(props: { api: Api; storeId: string; permissions: string[] }) {
  const { api, storeId } = props;
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Drill | null>(null);
  const [rows, setRows] = useState<Rows | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.dashboard(storeId));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the dashboard");
    }
  }, [api, storeId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    setRows(null);
    if (!open) return;
    const fetchRows = async (): Promise<Rows> => {
      if (open === "handed-over") return { kind: open, rows: await api.handedOverToday(storeId) };
      if (open === "out-of-stock") return { kind: open, rows: await api.outOfStock(storeId) };
      return { kind: open, rows: await api.expiring(storeId) };
    };
    fetchRows().then(setRows, (err) => setError(err instanceof ApiError ? err.message : "Could not load the list"));
  }, [api, storeId, open, view]);

  const toggle = (drill: Drill) => setOpen((current) => (current === drill ? null : drill));
  const card = (drill: Drill | null, value: number | string, label: string, note?: string) => {
    const body = (
      <>
        <strong className="figure">{value}</strong>
        <span>{label}</span>
        {note && <span className="muted">{note}</span>}
      </>
    );
    return drill ? (
      <button
        className={open === drill ? "kpi open" : "kpi"}
        aria-label={`${value} ${label}${note ? `, ${note}` : ""}`}
        aria-expanded={open === drill}
        onClick={() => toggle(drill)}
      >
        {body}
      </button>
    ) : (
      <div className="kpi">{body}</div>
    );
  };

  const attention = view ? attentionItems(view, storeId) : [];

  return (
    <main>
      <header className="bar">
        <a href={href({ screen: "stores" })}>‹ Jobs</a>
        <h1>Today</h1>
        <button onClick={() => void load()}>Refresh</button>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {!view && !error && <p className="muted">Loading…</p>}
      {view && (
        <>
          <p className="muted">{longDate(view.today)} · updates every minute</p>
          <div className="kpis">
            {card(
              "handed-over",
              view.kpis.handedOverToday,
              view.kpis.handedOverToday === 1 ? "order sent out" : "orders sent out",
              view.kpis.medianFulfilmentMinutes === null ? undefined : `usually ${view.kpis.medianFulfilmentMinutes} min`,
            )}
            {card(null, view.kpis.awaitingFulfilment, view.kpis.awaitingFulfilment === 1 ? "order still to go out" : "orders still to go out")}
            {card("out-of-stock", view.kpis.outOfStock, view.kpis.outOfStock === 1 ? "item out of stock" : "items out of stock")}
            {card("expiring", view.kpis.expiryAlerts, view.kpis.expiryAlerts === 1 ? "lot expiring" : "lots expiring", `within ${plural(view.expiryAlertDays, "day")}`)}
          </div>

          {open && (
            <section aria-label="Details">
              {!rows && <p className="muted">Loading…</p>}
              {rows?.rows.length === 0 && <p className="muted">None.</p>}
              {rows?.kind === "handed-over" && (
                <ul className="list">
                  {rows.rows.map((r) => (
                    <li key={r.orderId} className="row">
                      <strong>{r.externalRef}</strong>
                      <span className="muted">
                        sent {time(r.handedOverAt)}, {r.minutes} min after it came in
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {rows?.kind === "out-of-stock" && (
                <ul className="list">
                  {rows.rows.map((r) => (
                    <li key={r.productId} className="row">
                      <strong>{r.name}</strong>
                      <span className="muted">{r.sku}</span>
                      {r.openShortageUnits > 0 && <span className="tag warn">{r.openShortageUnits} wanted on orders</span>}
                    </li>
                  ))}
                </ul>
              )}
              {rows?.kind === "expiring" && (
                <ul className="list">
                  {rows.rows.map((r) => (
                    <li key={`${r.batchId}|${r.locationCode}|${r.status}`} className="row">
                      <strong>
                        {r.onHand} × {r.name}
                      </strong>
                      <span className={r.expiryDate <= view.today ? "tag late" : "tag warn"}>
                        {r.expiryDate <= view.today ? "Expired" : "Expires"} {r.expiryDate}
                      </span>
                      <span className="muted">
                        lot {r.lotCode} · {r.locationCode}
                        {r.status !== "available" && ` · ${r.status === "quarantined" ? "blocked" : r.status}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section>
            <h2>Needs attention</h2>
            {attention.length === 0 && <p className="muted">Nothing is waiting.</p>}
            <ul className="list">
              {attention.map((a) => (
                <li key={a.text} className={a.urgent ? "row urgent" : "row"}>
                  {a.route && props.permissions.includes(a.permission) ? <a href={href(a.route)}>{a.text}</a> : <span>{a.text}</span>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
