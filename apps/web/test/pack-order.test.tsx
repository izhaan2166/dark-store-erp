import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError, type FulfilmentView } from "../src/api";
import { lineForScan, PackOrder } from "../src/screens/PackOrder";

type Line = FulfilmentView["lines"][number];

const line = (over: Partial<Line> = {}): Line => ({
  orderItemId: "item-1",
  lineNo: 1,
  productId: "milk",
  sku: "MILK-1L",
  name: "Milk 1L",
  requestedQty: 2,
  reservedQty: 0,
  pickedQty: 2,
  fulfilledQty: 0,
  openShortageQty: 0,
  substitutesItemId: null,
  tasks: [],
  ...over,
});

const view = (over: Partial<FulfilmentView> = {}): FulfilmentView => ({
  orderId: "order-1",
  status: "packing",
  lines: [line(), line({ orderItemId: "item-2", lineNo: 2, productId: "eggs", name: "Eggs", pickedQty: 0 })],
  openShortages: [],
  ...over,
});

const PRODUCTS: Record<string, string> = { "111": "milk", "222": "eggs", "333": "bread" };

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    fulfilment: vi.fn().mockResolvedValue(view()),
    product: vi.fn(async (_s: string, code: string) => {
      if (!PRODUCTS[code]) throw new ApiError(404, "not_found", "Product not found");
      return { productId: PRODUCTS[code], sku: code, name: code };
    }),
    ...overrides,
  } as unknown as Api;
}

async function scan(...codes: string[]) {
  const user = userEvent.setup();
  const box = await screen.findByLabelText("Scan each item into the bag");
  for (const code of codes) await user.type(box, `${code}{Enter}`);
}

describe("pack order screen", () => {
  it("counts a scan toward a line that still needs units", () => {
    const lines = [line(), line({ orderItemId: "item-3", lineNo: 3, pickedQty: 1 })];
    expect(lineForScan(lines, new Map(), "milk")).toMatchObject({ orderItemId: "item-1" });
    expect(lineForScan(lines, new Map([["item-1", 2]]), "milk")).toMatchObject({ orderItemId: "item-3" });
    expect(lineForScan(lines, new Map([["item-1", 2], ["item-3", 1]]), "milk")).toBe("full");
    expect(lineForScan(lines, new Map(), "bread")).toBeNull();
  });

  it("packs once every picked unit is scanned, sending zero for lines not going out", async () => {
    const pack = vi.fn().mockResolvedValue(view({ status: "ready_for_handover" }));
    const handover = vi.fn().mockResolvedValue(view({ status: "handed_over" }));
    render(<PackOrder api={fakeApi({ pack, handover })} storeId="s1" orderId="order-1" />);

    const packed = await screen.findByRole("button", { name: "Packed" });
    expect(packed).toBeDisabled();
    await scan("111", "111");
    await waitFor(() => expect(screen.getByLabelText("Milk 1L counted")).toHaveTextContent("2 / 2"));
    expect(screen.getByText(/Not going out: Eggs/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Packed" }));
    await waitFor(() =>
      expect(pack).toHaveBeenCalledWith(
        "s1",
        "order-1",
        [
          { orderItemId: "item-1", quantity: 2 },
          { orderItemId: "item-2", quantity: 0 },
        ],
        expect.any(String),
      ),
    );
    await user.click(await screen.findByRole("button", { name: "Hand over to rider" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Handed over");
    expect(handover).toHaveBeenCalledTimes(1);
  });

  it("refuses extra units and items that were not picked", async () => {
    render(<PackOrder api={fakeApi()} storeId="s1" orderId="order-1" />);
    await scan("111", "111", "111");
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many");
    await scan("333");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Wrong item"));
    await scan("999");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Unknown barcode 999"));
    expect(screen.getByLabelText("Milk 1L counted")).toHaveTextContent("2 / 2");
  });

  it("holds the order while a manager decides on missing items", async () => {
    const api = fakeApi({
      fulfilment: vi.fn().mockResolvedValue(
        view({ openShortages: [{ shortageId: "sh-1", orderItemId: "item-2", source: "short_pick", quantity: 2, escalatedAt: null }] }),
      ),
    });
    render(<PackOrder api={api} storeId="s1" orderId="order-1" />);
    expect(await screen.findByText("Waiting for a manager")).toBeInTheDocument();
    await scan("111", "111");
    await waitFor(() => expect(screen.getByLabelText("Milk 1L counted")).toHaveTextContent("2 / 2"));
    expect(screen.getByRole("button", { name: "Packed" })).toBeDisabled();
  });

  it("reloads the order when the server says it changed", async () => {
    const fulfilment = vi
      .fn()
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view({ status: "picking" }));
    const pack = vi.fn().mockRejectedValue(new ApiError(409, "fulfilment_blocked", "Resolve every shortage before packing"));
    render(<PackOrder api={fakeApi({ fulfilment, pack })} storeId="s1" orderId="order-1" />);
    await scan("111", "111");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Packed" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Resolve every shortage");
    expect(await screen.findByText("This order is still being picked.")).toBeInTheDocument();
  });
});
