import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Api,
  ApiError,
  type Location,
  newKey,
  type PurchaseOrderLine,
  type PurchaseOrderView,
  type ReceiptLine,
  type ReceiptView,
} from "../api";
import { href } from "../route";
import { buzz } from "../buzz";
import { ScanBox } from "../ScanBox";

export interface Entry {
  accepted: number;
  damaged: number;
  rejected: number;
  lotCode: string;
  expiryDate: string;
}

type Message = { kind: "ok" | "error"; text: string };

const EMPTY: Entry = { accepted: 0, damaged: 0, rejected: 0, lotCode: "", expiryDate: "" };

const units = (e: Entry) => e.accepted + e.damaged + e.rejected;

/** The receipt to send: only lines with units, lot and expiry only where the product is batch tracked. */
export function receiptLines(lines: PurchaseOrderLine[], entries: Map<string, Entry>): ReceiptLine[] {
  return lines.flatMap((line) => {
    const e = entries.get(line.purchaseOrderLineId);
    if (!e || units(e) === 0) return [];
    return [
      {
        productId: line.productId,
        acceptedQty: e.accepted,
        damagedQty: e.damaged,
        rejectedQty: e.rejected,
        ...(line.batchTracked ? { lotCode: e.lotCode.trim(), expiryDate: e.expiryDate } : {}),
      },
    ];
  });
}

/** Batch-tracked lines with units counted but no lot code or expiry date yet. */
export function missingLotInfo(lines: PurchaseOrderLine[], entries: Map<string, Entry>): PurchaseOrderLine[] {
  return lines.filter((line) => {
    const e = entries.get(line.purchaseOrderLineId);
    return line.batchTracked && e && units(e) > 0 && (!e.lotCode.trim() || !e.expiryDate);
  });
}

/** Lines where the good units counted differ from what is still expected. */
export function differences(lines: PurchaseOrderLine[], entries: Map<string, Entry>) {
  return lines
    .map((line) => ({ line, counted: entries.get(line.purchaseOrderLineId)?.accepted ?? 0 }))
    .filter(({ line, counted }) => counted !== line.outstandingQty);
}

/**
 * Receiving one delivery against its purchase order. The receiver scans each
 * good unit as it is unloaded, notes damaged or refused units, and enters lot
 * and expiry for batch-tracked items. Counts that differ from the order by
 * more than the store allows wait for a Store Manager before stock moves.
 */
