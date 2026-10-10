import type { Session } from "../api";
import { href } from "../route";

const JOB_PERMISSIONS = ["orders.pick", "orders.pack", "orders.resolve_shortage", "receiving.record", "inventory.putaway", "inventory.count", "inventory.adjust", "inventory.approve_request", "catalog.manage", "locations.manage"];

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
          <div className="jobs">
            {store.permissions.includes("orders.pick") && (
              <a className="button primary" href={href({ screen: "queue", job: "pick", storeId: store.storeId })}>
                Pick orders
              </a>
            )}
            {store.permissions.includes("orders.pack") && (
              <a className="button primary" href={href({ screen: "queue", job: "pack", storeId: store.storeId })}>
                Pack orders
              </a>
            )}
            {store.permissions.includes("receiving.record") && (
              <a className="button primary" href={href({ screen: "receive", storeId: store.storeId })}>
                Receive deliveries
              </a>
            )}
            {store.permissions.includes("inventory.putaway") && (
              <a className="button primary" href={href({ screen: "putaway", storeId: store.storeId })}>
                Put away
              </a>
            )}
            {store.permissions.includes("inventory.count") && (
              <a className="button primary" href={href({ screen: "count", storeId: store.storeId })}>
                Count stock
              </a>
            )}
            {store.permissions.includes("inventory.adjust") && (
              <a className="button" href={href({ screen: "stock", storeId: store.storeId })}>
                Problem stock
              </a>
            )}
            {store.permissions.includes("inventory.approve_request") && (
              <a className="button" href={href({ screen: "approvals", storeId: store.storeId })}>
                Approvals
              </a>
            )}
            {store.permissions.includes("orders.resolve_shortage") && (
              <a className="button" href={href({ screen: "shortages", storeId: store.storeId })}>
                Missing items
              </a>
            )}
            {store.permissions.includes("catalog.manage") && (
              <a className="button" href={href({ screen: "products", storeId: store.storeId })}>
                Products
              </a>
            )}
            {store.permissions.includes("locations.manage") && (
              <a className="button" href={href({ screen: "shelves", storeId: store.storeId })}>
                Shelves
              </a>
            )}
            {!JOB_PERMISSIONS.some((p) => store.permissions.includes(p)) && (
              <p className="muted">Screens for your role are coming soon.</p>
            )}
          </div>
        </section>
      ))}
    </main>
  );
}
