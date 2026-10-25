import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { type Api, ApiError, newKey, type StaffMember, type StaffRole } from "../api";
import { href } from "../route";

/** The roles a Store Manager can give, with what each lets a person do. */
export const ROLES: { role: StaffRole; label: string; does: string }[] = [
  { role: "picker", label: "Picker", does: "picks orders" },
  { role: "packer", label: "Packer", does: "packs orders and hands them to riders" },
  { role: "receiving_staff", label: "Receiving", does: "receives deliveries and puts stock away" },
  { role: "inventory_manager", label: "Inventory Manager", does: "products, shelves, purchase orders, counts and problem stock" },
  { role: "auditor", label: "Auditor", does: "sees stock, orders and the dashboard, changes nothing" },
  { role: "store_manager", label: "Store Manager", does: "everything, including approvals and staff" },
];

export const roleLabel = (role: StaffRole) => ROLES.find((r) => r.role === role)?.label ?? (role === "super_admin" ? "Admin" : role);

const MIN_PASSWORD = 10;
const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

type Editing = { kind: "add" } | { kind: "roles"; person: StaffMember } | { kind: "password"; person: StaffMember };

/**
 * The Store Manager's list of who works in the store: add a person with a
 * first password, change what they may do, give a new password, or remove
 * them from the store. Changes apply on the person's next tap.
 */
