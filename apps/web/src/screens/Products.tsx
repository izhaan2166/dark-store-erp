import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useState } from "react";
import { type Api, ApiError, newKey, type NewProduct, type ProductDetail } from "../api";
import { href } from "../route";

type Message = { kind: "ok" | "error"; text: string };

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * A barcode field for a scanner or a keyboard: Enter adds the code instead
 * of submitting the surrounding form.
 */
function BarcodeInput(props: { label: string; onAdd: (code: string) => void | Promise<void> }) {
  const [value, setValue] = useState("");
  const add = () => {
    const code = value.trim();
    if (!code) return;
    setValue("");
    void props.onAdd(code);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    add();
  };
  return (
    <div className="search">
      <input aria-label={props.label} placeholder="Scan or type a barcode" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown} />
      <button type="button" onClick={add}>
        Add
      </button>
    </div>
  );
}

/** The product list: search by name, SKU or barcode (a scan works too), add and edit products. */
export function Products(props: { api: Api; storeId: string }) {
  const { api, storeId } = props;
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ProductDetail[] | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [editing, setEditing] = useState<ProductDetail | "new" | null>(null);

  const search = useCallback(
    async (q: string) => {
      try {
        setItems(await api.catalogue(storeId, q));
      } catch (err) {
        setMessage({ kind: "error", text: errorText(err, "Could not load products") });
      }
    },
    [api, storeId],
  );

  useEffect(() => {
    void search("");
  }, [search]);

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    void search(query);
  };

  const saved = (product: ProductDetail, text: string) => {
    setEditing(null);
    setMessage({ kind: "ok", text });
    setQuery(product.sku);
    void search(product.sku);
  };

  return (
    <main>
      <header className="bar">
        <a href={href({ screen: "stores" })}>‹ Jobs</a>
        <h1>Products</h1>
        <button className="primary" onClick={() => setEditing("new")}>
          New product
        </button>
      </header>
      {message && (
        <p className={message.kind === "ok" ? "ok" : "error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}
      <form className="search" onSubmit={onSearch}>
        <input aria-label="Find a product" placeholder="Name, SKU or barcode" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button>Search</button>
      </form>
      {items === null && !message && <p className="muted">Loading…</p>}
      {items?.length === 0 && <p className="muted">No products match.</p>}
      <ul className="list">
        {items?.map((p) => (
          <li key={p.productId} className="row">
            <strong>{p.name}</strong>
            <span className="muted">
              {p.sku} · {p.category}
              {p.batchTracked && " · lot and expiry"}
              {p.barcodes.length > 0 && ` · ${p.barcodes.join(", ")}`}
            </span>
            {p.status === "inactive" && <span className="tag warn">Not sold</span>}
            <button onClick={() => setEditing(p)}>Edit</button>
          </li>
        ))}
      </ul>

      {editing === "new" && (
        <NewProductDialog
          onCancel={() => setEditing(null)}
          onSave={async (body) => saved(await api.createProduct(storeId, body, newKey()), `Added ${body.name}`)}
        />
      )}
      {editing && editing !== "new" && (
        <EditProductDialog
          api={api}
          storeId={storeId}
          product={editing}
          onCancel={() => setEditing(null)}
          onSaved={(p) => saved(p, `Saved ${p.name}`)}
        />
      )}
    </main>
  );
}

function NewProductDialog(props: { onCancel: () => void; onSave: (body: NewProduct) => Promise<void> }) {
  const [form, setForm] = useState({ sku: "", name: "", category: "", unitOfMeasure: "each", batchTracked: false });
  const [barcodes, setBarcodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (change: Partial<typeof form>) => setForm((f) => ({ ...f, ...change }));
  const valid = form.sku.trim() && form.name.trim() && form.category.trim() && form.unitOfMeasure.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSave({ ...form, sku: form.sku.trim(), name: form.name.trim(), category: form.category.trim(), barcodes });
    } catch (err) {
      setError(errorText(err, "Could not add the product"));
      setBusy(false);
    }
  };

  return (
    <div className="dialog" role="dialog" aria-label="New product">
      <div className="sheet">
        <form className="stack" onSubmit={submit}>
          <h2>New product</h2>
          <label>
            SKU
            <input value={form.sku} onChange={(e) => set({ sku: e.target.value })} required />
          </label>
          <label>
            Name
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
          </label>
          <label>
            Category
            <input value={form.category} onChange={(e) => set({ category: e.target.value })} placeholder="e.g. Dairy" required />
          </label>
          <label>
            Unit
            <input value={form.unitOfMeasure} onChange={(e) => set({ unitOfMeasure: e.target.value })} required />
          </label>
          <label className="choice">
            <input type="checkbox" checked={form.batchTracked} onChange={(e) => set({ batchTracked: e.target.checked })} />
            Has a lot and expiry date (milk, bread, medicines…)
          </label>
          <div>
            <BarcodeInput label="Barcode" onAdd={(code) => setBarcodes((b) => (b.includes(code) ? b : [...b, code]))} />
            {barcodes.length > 0 && (
              <ul className="tags">
                {barcodes.map((b) => (
                  <li key={b} className="tag">
                    {b}{" "}
                    <button type="button" aria-label={`Remove ${b}`} onClick={() => setBarcodes((all) => all.filter((x) => x !== b))}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="muted">The SKU and the lot setting cannot be changed later.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button type="button" onClick={props.onCancel}>
              Cancel
            </button>
            <button className="primary" disabled={busy || !valid}>
              Add product
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditProductDialog(props: {
  api: Api;
  storeId: string;
  product: ProductDetail;
  onCancel: () => void;
  onSaved: (product: ProductDetail) => void;
}) {
  const { api, storeId } = props;
  const [product, setProduct] = useState(props.product);
  const [form, setForm] = useState({
    name: product.name,
    category: product.category,
    unitOfMeasure: product.unitOfMeasure,
    status: product.status,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (change: Partial<typeof form>) => setForm((f) => ({ ...f, ...change }));

  const addBarcode = async (code: string) => {
    setError(null);
    try {
      setProduct(await api.addBarcode(storeId, product.productId, code, newKey()));
    } catch (err) {
      setError(errorText(err, "Could not add the barcode"));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const changes = Object.fromEntries(
      Object.entries(form)
        .map(([k, v]) => [k, typeof v === "string" ? v.trim() : v] as const)
        .filter(([k, v]) => v !== product[k as keyof typeof form]),
    );
    if (Object.keys(changes).length === 0) {
      props.onSaved(product);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      props.onSaved(await api.updateProduct(storeId, product.productId, changes, newKey()));
    } catch (err) {
      setError(errorText(err, "Could not save"));
      setBusy(false);
    }
  };

  return (
    <div className="dialog" role="dialog" aria-label={`Edit ${product.name}`}>
      <div className="sheet">
        <form className="stack" onSubmit={submit}>
          <h2>{product.name}</h2>
          <p className="muted">
            {product.sku}
            {product.batchTracked ? " · has lot and expiry" : ""}
          </p>
          <label>
            Name
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
          </label>
          <label>
            Category
            <input value={form.category} onChange={(e) => set({ category: e.target.value })} required />
          </label>
          <label>
            Unit
            <input value={form.unitOfMeasure} onChange={(e) => set({ unitOfMeasure: e.target.value })} required />
          </label>
          <label>
            Status
            <select value={form.status} onChange={(e) => set({ status: e.target.value as ProductDetail["status"] })}>
              <option value="active">Sold</option>
              <option value="inactive">Not sold (no new customer or supplier orders)</option>
            </select>
          </label>
          <div>
            <span>Barcodes</span>
            {product.barcodes.length > 0 ? (
              <ul className="tags">
                {product.barcodes.map((b) => (
                  <li key={b} className="tag">
                    {b}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">None yet.</p>
            )}
            <BarcodeInput label="Add barcode" onAdd={addBarcode} />
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button type="button" onClick={props.onCancel}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
