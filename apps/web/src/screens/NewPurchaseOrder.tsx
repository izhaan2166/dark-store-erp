import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { type Api, ApiError, newKey, type Product, type Supplier } from "../api";
import { buzz } from "../buzz";
import { backToScan, ItemLookup } from "../ItemLookup";
import { href } from "../route";

const MAX_QTY = 1_000_000;

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** A whole number of units from 1 to 1,000,000, or null. */
export function orderQuantity(text: string): number | null {
  const n = Number(text);
  return text.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= MAX_QTY ? n : null;
}

/** Paise from a rupee amount with up to two decimals ("12", "12.5", "12.50"), or null. */
export function paiseFrom(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** ₹ with paise and Indian digit grouping. */
export const money = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Line = { product: Product; quantityText: string; costText: string };

/**
 * Writing a purchase order: choose (or add) the supplier, give the PO
 * number, then scan or search the items with how many and the cost of one.
 * A saved order appears on the Deliveries list for receiving.
 */
export function NewPurchaseOrder(props: { api: Api; storeId: string }) {
  const { api, storeId } = props;
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingSupplier, setAddingSupplier] = useState(false);
  // One key per version of the purchase order: a resend reuses it, any edit makes a new one.
  const submitKey = useRef(newKey());
  const edited = () => {
    submitKey.current = newKey();
    setDone(null);
  };

  const loadSuppliers = useCallback(async () => {
    try {
      const list = await api.suppliers(storeId);
      setSuppliers(list);
      return list;
    } catch (err) {
      setError(errorText(err, "Could not load suppliers"));
      return [];
    }
  }, [api, storeId]);

  useEffect(() => {
    void loadSuppliers().then((list) => {
      if (list.length === 1) setSupplierId(list[0]!.supplierId);
    });
  }, [loadSuppliers]);

  const add = (product: Product) => {
    edited();
    setLines((all) => {
      const existing = all.find((l) => l.product.productId === product.productId);
      if (!existing) return [...all, { product, quantityText: "1", costText: "" }];
      const next = (orderQuantity(existing.quantityText) ?? 0) + 1;
      return all.map((l) => (l === existing ? { ...l, quantityText: String(next) } : l));
    });
  };

  const change = (productId: string, patch: Partial<Line>) => {
    edited();
    setLines((all) => all.map((l) => (l.product.productId === productId ? { ...l, ...patch } : l)));
  };

  const remove = (productId: string) => {
    edited();
    setLines((all) => all.filter((l) => l.product.productId !== productId));
  };

  const priced = lines.map((l) => ({ line: l, quantity: orderQuantity(l.quantityText), cost: paiseFrom(l.costText) }));
  const valid =
    supplierId !== "" && poNumber.trim() !== "" && lines.length > 0 && priced.every((p) => p.quantity !== null && p.cost !== null);
  const total = priced.reduce((sum, p) => sum + (p.quantity ?? 0) * (p.cost ?? 0), 0);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const po = await api.createPurchaseOrder(
        storeId,
        {
          supplierId,
          poNumber: poNumber.trim(),
          lines: priced.map((p) => ({ productId: p.line.product.productId, quantity: p.quantity!, unitCostPaise: p.cost! })),
        },
        submitKey.current,
      );
      const supplier = suppliers?.find((s) => s.supplierId === supplierId)?.name ?? "the supplier";
      setPoNumber("");
      setLines([]);
      edited();
      setDone(`Purchase order ${po.poNumber} saved for ${supplier}: ${priced.length} ${priced.length === 1 ? "item" : "items"}, ${money(total)}. It is on the Deliveries list for receiving.`);
    } catch (err) {
      buzz();
      setError(errorText(err, "Could not save the purchase order"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <header className="bar">
        <a href={href({ screen: "receive", storeId })}>‹ Deliveries</a>
        <h1>New purchase order</h1>
      </header>
      {done && <p className="ok" role="status">{done}</p>}
      <div className="stack">
        <div className="search">
          <label style={{ flex: 1 }}>
            Supplier
            <select
              value={supplierId}
              onChange={(e) => {
                edited();
                setSupplierId(e.target.value);
              }}
            >
              <option value="">{suppliers?.length === 0 ? "No suppliers yet" : "Choose…"}</option>
              {suppliers?.map((s) => (
                <option key={s.supplierId} value={s.supplierId}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => setAddingSupplier(true)}>
            New supplier
          </button>
        </div>
        <label>
          Purchase order number
          <input
            value={poNumber}
            onChange={(e) => {
              edited();
              setPoNumber(e.target.value);
            }}
            placeholder="e.g. PO-1042"
          />
        </label>
        <ItemLookup api={api} storeId={storeId} onAdd={add} />
      </div>

      {lines.length > 0 && (
        <ul className="list" aria-label="Items on the purchase order">
          {priced.map(({ line: l, quantity, cost }) => (
            <li key={l.product.productId} className="row">
              <strong>{l.product.name}</strong>
              <div className="pair">
              <label>
                How many
                <input
                  className="qty"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  aria-label={`How many ${l.product.name}`}
                  value={l.quantityText}
                  onChange={(e) => change(l.product.productId, { quantityText: e.target.value })}
                  onKeyDown={backToScan}
                />
              </label>
              <label>
                Cost of one (₹)
                <input
                  className="qty"
                  inputMode="decimal"
                  aria-label={`Cost of one ${l.product.name}`}
                  placeholder="0.00"
                  value={l.costText}
                  onChange={(e) => change(l.product.productId, { costText: e.target.value })}
                  onKeyDown={backToScan}
                />
              </label>
              </div>
              {quantity !== null && cost !== null && <span className="muted">{money(quantity * cost)}</span>}
              {l.costText.trim() !== "" && cost === null && <span className="tag warn">Use rupees, like 42.50</span>}
              <button aria-label={`Remove ${l.product.name}`} onClick={() => remove(l.product.productId)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        {lines.length > 0 && <span className="muted">Total {money(total)}</span>}
        <button className="primary" disabled={busy || !valid} onClick={() => void submit()}>
          {busy ? "Saving…" : "Save purchase order"}
        </button>
      </div>

      {addingSupplier && (
        <SupplierDialog
          onCancel={() => setAddingSupplier(false)}
          onSave={async (body) => {
            const { supplierId: id } = await api.createSupplier(storeId, body, newKey());
            await loadSuppliers();
            edited();
            setSupplierId(id);
            setAddingSupplier(false);
          }}
        />
      )}
    </main>
  );
}

function SupplierDialog(props: { onCancel: () => void; onSave: (body: { code: string; name: string }) => Promise<void> }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSave({ code: code.trim(), name: name.trim() });
    } catch (err) {
      setError(errorText(err, "Could not add the supplier"));
      setBusy(false);
    }
  };
  return (
    <div className="dialog" role="dialog" aria-label="New supplier">
      <form className="stack" onSubmit={submit}>
        <h2>New supplier</h2>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fresh Farms" required autoFocus />
        </label>
        <label>
          Short code
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. FRESH" required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !code.trim() || !name.trim()}>
            Add supplier
          </button>
        </div>
      </form>
    </div>
  );
}
