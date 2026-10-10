import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type Api, ApiError, type Location, newKey, type NewLocation } from "../api";
import { href } from "../route";

type Message = { kind: "ok" | "error"; text: string };
type Purpose = NewLocation["purpose"];
type Kind = NewLocation["kind"];

const MAX_RANGE = 100;

const PURPOSES: { purpose: Purpose; title: string; label: string }[] = [
  { purpose: "storage", title: "Storage shelves", label: "Storage (stock for orders)" },
  { purpose: "receiving", title: "Unloading areas", label: "Unloading area (deliveries)" },
  { purpose: "packing", title: "Packing", label: "Packing" },
  { purpose: "quarantine", title: "Blocked stock areas", label: "Blocked stock area" },
];

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "bin", label: "Bin" },
  { kind: "shelf", label: "Shelf" },
  { kind: "rack", label: "Rack" },
  { kind: "zone", label: "Area" },
];

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * The codes from `first` up to the number `last`, keeping zero padding:
 * ("A-01-01", "12") gives A-01-01 … A-01-12. An empty `last` gives just
 * `first`. Null when the range is not valid or longer than 100.
 */
export function codeRange(first: string, last: string): string[] | null {
  const code = first.trim();
  if (!code) return null;
  if (!last.trim()) return [code];
  const match = /^(.*?)(\d+)$/.exec(code);
  if (!match || !/^\d+$/.test(last.trim())) return null;
  const [, prefix, digits] = match as unknown as [string, string, string];
  const start = Number(digits);
  const end = Number(last.trim());
  if (end < start || end - start + 1 > MAX_RANGE) return null;
  return Array.from({ length: end - start + 1 }, (_, i) => prefix + String(start + i).padStart(digits.length, "0"));
}

/** Store locations: add shelves (one or a numbered run), switch them off, and choose which hold stock for orders. */
export function Shelves(props: { api: Api; storeId: string }) {
  const { api, storeId } = props;
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [filter, setFilter] = useState("");
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setLocations(await api.locations(storeId));
    } catch (err) {
      setMessage({ kind: "error", text: errorText(err, "Could not load shelves") });
    }
  }, [api, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (location: Location, body: { status?: string; allocatable?: boolean }, done: string) => {
    setBusy(location.locationId);
    try {
      const updated = await api.updateLocation(storeId, location.locationId, body, newKey());
      setLocations((all) => all?.map((l) => (l.locationId === updated.locationId ? updated : l)) ?? null);
      setMessage({ kind: "ok", text: `${location.code}: ${done}` });
    } catch (err) {
      setMessage({ kind: "error", text: `${location.code}: ${errorText(err, "Could not save")}` });
    } finally {
      setBusy(null);
    }
  };

  const needle = filter.trim().toLowerCase();
  const shown = locations?.filter((l) => l.code.toLowerCase().includes(needle)) ?? [];

  return (
    <main>
      <header className="bar">
        <a href={href({ screen: "stores" })}>‹ Jobs</a>
        <h1>Shelves</h1>
        <button className="primary" onClick={() => setAdding(true)}>
          Add shelves
        </button>
      </header>
      {message && (
        <p className={message.kind === "ok" ? "ok" : "error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}
      <div className="search">
        <input aria-label="Find a shelf" placeholder="Shelf code" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {locations === null && !message && <p className="muted">Loading…</p>}
      {locations && shown.length === 0 && <p className="muted">{needle ? "No shelves match." : "No shelves yet."}</p>}

      {PURPOSES.map(({ purpose, title }) => {
        const group = shown.filter((l) => l.purpose === purpose);
        if (group.length === 0) return null;
        return (
          <section key={purpose}>
            <h2>{title}</h2>
            <ul className="list">
              {group.map((l) => {
                const active = l.status === "active";
                return (
                  <li key={l.locationId} className="row">
                    <strong>{l.code}</strong>
                    <span className="muted">{KINDS.find((k) => k.kind === l.kind)?.label ?? l.kind}</span>
                    {!active && <span className="tag warn">Turned off</span>}
                    {active && purpose === "storage" && !l.allocatable && <span className="tag warn">Not for orders</span>}
                    <div className="jobs">
                      {active && purpose === "storage" && (
                        <button
                          disabled={busy !== null}
                          onClick={() =>
                            void change(
                              l,
                              { allocatable: !l.allocatable },
                              l.allocatable ? "orders will no longer take stock from here" : "orders can take stock from here",
                            )
                          }
                        >
                          {l.allocatable ? "Stop using for orders" : "Use for orders"}
                        </button>
                      )}
                      <button
                        disabled={busy !== null}
                        onClick={() => void change(l, { status: active ? "inactive" : "active" }, active ? "turned off" : "turned on")}
                      >
                        {active ? "Turn off" : "Turn on"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {adding && (
        <AddDialog
          onCancel={() => setAdding(false)}
          onAdd={async (codes, body) => {
            const failed: string[] = [];
            for (const code of codes) {
              try {
                await api.createLocation(storeId, { ...body, code }, newKey());
              } catch (err) {
                failed.push(`${code}: ${errorText(err, "could not add")}`);
              }
            }
            const added = codes.length - failed.length;
            setAdding(false);
            setMessage(
              failed.length === 0
                ? { kind: "ok", text: added === 1 ? `Added ${codes[0]}` : `Added ${added} shelves, ${codes[0]} to ${codes[codes.length - 1]}` }
                : { kind: "error", text: `Added ${added} of ${codes.length}. ${failed.join("; ")}` },
            );
            await load();
          }}
        />
      )}
    </main>
  );
}

function AddDialog(props: { onCancel: () => void; onAdd: (codes: string[], body: Omit<NewLocation, "code">) => Promise<void> }) {
  const [code, setCode] = useState("");
  const [upTo, setUpTo] = useState("");
  const [purpose, setPurpose] = useState<Purpose>("storage");
  const [kind, setKind] = useState<Kind>("bin");
  const [forOrders, setForOrders] = useState(true);
  const [busy, setBusy] = useState(false);
  const codes = codeRange(code, upTo);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!codes) return;
    setBusy(true);
    await props.onAdd(codes, { purpose, kind, allocatable: purpose === "storage" && forOrders });
  };

  return (
    <div className="dialog" role="dialog" aria-label="Add shelves">
      <div className="sheet">
        <form className="stack" onSubmit={submit}>
          <h2>Add shelves</h2>
          <label>
            Code
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. A-01-01" required />
          </label>
          <label>
            Up to number (optional, to add a run)
            <input inputMode="numeric" value={upTo} onChange={(e) => setUpTo(e.target.value)} placeholder="e.g. 12" />
          </label>
          {code.trim() && (
            <p className={codes ? "muted" : "error"}>
              {codes === null
                ? `The code must end in a number, and a run can be at most ${MAX_RANGE} long.`
                : codes.length === 1
                  ? `Adds ${codes[0]}`
                  : `Adds ${codes.length}: ${codes[0]} to ${codes[codes.length - 1]}`}
            </p>
          )}
          <label>
            Used for
            <select value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>
              {PURPOSES.map((p) => (
                <option key={p.purpose} value={p.purpose}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          {purpose === "storage" && (
            <label className="choice">
              <input type="checkbox" checked={forOrders} onChange={(e) => setForOrders(e.target.checked)} />
              Orders can take stock from here
            </label>
          )}
          <div className="actions">
            <button type="button" onClick={props.onCancel} disabled={busy}>
              Cancel
            </button>
            <button className="primary" disabled={busy || !codes}>
              {busy ? "Adding…" : "Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
