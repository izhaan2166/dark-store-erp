import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, ApiError, type Location, newKey, type StockRow } from "../api";
import { href } from "../route";
import { buzz } from "../buzz";
import { ScanBox } from "../ScanBox";

type Message = { kind: "ok" | "error"; text: string };

const rowKey = (r: StockRow) => `${r.productId}|${r.batchId ?? ""}|${r.locationId}`;

/** The unloaded stock of a product to put away first: earliest expiry first. */
export function firstToPutAway(rows: StockRow[], productId: string): StockRow | null {
  return (
    rows
      .filter((r) => r.productId === productId)
      .sort((a, b) => (a.expiryDate ?? "9999").localeCompare(b.expiryDate ?? "9999"))[0] ?? null
  );
}

/** The shelf a scanned label names, or why it cannot take stock. */
export function shelfFor(locations: Location[], code: string): Location | "not_storage" | null {
  const location = locations.find((l) => l.code.toLowerCase() === code.trim().toLowerCase());
  if (!location) return null;
  return location.purpose === "storage" && location.status === "active" ? location : "not_storage";
}

/**
 * Putting received stock on the shelves. The worker scans an item from the
 * unloading area, checks how many to move, then scans the shelf label. Only
 * then is the stock sellable.
 */
export function Putaway(props: { api: Api; storeId: string }) {
  const { api, storeId } = props;
  const [rows, setRows] = useState<StockRow[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [selected, setSelected] = useState<StockRow | null>(null);
  const [quantityText, setQuantityText] = useState("");
  const [onShelves, setOnShelves] = useState<StockRow[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const products = useRef(new Map<string, string>());
  const state = useRef({ rows, selected, locations, quantityText });
  state.current = { rows, selected, locations, quantityText };
  const queue = useRef(Promise.resolve());

  const fail = useCallback((err: unknown) => {
    buzz();
    setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Something went wrong" });
  }, []);

  const load = useCallback(async () => {
    setRows(await api.stockRows(storeId, { status: "receiving" }));
  }, [api, storeId]);

  useEffect(() => {
    load().catch(fail);
    api.locations(storeId).then(setLocations, fail);
  }, [api, storeId, load, fail]);

  const select = (row: StockRow | null) => {
    setSelected(row);
    setOnShelves([]);
    if (!row) return;
    setQuantityText(String(row.onHand));
    api.stockRows(storeId, { status: "available", productId: row.productId }).then(setOnShelves, () => setOnShelves([]));
  };

  const pickItem = async (code: string) => {
    let productId = products.current.get(code);
    if (!productId) {
      try {
        productId = (await api.product(storeId, code)).productId;
        products.current.set(code, productId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          buzz();
          setMessage({ kind: "error", text: `Unknown barcode ${code}` });
          return;
        }
        throw err;
      }
    }
    const row = firstToPutAway(state.current.rows ?? [], productId);
    if (!row) {
      buzz();
      setMessage({ kind: "error", text: "Nothing of this item is waiting to be put away" });
      return;
    }
    setMessage(null);
    select(row);
  };

  const placeOnShelf = async (row: StockRow, code: string) => {
    const shelf = shelfFor(state.current.locations, code);
    if (shelf === null || shelf === "not_storage") {
      buzz();
      setMessage({ kind: "error", text: shelf === null ? `Unknown shelf ${code}` : `${code} is not a shelf for stock` });
      return;
    }
    const quantity = Number(state.current.quantityText);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > row.onHand) {
      buzz();
      setMessage({ kind: "error", text: `Enter how many to put away, up to ${row.onHand}` });
      return;
    }
    await api.putaway(
      storeId,
      { productId: row.productId, batchId: row.batchId, fromLocationId: row.locationId, toLocationId: shelf.locationId, quantity },
      newKey(),
    );
    setMessage({ kind: "ok", text: `Put ${quantity} × ${row.name} on ${shelf.code}` });
    select(null);
    await load();
  };

  const onScan = (code: string) => {
    queue.current = queue.current.then(async () => {
      setBusy(true);
      try {
        const row = state.current.selected;
        await (row ? placeOnShelf(row, code) : pickItem(code));
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    });
  };

  return (
    <main>
      <header className="bar">
        <a href={href({ screen: "stores" })}>‹ Jobs</a>
        <h1>Put away</h1>
      </header>
      {message && (
        <p className={message.kind === "ok" ? "ok" : "error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}

      {selected ? (
        <section className="card">
          <h2>{selected.name}</h2>
          <p className="muted">
            {selected.sku}
            {selected.lotCode && ` · lot ${selected.lotCode}`}
            {selected.expiryDate && ` · exp ${selected.expiryDate}`} · {selected.onHand} in {selected.locationCode}
          </p>
          <p>
            {onShelves.length > 0
              ? `Already on ${[...new Set(onShelves.map((r) => r.locationCode))].join(", ")}`
              : "Not on any shelf yet"}
          </p>
          <label>
            How many
            <input
              type="number"
              min={1}
              max={selected.onHand}
              step={1}
              value={quantityText}
              onChange={(e) => setQuantityText(e.target.value)}
              // Enter hands focus back to the scan box, ready for the shelf label.
              onKeyDown={(e) => e.key === "Enter" && document.getElementById("scan")?.focus()}
            />
          </label>
          <ScanBox label="Scan the shelf label" disabled={busy} onScan={onScan} />
          <button onClick={() => select(null)}>Cancel</button>
        </section>
      ) : (
        <ScanBox label="Scan an item to put away" disabled={busy} onScan={onScan} />
      )}

      {rows === null && !message && <p className="muted">Loading…</p>}
      {rows?.length === 0 && <p className="muted">Nothing is waiting to be put away.</p>}
      <ul className="list">
        {rows?.map((row) => (
          <li key={rowKey(row)} className="row">
            <strong>{row.name}</strong>
            <span className="muted">
              {row.sku}
              {row.expiryDate && ` · exp ${row.expiryDate}`}
            </span>
            <span>
              {row.onHand} in {row.locationCode}
            </span>
            <button disabled={busy} onClick={() => select(row)}>
              Put away
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
