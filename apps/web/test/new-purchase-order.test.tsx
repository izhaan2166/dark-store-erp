import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError, type NewPurchaseOrder as Body, type Product } from "../src/api";
import { money, NewPurchaseOrder, orderQuantity, paiseFrom } from "../src/screens/NewPurchaseOrder";

const MILK: Product = { productId: "milk", sku: "MILK-1L", name: "Milk 1L" };
const RICE: Product = { productId: "rice", sku: "RICE-5", name: "Rice 5kg" };
const FARMS = { supplierId: "sup-1", code: "FRESH", name: "Fresh Farms" };
const MANDI = { supplierId: "sup-2", code: "MANDI", name: "Veg Mandi" };

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    suppliers: vi.fn().mockResolvedValue([FARMS, MANDI]),
    createSupplier: vi.fn().mockResolvedValue({ supplierId: "sup-3" }),
    product: vi.fn(async (_s: string, code: string) => {
      if (code === "8901") return MILK;
      throw new ApiError(404, "not_found", "Unknown barcode");
    }),
    searchProducts: vi.fn(async (_s: string, q: string) => [MILK, RICE].filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))),
    createPurchaseOrder: vi.fn(async (_s: string, body: Body) => ({ purchaseOrderId: "po", poNumber: body.poNumber })),
    ...overrides,
  } as unknown as Api;
}

describe("purchase order helpers", () => {
  it("reads rupees with up to two decimals as paise", () => {
    expect(paiseFrom("42")).toBe(4200);
    expect(paiseFrom("42.5")).toBe(4250);
    expect(paiseFrom("0.05")).toBe(5);
    expect(paiseFrom("0")).toBe(0);
    expect(paiseFrom("")).toBeNull();
    expect(paiseFrom("4.555")).toBeNull();
    expect(paiseFrom("-3")).toBeNull();
    expect(paiseFrom("₹4")).toBeNull();
  });

  it("accepts whole quantities and writes money the Indian way", () => {
    expect(orderQuantity("12")).toBe(12);
    expect(orderQuantity("0")).toBeNull();
    expect(orderQuantity("2.5")).toBeNull();
    expect(money(12345678)).toBe("₹1,23,456.78");
  });
});

describe("new purchase order screen", () => {
  it("saves a purchase order with quantities and costs, then clears for the next one", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<NewPurchaseOrder api={api} storeId="s1" />);
    await screen.findByRole("option", { name: "Veg Mandi" });
    await user.selectOptions(screen.getByLabelText("Supplier"), "sup-1");
    await user.type(screen.getByLabelText("Purchase order number"), "PO-1042");
    const scan = screen.getByLabelText("Add an item");
    await user.type(scan, "8901{Enter}8901{Enter}");
    await user.type(scan, "rice{Enter}");
    const milkQty = await screen.findByLabelText("How many Milk 1L");
    expect(milkQty).toHaveValue(2);
    await user.clear(milkQty);
    await user.type(milkQty, "24");
    await user.type(screen.getByLabelText("Cost of one Milk 1L"), "31.50");
    const save = screen.getByRole("button", { name: "Save purchase order" });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Cost of one Rice 5kg"), "410");
    expect(screen.getByText("Total ₹1,166.00")).toBeInTheDocument();
    await user.click(save);

    await waitFor(() =>
      expect(api.createPurchaseOrder).toHaveBeenCalledWith(
        "s1",
        {
          supplierId: "sup-1",
          poNumber: "PO-1042",
          lines: [
            { productId: "milk", quantity: 24, unitCostPaise: 3150 },
            { productId: "rice", quantity: 1, unitCostPaise: 41000 },
          ],
        },
        expect.any(String),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Purchase order PO-1042 saved for Fresh Farms: 2 items, ₹1,166.00");
    expect(screen.queryByRole("list", { name: "Items on the purchase order" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Supplier")).toHaveValue("sup-1");
  });

  it("flags a cost that is not in rupees", async () => {
    const user = userEvent.setup();
    render(<NewPurchaseOrder api={fakeApi()} storeId="s1" />);
    await user.type(screen.getByLabelText("Add an item"), "8901{Enter}");
    await user.type(await screen.findByLabelText("Cost of one Milk 1L"), "31.505");
    expect(screen.getByText("Use rupees, like 42.50")).toBeInTheDocument();
  });

  it("adds a supplier and chooses it", async () => {
    const suppliers = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([{ supplierId: "sup-3", code: "AMUL", name: "Amul Dairy" }]);
    const api = fakeApi({ suppliers });
    const user = userEvent.setup();
    render(<NewPurchaseOrder api={api} storeId="s1" />);
    await screen.findByRole("option", { name: "No suppliers yet" });
    await user.click(screen.getByRole("button", { name: "New supplier" }));
    const dialog = screen.getByRole("dialog", { name: "New supplier" });
    await user.type(within(dialog).getByLabelText("Name"), " Amul Dairy ");
    await user.type(within(dialog).getByLabelText("Short code"), "AMUL");
    await user.click(within(dialog).getByRole("button", { name: "Add supplier" }));
    await waitFor(() => expect(api.createSupplier).toHaveBeenCalledWith("s1", { code: "AMUL", name: "Amul Dairy" }, expect.any(String)));
    expect(await screen.findByLabelText("Supplier")).toHaveValue("sup-3");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the form and reuses the key when saving fails", async () => {
    const createPurchaseOrder = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(0, "offline", "No connection. Check the Wi-Fi and try again."))
      .mockRejectedValueOnce(new ApiError(409, "conflict", "A purchase order with this number already exists"));
    const user = userEvent.setup();
    render(<NewPurchaseOrder api={fakeApi({ createPurchaseOrder })} storeId="s1" />);
    await screen.findByRole("option", { name: "Fresh Farms" });
    await user.selectOptions(screen.getByLabelText("Supplier"), "sup-2");
    await user.type(screen.getByLabelText("Purchase order number"), "PO-1");
    await user.type(screen.getByLabelText("Add an item"), "8901{Enter}");
    await user.type(await screen.findByLabelText("Cost of one Milk 1L"), "30");
    const save = screen.getByRole("button", { name: "Save purchase order" });
    await user.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent("No connection");
    await user.click(save);
    expect(await screen.findByText("A purchase order with this number already exists")).toBeInTheDocument();
    expect(createPurchaseOrder.mock.calls[1]![2]).toBe(createPurchaseOrder.mock.calls[0]![2]);
    expect(screen.getByLabelText("Purchase order number")).toHaveValue("PO-1");
  });
});
