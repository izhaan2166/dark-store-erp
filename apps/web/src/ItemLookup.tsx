import { type FormEvent, useState } from "react";
import { type Api, ApiError, type Product } from "./api";
import { buzz } from "./buzz";

/**
 * One box for adding items: a scanned barcode adds its product at once;
 * typed text searches names and SKUs, adding the only match or listing
 * several to choose from. The box has id="scan" so quantity fields can
 * send focus back to it.
 */
export function ItemLookup(props: { api: Api; storeId: string; onAdd: (product: Product) => void }) {
  const { api, storeId } = props;
  const [text, setText] = useState("");
  const [results, setResults] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = (product: Product) => {
    setResults(null);
    setError(null);
    props.onAdd(product);
  };

  const find = async (event: FormEvent) => {
    event.preventDefault();
    const code = text.trim();
    if (!code) return;
    setText("");
    setError(null);
    try {
      add(await api.product(storeId, code));
      return;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        buzz();
        setError(err instanceof ApiError ? err.message : "Could not find the item");
        return;
      }
    }
    try {
      const found = await api.searchProducts(storeId, code);
      if (found.length === 1) add(found[0]!);
      else if (found.length === 0) {
        buzz();
        setError(`Nothing matches “${code}”`);
      } else setResults(found);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Search failed");
    }
  };

  return (
    <>
      <form className="search" onSubmit={find}>
        <input id="scan" aria-label="Add an item" placeholder="Scan, or type a name or SKU" value={text} onChange={(e) => setText(e.target.value)} />
        <button>Add</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {results && (
        <ul className="list" aria-label="Matching items">
          {results.map((p) => (
            <li key={p.productId} className="row">
              <strong>{p.name}</strong>
              <span className="muted">{p.sku}</span>
              <button onClick={() => add(p)}>Add</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Enter in a quantity field goes back to the item box, ready for the next scan. */
export function backToScan(event: { key: string; preventDefault: () => void }): void {
  if (event.key !== "Enter") return;
  event.preventDefault();
  document.getElementById("scan")?.focus();
}
