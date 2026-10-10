import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError, type Location, type StockRow } from "../src/api";
import { firstToPutAway, Putaway, shelfFor } from "../src/screens/Putaway";

const row = (over: Partial<StockRow> = {}): StockRow => ({
  productId: "milk",
  sku: "MILK-1L",
  name: "Milk 1L",
  locationId: "recv-1",
  locationCode: "RECV-1",
  batchId: "lot-late",
  lotCode: "L2",
  expiryDate: "2026-12-20",
  status: "receiving",
  onHand: 6,
  ...over,
});

const EARLY = row({ batchId: "lot-early", lotCode: "L1", expiryDate: "2026-11-01", onHand: 4 });
const RICE = row({ productId: "rice", sku: "RICE-5", name: "Rice 5kg", batchId: null, lotCode: null, expiryDate: null, onHand: 3 });

const LOCATIONS: Location[] = [
  { locationId: "a1", code: "A-01-01", purpose: "storage", status: "active" },
  { locationId: "q1", code: "QUAR-1", purpose: "quarantine", status: "active" },
  { locationId: "old", code: "Z-99", purpose: "storage", status: "inactive" },
];

const PRODUCTS: Record<string, string> = { "111": "milk", "222": "rice", "333": "bread" };

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    stockRows: vi.fn(async (_s: string, filter: { status: string }) =>
      filter.status === "receiving" ? [row(), EARLY, RICE] : [row({ status: "available", locationCode: "B-02-03" })],
    ),
    locations: vi.fn().mockResolvedValue(LOCATIONS),
    product: vi.fn(async (_s: string, code: string) => {
      if (!PRODUCTS[code]) throw new ApiError(404, "not_found", "Product not found");
      return { productId: PRODUCTS[code], sku: code, name: code };
    }),
    putaway: vi.fn().mockResolvedValue({ putawayId: "p1" }),
    ...overrides,
  } as unknown as Api;
}

describe("putaway helpers", () => {
  it("puts the earliest expiry away first", () => {
    expect(firstToPutAway([row(), EARLY, RICE], "milk")).toBe(EARLY);
    expect(firstToPutAway([row(), RICE], "bread")).toBeNull();
  });

  it("accepts only active storage shelves, ignoring case", () => {
    expect(shelfFor(LOCATIONS, " a-01-01 ")).toMatchObject({ locationId: "a1" });
    expect(shelfFor(LOCATIONS, "QUAR-1")).toBe("not_storage");
    expect(shelfFor(LOCATIONS, "Z-99")).toBe("not_storage");
    expect(shelfFor(LOCATIONS, "NOPE")).toBeNull();
  });
});

describe("putaway screen", () => {
  it("scans an item, then a shelf, and moves all of it by default", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Putaway api={api} storeId="s1" />);
    await user.type(await screen.findByLabelText("Scan an item to put away"), "111{Enter}");
    expect(await screen.findByRole("heading", { name: "Milk 1L" })).toBeInTheDocument();
    expect(screen.getByText(/lot L1 · exp 2026-11-01 · 4 in RECV-1/)).toBeInTheDocument();
    expect(await screen.findByText("Already on B-02-03")).toBeInTheDocument();
    expect(screen.getByLabelText("How many")).toHaveValue(4);

    await user.type(screen.getByLabelText("Scan the shelf label"), "A-01-01{Enter}");
    await waitFor(() =>
      expect(api.putaway).toHaveBeenCalledWith(
        "s1",
        { productId: "milk", batchId: "lot-early", fromLocationId: "recv-1", toLocationId: "a1", quantity: 4 },
        expect.any(String),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Put 4 × Milk 1L on A-01-01");
    expect(screen.getByLabelText("Scan an item to put away")).toBeInTheDocument();
  });

  it("moves part of it when the worker changes how many", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Putaway api={api} storeId="s1" />);
    await user.click((await screen.findAllByRole("button", { name: "Put away" }))[2]!);
    const howMany = screen.getByLabelText("How many");
    await user.clear(howMany);
    await user.type(howMany, "2{Enter}");
    expect(screen.getByLabelText("Scan the shelf label")).toHaveFocus();
    await user.keyboard("A-01-01{Enter}");
    await waitFor(() => expect(api.putaway).toHaveBeenCalledWith("s1", expect.objectContaining({ productId: "rice", quantity: 2 }), expect.any(String)));
  });

  it("refuses a shelf that cannot hold stock and too many units", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Putaway api={api} storeId="s1" />);
    await user.click((await screen.findAllByRole("button", { name: "Put away" }))[2]!);
    await user.type(screen.getByLabelText("Scan the shelf label"), "QUAR-1{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("QUAR-1 is not a shelf for stock");
    await user.type(screen.getByLabelText("Scan the shelf label"), "NOPE{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Unknown shelf NOPE");
    const howMany = screen.getByLabelText("How many");
    await user.clear(howMany);
    await user.type(howMany, "9");
    await user.type(screen.getByLabelText("Scan the shelf label"), "A-01-01{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter how many to put away, up to 3");
    expect(api.putaway).not.toHaveBeenCalled();
  });

  it("says when a scanned item is not waiting and when nothing is", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Putaway api={fakeApi()} storeId="s1" />);
    await user.type(await screen.findByLabelText("Scan an item to put away"), "333{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing of this item is waiting to be put away");
    unmount();
    render(<Putaway api={fakeApi({ stockRows: vi.fn().mockResolvedValue([]) })} storeId="s1" />);
    expect(await screen.findByText("Nothing is waiting to be put away.")).toBeInTheDocument();
  });
});
