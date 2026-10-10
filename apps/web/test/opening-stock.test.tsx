import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError, type Location, type Product } from "../src/api";
import { lineProblem, type OpeningLine, openingBody, OpeningStock } from "../src/screens/OpeningStock";

const MILK: Product = { productId: "milk", sku: "MILK-1L", name: "Milk 1L", batchTracked: true };
const RICE: Product = { productId: "rice", sku: "RICE-5", name: "Rice 5kg", batchTracked: false };
const LOCATIONS: Location[] = [
  { locationId: "a1", code: "A-01", kind: "bin", purpose: "storage", status: "active", allocatable: true },
  { locationId: "a2", code: "A-02", kind: "bin", purpose: "storage", status: "active", allocatable: true },
  { locationId: "r1", code: "DOCK-1", kind: "zone", purpose: "receiving", status: "active", allocatable: false },
];
const TODAY = "2026-10-10";

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    locations: vi.fn().mockResolvedValue(LOCATIONS),
    product: vi.fn(async (_s: string, code: string) => {
      if (code === "8901") return MILK;
      if (code === "8902") return RICE;
      throw new ApiError(404, "not_found", "Unknown barcode");
    }),
    searchProducts: vi.fn().mockResolvedValue([]),
    loadOpeningStock: vi.fn().mockResolvedValue({ openingStockId: "os", locationId: "a1", lines: [] }),
    ...overrides,
  } as unknown as Api;
}

const line = (patch: Partial<OpeningLine>): OpeningLine => ({ id: 1, product: RICE, quantityText: "5", lotText: "", expiryText: "", costText: "", ...patch });

describe("opening stock lines", () => {
  it("needs a quantity, and a lot and a future expiry for batch-tracked items", () => {
    expect(lineProblem(line({}), TODAY)).toBeNull();
    expect(lineProblem(line({ quantityText: "0" }), TODAY)).toBe("Enter how many, as a whole number");
    expect(lineProblem(line({ product: MILK }), TODAY)).toBe("Enter the lot number");
    expect(lineProblem(line({ product: MILK, lotText: "L1" }), TODAY)).toBe("Enter the expiry date");
    expect(lineProblem(line({ product: MILK, lotText: "L1", expiryText: TODAY }), TODAY)).toMatch(/^Expired/);
    expect(lineProblem(line({ product: MILK, lotText: "L1", expiryText: "2026-10-11" }), TODAY)).toBeNull();
    expect(lineProblem(line({ costText: "12.345" }), TODAY)).toBe("Use rupees, like 42.50");
  });

  it("builds the request, leaving out what was not given, and refuses an item and lot entered twice", () => {
    const milk = line({ id: 2, product: MILK, lotText: " L1 ", expiryText: "2026-11-01", costText: "30" });
    expect(openingBody("a1", [line({}), milk], TODAY)).toEqual({
      locationId: "a1",
      lines: [
        { productId: "rice", quantity: 5 },
        { productId: "milk", quantity: 5, lotCode: "L1", expiryDate: "2026-11-01", unitCostPaise: 3000 },
      ],
    });
    expect(openingBody("a1", [milk, { ...milk, id: 3, lotText: "L2" }], TODAY)).not.toBeNull();
    expect(openingBody("a1", [milk, { ...milk, id: 3, lotText: "l1" }], TODAY)).toBeNull();
    expect(openingBody("a1", [line({}), line({ id: 2 })], TODAY)).toBeNull();
    expect(openingBody("a1", [], TODAY)).toBeNull();
  });
});

