import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { type Api, ApiError, type Location, newKey, type StockRequestSummary, type StockRow } from "../api";
import { href } from "../route";
import { buzz } from "../buzz";
import { ScanBox } from "../ScanBox";

type Message = { kind: "ok" | "error"; text: string };
export type Action = "block" | "release" | "write_off";

const STATUS: Record<string, string> = {
  available: "On sale",
  quarantined: "Blocked",
  damaged: "Damaged",
  expired: "Expired",
};

const ACTIONS: Record<Action, { label: string; done: string }> = {
  block: { label: "Block", done: "Blocked" },
  release: { label: "Put back on sale", done: "Asked a Store Manager to put back on sale" },
  write_off: { label: "Write off", done: "Asked a Store Manager to write off" },
};

/** What can be done with stock in this state and place. Selling stock can only be blocked or written off from a shelf. */
export function actionsFor(row: StockRow, locations: Map<string, Location>): Action[] {
  const purpose = locations.get(row.locationId)?.purpose;
  if (row.status === "available") return purpose === "storage" ? ["block", "write_off"] : [];
  if (row.status === "quarantined") return ["release", "write_off"];
  if (row.status === "damaged" || row.status === "expired") return ["write_off"];
  return [];
}

/** Units an action may move: blocking cannot touch units orders have reserved. */
export const movable = (row: StockRow, action: Action) => (action === "block" ? row.free : row.onHand);

const rowKey = (r: { productId: string; batchId: string | null; locationId: string; status: string }) =>
  `${r.productId}|${r.batchId ?? ""}|${r.locationId}|${r.status}`;

/**
 * Problem stock. Blocked, damaged and expired stock is listed; any item can
 * be scanned to see all of it. Blocking takes effect at once. Putting stock
 * back on sale and writing it off are requests a Store Manager approves.
 */