export function Staff(props: { api: Api; storeId: string; meId: string }) {
  const { api, storeId } = props;
  const [people, setPeople] = useState<StaffMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const load = useCallback(async () => {
    try {
      setPeople(await api.staff(storeId));
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not load staff"));
    }
  }, [api, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const finish = async (message: string) => {
    setEditing(null);
    setDone(message);
    await load();
  };

  return (
    <main>
      <header className="bar">
        <a href={href({ screen: "stores" })}>‹ Jobs</a>
        <h1>Staff</h1>
        <button className="primary" onClick={() => setEditing({ kind: "add" })}>
          Add person
        </button>
      </header>
      {done && <p className="ok" role="status">{done}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {people === null && !error && <p className="muted">Loading…</p>}
      <ul className="list" aria-label="People in this store">
        {people?.map((p) => (
          <li key={p.userId} className="row">
            <strong>{p.name}</strong>
            <span className="muted">{p.email}</span>
            <span className="tags">
              {p.roles.map((r) => (
                <span key={r} className="tag">
                  {roleLabel(r)}
                </span>
              ))}
            </span>
            {p.editable ? (
              <span className="jobs">
                <button onClick={() => setEditing({ kind: "roles", person: p })}>Change roles</button>
                <button onClick={() => setEditing({ kind: "password", person: p })}>New password</button>
              </span>
            ) : (
              <span className="muted">{p.userId === props.meId ? "This is you. Another Store Manager can change your access." : "Only an admin can change this person"}</span>
            )}
          </li>
        ))}
      </ul>

      {editing?.kind === "add" && (
        <AddDialog
          onCancel={() => setEditing(null)}
          onSave={async (body) => {
            const person = await api.addStaff(storeId, body, newKey());
            await finish(`${person.name} added. They can sign in with ${person.email} and the password you gave.`);
          }}
        />
      )}
      {editing?.kind === "roles" && (
        <RolesDialog
          person={editing.person}
          onCancel={() => setEditing(null)}
          onSave={async (roles, key) => {
            const person = await api.setStaffRoles(storeId, editing.person.userId, roles, key);
            await finish(person ? `${person.name} is now ${person.roles.map(roleLabel).join(", ")}.` : `${editing.person.name} was removed from this store.`);
          }}
        />
      )}
      {editing?.kind === "password" && (
        <PasswordDialog
          person={editing.person}
          onCancel={() => setEditing(null)}
          onSave={async (password, key) => {
            await api.setStaffPassword(storeId, editing.person.userId, password, key);
            await finish(`${editing.person.name} has a new password and was signed out everywhere.`);
          }}
        />
      )}
    </main>
  );
}

function RoleChoices(props: { chosen: StaffRole[]; onChange: (roles: StaffRole[]) => void }) {
  return (
    <fieldset>
      <legend>What they do</legend>
      {ROLES.map((r) => (
        <label key={r.role} className="choice">
          <input
            type="checkbox"
            checked={props.chosen.includes(r.role)}
            onChange={(e) => props.onChange(e.target.checked ? [...props.chosen, r.role] : props.chosen.filter((x) => x !== r.role))}
          />
          <span>
            <strong>{r.label}</strong> <span className="muted">{r.does}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Saves through `onSave`, showing its error in the dialog and keeping the dialog open. */
function useSave() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (save: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await save();
    } catch (err) {
      setError(errorText(err, fallback));
      setBusy(false);
    }
  };
  return { error, busy, run };
}

function AddDialog(props: { onCancel: () => void; onSave: (body: { name: string; email: string; password: string; roles: StaffRole[] }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const { error, busy, run } = useSave();
  const valid = name.trim() !== "" && /^\S+@\S+\.\S+$/.test(email.trim()) && password.length >= MIN_PASSWORD && roles.length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) void run(() => props.onSave({ name: name.trim(), email: email.trim(), password, roles }), "Could not add the person");
  };
  return (
    <div className="dialog" role="dialog" aria-label="Add person">
      <div className="sheet">
        <form className="stack" onSubmit={submit}>
          <h2>Add person</h2>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          </label>
          <label>
            Email (they sign in with it)
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <PasswordInput value={password} onChange={setPassword} label="First password" />
          <RoleChoices chosen={roles} onChange={setRoles} />
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button type="button" onClick={props.onCancel}>
              Cancel
            </button>
            <button className="primary" disabled={busy || !valid}>
              Add person
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RolesDialog(props: { person: StaffMember; onCancel: () => void; onSave: (roles: StaffRole[], key: string) => Promise<void> }) {
  const { person } = props;
  const [roles, setRoles] = useState<StaffRole[]>(person.roles);
  const [removing, setRemoving] = useState(false);
  const { error, busy, run } = useSave();
  // One key per choice of roles, so a resend after a lost reply is not applied twice.
  const key = useRef(newKey());
  const change = (next: StaffRole[]) => {
    key.current = newKey();
    setRemoving(false);
    setRoles(next);
  };
  const unchanged = [...roles].sort().join() === [...person.roles].sort().join();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (roles.length > 0 && !unchanged) void run(() => props.onSave(roles, key.current), "Could not change the roles");
  };
  return (
    <div className="dialog" role="dialog" aria-label={`Roles of ${person.name}`}>
      <div className="sheet">
        <form className="stack" onSubmit={submit}>
          <h2>{person.name}</h2>
          <RoleChoices chosen={roles} onChange={change} />
          {error && <p className="error" role="alert">{error}</p>}
          {removing ? (
            <div className="card warn stack">
              <span>
                Remove {person.name} from this store? They will not be able to do anything here until a manager adds them back.
              </span>
              <div className="actions">
                <button type="button" onClick={() => setRemoving(false)}>
                  Keep
                </button>
                <button type="button" className="primary" disabled={busy} onClick={() => void run(() => props.onSave([], key.current), "Could not remove the person")}>
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <div className="actions">
              <button
                type="button"
                onClick={() => {
                  key.current = newKey();
                  setRemoving(true);
                }}
              >
                Remove from store
              </button>
              <button type="button" onClick={props.onCancel}>
                Cancel
              </button>
              <button className="primary" disabled={busy || roles.length === 0 || unchanged}>
                Save roles
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

function PasswordDialog(props: { person: StaffMember; onCancel: () => void; onSave: (password: string, key: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const { error, busy, run } = useSave();
  const key = useRef(newKey());
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password.length >= MIN_PASSWORD) void run(() => props.onSave(password, key.current), "Could not set the password");
  };
  return (
    <div className="dialog" role="dialog" aria-label={`New password for ${props.person.name}`}>
      <form className="stack" onSubmit={submit}>
        <h2>New password for {props.person.name}</h2>
        <PasswordInput
          value={password}
          onChange={(next) => {
            key.current = newKey();
            setPassword(next);
          }}
          label="New password"
        />
        <p className="muted">They will be signed out on every phone and must sign in with this password.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={busy || password.length < MIN_PASSWORD}>
            Set password
          </button>
        </div>
      </form>
    </div>
  );
}

function PasswordInput(props: { value: string; onChange: (value: string) => void; label: string }) {
  const short = props.value.length > 0 && props.value.length < MIN_PASSWORD;
  return (
    <label>
      {props.label}
      <input type="text" autoComplete="new-password" spellCheck={false} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      <span className={short ? "tag warn" : "muted"}>At least {MIN_PASSWORD} characters. Tell the person in private.</span>
    </label>
  );
}
