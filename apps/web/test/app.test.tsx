import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/api";
import { App } from "../src/App";
import { saveSession } from "../src/session";

const STORE = { storeId: "s1", code: "DS01", name: "Pilot store" };
const session = (permissions: string[]): Session => ({
  token: "t1",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  user: { id: "u1", email: "priya@store.in", name: "Priya" },
  stores: [{ ...STORE, roles: [], permissions }],
});
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("app", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("picks up role changes made since sign-in", async () => {
    saveSession(session(["orders.pick", "orders.pack"]));
    const fetch = vi.fn().mockResolvedValue(answer(200, { user: session([]).user, stores: [{ ...STORE, roles: ["receiving_staff"], permissions: ["receiving.record"] }] }));
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    expect(await screen.findByRole("link", { name: "Receive deliveries" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Pick orders" })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/auth/me", expect.objectContaining({ method: "GET" }));
  });

  it("goes back to sign-in when the session was ended", async () => {
    saveSession(session(["orders.pick"]));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(401, { error: { code: "unauthenticated", message: "Your session has ended; sign in again" } })));
    render(<App />);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});
