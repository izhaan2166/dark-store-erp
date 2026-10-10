import { useEffect, useRef, useState } from "react";
import { type Api, ApiError, type Location, newKey, type OpeningStock as OpeningStockBody, type Product } from "../api";
import { buzz } from "../buzz";
import { backToScan, ItemLookup } from "../ItemLookup";
import { href } from "../route";
import { ScanBox } from "../ScanBox";
import { orderQuantity, paiseFrom } from "./NewPurchaseOrder";
import { shelfFor } from "./Putaway";

/** One product, or one lot of a batch-tracked product, counted on the shelf. */
export type OpeningLine = { id: number; product: Product; quantityText: string; lotText: string; expiryText: string; costText: string };

/** What is wrong with a line, in words for the person typing it, or null. */
export function lineProblem(line: OpeningLine, today: string): string | null {
  if (orderQuantity(line.quantityText) === null) return "Enter how many, as a whole number";
  if (line.product.batchTracked) {
    if (!line.lotText.trim()) return "Enter the lot number";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(line.expiryText)) return "Enter the expiry date";
    if (line.expiryText <= today) return "Expired: keep it off the shelf and out of this count";
  }
  if (line.costText.trim() !== "" && paiseFrom(line.costText) === null) return "Use rupees, like 42.50";
  return null;
}

/**
 * The request for a shelf's lines, or null while any line has a problem or a
 * product (and lot) appears twice.
 */
export function openingBody(locationId: string, lines: OpeningLine[], today: string): OpeningStockBody | null {
  if (lines.length === 0 || lines.some((l) => lineProblem(l, today) !== null)) return null;
  const keys = lines.map((l) => `${l.product.productId}:${l.product.batchTracked ? l.lotText.trim().toLowerCase() : ""}`);
  if (new Set(keys).size !== keys.length) return null;
  return {
    locationId,
    lines: lines.map((l) => ({
      productId: l.product.productId,
      quantity: orderQuantity(l.quantityText)!,
      ...(l.product.batchTracked ? { lotCode: l.lotText.trim(), expiryDate: l.expiryText } : {}),
      ...(l.costText.trim() !== "" ? { unitCostPaise: paiseFrom(l.costText)! } : {}),
    })),
  };
}

const localToday = () => new Date().toLocaleDateString("en-CA");
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

/**
 * Loading the full count before go-live, one shelf at a time: scan the
 * shelf, scan or search each item on it with how many (and the lot and
 * expiry of batch-tracked items), then load. A shelf can be loaded once;
 * after that, differences go through Count stock.
 */
