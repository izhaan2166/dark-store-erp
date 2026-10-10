import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { type Api, ApiError, type CountView, type Location, newKey, type Product, type StockRow } from "../api";
import { go, href } from "../route";
import { buzz } from "../buzz";
import { ScanBox } from "../ScanBox";
import { shelfFor } from "./Putaway";

type Message = { kind: "ok" | "error"; text: string };

/** One product (and lot) on the shelf being counted. */
export interface CountItem {
  key: string;
  productId: string;
  batchId: string | null;
  name: string;
  sku: string;
  lotCode: string | null;
  expiryDate: string | null;
  /** Whether the system thinks it is on this shelf. Found extras are not. */
  expected: boolean;
}

const keyOf = (productId: string, batchId: string | null) => `${productId}:${batchId ?? ""}`;

/**
 * What the count is checked against: sellable and blocked stock on the shelf,
 * one item per product and lot. Quantities stay hidden so the count is blind.
 */
export function expectedItems(rows: StockRow[]): CountItem[] {
  const items = new Map<string, CountItem>();
  for (const r of rows) {
    if (r.status !== "available" && r.status !== "quarantined") continue;
    const key = keyOf(r.productId, r.batchId);
    if (!items.has(key)) {
      items.set(key, { key, productId: r.productId, batchId: r.batchId, name: r.name, sku: r.sku, lotCode: r.lotCode, expiryDate: r.expiryDate, expected: true });
    }
  }
  return [...items.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.expiryDate ?? "").localeCompare(b.expiryDate ?? ""));
}

