import { useMemo, useState } from "react";
import { Api, type Session } from "./api";
import { permissionFor, useRoute } from "./route";
import { OrderQueue } from "./screens/OrderQueue";
import { PackOrder } from "./screens/PackOrder";
import { PickOrder } from "./screens/PickOrder";
import { Products } from "./screens/Products";
import { Putaway } from "./screens/Putaway";
import { NewPurchaseOrder } from "./screens/NewPurchaseOrder";
import { ReceiveList } from "./screens/ReceiveList";
import { ReceiveOrder } from "./screens/ReceiveOrder";
import { Shelves } from "./screens/Shelves";
import { Shortages } from "./screens/Shortages";
import { SignIn } from "./screens/SignIn";
import { Approvals } from "./screens/Approvals";
import { Dashboard } from "./screens/Dashboard";
import { CountShelf, CountStart } from "./screens/StockCount";
import { StockControl } from "./screens/StockControl";
import { Stores } from "./screens/Stores";
import { loadSession, saveSession } from "./session";

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const route = useRoute();

  const signOut = () => {
    saveSession(null);
    setSession(null);
  };
  const api = useMemo(() => new Api(session?.token ?? null, signOut), [session]);

  if (!session) {
    return (
      <SignIn
        onSignedIn={(s) => {
          saveSession(s);
          setSession(s);
        }}
      />
    );
  }

  const store = "storeId" in route ? session.stores.find((s) => s.storeId === route.storeId) : undefined;
  const needs = permissionFor(route);
  const allowed = needs !== null && (store?.permissions.includes(needs) ?? false);

  return (
    <>
      <div className="who">
        <span>
          {session.user.name}
          {store && ` · ${store.name}`}
        </span>
        <button onClick={() => void api.logout().catch(() => {}).finally(signOut)}>Sign out</button>
      </div>
      {route.screen === "stores" || !allowed ? (
        <Stores session={session} />
      ) : route.screen === "shortages" ? (
        <Shortages api={api} storeId={route.storeId} />
      ) : route.screen === "receive" ? (
        <ReceiveList api={api} storeId={route.storeId} canOrder={store?.permissions.includes("purchasing.manage") ?? false} />
      ) : route.screen === "new-purchase-order" ? (
        <NewPurchaseOrder api={api} storeId={route.storeId} />
      ) : route.screen === "receipt" ? (
        <ReceiveOrder key={route.purchaseOrderId} api={api} storeId={route.storeId} purchaseOrderId={route.purchaseOrderId} />
      ) : route.screen === "putaway" ? (
        <Putaway api={api} storeId={route.storeId} />
      ) : route.screen === "count" ? (
        <CountStart api={api} storeId={route.storeId} />
      ) : route.screen === "approvals" ? (
        <Approvals api={api} storeId={route.storeId} />
      ) : route.screen === "stock" ? (
        <StockControl api={api} storeId={route.storeId} />
      ) : route.screen === "dashboard" ? (
        <Dashboard api={api} storeId={route.storeId} permissions={store?.permissions ?? []} />
      ) : route.screen === "products" ? (
        <Products api={api} storeId={route.storeId} />
      ) : route.screen === "shelves" ? (
        <Shelves api={api} storeId={route.storeId} />
      ) : route.screen === "shelf" ? (
        <CountShelf key={route.locationId} api={api} storeId={route.storeId} locationId={route.locationId} />
      ) : route.screen === "queue" ? (
        <OrderQueue key={route.job} api={api} storeId={route.storeId} job={route.job} />
      ) : route.job === "pick" ? (
        <PickOrder key={route.orderId} api={api} storeId={route.storeId} orderId={route.orderId} />
      ) : (
        <PackOrder key={route.orderId} api={api} storeId={route.storeId} orderId={route.orderId} />
      )}
    </>
  );
}