export function OpeningStock(props: { api: Api; storeId: string }) {
  const { api, storeId } = props;
  const [all, setAll] = useState<Location[] | null>(null);
  const [shelf, setShelf] = useState<Location | null>(null);
  const [lines, setLines] = useState<OpeningLine[]>([]);
  const [loaded, setLoaded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  // One key per version of the shelf's lines: a resend reuses it, any edit makes a new one.
  const submitKey = useRef(newKey());
  const edited = () => {
    submitKey.current = newKey();
    setError(null);
  };

  useEffect(() => {
    api.locations(storeId).then(setAll, (err) => setError(err instanceof ApiError ? err.message : "Could not load shelves"));
  }, [api, storeId]);

  const shelves = all?.filter((l) => l.purpose === "storage" && l.status === "active") ?? null;

  const choose = (location: Location) => {
    setShelf(location);
    setLines([]);
    setDone(null);
    edited();
  };

  const onShelfScan = (code: string) => {
    const found = shelfFor(all ?? [], code);
    if (found === null || found === "not_storage") {
      buzz();
      setError(found === null ? `Unknown shelf ${code}` : `${code} is not a shelf for stock`);
      return;
    }
    choose(found);
  };

  const add = (product: Product) => {
    edited();
    setLines((current) => {
      // Scanning again adds one to the item's latest line: the lot being counted.
      const latest = current.filter((l) => l.product.productId === product.productId).at(-1);
      if (!latest) return [...current, { id: nextId.current++, product, quantityText: "1", lotText: "", expiryText: "", costText: "" }];
      const next = (orderQuantity(latest.quantityText) ?? 0) + 1;
      return current.map((l) => (l === latest ? { ...l, quantityText: String(next) } : l));
    });
  };

  const anotherLot = (line: OpeningLine) => {
    edited();
    setLines((current) => {
      const at = current.indexOf(line) + 1;
      const fresh = { id: nextId.current++, product: line.product, quantityText: "1", lotText: "", expiryText: "", costText: line.costText };
      return [...current.slice(0, at), fresh, ...current.slice(at)];
    });
  };

  const change = (id: number, patch: Partial<OpeningLine>) => {
    edited();
    setLines((current) => current.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };

  const remove = (id: number) => {
    edited();
    setLines((current) => current.filter((l) => l.id !== id));
  };

  const leave = () => {
    if (lines.length > 0 && !window.confirm(`Leave ${shelf?.code} without loading? The items entered so far will be lost.`)) return;
    setShelf(null);
    setLines([]);
    edited();
  };

  const today = localToday();
  const body = shelf ? openingBody(shelf.locationId, lines, today) : null;
  const twice = lines.length > 0 && lines.every((l) => lineProblem(l, today) === null) && body === null;
  const units = lines.reduce((n, l) => n + (orderQuantity(l.quantityText) ?? 0), 0);
  const items = new Set(lines.map((l) => l.product.productId)).size;

  const load = async () => {
    if (!shelf || !body) return;
    setBusy(true);
    setError(null);
    try {
      await api.loadOpeningStock(storeId, body, submitKey.current);
      setLoaded((codes) => [...codes, shelf.code]);
      setDone(`${shelf.code} loaded: ${plural(items, "product", "products")}, ${plural(units, "unit", "units")}. Scan the next shelf.`);
      setShelf(null);
      setLines([]);
      edited();
    } catch (err) {
      buzz();
      setError(err instanceof ApiError ? err.message : "Could not load the stock");
    } finally {
      setBusy(false);
    }
  };

  if (!shelf) {
    return (
      <main>
        <header className="bar">
          <a href={href({ screen: "stores" })}>‹ Jobs</a>
          <h1>Opening stock</h1>
        </header>
        <p className="muted">Enter what you counted on each shelf before the store starts taking orders. Each shelf can be loaded once; after that, use Count stock to correct it.</p>
        {done && <p className="ok" role="status">{done}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <ScanBox label="Scan the label of the shelf you counted" disabled={shelves === null} onScan={onShelfScan} />
        {shelves === null && !error && <p className="muted">Loading…</p>}
        <ul className="list" aria-label="Shelves">
          {shelves?.map((s) => (
            <li key={s.locationId}>
              <button className="row" onClick={() => choose(s)}>
                <strong>{s.code}</strong>
                {loaded.includes(s.code) && <span className="tag">Loaded</span>}
              </button>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  return (
    <main>
      <header className="bar">
        <button onClick={leave}>‹ Shelves</button>
        <h1>Shelf {shelf.code}</h1>
      </header>
      <ItemLookup api={api} storeId={storeId} onAdd={add} />

      {lines.length > 0 && (
        <ul className="list" aria-label={`Items on ${shelf.code}`}>
          {lines.map((l) => {
            const problem = lineProblem(l, today);
            const name = l.product.batchTracked && l.lotText.trim() ? `${l.product.name} lot ${l.lotText.trim()}` : l.product.name;
            return (
              <li key={l.id} className="row">
                <strong>{l.product.name}</strong>
                <span className="muted">{l.product.sku}</span>
                <div className="pair">
                  <label>
                    How many
                    <input
                      className="qty"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      aria-label={`How many ${name}`}
                      value={l.quantityText}
                      onChange={(e) => change(l.id, { quantityText: e.target.value })}
                      onKeyDown={backToScan}
                    />
                  </label>
                  <label>
                    Cost of one (₹, if known)
                    <input
                      className="qty"
                      inputMode="decimal"
                      aria-label={`Cost of one ${name}`}
                      placeholder="0.00"
                      value={l.costText}
                      onChange={(e) => change(l.id, { costText: e.target.value })}
                      onKeyDown={backToScan}
                    />
                  </label>
                </div>
                {l.product.batchTracked && (
                  <div className="pair">
                    <label>
                      Lot
                      <input aria-label={`Lot of ${l.product.name}`} value={l.lotText} onChange={(e) => change(l.id, { lotText: e.target.value })} />
                    </label>
                    <label>
                      Expiry
                      <input
                        type="date"
                        aria-label={`Expiry of ${name}`}
                        value={l.expiryText}
                        onChange={(e) => change(l.id, { expiryText: e.target.value })}
                      />
                    </label>
                  </div>
                )}
                {problem && l.quantityText.trim() !== "" && <span className="tag warn">{problem}</span>}
                <div className="actions">
                  {l.product.batchTracked && <button onClick={() => anotherLot(l)}>Another lot</button>}
                  <button aria-label={`Remove ${name}`} onClick={() => remove(l.id)}>
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {twice && <p className="error" role="alert">The same item and lot is entered twice. Add the quantities together on one line.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        {lines.length > 0 && (
          <span className="muted">
            {plural(items, "product", "products")}, {plural(units, "unit", "units")}
          </span>
        )}
        <button className="primary" disabled={busy || body === null} onClick={() => void load()}>
          {busy ? "Loading…" : `Load stock onto ${shelf.code}`}
        </button>
      </div>
      <p className="muted">A shelf can be loaded only once, so check the numbers first.</p>
    </main>
  );
}