/** Pick a shelf to count by scanning its label or tapping it. */
export function CountStart(props: { api: Api; storeId: string }) {
  const { api, storeId } = props;
  const [shelves, setShelves] = useState<Location[] | null>(null);
  const [all, setAll] = useState<Location[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.locations(storeId).then(
      (locations) => {
        setAll(locations);
        setShelves(locations.filter((l) => l.purpose === "storage" && l.status === "active"));
      },
      (err) => setError(err instanceof ApiError ? err.message : "Could not load shelves"),
    );
  }, [api, storeId]);

  const onScan = (code: string) => {
    const shelf = shelfFor(all, code);
    if (shelf === null || shelf === "not_storage") {
      buzz();
      setError(shelf === null ? `Unknown shelf ${code}` : `${code} is not a shelf for stock`);
      return;
    }
    go({ screen: "shelf", storeId, locationId: shelf.locationId });
  };

  return (
    <main>
      <header className="bar">
        <a href={href({ screen: "stores" })}>‹ Jobs</a>
        <h1>Count stock</h1>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      <ScanBox label="Scan the label of the shelf to count" disabled={shelves === null} onScan={onScan} />
      {shelves === null && !error && <p className="muted">Loading…</p>}
      <ul className="list">
        {shelves?.map((s) => (
          <li key={s.locationId}>
            <a className="row" href={href({ screen: "shelf", storeId, locationId: s.locationId })}>
              <strong>{s.code}</strong>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}

/**
 * Counting one shelf. The counter scans every sellable item on it (or uses
 * + and −, or types a number). Items expected there but not found count as
 * none. Differences within the store's limits update stock at once; bigger
 * ones wait for a Store Manager.
 */
export function CountShelf(props: { api: Api; storeId: string; locationId: string }) {
  const { api, storeId, locationId } = props;
  const [shelf, setShelf] = useState<Location | null>(null);
  const [items, setItems] = useState<CountItem[] | null>(null);
  const [counts, setCounts] = useState(() => new Map<string, number>());
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CountView | null>(null);
  const [typing, setTyping] = useState<CountItem | null>(null);
  const [choosing, setChoosing] = useState<{ product: Product; lots: CountItem[] } | null>(null);
  const products = useRef(new Map<string, Product>());
  const state = useRef({ items, counts });
  state.current = { items, counts };
  const queue = useRef(Promise.resolve());
  // One key per version of the counts, so a retried submit can never post the count twice.
  const submitKey = useRef(newKey());

  const fail = useCallback((err: unknown) => {
    buzz();
    setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Something went wrong" });
  }, []);

  useEffect(() => {
    api.locations(storeId).then((all) => setShelf(all.find((l) => l.locationId === locationId) ?? null), fail);
    api.stockRows(storeId, { locationId }).then((rows) => setItems(expectedItems(rows)), fail);
  }, [api, storeId, locationId, fail]);

  const setCount = (key: string, value: number) => {
    submitKey.current = newKey();
    setCounts((current) => new Map(current).set(key, Math.max(0, value)));
  };

  const addOne = (item: CountItem) => {
    const next = (state.current.counts.get(item.key) ?? 0) + 1;
    setCount(item.key, next);
    setMessage({ kind: "ok", text: `${item.name}${item.lotCode ? ` lot ${item.lotCode}` : ""}: ${next}` });
  };

  const addItem = (item: CountItem) => {
    setItems((current) => (current?.some((i) => i.key === item.key) ? current : [...(current ?? []), item]));
    addOne(item);
  };

  const countScanned = async (code: string) => {
    let product = products.current.get(code);
    if (!product) {
      try {
        product = await api.product(storeId, code);
        products.current.set(code, product);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          buzz();
          setMessage({ kind: "error", text: `Unknown barcode ${code}. Set it aside for the manager.` });
          return;
        }
        throw err;
      }
    }
    const found = product;
    const here = (state.current.items ?? []).filter((i) => i.productId === found.productId);
    if (!product.batchTracked) {
      addItem(
        here[0] ?? {
          key: keyOf(product.productId, null),
          productId: product.productId,
          batchId: null,
          name: product.name,
          sku: product.sku,
          lotCode: null,
          expiryDate: null,
          expected: false,
        },
      );
      return;
    }
    if (here.length === 1) {
      addOne(here[0]!);
      return;
    }
    if (here.length > 1) {
      buzz();
      setMessage({ kind: "error", text: `${product.name} has ${here.length} lots on this shelf. Use + on the right lot.` });
      return;
    }
    // A batch-tracked product the system did not expect here: ask which of its known lots it is.
    const elsewhere = await api.stockRows(storeId, { productId: product.productId });
    const lots = expectedItems(elsewhere.map((r) => ({ ...r, status: "available" }))).map((i) => ({ ...i, expected: false }));
    if (lots.length === 0) {
      buzz();
      setMessage({ kind: "error", text: `No lot of ${product.name} is known in this store. Set it aside for the manager.` });
      return;
    }
    setChoosing({ product, lots });
  };

  const onScan = (code: string) => {
    queue.current = queue.current.then(async () => {
      setBusy(true);
      try {
        await countScanned(code);
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    });
  };

  const title = `Count ${shelf?.code ?? "shelf"}`;
  if (!items) {
    return (
      <main>
        <Header storeId={storeId} title={title} />
        {message ? <p className="error" role="alert">{message.text}</p> : <p className="muted">Loading…</p>}
      </main>
    );
  }

  if (result) {
    const byKey = new Map(items.map((i) => [i.key, i]));
    const changed = result.lines.filter((l) => l.variance !== 0);
    return (
      <main>
        <Header storeId={storeId} title={title} />
        <section className={result.status === "posted" ? "card" : "card warn"} role="status">
          <h2>{result.status === "posted" ? "Count saved" : "Saved, waiting for approval"}</h2>
          <p>
            {result.status === "posted"
              ? changed.length === 0
                ? "Everything matched. Stock is unchanged."
                : "Stock is updated to what you counted."
              : "Some differences are above the store's limit. A Store Manager must approve before stock changes."}
          </p>
          {changed.length > 0 && (
            <ul>
              {changed.map((l) => {
                const item = byKey.get(keyOf(l.productId, l.batchId));
                return (
                  <li key={keyOf(l.productId, l.batchId)}>
                    {item?.name ?? l.productId}
                    {item?.lotCode && ` lot ${item.lotCode}`}: {Math.abs(l.variance)} {l.variance > 0 ? "more" : "fewer"} than recorded
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <a className="button primary big" href={href({ screen: "count", storeId })}>
          Count another shelf
        </a>
      </main>
    );
  }

  const notFound = items.filter((i) => i.expected && (counts.get(i.key) ?? 0) === 0);

  const submit = async () => {
    setBusy(true);
    try {
      const lines = items.map((i) => ({ productId: i.productId, batchId: i.batchId, countedQty: counts.get(i.key) ?? 0 }));
      setResult(await api.submitCount(storeId, { locationId, lines }, submitKey.current));
      setMessage(null);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <Header storeId={storeId} title={title} />
      {message && (
        <p className={message.kind === "ok" ? "ok" : "error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}
      <p className="muted">Count sellable items only. Leave out anything damaged or expired.</p>
      <ScanBox label="Scan every item on the shelf" disabled={busy || typing !== null || choosing !== null} onScan={onScan} />
      {items.length === 0 && <p className="muted">Nothing is recorded on this shelf. Scan anything you find.</p>}
      <ul className="receive">
        {items.map((item) => {
          const counted = counts.get(item.key) ?? 0;
          const label = `${item.name}${item.lotCode ? ` lot ${item.lotCode}` : ""}`;
          return (
            <li key={item.key}>
              <div className="what">
                <strong>{item.name}</strong>
                <span className="muted">
                  {item.sku}
                  {item.lotCode && ` · lot ${item.lotCode}`}
                  {item.expiryDate && ` · exp ${item.expiryDate}`}
                  {!item.expected && " · found here"}
                </span>
              </div>
              <button className="count" aria-label={`Type count for ${label}`} onClick={() => setTyping(item)}>
                {counted}
              </button>
              <div className="steppers">
                <button aria-label={`One less ${label}`} onClick={() => setCount(item.key, counted - 1)}>
                  −
                </button>
                <button aria-label={`One more ${label}`} onClick={() => setCount(item.key, counted + 1)}>
                  +
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {notFound.length > 0 && (
        <section className="card warn">
          <h2>Not found yet</h2>
          <p>{notFound.map((i) => i.name + (i.lotCode ? ` lot ${i.lotCode}` : "")).join(", ")}</p>
          <p className="muted">If you finish now, these count as none on the shelf.</p>
        </section>
      )}
      <button className="primary big" disabled={busy || items.length === 0} onClick={() => void submit()}>
        Finish count
      </button>

      {typing && (
        <TypeCount
          item={typing}
          value={counts.get(typing.key) ?? 0}
          onCancel={() => setTyping(null)}
          onSave={(value) => {
            setCount(typing.key, value);
            setTyping(null);
          }}
        />
      )}
      {choosing && (
        <ChooseLot
          name={choosing.product.name}
          lots={choosing.lots}
          onCancel={() => setChoosing(null)}
          onChoose={(lot) => {
            setChoosing(null);
            addItem(lot);
          }}
        />
      )}
    </main>
  );
}

function TypeCount(props: { item: CountItem; value: number; onCancel: () => void; onSave: (value: number) => void }) {
  const [text, setText] = useState(String(props.value));
  const value = Number(text);
  const valid = text.trim() !== "" && Number.isInteger(value) && value >= 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) props.onSave(value);
  };
  return (
    <div className="dialog" role="dialog" aria-label="Type the count">
      <form className="stack" onSubmit={submit}>
        <h2>
          {props.item.name}
          {props.item.lotCode && ` lot ${props.item.lotCode}`}
        </h2>
        <label>
          How many are on the shelf?
          <input type="number" min={0} step={1} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </label>
        <div className="actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={!valid}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

function ChooseLot(props: { name: string; lots: CountItem[]; onCancel: () => void; onChoose: (lot: CountItem) => void }) {
  const [chosen, setChosen] = useState<CountItem | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (chosen) props.onChoose(chosen);
  };
  return (
    <div className="dialog" role="dialog" aria-label="Which lot?">
      <form className="stack" onSubmit={submit}>
        <h2>Which lot of {props.name}?</h2>
        <p className="muted">The system does not expect it on this shelf. Check the lot on the pack.</p>
        {props.lots.map((lot) => (
          <label key={lot.key} className="choice">
            <input type="radio" name="lot" checked={chosen?.key === lot.key} onChange={() => setChosen(lot)} />
            Lot {lot.lotCode}
            {lot.expiryDate && ` · exp ${lot.expiryDate}`}
          </label>
        ))}
        <div className="actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={!chosen}>
            Count it
          </button>
        </div>
      </form>
    </div>
  );
}

function Header(props: { storeId: string; title: string }) {
  return (
    <header className="bar">
      <a href={href({ screen: "count", storeId: props.storeId })}>‹ Shelves</a>
      <h1>{props.title}</h1>
    </header>
  );
}
