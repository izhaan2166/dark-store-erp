import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { type AcceptedOrder, type Api, ApiError, newKey, type OrderSummary, type Product } from "../api";
import { buzz } from "../buzz";
import { backToScan, ItemLookup } from "../ItemLookup";
import { href } from "../route";

const REFRESH_MS = 30_000;
const ACTIVE = "accepted,picking,packing,ready_for_handover,cancel_pending,exception";
const MAX_QTY = 10_000;

const STATUS: Record<string, string> = {
  accepted: "Waiting to pick",
  picking: "Picking",
  packing: "Packing",
  ready_for_handover: "Ready for rider",
  cancel_pending: "Cancelling",
  exception: "Problem",
};

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

/** Orders still being worked on, newest last, with a way to cancel one. */
export function Orders(props: { api: Api; storeId: string; canCancel: boolean }) {
  const { api, storeId } = props;
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<OrderSummary | null>(null);

  const load = useCallback(async () => {
    try {
      setOrders(await api.orders(storeId, ACTIVE));
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not load orders"));
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
        <h1>Orders</h1>
        <a className="button primary" href={href({ screen: "new-order", storeId })}>
          New order
        </a>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {done && <p className="ok" role="status">{done}</p>}
      {orders === null && !error && <p className="muted">Loading…</p>}
      {orders?.length === 0 && <p className="muted">No orders are open.</p>}
      <ul className="list">
        {orders?.map((o) => (
          <li key={o.orderId} className="row">
            <strong>{o.externalRef}</strong>
            <span className={o.status === "exception" ? "tag late" : "tag"}>{STATUS[o.status] ?? o.status}</span>
            {o.openShortages > 0 && <span className="tag warn">{o.openShortages} missing</span>}
            <span className="muted">
              {time(o.createdAt)} · {o.lineCount} {o.lineCount === 1 ? "item" : "items"} · {o.requestedUnits} units
              {o.pickedUnits > 0 && ` · ${o.pickedUnits} picked`}
            </span>
            {props.canCancel && o.status !== "cancel_pending" && <button onClick={() => setCancelling(o)}>Cancel</button>}
          </li>
        ))}
      </ul>

      {cancelling && (
        <CancelDialog
          order={cancelling}
          onBack={() => setCancelling(null)}
          onConfirm={async (reason) => {
            await api.cancelOrder(storeId, cancelling.orderId, reason, newKey());
            setCancelling(null);
            setDone(`Order ${cancelling.externalRef} cancelled. Its stock is free again.`);
            await load();
          }}
        />
      )}
    </main>
  );
}

function CancelDialog(props: { order: OrderSummary; onBack: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const why = reason.trim();
    if (!why) return;
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(why);
    } catch (err) {
      setError(errorText(err, "Could not cancel the order"));
      setBusy(false);
    }
  };
  return (
    <div className="dialog" role="dialog" aria-label={`Cancel ${props.order.externalRef}`}>
      <form className="stack" onSubmit={submit}>
        <h2>Cancel order {props.order.externalRef}</h2>
        <label>
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? This is kept in the audit log" required autoFocus />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={props.onBack}>
            Back
          </button>
          <button className="primary" disabled={busy || !reason.trim()}>
            Cancel order
          </button>
        </div>
      </form>
    </div>
  );
}

type Line = { product: Product; quantityText: string; free: number | null };

/** A whole number from 1 to 10,000, or null. */
export function lineQuantity(text: string): number | null {
  const n = Number(text);
  return text.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= MAX_QTY ? n : null;
}

/** What the store could not reserve, in words, or null when everything was reserved. */
export function shortText(result: AcceptedOrder, names: Map<string, string>): string | null {
  const short = result.lines.filter((l) => l.shortQty > 0);
  if (short.length === 0) return null;
  return short.map((l) => `${l.shortQty} × ${names.get(l.productId) ?? "an item"}`).join(", ");
}

/**
 * Typing in an order taken by phone or chat. Items are scanned or searched
 * by name; scanning one again adds one more. Whatever the store cannot
 * reserve waits under Missing items for a manager.
 */
export function NewOrder(props: { api: Api; storeId: string }) {
  const { api, storeId } = props;
  const [ref, setRef] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ ref: string; short: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per version of the order: a resend after a lost reply reuses it, any edit makes a new one.
  const submitKey = useRef(newKey());
  const edited = () => {
    submitKey.current = newKey();
  };

  const add = (product: Product) => {
    edited();
    setError(null);
    setDone(null);
    setLines((all) => {
      const existing = all.find((l) => l.product.productId === product.productId);
      if (existing) {
        const next = (lineQuantity(existing.quantityText) ?? 0) + 1;
        return all.map((l) => (l === existing ? { ...l, quantityText: String(next) } : l));
      }
      return [...all, { product, quantityText: "1", free: null }];
    });
    api.stock(storeId, product.productId).then(
      (s) => setLines((all) => all.map((l) => (l.product.productId === product.productId ? { ...l, free: s.availableToPromise } : l))),
      () => {},
    );
  };

  const setQuantity = (productId: string, quantityText: string) => {
    edited();
    setLines((all) => all.map((l) => (l.product.productId === productId ? { ...l, quantityText } : l)));
  };

  const remove = (productId: string) => {
    edited();
    setLines((all) => all.filter((l) => l.product.productId !== productId));
  };

  const valid = ref.trim() !== "" && lines.length > 0 && lines.every((l) => lineQuantity(l.quantityText) !== null);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const externalRef = ref.trim();
      const result = await api.acceptOrder(
        storeId,
        { externalRef, lines: lines.map((l) => ({ productId: l.product.productId, quantity: lineQuantity(l.quantityText)! })) },
        submitKey.current,
      );
      const names = new Map(lines.map((l) => [l.product.productId, l.product.name]));
      setDone({ ref: externalRef, short: shortText(result, names) });
      setRef("");
      setLines([]);
      edited();
    } catch (err) {
      buzz();
      setError(errorText(err, "Could not save the order"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <header className="bar">
        <a href={href({ screen: "orders", storeId })}>‹ Orders</a>
        <h1>New order</h1>
      </header>
      {done && (
        <p className={done.short ? "error" : "ok"} role="status">
          {done.short
            ? `Order ${done.ref} saved, but the store is short of ${done.short}. A manager will see it under Missing items; the rest can be picked now.`
            : `Order ${done.ref} saved. Everything is reserved and it is in the pick queue.`}
        </p>
      )}
      <div className="stack">
        <label>
          Order number
          <input
            value={ref}
            onChange={(e) => {
              edited();
              setRef(e.target.value);
            }}
            placeholder="From the app, phone or chat"
          />
        </label>
        <ItemLookup api={api} storeId={storeId} onAdd={add} />
        {error && <p className="error" role="alert">{error}</p>}
      </div>

      {lines.length > 0 && (
        <ul className="list" aria-label="Items on the order">
          {lines.map((l) => {
            const quantity = lineQuantity(l.quantityText);
            const short = l.free !== null && quantity !== null && quantity > l.free;
            return (
              <li key={l.product.productId} className="row">
                <strong>{l.product.name}</strong>
                <input
                  className="qty"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_QTY}
                  aria-label={`How many ${l.product.name}`}
                  value={l.quantityText}
                  onChange={(e) => setQuantity(l.product.productId, e.target.value)}
                  onKeyDown={backToScan}
                />
                {l.free !== null && (
                  <span className={short ? "tag warn" : "muted"}>
                    {short ? `Only ${l.free} free; ${quantity! - l.free} will be missing` : `${l.free} free`}
                  </span>
                )}
                <button aria-label={`Remove ${l.product.name}`} onClick={() => remove(l.product.productId)}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="actions">
        <button className="primary" disabled={busy || !valid} onClick={() => void submit()}>
          {busy ? "Saving…" : "Save order"}
        </button>
      </div>
    </main>
  );
}
