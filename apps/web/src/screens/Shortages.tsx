import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type Api, ApiError, newKey, type OpenShortage, type Product, type Resolution } from "../api";
import { href } from "../route";

const REFRESH_MS = 15_000;

const SOURCES: Record<string, string> = {
  reservation: "Not in stock when ordered",
  short_pick: "Picker couldn't find it",
  expired: "Stock expired",
  quarantine: "Stock blocked",
};

type Action = "reallocate" | "remove" | "substitute";

const ACTIONS: Record<Action, { label: string; reason: string }> = {
  reallocate: { label: "Reserve again", reason: "More stock is on the shelf" },
  remove: { label: "Send without it", reason: "Customer agreed to go without" },
  substitute: { label: "Substitute", reason: "Customer accepted the substitute" },
};

/** Minutes since a time, for "waiting 12 min". */
export function minutesSince(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

/**
 * The Store Manager's list of missing items, late ones first. Each can be
 * reserved again from other stock, dropped from the order, or replaced by
 * another product. Every decision needs a reason.
 */
export function Shortages(props: { api: Api; storeId: string }) {
  const { api, storeId } = props;
  const [items, setItems] = useState<OpenShortage[] | null>(null);
  const [sellable, setSellable] = useState(new Map<string, number>());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [open, setOpen] = useState<{ shortage: OpenShortage; action: Action } | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.shortages(storeId);
      setItems(list);
      setError(null);
      const products = [...new Set(list.map((s) => s.productId))];
      const stock = await Promise.all(products.map((id) => api.stock(storeId, id).catch(() => null)));
      setSellable(new Map(stock.filter((s) => s !== null).map((s) => [s.productId, s.availableToPromise])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load missing items");
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
        <h1>Missing items</h1>
        <button onClick={() => void load()}>Refresh</button>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {done && <p className="ok" role="status">{done}</p>}
      {items === null && !error && <p className="muted">Loading…</p>}
      {items?.length === 0 && <p className="muted">Nothing is missing right now.</p>}
      <ul className="list">
        {items?.map((s) => {
          const free = sellable.get(s.productId);
          return (
            <li key={s.shortageId} className={s.escalatedAt ? "card late" : "card"}>
              <div className="title">
                <strong>
                  {s.quantity} × {s.name}
                </strong>
                {s.escalatedAt && <span className="tag late">Late</span>}
              </div>
              <span className="muted">
                Order {s.externalRef} · {SOURCES[s.source] ?? s.source} · waiting {minutesSince(s.createdAt)} min
              </span>
              <span className="muted">{free === undefined ? "" : `${free} more in stock`}</span>
              <div className="jobs">
                <button disabled={free !== undefined && free < s.quantity} onClick={() => setOpen({ shortage: s, action: "reallocate" })}>
                  {ACTIONS.reallocate.label}
                </button>
                <button onClick={() => setOpen({ shortage: s, action: "substitute" })}>{ACTIONS.substitute.label}</button>
                <button onClick={() => setOpen({ shortage: s, action: "remove" })}>{ACTIONS.remove.label}</button>
              </div>
            </li>
          );
        })}
      </ul>
      {open && (
        <DecisionDialog
          api={api}
          storeId={storeId}
          shortage={open.shortage}
          action={open.action}
          onClose={() => setOpen(null)}
          onDone={(text) => {
            setOpen(null);
            setDone(text);
            void load();
          }}
        />
      )}
    </main>
  );
}

function DecisionDialog(props: {
  api: Api;
  storeId: string;
  shortage: OpenShortage;
  action: Action;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { api, storeId, shortage, action } = props;
  const [reason, setReason] = useState(ACTIONS[action].reason);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<(Product & { free: number | null })[]>([]);
  const [chosen, setChosen] = useState<Product | null>(null);
  const [quantityText, setQuantityText] = useState(String(shortage.quantity));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const found = (await api.searchProducts(storeId, query.trim())).filter((p) => p.productId !== shortage.productId);
      const stock = await Promise.all(found.map((p) => api.stock(storeId, p.productId).catch(() => null)));
      setResults(found.map((p, i) => ({ ...p, free: stock[i]?.availableToPromise ?? null })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Search failed");
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const why = reason.trim();
    if (!why) return;
    const quantity = Number(quantityText);
    let body: Resolution;
    if (action === "substitute") {
      if (!chosen) {
        setError("Choose the product to send instead");
        return;
      }
      if (!Number.isInteger(quantity) || quantity < 1) {
        setError("Enter how many to send");
        return;
      }
      body = { resolution: "substitute", reason: why, substituteProductId: chosen.productId, quantity };
    } else {
      body = { resolution: action, reason: why };
    }
    setBusy(true);
    setError(null);
    try {
      await api.resolveShortage(storeId, shortage.orderId, shortage.shortageId, body, newKey());
      props.onDone(
        action === "substitute"
          ? `Order ${shortage.externalRef} gets ${quantity} × ${chosen!.name} instead`
          : action === "reallocate"
            ? `Reserved ${shortage.quantity} × ${shortage.name} again for order ${shortage.externalRef}`
            : `Order ${shortage.externalRef} goes without ${shortage.name}`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the decision");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog" role="dialog" aria-label={ACTIONS[action].label}>
      <div className="sheet stack">
        <h2>
          {ACTIONS[action].label}: {shortage.quantity} × {shortage.name}
        </h2>
        {action === "substitute" && (
          <>
            <form className="search" onSubmit={search}>
              <input aria-label="Search products" placeholder="Name, SKU or barcode" value={query} onChange={(e) => setQuery(e.target.value)} />
              <button>Search</button>
            </form>
            <ul className="list">
              {results.map((p) => (
                <li key={p.productId}>
                  <label className="choice">
                    <input
                      type="radio"
                      name="substitute"
                      disabled={p.free === 0}
                      checked={chosen?.productId === p.productId}
                      onChange={() => setChosen(p)}
                    />
                    <span>
                      {p.name} <span className="muted">{p.sku}{p.free !== null && ` · ${p.free} in stock`}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <label>
              How many to send
              <input type="number" min={1} step={1} value={quantityText} onChange={(e) => setQuantityText(e.target.value)} />
            </label>
          </>
        )}
        <form className="stack" onSubmit={submit}>
          <label>
            Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} required />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button type="button" onClick={props.onClose}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              Confirm
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