export function StockControl(props: { api: Api; storeId: string }) {
  const { api, storeId } = props;
  const [problem, setProblem] = useState<StockRow[] | null>(null);
  const [scanned, setScanned] = useState<{ name: string; rows: StockRow[] } | null>(null);
  const [locations, setLocations] = useState(new Map<string, Location>());
  const [waiting, setWaiting] = useState<StockRequestSummary[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ row: StockRow; action: Action } | null>(null);
  const products = useRef(new Map<string, { productId: string; name: string }>());
  const queue = useRef(Promise.resolve());

  const fail = useCallback((err: unknown) => {
    buzz();
    setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Something went wrong" });
  }, []);

  const load = useCallback(async () => {
    const lists = await Promise.all(["quarantined", "damaged", "expired"].map((status) => api.stockRows(storeId, { status })));
    setProblem(lists.flat());
    setWaiting(await api.pendingRequests(storeId));
  }, [api, storeId]);

  useEffect(() => {
    load().catch(fail);
    api.locations(storeId).then((all) => setLocations(new Map(all.map((l) => [l.locationId, l]))), fail);
  }, [api, storeId, load, fail]);

  const lookUp = async (code: string) => {
    let product = products.current.get(code);
    if (!product) {
      try {
        product = await api.product(storeId, code);
        products.current.set(code, product);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          buzz();
          setMessage({ kind: "error", text: `Unknown barcode ${code}` });
          return;
        }
        throw err;
      }
    }
    const rows = (await api.stockRows(storeId, { productId: product.productId })).filter((r) => r.status !== "receiving");
    setScanned({ name: product.name, rows });
    setMessage(null);
  };

  const onScan = (code: string) => {
    queue.current = queue.current.then(async () => {
      setBusy(true);
      try {
        await lookUp(code);
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    });
  };

  const pendingKeys = new Set(
    waiting.map((w) => rowKey({ productId: w.productId, batchId: w.batchId, locationId: w.fromLocationId, status: w.fromStatus })),
  );
  const isWaiting = (r: StockRow) => pendingKeys.has(rowKey(r));

  const table = (rows: StockRow[]) => (
    <ul className="list">
      {rows.map((row) => (
        <li key={rowKey(row)} className="card">
          <div className="title">
            <strong>
              {row.onHand} × {row.name}
            </strong>
            <span className={row.status === "available" ? "tag" : "tag warn"}>{STATUS[row.status] ?? row.status}</span>
          </div>
          <span className="muted">
            {row.sku}
            {row.lotCode && ` · lot ${row.lotCode}`}
            {row.expiryDate && ` · exp ${row.expiryDate}`} · {row.locationCode}
            {row.status === "available" && row.free < row.onHand && ` · ${row.onHand - row.free} reserved for orders`}
          </span>
          {isWaiting(row) && <span className="tag warn">Waiting for a manager</span>}
          <div className="jobs">
            {actionsFor(row, locations).map((action) => (
              <button key={action} disabled={busy || movable(row, action) < 1} onClick={() => setOpen({ row, action })}>
                {ACTIONS[action].label}
              </button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <main>
      <header className="bar">
        <a href={href({ screen: "stores" })}>‹ Jobs</a>
        <h1>Problem stock</h1>
      </header>
      {message && (
        <p className={message.kind === "ok" ? "ok" : "error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}
      <ScanBox label="Scan an item to block or write off" disabled={busy || open !== null} onScan={onScan} />

      {scanned && (
        <section>
          <div className="bar">
            <h2>All stock of {scanned.name}</h2>
            <button onClick={() => setScanned(null)}>Close</button>
          </div>
          {scanned.rows.length === 0 ? <p className="muted">None in the store.</p> : table(scanned.rows)}
        </section>
      )}

      <section>
        <h2>Blocked, damaged and expired</h2>
        {problem === null && !message && <p className="muted">Loading…</p>}
        {problem?.length === 0 && <p className="muted">No problem stock right now.</p>}
        {problem && table(problem)}
      </section>

      {open && (
        <ActionDialog
          row={open.row}
          action={open.action}
          targets={[...locations.values()].filter(
            (l) => l.status === "active" && l.purpose === (open.action === "block" ? "quarantine" : "storage"),
          )}
          onCancel={() => setOpen(null)}
          onConfirm={async (quantity, reason, targetId) => {
            const { row, action } = open;
            const key = newKey();
            const what = { productId: row.productId, batchId: row.batchId, quantity, reason };
            if (action === "block") await api.quarantine(storeId, { ...what, fromLocationId: row.locationId, toLocationId: targetId! }, key);
            if (action === "release") await api.requestRelease(storeId, { ...what, fromLocationId: row.locationId, toLocationId: targetId! }, key);
            if (action === "write_off") await api.requestWriteOff(storeId, { ...what, locationId: row.locationId, status: row.status }, key);
            setOpen(null);
            setScanned(null);
            setMessage({ kind: "ok", text: `${ACTIONS[action].done}: ${quantity} × ${row.name}` });
            await load();
          }}
        />
      )}
    </main>
  );
}

function ActionDialog(props: {
  row: StockRow;
  action: Action;
  targets: Location[];
  onCancel: () => void;
  onConfirm: (quantity: number, reason: string, targetId: string | null) => Promise<void>;
}) {
  const { row, action, targets } = props;
  const max = movable(row, action);
  const needsTarget = action !== "write_off";
  const [quantityText, setQuantityText] = useState(String(max));
  const [reason, setReason] = useState("");
  const [targetId, setTargetId] = useState(targets.length === 1 ? targets[0]!.locationId : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const quantity = Number(quantityText);
  const valid = Number.isInteger(quantity) && quantity >= 1 && quantity <= max && reason.trim() !== "" && (!needsTarget || targetId !== "");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(quantity, reason.trim(), needsTarget ? targetId : null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
      setBusy(false);
    }
  };

  const label = ACTIONS[action].label;
  return (
    <div className="dialog" role="dialog" aria-label={label}>
      <form className="stack" onSubmit={submit}>
        <h2>
          {label}: {row.name}
          {row.lotCode && ` lot ${row.lotCode}`}
        </h2>
        {action !== "block" && <p className="muted">A Store Manager must approve this before stock changes.</p>}
        <label>
          How many (up to {max})
          <input type="number" min={1} max={max} step={1} value={quantityText} onChange={(e) => setQuantityText(e.target.value)} />
        </label>
        {needsTarget && (
          <label>
            {action === "block" ? "Move to" : "Back to shelf"}
            <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">Choose…</option>
              {targets.map((t) => (
                <option key={t.locationId} value={t.locationId}>
                  {t.code}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What is wrong with it?" required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={props.onCancel}>
            Back
          </button>
          <button className="primary" disabled={busy || !valid}>
            {label}
          </button>
        </div>
      </form>
    </div>
  );
}
