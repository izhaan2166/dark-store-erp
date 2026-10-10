import { afterEach, describe, expect, it, vi } from "vitest";
import { Api, ApiError } from "../src/api";

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("api client", () => {
  it("sends the token and the idempotency key under /api", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { orderId: "o1", status: "picking", lines: [], openShortages: [] }));
    vi.stubGlobal("fetch", fetch);
    await new Api("tok").startPicking("s1", "o1", "key-1");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/stores/s1/orders/o1/start-picking");
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok", "Idempotency-Key": "key-1" });
  });

  it("retries a write once with the same key when the network drops", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(json(200, { orderId: "o1" }));
    vi.stubGlobal("fetch", fetch);
    await new Api("tok").pick("s1", "o1", { orderItemId: "i1", locationId: "l1", barcode: "B1", quantity: 1 }, "key-2");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => init.headers["Idempotency-Key"])).toEqual(["key-2", "key-2"]);
  });

  it("turns API errors into readable messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(422, { error: { code: "wrong_item", message: "That barcode is not this item" } })),
    );
    const err = await new Api("tok").fulfilment("s1", "o1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: "wrong_item", message: "That barcode is not this item" });
  });

  it("signs the user out when the session has ended", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(401, { error: { code: "unauthenticated", message: "Sign in again" } })));
    const signedOut = vi.fn();
    await expect(new Api("old", signedOut).orders("s1")).rejects.toThrow("Sign in again");
    expect(signedOut).toHaveBeenCalled();
  });
});
