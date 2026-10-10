import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, ApiError, type FulfilmentLine, type FulfilmentView, newKey } from "../api";
import { href } from "../route";
import { buzz } from "../buzz";
import { ScanBox } from "../ScanBox";

type Message = { kind: "ok" | "error"; text: string };

/** The line a scanned product counts toward: one still short of what was picked. */
export function lineForScan(lines: FulfilmentLine[], counts: Map<string, number>, productId: string): FulfilmentLine | "full" | null {
  const matching = lines.filter((l) => l.productId === productId && l.pickedQty > 0);
  if (matching.length === 0) return null;
  return matching.find((l) => (counts.get(l.orderItemId) ?? 0) < l.pickedQty) ?? "full";
}

/**
 * Packing one order. The packer scans every item into the bag; the app counts
 * per line and only lets the order through when each count matches what was
 * picked. The server checks the same again. Then the order is handed over.
 */
export function PackOrder(props: { api: Api; storeId: string; orderId: string }) {
  const { api, storeId, orderId } = props;
  const [view, setView] = useState<FulfilmentView | null>(null);
  const [counts, setCounts] = useState(() => new Map<string, number>());
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const products = useRef(new Map<string, string>());
  const state = useRef({ view, counts });
  state.current = { view, counts };
  const queue = useRef(Promise.resolve());

  const fail = useCallback((err: unknown) => {
    buzz();
    setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Something went wrong" });
  }, []);

  useEffect(() => {
    api.fulfilment(storeId, orderId).then(setView, fail);
  }, [api, storeId, orderId, fail]);

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

  const setCount = (orderItemId: string, value: number) =>
    setCounts((current) => new Map(current).set(orderItemId, Math.max(0, value)));

  const countScanned = async (code: string) => {
    const current = state.current.view;
    if (!current) return;
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
    const line = lineForScan(current.lines, state.current.counts, productId);
    if (line === null) {
      buzz();
      setMessage({ kind: "error", text: "Wrong item: this was not picked for the order" });
      return;
    }
    if (line === "full") {
      buzz();
      setMessage({ kind: "error", text: "Too many: every unit of this item is already counted" });
      return;
    }
    const next = (state.current.counts.get(line.orderItemId) ?? 0) + 1;
    setCount(line.orderItemId, next);
    setMessage({ kind: "ok", text: `${line.name}: ${next} of ${line.pickedQty}` });
  };

  const onScan = (code: string) => {
    queue.current = queue.current.then(() => run(() => countScanned(code)));
  };

  if (!view) {
    return (
      <main>
        <Header storeId={storeId} />
        {message ? <p className="error" role="alert">{message.text}</p> : <p className="muted">Loading…</p>}
      </main>
    );
  }

  const going = view.lines.filter((l) => l.pickedQty > 0);
  const notGoing = view.lines.filter((l) => l.pickedQty === 0);
  const allCounted = going.every((l) => (counts.get(l.orderItemId) ?? 0) === l.pickedQty);
  const waiting = view.openShortages.length;

  const pack = () =>
    run(async () => {
      try {
        setView(
          await api.pack(
            storeId,
            orderId,
            view.lines.map((l) => ({ orderItemId: l.orderItemId, quantity: counts.get(l.orderItemId) ?? 0 })),
            newKey(),
          ),
        );
        setMessage({ kind: "ok", text: "Packed. Hand it over when the rider arrives." });
      } catch (err) {
        // Something changed since the screen loaded (e.g. a manager sent it back to picking).
        if (err instanceof ApiError && err.code === "fulfilment_blocked") setView(await api.fulfilment(storeId, orderId));
        throw err;
      }
    });

  return (
    <main>
      <Header storeId={storeId} />
      {message && (
        <p className={message.kind === "ok" ? "ok" : "error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}

      {view.status === "packing" && (
        <>
          {waiting > 0 && (
            <section className="card warn">
              <h2>Waiting for a manager</h2>
              <p>
                {waiting} missing {waiting === 1 ? "item needs" : "items need"} a decision before this order can be packed.
              </p>
            </section>
          )}
          <ScanBox label="Scan each item into the bag" disabled={busy} onScan={onScan} />
          <ul className="pack">
            {going.map((line) => {
              const counted = counts.get(line.orderItemId) ?? 0;
              return (
                <li key={line.orderItemId} className={counted === line.pickedQty ? "done" : undefined}>
                  <div className="what">
                    <strong>{line.name}</strong>
                    <span className="muted">
                      {line.sku}
                      {line.substitutesItemId && " · substitute"}
                    </span>
                  </div>
                  <div className="count" aria-label={`${line.name} counted`}>
                    {counted} / {line.pickedQty}
                  </div>
                  <div className="steppers">
                    <button aria-label={`One less ${line.name}`} onClick={() => setCount(line.orderItemId, counted - 1)}>
                      −
                    </button>
                    <button aria-label={`One more ${line.name}`} onClick={() => setCount(line.orderItemId, counted + 1)}>
                      +
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {notGoing.length > 0 && (
            <p className="muted">Not going out: {notGoing.map((l) => l.name).join(", ")}</p>
          )}
          <button className="primary big" disabled={busy || !allCounted || waiting > 0} onClick={() => void pack()}>
            Packed
          </button>
        </>
      )}

      {view.status === "ready_for_handover" && (
        <button
          className="primary big"
          disabled={busy}
          onClick={() =>
            run(async () => {
              setView(await api.handover(storeId, orderId, newKey()));
              setMessage({ kind: "ok", text: "Handed over. Done." });
            })
          }
        >
          Hand over to rider
        </button>
      )}

      {(view.status === "accepted" || view.status === "picking") && (
        <p className="muted">This order is still being picked.</p>
      )}

      {!["packing", "ready_for_handover", "accepted", "picking"].includes(view.status) && (
        <p>
          This order is {view.status.replaceAll("_", " ")}. <a href={href({ screen: "queue", job: "pack", storeId })}>Back to orders</a>
        </p>
      )}
    </main>
  );
}

function Header(props: { storeId: string }) {
  return (
    <header className="bar">
      <a href={href({ screen: "queue", job: "pack", storeId: props.storeId })}>‹ Orders</a>
      <h1>Pack order</h1>
    </header>
  );
}
