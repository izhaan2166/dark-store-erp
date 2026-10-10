import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError, type OrderSummary, type Product } from "../src/api";
import { lineQuantity, NewOrder, Orders, shortText } from "../src/screens/Orders";

const MILK: Product = { productId: "milk", sku: "MILK-1L", name: "Milk 1L" };
const BREAD: Product = { productId: "bread", sku: "BREAD-W", name: "White bread" };
const BUN: Product = { productId: "bun", sku: "BUN-4", name: "Bun pack" };
const STOCK: Record<string, number> = { milk: 5, bread: 1, bun: 9 };

const order = (over: Partial<OrderSummary> = {}): OrderSummary => ({
  orderId: "o1",
  externalRef: "ZP-1001",
  status: "accepted",
  createdAt: "2026-10-10T09:30:00Z",
  lineCount: 2,
  requestedUnits: 3,
  pickedUnits: 0,
  openShortages: 0,
  ...over,
});

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    orders: vi.fn().mockResolvedValue([order(), order({ orderId: "o2", externalRef: "ZP-1002", status: "picking", openShortages: 1, pickedUnits: 1 })]),
    cancelOrder: vi.fn().mockResolvedValue({}),
    product: vi.fn(async (_s: string, code: string) => {
      if (code === "8901") return MILK;
      throw new ApiError(404, "not_found", "Unknown barcode");
    }),
    searchProducts: vi.fn(async (_s: string, q: string) => [MILK, BREAD, BUN].filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))),
    stock: vi.fn(async (_s: string, productId: string) => ({ productId, availableToPromise: STOCK[productId] ?? 0 })),
    acceptOrder: vi.fn(async (_s: string, body: { lines: { productId: string; quantity: number }[] }) => ({
      orderId: "new",
      status: "accepted",
      fullyReserved: body.lines.every((l) => l.quantity <= STOCK[l.productId]!),
      lines: body.lines.map((l) => ({
        productId: l.productId,
        requestedQty: l.quantity,
        reservedQty: Math.min(l.quantity, STOCK[l.productId]!),
        shortQty: Math.max(0, l.quantity - STOCK[l.productId]!),
      })),
    })),
    ...overrides,
  } as unknown as Api;
}

describe("order helpers", () => {
  it("accepts only whole quantities from 1 to 10,000", () => {
    expect(lineQuantity("3")).toBe(3);
    expect(lineQuantity("")).toBeNull();
    expect(lineQuantity("0")).toBeNull();
    expect(lineQuantity("1.5")).toBeNull();
    expect(lineQuantity("10001")).toBeNull();
  });

  it("names what could not be reserved", () => {
    const names = new Map([["bread", "White bread"]]);
    const lines = [
      { productId: "milk", requestedQty: 2, reservedQty: 2, shortQty: 0 },
      { productId: "bread", requestedQty: 3, reservedQty: 1, shortQty: 2 },
    ];
    expect(shortText({ orderId: "o", status: "accepted", fullyReserved: false, lines }, names)).toBe("2 × White bread");
    expect(shortText({ orderId: "o", status: "accepted", fullyReserved: true, lines: [lines[0]!] }, names)).toBeNull();
  });
});