export function ReceiveOrder(props: { api: Api; storeId: string; purchaseOrderId: string }) {
  const { api, storeId, purchaseOrderId } = props;
  const [po, setPo] = useState<PurchaseOrderView | null>(null);
  const [areas, setAreas] = useState<Location[] | null>(null);
  const [areaId, setAreaId] = useState<string>("");
  const [entries, setEntries] = useState(() => new Map<string, Entry>());
  const [message, setMessage] = useState<Message | null>(null);
  const [result, setResult] = useState<ReceiptView | null>(null);
  const [busy, setBusy] = useState(false);
  const products = useRef(new Map<string, string>());
  const state = useRef({ po, entries });
  state.current = { po, entries };
  const queue = useRef(Promise.resolve());
  // One key per version of the counts, so a retried submit can never record the delivery twice.
  const submitKey = useRef(newKey());

  const fail = useCallback((err: unknown) => {
    buzz();
    setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Something went wrong" });
  }, []);

  useEffect(() => {
    api.purchaseOrder(storeId, purchaseOrderId).then(setPo, fail);
    api.locations(storeId).then((all) => {
      const receiving = all.filter((l) => l.purpose === "receiving" && l.status === "active");
      setAreas(receiving);
      if (receiving.length === 1) setAreaId(receiving[0]!.locationId);
    }, fail);
  }, [api, storeId, purchaseOrderId, fail]);

  const update = (lineId: string, change: Partial<Entry>) => {
    submitKey.current = newKey();
    setEntries((current) => {
      const next = { ...(current.get(lineId) ?? EMPTY), ...change };
      for (const k of ["accepted", "damaged", "rejected"] as const) next[k] = Math.max(0, next[k]);
      return new Map(current).set(lineId, next);
    });
  };

  const countScanned = async (code: string) => {
    const current = state.current.po;
    if (!current) return;
    let productId = products.current.get(code);
    if (!productId) {
      try {
        productId = (await api.product(storeId, code)).productId;
        products.current.set(code, productId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          buzz();
          setMessage({ kind: "error", text: `Unknown barcode ${code}. Set it aside for the manager.` });
          return;
        }
        throw err;
      }
    }
    const line = current.lines.find((l) => l.productId === productId);
    if (!line) {
      buzz();
      setMessage({ kind: "error", text: "Not on this purchase order. Set it aside for the manager." });
      return;
    }
    const counted = (state.current.entries.get(line.purchaseOrderLineId)?.accepted ?? 0) + 1;
    update(line.purchaseOrderLineId, { accepted: counted });
    setMessage({ kind: "ok", text: `${line.name}: ${counted} of ${line.outstandingQty}` });
  };

  const onScan = (code: string) => {
    setResult(null);
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

  if (!po) {
    return (
      <main>
        <Header storeId={storeId} title="Receive" />
        {message ? <p className="error" role="alert">{message.text}</p> : <p className="muted">Loading…</p>}
      </main>
    );
  }

  const lines = receiptLines(po.lines, entries);
  const needLot = missingLotInfo(po.lines, entries);
  const differ = differences(po.lines, entries);
  const canSubmit = !busy && lines.length > 0 && needLot.length === 0 && areaId !== "";

  const submit = async () => {
    setBusy(true);
    try {
      const receipt = await api.recordReceipt(storeId, { purchaseOrderId, receivingLocationId: areaId, lines }, submitKey.current);
      submitKey.current = newKey();
      setResult(receipt);
      setMessage(null);
      setEntries(new Map());
      setPo(await api.purchaseOrder(storeId, purchaseOrderId));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <Header storeId={storeId} title={`Receive ${po.poNumber}`} />
      <p className="muted">{po.supplierName}</p>
      {message && (
        <p className={message.kind === "ok" ? "ok" : "error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}
      {result && <ResultCard result={result} storeId={storeId} />}
      {po.pendingReceipts > 0 && (
        <section className="card warn">
          <h2>Waiting for a manager</h2>
          <p>An earlier delivery for this order is waiting for approval. Check with the Store Manager before receiving more.</p>
        </section>
      )}
      {po.status !== "open" && <p className="muted">This purchase order is {po.status}.</p>}

      {areas?.length === 0 && <p className="error">No receiving area is set up for this store. Ask a Store Manager.</p>}
      {areas && areas.length > 1 && (
        <label>
          Unloading area
          <select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">Choose…</option>
            {areas.map((a) => (
              <option key={a.locationId} value={a.locationId}>
                {a.code}
              </option>
            ))}
          </select>
        </label>
      )}

      <ScanBox label="Scan each good item as you unload" disabled={busy} onScan={onScan} />
      <ul className="receive">
        {po.lines.map((line) => {
          const e = entries.get(line.purchaseOrderLineId) ?? EMPTY;
          const id = line.purchaseOrderLineId;
          return (
            <li key={id} className={e.accepted === line.outstandingQty && e.accepted > 0 ? "done" : undefined}>
              <div className="what">
                <strong>{line.name}</strong>
                <span className="muted">
                  {line.sku} · expected {line.outstandingQty}
                </span>
              </div>
              <div className="count" aria-label={`${line.name} good`}>
                {e.accepted}
              </div>
              <div className="steppers">
                <button aria-label={`One less ${line.name}`} onClick={() => update(id, { accepted: e.accepted - 1 })}>
                  −
                </button>
                <button aria-label={`One more ${line.name}`} onClick={() => update(id, { accepted: e.accepted + 1 })}>
                  +
                </button>
              </div>
              <div className="extra">
                <Small text="Damaged" name={line.name} value={e.damaged} onChange={(v) => update(id, { damaged: v })} />
                <Small text="Sent back" name={line.name} value={e.rejected} onChange={(v) => update(id, { rejected: v })} />
              </div>
              {line.batchTracked && units(e) > 0 && (
                <div className="extra">
                  <label>
                    Lot
                    <input aria-label={`Lot ${line.name}`} value={e.lotCode} onChange={(ev) => update(id, { lotCode: ev.target.value })} />
                  </label>
                  <label>
                    Expiry
                    <input
                      aria-label={`Expiry ${line.name}`}
                      type="date"
                      value={e.expiryDate}
                      onChange={(ev) => update(id, { expiryDate: ev.target.value })}
                    />
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {lines.length > 0 && differ.length > 0 && (
        <section className="card warn">
          <h2>Different from the order</h2>
          <ul>
            {differ.map(({ line, counted }) => (
              <li key={line.purchaseOrderLineId}>
                {line.name}: expected {line.outstandingQty}, counted {counted}
              </li>
            ))}
          </ul>
          <p className="muted">Big differences wait for a Store Manager's approval before the stock is added.</p>
        </section>
      )}
      {needLot.length > 0 && <p className="muted">Enter lot and expiry for {needLot.map((l) => l.name).join(", ")}.</p>}
      <button className="primary big" disabled={!canSubmit} onClick={() => void submit()}>
        Finish receiving
      </button>
    </main>
  );
}

function ResultCard(props: { result: ReceiptView; storeId: string }) {
  if (props.result.status === "pending_approval") {
    return (
      <section className="card warn" role="status">
        <h2>Saved, waiting for approval</h2>
        <p>Some counts differ from the order by more than the store allows. A Store Manager must approve before the stock is added.</p>
      </section>
    );
  }
  return (
    <section className="card" role="status">
      <h2>Received</h2>
      <p>
        The goods are in the unloading area. <a href={href({ screen: "putaway", storeId: props.storeId })}>Put them away</a>
      </p>
    </section>
  );
}

/** A small counter for damaged or sent-back units. */
function Small(props: { text: string; name: string; value: number; onChange: (value: number) => void }) {
  const what = `${props.text.toLowerCase()} ${props.name}`;
  return (
    <span className="small-stepper">
      {props.text}
      <button aria-label={`One less ${what}`} onClick={() => props.onChange(props.value - 1)}>
        −
      </button>
      <span aria-label={`${props.text} ${props.name}`}>{props.value}</span>
      <button aria-label={`One more ${what}`} onClick={() => props.onChange(props.value + 1)}>
        +
      </button>
    </span>
  );
}

function Header(props: { storeId: string; title: string }) {
  return (
    <header className="bar">
      <a href={href({ screen: "receive", storeId: props.storeId })}>‹ Deliveries</a>
      <h1>{props.title}</h1>
    </header>
  );
}