describe("opening stock screen", () => {
  it("loads a counted shelf, then is ready for the next one", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<OpeningStock api={api} storeId="s1" />);

    const shelves = await screen.findByRole("list", { name: "Shelves" });
    expect(within(shelves).queryByText("DOCK-1")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Scan the label of the shelf you counted"), "a-01{Enter}");
    expect(screen.getByRole("heading", { name: "Shelf A-01" })).toBeInTheDocument();

    const lookup = screen.getByLabelText("Add an item");
    await user.type(lookup, "8902{Enter}");
    await user.type(lookup, "8902{Enter}");
    expect(screen.getByLabelText("How many Rice 5kg")).toHaveValue(2);
    await user.type(lookup, "8901{Enter}");
    const load = screen.getByRole("button", { name: "Load stock onto A-01" });
    expect(load).toBeDisabled();
    expect(screen.getByText("Enter the lot number")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Lot of Milk 1L"), "L1");
    await user.type(screen.getByLabelText("Expiry of Milk 1L lot L1"), "2099-01-31");
    await user.clear(screen.getByLabelText("How many Milk 1L lot L1"));
    await user.type(screen.getByLabelText("How many Milk 1L lot L1"), "12");
    await user.click(screen.getByRole("button", { name: "Another lot" }));
    const lots = screen.getAllByLabelText("Lot of Milk 1L");
    await user.type(lots[1]!, "L2");
    await user.type(screen.getAllByLabelText(/^Expiry of Milk 1L/)[1]!, "2099-02-28");
    expect(screen.getByText("2 products, 15 units")).toBeInTheDocument();

    await user.click(load);
    expect(api.loadOpeningStock).toHaveBeenCalledWith(
      "s1",
      {
        locationId: "a1",
        lines: [
          { productId: "rice", quantity: 2 },
          { productId: "milk", quantity: 12, lotCode: "L1", expiryDate: "2099-01-31" },
          { productId: "milk", quantity: 1, lotCode: "L2", expiryDate: "2099-02-28" },
        ],
      },
      expect.any(String),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("A-01 loaded: 2 products, 15 units. Scan the next shelf.");
    expect(within(screen.getByRole("list", { name: "Shelves" })).getByText("A-01").closest("button")).toHaveTextContent("Loaded");
  });

  it("shows why a shelf was refused and resends with the same key until something changes", async () => {
    const loadOpeningStock = vi.fn().mockRejectedValue(new ApiError(409, "conflict", "This location already has stock history. Use a stock count to correct it."));
    const api = fakeApi({ loadOpeningStock });
    const user = userEvent.setup();
    render(<OpeningStock api={api} storeId="s1" />);
    await user.click(await screen.findByRole("button", { name: "A-02" }));
    await user.type(screen.getByLabelText("Add an item"), "8902{Enter}");
    const load = screen.getByRole("button", { name: "Load stock onto A-02" });

    await user.click(load);
    expect(await screen.findByRole("alert")).toHaveTextContent("already has stock history");
    await user.click(load);
    await waitFor(() => expect(loadOpeningStock).toHaveBeenCalledTimes(2));
    expect(loadOpeningStock.mock.calls[1]![2]).toBe(loadOpeningStock.mock.calls[0]![2]);

    await user.type(screen.getByLabelText("How many Rice 5kg"), "0");
    await user.click(load);
    await waitFor(() => expect(loadOpeningStock).toHaveBeenCalledTimes(3));
    expect(loadOpeningStock.mock.calls[2]![2]).not.toBe(loadOpeningStock.mock.calls[0]![2]);
    expect(loadOpeningStock.mock.calls[2]![1].lines[0].quantity).toBe(10);
  });

  it("asks before leaving a shelf with items entered", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const user = userEvent.setup();
    render(<OpeningStock api={fakeApi()} storeId="s1" />);
    await user.click(await screen.findByRole("button", { name: "A-01" }));
    await user.type(screen.getByLabelText("Add an item"), "8902{Enter}");
    await user.click(screen.getByRole("button", { name: "‹ Shelves" }));
    expect(confirm).toHaveBeenCalledWith("Leave A-01 without loading? The items entered so far will be lost.");
    expect(screen.getByRole("heading", { name: "Shelf A-01" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "‹ Shelves" }));
    expect(await screen.findByRole("list", { name: "Shelves" })).toBeInTheDocument();
    confirm.mockRestore();
  });
});