describe("new order screen", () => {
  it("adds scanned items, counts repeat scans, and saves the order", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<NewOrder api={api} storeId="s1" />);
    await user.type(screen.getByLabelText("Order number"), "ZP-2001");
    const scan = screen.getByLabelText("Add an item");
    await user.type(scan, "8901{Enter}");
    await user.type(scan, "8901{Enter}");
    expect(await screen.findByLabelText("How many Milk 1L")).toHaveValue(2);
    expect(await screen.findByText("5 free")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save order" }));
    await waitFor(() =>
      expect(api.acceptOrder).toHaveBeenCalledWith("s1", { externalRef: "ZP-2001", lines: [{ productId: "milk", quantity: 2 }] }, expect.any(String)),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Order ZP-2001 saved. Everything is reserved");
    expect(screen.getByLabelText("Order number")).toHaveValue("");
    expect(screen.queryByLabelText("How many Milk 1L")).not.toBeInTheDocument();
  });

  it("searches by name, warns before saving more than is free, and says what is missing", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<NewOrder api={api} storeId="s1" />);
    await user.type(screen.getByLabelText("Order number"), "PHONE-7");
    await user.type(screen.getByLabelText("Add an item"), "b{Enter}");
    const matches = await screen.findByRole("list", { name: "Matching items" });
    await user.click(within(within(matches).getByText("White bread").closest("li")!).getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("list", { name: "Matching items" })).not.toBeInTheDocument();

    const qty = await screen.findByLabelText("How many White bread");
    await user.clear(qty);
    await user.type(qty, "3");
    expect(await screen.findByText("Only 1 free; 2 will be missing")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save order" }));
    expect(await screen.findByRole("status")).toHaveTextContent("short of 2 × White bread");
  });

  it("will not save without an order number or with a bad quantity", async () => {
    const user = userEvent.setup();
    render(<NewOrder api={fakeApi()} storeId="s1" />);
    await user.type(screen.getByLabelText("Add an item"), "8901{Enter}");
    const save = screen.getByRole("button", { name: "Save order" });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Order number"), "ZP-1");
    expect(save).toBeEnabled();
    await user.clear(await screen.findByLabelText("How many Milk 1L"));
    expect(save).toBeDisabled();
  });

  it("reuses the key when the same order is sent again, and makes a new one after an edit", async () => {
    const acceptOrder = vi.fn().mockRejectedValue(new ApiError(0, "offline", "No connection. Check the Wi-Fi and try again."));
    const api = fakeApi({ acceptOrder });
    const user = userEvent.setup();
    render(<NewOrder api={api} storeId="s1" />);
    await user.type(screen.getByLabelText("Order number"), "ZP-9");
    await user.type(screen.getByLabelText("Add an item"), "8901{Enter}");
    await screen.findByLabelText("How many Milk 1L");
    const save = screen.getByRole("button", { name: "Save order" });
    await user.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent("No connection");
    await user.click(save);
    await waitFor(() => expect(acceptOrder).toHaveBeenCalledTimes(2));
    expect(acceptOrder.mock.calls[1]![2]).toBe(acceptOrder.mock.calls[0]![2]);

    await user.type(screen.getByLabelText("Order number"), "0");
    await user.click(save);
    await waitFor(() => expect(acceptOrder).toHaveBeenCalledTimes(3));
    expect(acceptOrder.mock.calls[2]![2]).not.toBe(acceptOrder.mock.calls[0]![2]);
  });

  it("says when nothing matches and when the order number is taken", async () => {
    const api = fakeApi({ acceptOrder: vi.fn().mockRejectedValue(new ApiError(409, "duplicate_order", "An order with this external reference already exists")) });
    const user = userEvent.setup();
    render(<NewOrder api={api} storeId="s1" />);
    await user.type(screen.getByLabelText("Add an item"), "zzz{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing matches “zzz”");
    await user.type(screen.getByLabelText("Add an item"), "milk{Enter}");
    await screen.findByLabelText("How many Milk 1L");
    await user.type(screen.getByLabelText("Order number"), "ZP-1001");
    await user.click(screen.getByRole("button", { name: "Save order" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("An order with this external reference already exists");
    expect(screen.getByLabelText("Order number")).toHaveValue("ZP-1001");
  });
});

describe("orders screen", () => {
  it("lists open orders and cancels one with a reason", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Orders api={api} storeId="s1" canCancel />);
    const first = (await screen.findByText("ZP-1001")).closest("li") as HTMLElement;
    expect(first).toHaveTextContent("Waiting to pick");
    expect(screen.getByText("ZP-1002").closest("li")).toHaveTextContent("1 missing");
    await user.click(within(first).getByRole("button", { name: "Cancel" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel ZP-1001" });
    const confirm = within(dialog).getByRole("button", { name: "Cancel order" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Reason"), "Customer called to cancel");
    await user.click(confirm);
    await waitFor(() => expect(api.cancelOrder).toHaveBeenCalledWith("s1", "o1", "Customer called to cancel", expect.any(String)));
    expect(await screen.findByRole("status")).toHaveTextContent("Order ZP-1001 cancelled");
  });

  it("shows the server's reason when an order cannot be cancelled, and hides Cancel without the permission", async () => {
    const api = fakeApi({ cancelOrder: vi.fn().mockRejectedValue(new ApiError(409, "invalid_state", "Picked units must be returned first")) });
    const user = userEvent.setup();
    const { unmount } = render(<Orders api={api} storeId="s1" canCancel />);
    const second = (await screen.findByText("ZP-1002")).closest("li") as HTMLElement;
    await user.click(within(second).getByRole("button", { name: "Cancel" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Reason"), "Out of stock");
    await user.click(within(dialog).getByRole("button", { name: "Cancel order" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Picked units must be returned first");
    unmount();

    render(<Orders api={fakeApi()} storeId="s1" canCancel={false} />);
    await screen.findByText("ZP-1001");
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });
});
