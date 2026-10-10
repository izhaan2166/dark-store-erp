import { useMemo, useState } from "react";
import { Api, type Session } from "./api";
import { useRoute } from "./route";
import { PickOrder } from "./screens/PickOrder";
import { PickQueue } from "./screens/PickQueue";
import { SignIn } from "./screens/SignIn";
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
  const canPick = store?.permissions.includes("orders.pick") ?? false;

  return (
    <>
      <div className="who">
        <span>
          {session.user.name}
          {store && ` · ${store.name}`}
        </span>
        <button onClick={() => void api.logout().catch(() => {}).finally(signOut)}>Sign out</button>
      </div>
      {route.screen === "stores" || !canPick ? (
        <Stores session={session} />
      ) : route.screen === "queue" ? (
        <PickQueue api={api} storeId={route.storeId} />
      ) : (
        <PickOrder key={route.orderId} api={api} storeId={route.storeId} orderId={route.orderId} />
      )}
    </>
  );
}
