import type { Session } from "../api";
import { href } from "../route";

/** Where the user works. Only the jobs their roles allow are offered. */
export function Stores(props: { session: Session }) {
  const { stores } = props.session;
  if (stores.length === 0) {
    return (
      <main className="narrow">
        <p>You have no role in any store yet. Ask a Store Manager to add you.</p>
      </main>
    );
  }
  return (
    <main className="narrow">
      <h1>Choose a job</h1>
      {stores.map((store) => (
        <section key={store.storeId} className="card">
          <h2>
            {store.name} <span className="muted">{store.code}</span>
          </h2>
          {store.permissions.includes("orders.pick") ? (
            <a className="button primary" href={href({ screen: "queue", storeId: store.storeId })}>
              Pick orders
            </a>
          ) : (
            <p className="muted">Screens for your role are coming soon.</p>
          )}
        </section>
      ))}
    </main>
  );
}
