import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type Api, ApiError, type CountSummary, type Decision, newKey, type ReceiptSummary, type StockRequestSummary } from "../api";
import { href } from "../route";

const REFRESH_MS = 30_000;

/** ₹ from paise, whole rupees, with Indian digit grouping. */
export function rupees(paise: number): string {
  const sign = paise < 0 ? "−" : "";
  return `${sign}₹${Math.round(Math.abs(paise) / 100).toLocaleString("en-IN")}`;
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");
const lot = (code: string | null) => (code ? ` lot ${code}` : "");

/** One thing waiting for a decision, in the words shown on the dialog. */
type Pending =
  | { kind: "receipt"; item: ReceiptSummary }
  | { kind: "count"; item: CountSummary }
  | { kind: "request"; item: StockRequestSummary };

const TITLES: Record<Pending["kind"], { approve: string; reject: string }> = {
  receipt: { approve: "Accept delivery", reject: "Cancel delivery" },
  count: { approve: "Accept count", reject: "Reject count" },
  request: { approve: "Approve", reject: "Reject" },
};

/** What a decision did, for the confirmation line. */
export function outcome(pending: Pending, decision: Decision): string {
  if (pending.kind === "receipt") {
    const name = pending.item.poNumber ?? "without a purchase order";
    return decision === "approve" ? `Delivery ${name} accepted. The stock is in the unloading area.` : `Delivery ${name} cancelled. No stock was added.`;
  }
  if (pending.kind === "count") {
    const shelf = pending.item.locationCode;
    return decision === "approve" ? `Count of ${shelf} accepted. Stock now matches it.` : `Count of ${shelf} rejected. Stock is unchanged.`;
  }
  if (decision === "reject") return "Request rejected. Stock is unchanged.";
  const r = pending.item;
  return r.kind === "write_off"
    ? `Written off ${r.quantity} × ${r.productName}.`
    : `${r.quantity} × ${r.productName} is back on sale in ${r.toLocationCode}.`;
}

export function requestText(r: StockRequestSummary): string {
  const what = `${r.quantity} × ${r.productName}${lot(r.lotCode)}`;
  return r.kind === "write_off"
    ? `Write off ${what} (${r.fromStatus}) in ${r.fromLocationCode}`
    : `Put ${what} back on sale: ${r.fromLocationCode} to ${r.toLocationCode}`;
}

/**
 * Everything waiting for a Store Manager: deliveries off by more than the
 * store allows, counts over the variance limits, and requests to write off
 * or release blocked stock. Every decision needs a reason, which is audited.
 */
export function Approvals(props: { api: Api; storeId: string }) {
  const { api, storeId } = props;
  const [receipts, setReceipts] = useState<ReceiptSummary[] | null>(null);
  const [counts, setCounts] = useState<CountSummary[] | null>(null);
  const [requests, setRequests] = useState<StockRequestSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [open, setOpen] = useState<{ pending: Pending; decision: Decision } | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, c, q] = await Promise.all([api.pendingReceipts(storeId), api.pendingCounts(storeId), api.pendingRequests(storeId)]);
      setReceipts(r);
      setCounts(c);
      setRequests(q);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load approvals");
    }
  }, [api, storeId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const total = (receipts?.length ?? 0) + (counts?.length ?? 0) + (requests?.length ?? 0);
  const loaded = receipts !== null && counts !== null && requests !== null;
  const buttons = (pending: Pending) => (
    <div className="jobs">
      <button className="primary" onClick={() => setOpen({ pending, decision: "approve" })}>
        {TITLES[pending.kind].approve}
      </button>
      <button onClick={() => setOpen({ pending, decision: "reject" })}>{TITLES[pending.kind].reject}</button>
    </div>
  );

  return (
    <main>
      <header className="bar">
        <a href={href({ screen: "stores" })}>‹ Jobs</a>
        <h1>Approvals</h1>
        <button onClick={() => void load()}>Refresh</button>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {done && <p className="ok" role="status">{done}</p>}
      {!loaded && !error && <p className="muted">Loading…</p>}
      {loaded && total === 0 && <p className="muted">Nothing is waiting for you.</p>}

      {receipts && receipts.length > 0 && (
        <section>
          <h2>Deliveries</h2>
          <ul className="list">
            {receipts.map((r) => (
              <li key={r.goodsReceiptId} className="card">
                <div className="title">
                  <strong>
                    {r.poNumber ?? "No purchase order"} · {r.supplierName}
                  </strong>
                </div>
                <span className="muted">Received by {r.receivedByName}</span>
                <ul className="lines">
                  {r.lines.map((l, i) => (
                    <li key={i} className={l.needsApproval ? "flag" : undefined}>
                      {l.name}
                      {lot(l.lotCode)}: expected {l.expectedQty}, accepted {l.acceptedQty}
                      {l.damagedQty > 0 && `, damaged ${l.damagedQty}`}
                      {l.rejectedQty > 0 && `, sent back ${l.rejectedQty}`}
                    </li>
                  ))}
                </ul>
                {buttons({ kind: "receipt", item: r })}
              </li>
            ))}
          </ul>
        </section>
      )}

      {counts && counts.length > 0 && (
        <section>
          <h2>Counts</h2>
          <ul className="list">
            {counts.map((c) => (
              <li key={c.stockCountId} className="card">
                <div className="title">
                  <strong>Shelf {c.locationCode}</strong>
                </div>
                <span className="muted">Counted by {c.countedByName}</span>
                <ul className="lines">
                  {c.lines
                    .filter((l) => l.variance !== 0 || l.needsApproval)
                    .map((l, i) => (
                      <li key={i} className={l.needsApproval ? "flag" : undefined}>
                        {l.name}
                        {lot(l.lotCode)}: recorded {l.bookQty}, counted {l.countedQty} ({signed(l.variance)}
                        {l.varianceValuePaise !== null ? `, ${rupees(l.varianceValuePaise)}` : ", no cost yet"})
                      </li>
                    ))}
                </ul>
                {buttons({ kind: "count", item: c })}
              </li>
            ))}
          </ul>
        </section>
      )}

      {requests && requests.length > 0 && (
        <section>
          <h2>Write-offs and releases</h2>
          <ul className="list">
            {requests.map((r) => (
              <li key={r.id} className="card">
                <div className="title">
                  <strong>{requestText(r)}</strong>
                </div>
                <span className="muted">
                  “{r.reason}” · asked by {r.requestedByName}
                </span>
                {buttons({ kind: "request", item: r })}
              </li>
            ))}
          </ul>
        </section>
      )}

      {open && (
        <DecideDialog
          title={TITLES[open.pending.kind][open.decision]}
          onCancel={() => setOpen(null)}
          onConfirm={async (reason) => {
            const { pending, decision } = open;
            const key = newKey();
            if (pending.kind === "receipt") await api.decideReceipt(storeId, pending.item.goodsReceiptId, decision, reason, key);
            if (pending.kind === "count") await api.decideCount(storeId, pending.item.stockCountId, decision, reason, key);
            if (pending.kind === "request") await api.decideRequest(storeId, pending.item.id, decision, reason, key);
            setOpen(null);
            setDone(outcome(pending, decision));
            await load();
          }}
        />
      )}
    </main>
  );
}

function DecideDialog(props: { title: string; onCancel: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const why = reason.trim();
    if (!why) return;
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(why);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the decision");
      setBusy(false);
    }
  };
  return (
    <div className="dialog" role="dialog" aria-label={props.title}>
      <form className="stack" onSubmit={submit}>
        <h2>{props.title}</h2>
        <label>
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? This is kept in the audit log" required autoFocus />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={props.onCancel}>
            Back
          </button>
          <button className="primary" disabled={busy || !reason.trim()}>
            {props.title}
          </button>
        </div>
      </form>
    </div>
  );
}
