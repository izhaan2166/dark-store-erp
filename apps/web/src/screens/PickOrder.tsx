import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { type Api, ApiError, type FulfilmentLine, type FulfilmentView, newKey, type PickTask } from "../api";
import { href } from "../route";
import { ScanBox } from "../ScanBox";

type Message = { kind: "ok" | "error"; text: string };
type Stop = { line: FulfilmentLine; task: PickTask };

const SHORT_REASONS = ["Not on the shelf", "Damaged", "Expired"];

/** Every bin stop still to pick, in walking order (bin code, then earliest expiry). */
export function stops(view: FulfilmentView): Stop[] {
  return view.lines
    .flatMap((line) => line.tasks.map((task) => ({ line, task })))
    .sort(
      (a, b) =>
        a.task.locationCode.localeCompare(b.task.locationCode) ||
        (a.task.expiryDate ?? "9999").localeCompare(b.task.expiryDate ?? "9999") ||
        a.line.lineNo - b.line.lineNo,
    );
}

function buzz(): void {
  try {
    navigator.vibrate?.([120, 60, 120]);
  } catch {
    // Not every device can vibrate.
  }
}

/**
 * Picking one order. The picker scans each item; every scan picks one unit
 * from the next bin that holds it for this order. Items that are not there
 * are reported short, and a Store Manager decides what happens next.
 */
export function PickOrder(props: { api: Api; storeId: string; orderId: string }) {
  const { api, storeId, orderId } = props;
  const [view, setView] = useState<FulfilmentView | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [short, setShort] = useState<Stop | null>(null);
  const viewRef = useRef<FulfilmentView | null>(null);
  const products = useRef(new Map<string, string>());
  const queue = useRef(Promise.resolve());

  const show = useCallback((next: FulfilmentView) => {
    viewRef.current = next;
    setView(next);
  }, []);

  const fail = useCallback((err: unknown) => {
    buzz();
    setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Something went wrong" });
  }, []);

  useEffect(() => {
    api.fulfilment(storeId, orderId).then(show, fail);
  }, [api, storeId, orderId, show, fail]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const pickScanned = async (code: string) => {
    const current = viewRef.current;
    if (!current) return;
    if (current.status !== "picking") {
      buzz();
      setMessage({ kind: "error", text: "Tap Start picking first" });
      return;
    }
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
    const stop = stops(current).find((s) => s.line.productId === productId);
    if (!stop) {
      buzz();
      const inOrder = current.lines.some((l) => l.productId === productId);
      setMessage({ kind: "error", text: inOrder ? "All of this item is already picked" : "Wrong item: this is not in the order" });
      return;
    }
    show(
      await api.pick(
        storeId,
        orderId,
        { orderItemId: stop.line.orderItemId, locationId: stop.task.locationId, barcode: code, quantity: 1 },
        newKey(),
      ),
    );
    setMessage({ kind: "ok", text: `Picked 1 × ${stop.line.name} from ${stop.task.locationCode}` });
  };

  // Scans are handled one at a time, in the order they were made.
  const onScan = (code: string) => {
    queue.current = queue.current.then(() => run(() => pickScanned(code)));
  };

  if (!view) {
    return (
      <main>
        <Header storeId={storeId} />
        {message ? <p className="error" role="alert">{message.text}</p> : <p className="muted">Loading…</p>}
      </main>
    );
  }

  const remaining = stops(view);
  const missing = view.lines.filter((l) => l.openShortageQty > 0);

  return (
    <main>
      <Header storeId={storeId} />
      {message && (
        <p className={message.kind === "ok" ? "ok" : "error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}

      {view.status === "accepted" && (
        <button className="primary big" disabled={busy} onClick={() => run(async () => show(await api.startPicking(storeId, orderId, newKey())))}>
          Start picking
        </button>
      )}

      {view.status === "picking" && (
        <>
          <ScanBox label="Scan an item" disabled={busy} onScan={onScan} />
          {remaining.length === 0 ? (
            <button
              className="primary big"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  show(await api.completePicking(storeId, orderId, newKey()));
                  setMessage({ kind: "ok", text: "Picking finished. The order is ready for packing." });
                })
              }
            >
              Finish picking
            </button>
          ) : (
            <ol className="stops">
              {remaining.map((stop, i) => (
                <li key={`${stop.line.orderItemId}-${stop.task.locationId}-${stop.task.batchId}`} className={i === 0 ? "next" : undefined}>
                  <div className="bin">{stop.task.locationCode}</div>
                  <div className="what">
                    <strong>{stop.line.name}</strong>
                    <span className="muted">
                      {stop.line.sku}
                      {stop.task.lotCode && ` · lot ${stop.task.lotCode}`}
                      {stop.task.expiryDate && ` · exp ${stop.task.expiryDate}`}
                      {stop.line.substitutesItemId && " · substitute"}
                    </span>
                  </div>
                  <div className="qty">× {stop.task.quantity}</div>
                  <button disabled={busy} onClick={() => setShort(stop)}>
                    Can't find
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {view.status !== "accepted" && view.status !== "picking" && (
        <p className="ok">
          This order is {view.status.replaceAll("_", " ")}. <a href={href({ screen: "queue", storeId })}>Back to orders</a>
        </p>
      )}

      {missing.length > 0 && (
        <section className="card warn">
          <h2>Missing</h2>
          <ul>
            {missing.map((l) => (
              <li key={l.orderItemId}>
                {l.openShortageQty} × {l.name}. A manager will decide what to do.
              </li>
            ))}
          </ul>
        </section>
      )}

      {short && (
        <ShortPickDialog
          stop={short}
          busy={busy}
          onCancel={() => setShort(null)}
          onSubmit={(quantity, reason) =>
            run(async () => {
              show(
                await api.shortPick(
                  storeId,
                  orderId,
                  { orderItemId: short.line.orderItemId, locationId: short.task.locationId, quantity, reason },
                  newKey(),
                ),
              );
              setShort(null);
              setMessage({ kind: "ok", text: `Reported ${quantity} × ${short.line.name} missing` });
            })
          }
        />
      )}
    </main>
  );
}

function Header(props: { storeId: string }) {
  return (
    <header className="bar">
      <a href={href({ screen: "queue", storeId: props.storeId })}>‹ Orders</a>
      <h1>Pick order</h1>
    </header>
  );
}

function ShortPickDialog(props: {
  stop: Stop;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (quantity: number, reason: string) => void;
}) {
  const { stop } = props;
  const [quantity, setQuantity] = useState(stop.task.quantity);
  const [reason, setReason] = useState(SHORT_REASONS[0]!);
  const [other, setOther] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const why = reason === "Other" ? other.trim() : reason;
    if (why) props.onSubmit(quantity, why);
  };

  return (
    <div className="dialog" role="dialog" aria-label="Report missing items">
      <form className="stack" onSubmit={submit}>
        <h2>
          {stop.line.name} in {stop.task.locationCode}
        </h2>
        <label>
          How many are missing?
          <input
            type="number"
            min={1}
            max={stop.task.quantity}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Math.min(stop.task.quantity, Number(e.target.value) || 1)))}
          />
        </label>
        <fieldset>
          <legend>Why?</legend>
          {[...SHORT_REASONS, "Other"].map((r) => (
            <label key={r} className="choice">
              <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
              {r}
            </label>
          ))}
          {reason === "Other" && <input aria-label="Other reason" value={other} onChange={(e) => setOther(e.target.value)} required />}
        </fieldset>
        <div className="actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={props.busy}>
            Report missing
          </button>
        </div>
      </form>
    </div>
  );
}
