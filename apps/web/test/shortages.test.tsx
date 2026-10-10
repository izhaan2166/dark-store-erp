import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError, type OpenShortage } from "../src/api";
import { minutesSince, Shortages } from "../src/screens/Shortages";

const shortage = (over: Partial<OpenShortage> = {}): OpenShortage => ({
  shortageId: "short-1",
  orderId: "order-1",
  externalRef: "ZP-1001",
  orderStatus: "picking",
  orderItemId: "item-1",
  productId: "milk",
  sku: "MILK-1L",
  name: "Milk 1L",
  source: "short_pick",
  quantity: 2,
  createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  escalatedAt: null,
  ...over,
});

const LATE = shortage({
  shortageId: "short-2",
  orderId: "order-2",
  externalRef: "ZP-1002",
  productId: "eggs",
  name: "Eggs",
  quantity: 1,
  source: "reservation",
  escalatedAt: new Date().toISOString(),
});

const STOCK: Record<string, number> = { milk: 5, eggs: 0, butter: 7, ghee: 3, paneer: 0 };

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    shortages: vi.fn().mockResolvedValue([LATE, shortage()]),
    stock: vi.fn(async (_s: string, productId: string) => ({ productId, availableToPromise: STOCK[productId] ?? 0 })),
    resolveShortage: vi.fn().mockResolvedValue({}),
    searchProducts: vi.fn().mockResolvedValue([
      { productId: "milk", sku: "MILK-1L", name: "Milk 1L" },
      { productId: "butter", sku: "BUT-100", name: "Butter 100g" },
      { productId: "ghee", sku: "GHEE-200", name: "Ghee 200g" },
      { productId: "paneer", sku: "PAN-200", name: "Paneer 200g" },
    ]),
    ...overrides,
  } as unknown as Api;
}

const card = async (name: string) => (await screen.findByText(name, { exact: false })).closest("li")!;

describe("missing items screen", () => {
  it("counts whole minutes and never goes negative", () => {
    const now = Date.parse("2026-10-10T10:00:00Z");
    expect(minutesSince("2026-10-10T09:47:30Z", now)).toBe(12);
    expect(minutesSince("2026-10-10T10:05:00Z", now)).toBe(0);
  });

  it("lists late items first with the order, the cause and how much stock is free", async () => {
    render(<Shortages api={fakeApi()} storeId="s1" />);
    const items = await screen.findAllByRole("listitem");
    expect(items[0]).toHaveTextContent("1 × Eggs");
    expect(items[0]).toHaveTextContent("Late");
    expect(items[1]).toHaveTextContent("2 × Milk 1L");
    expect(items[1]).toHaveTextContent("Order ZP-1001 · Picker couldn't find it · waiting 12 min");
    await waitFor(() => expect(items[1]).toHaveTextContent("5 more in stock"));
    expect(items[1]).not.toHaveTextContent("Late");
  });

  it("only offers to reserve again when enough stock is free", async () => {
    render(<Shortages api={fakeApi()} storeId="s1" />);
    const eggs = await card("1 × Eggs");
    await waitFor(() => expect(within(eggs).getByRole("button", { name: "Reserve again" })).toBeDisabled());
    expect(within(await card("2 × Milk 1L")).getByRole("button", { name: "Reserve again" })).toBeEnabled();
  });

  it("reserves again with a reason and refreshes the list", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Shortages api={api} storeId="s1" />);
    const milk = await card("2 × Milk 1L");
    await waitFor(() => expect(within(milk).getByRole("button", { name: "Reserve again" })).toBeEnabled());
    await user.click(within(milk).getByRole("button", { name: "Reserve again" }));
    const dialog = screen.getByRole("dialog", { name: "Reserve again" });
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));

    expect(api.resolveShortage).toHaveBeenCalledWith(
      "s1",
      "order-1",
      "short-1",
      { resolution: "reallocate", reason: "More stock is on the shelf" },
      expect.any(String),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Reserved 2 × Milk 1L again for order ZP-1001");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.shortages).toHaveBeenCalledTimes(2);
  });

  it("sends the order without the item, using the reason the manager typed", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Shortages api={api} storeId="s1" />);
    await user.click(within(await card("1 × Eggs")).getByRole("button", { name: "Send without it" }));
    const reason = screen.getByLabelText("Reason");
    await user.clear(reason);
    await user.type(reason, "Customer cancelled the eggs");
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(api.resolveShortage).toHaveBeenCalledWith(
      "s1",
      "order-2",
      "short-2",
      { resolution: "remove", reason: "Customer cancelled the eggs" },
      expect.any(String),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Order ZP-1002 goes without Eggs");
  });

  it("substitutes a searched product, leaving out the missing one itself", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Shortages api={api} storeId="s1" />);
    await user.click(within(await card("2 × Milk 1L")).getByRole("button", { name: "Substitute" }));
    const dialog = screen.getByRole("dialog", { name: "Substitute" });

    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Choose the product to send instead");
    expect(api.resolveShortage).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText("Search products"), "dairy{Enter}");
    expect(api.searchProducts).toHaveBeenCalledWith("s1", "dairy");
    const options = await within(dialog).findAllByRole("radio");
    expect(options).toHaveLength(3);
    expect(within(dialog).getByLabelText(/Paneer 200g/)).toBeDisabled();
    expect(within(dialog).queryByText(/^Milk 1L/)).toBeNull();
    expect(within(dialog).getByText(/Butter 100g/).closest("label")).toHaveTextContent("7 in stock");

    await user.click(within(dialog).getByLabelText(/Ghee 200g/));
    const howMany = within(dialog).getByLabelText("How many to send");
    await user.clear(howMany);
    await user.type(howMany, "1");
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));

    expect(api.resolveShortage).toHaveBeenCalledWith(
      "s1",
      "order-1",
      "short-1",
      { resolution: "substitute", reason: "Customer accepted the substitute", substituteProductId: "ghee", quantity: 1 },
      expect.any(String),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Order ZP-1001 gets 1 × Ghee 200g instead");
  });

  it("keeps the dialog open and shows the server's reason when a decision fails", async () => {
    const api = fakeApi({
      resolveShortage: vi.fn().mockRejectedValue(new ApiError(409, "insufficient_stock", "Not enough sellable stock")),
    });
    const user = userEvent.setup();
    render(<Shortages api={api} storeId="s1" />);
    await user.click(within(await card("1 × Eggs")).getByRole("button", { name: "Send without it" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Not enough sellable stock");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says so when nothing is missing", async () => {
    render(<Shortages api={fakeApi({ shortages: vi.fn().mockResolvedValue([]) })} storeId="s1" />);
    expect(await screen.findByText("Nothing is missing right now.")).toBeInTheDocument();
  });
});
