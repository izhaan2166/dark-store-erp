import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Api, ApiError, type CountView, type StockRow } from "../src/api";
import { CountShelf, CountStart, expectedItems } from "../src/screens/StockCount";

const row = (over: Partial<StockRow> = {}): StockRow => ({
  productId: "rice",
  sku: "RICE-5",
  name: "Rice 5kg",
  locationId: "a1",
  locationCode: "A-01",
  batchId: null,
  lotCode: null,
  expiryDate: null,
  status: "available",
  onHand: 5,
  ...over,
});

const MILK_L1 = row({ productId: "milk", sku: "MILK-1L", name: "Milk 1L", batchId: "b1", lotCode: "L1", expiryDate: "2026-11-01", onHand: 4 });
const MILK_L2 = row({ ...MILK_L1, batchId: "b2", lotCode: "L2", expiryDate: "2026-12-01", onHand: 6 });
const CURD = row({ productId: "curd", sku: "CURD", name: "Curd 400g", batchId: "c1", lotCode: "C1", expiryDate: "2026-10-20" });

const SHELF_ROWS = [row(), row({ status: "quarantined", onHand: 1 }), MILK_L1, MILK_L2, CURD, row({ productId: "jam", name: "Jam", status: "expired" })];

const PRODUCTS: Record<string, { productId: string; sku: string; name: string; batchTracked: boolean }> = {
  "111": { productId: "rice", sku: "RICE-5", name: "Rice 5kg", batchTracked: false },
  "222": { productId: "milk", sku: "MILK-1L", name: "Milk 1L", batchTracked: true },
  "333": { productId: "oil", sku: "OIL-1", name: "Oil 1L", batchTracked: false },
  "444": { productId: "ghee", sku: "GHEE", name: "Ghee", batchTracked: true },
  "555": { productId: "curd", sku: "CURD", name: "Curd 400g", batchTracked: true },
  "666": { productId: "paneer", sku: "PAN", name: "Paneer", batchTracked: true },
};

const LOCATIONS = [
  { locationId: "a1", code: "A-01", purpose: "storage", status: "active" },
  { locationId: "r1", code: "RECV-1", purpose: "receiving", status: "active" },
];

const posted = (lines: CountView["lines"] = []): CountView => ({ stockCountId: "c1", status: "posted", lines });

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    locations: vi.fn().mockResolvedValue(LOCATIONS),
    stockRows: vi.fn(async (_s: string, filter: { locationId?: string; productId?: string }) => {
      if (filter.locationId) return SHELF_ROWS;
      if (filter.productId === "ghee") return [row({ productId: "ghee", name: "Ghee", batchId: "g9", lotCode: "G9", expiryDate: "2027-01-01", locationCode: "B-02" })];
      return [];
    }),
    product: vi.fn(async (_s: string, code: string) => {
      if (!PRODUCTS[code]) throw new ApiError(404, "not_found", "Product not found");
      return PRODUCTS[code];
    }),
    submitCount: vi.fn().mockResolvedValue(posted()),
    ...overrides,
  } as unknown as Api;
}

async function scan(...codes: string[]) {
  const user = userEvent.setup();
  const box = await screen.findByLabelText("Scan every item on the shelf");
  for (const code of codes) await user.type(box, `${code}{Enter}`);
  return user;
}

const countOf = (label: string) => screen.getByRole("button", { name: `Type count for ${label}` });

afterEach(() => {
  window.location.hash = "";
});

describe("expected items", () => {
  it("lists sellable and blocked stock once per product and lot, leaving out expired", () => {
    expect(expectedItems(SHELF_ROWS).map((i) => i.key)).toEqual(["curd:c1", "milk:b1", "milk:b2", "rice:"]);
  });
});

describe("count start", () => {
  it("opens the shelf whose label is scanned and refuses other locations", async () => {
    const user = userEvent.setup();
    render(<CountStart api={fakeApi()} storeId="s1" />);
    const box = await screen.findByLabelText("Scan the label of the shelf to count");
    await waitFor(() => expect(box).toBeEnabled());
    await user.type(box, "RECV-1{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("RECV-1 is not a shelf for stock");
    await user.type(box, "a-01{Enter}");
    expect(window.location.hash).toBe("#/stores/s1/count/a1");
    expect(screen.getByRole("link", { name: "A-01" })).toHaveAttribute("href", "#/stores/s1/count/a1");
  });
});

describe("shelf count", () => {
  it("is blind, counts scans, and submits every expected item with not-found ones as zero", async () => {
    const api = fakeApi();
    render(<CountShelf api={api} storeId="s1" locationId="a1" />);
    expect(await screen.findByRole("heading", { name: "Count A-01" })).toBeInTheDocument();
    expect(screen.queryByText(/\b(5|4|6)\b in/)).toBeNull();
    const user = await scan("111", "111", "555");
    expect(screen.getByRole("status")).toHaveTextContent("Curd 400g lot C1: 1");
    expect(countOf("Rice 5kg")).toHaveTextContent("2");
    expect(screen.getByText("Milk 1L lot L1, Milk 1L lot L2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "One more Milk 1L lot L2" }));
    await user.click(screen.getByRole("button", { name: "Finish count" }));
    await waitFor(() =>
      expect(api.submitCount).toHaveBeenCalledWith(
        "s1",
        {
          locationId: "a1",
          lines: [
            { productId: "curd", batchId: "c1", countedQty: 1 },
            { productId: "milk", batchId: "b1", countedQty: 0 },
            { productId: "milk", batchId: "b2", countedQty: 1 },
            { productId: "rice", batchId: null, countedQty: 2 },
          ],
        },
        expect.any(String),
      ),
    );
    expect(await screen.findByRole("heading", { name: "Count saved" })).toBeInTheDocument();
    expect(screen.getByText("Everything matched. Stock is unchanged.")).toBeInTheDocument();
  });

  it("asks for + on the right lot when a product has several lots on the shelf", async () => {
    render(<CountShelf api={fakeApi()} storeId="s1" locationId="a1" />);
    await scan("222");
    expect(screen.getByRole("alert")).toHaveTextContent("Milk 1L has 2 lots on this shelf. Use + on the right lot.");
    expect(countOf("Milk 1L lot L1")).toHaveTextContent("0");
  });

  it("adds items found on the shelf that were not expected", async () => {
    const api = fakeApi();
    render(<CountShelf api={api} storeId="s1" locationId="a1" />);
    const user = await scan("333", "444");
    expect(screen.getByText(/OIL-1 · found here/)).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "Which lot?" });
    await user.click(within(dialog).getByLabelText(/Lot G9/));
    await user.click(within(dialog).getByRole("button", { name: "Count it" }));
    expect(countOf("Ghee lot G9")).toHaveTextContent("1");
    await scan("666");
    expect(screen.getByRole("alert")).toHaveTextContent("No lot of Paneer is known in this store");

    await user.click(screen.getByRole("button", { name: "Finish count" }));
    await waitFor(() => expect(api.submitCount).toHaveBeenCalled());
    const lines = vi.mocked(api.submitCount).mock.calls[0]![1].lines;
    expect(lines).toEqual(
      expect.arrayContaining([
        { productId: "oil", batchId: null, countedQty: 1 },
        { productId: "ghee", batchId: "g9", countedQty: 1 },
      ]),
    );
  });

  it("lets the counter type a number", async () => {
    render(<CountShelf api={fakeApi()} storeId="s1" locationId="a1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Type count for Rice 5kg" }));
    const input = screen.getByLabelText("How many are on the shelf?");
    await user.clear(input);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(input, "24{Enter}");
    expect(countOf("Rice 5kg")).toHaveTextContent("24");
    expect(screen.getByLabelText("Scan every item on the shelf")).toHaveFocus();
  });

  it("shows the differences, and when they wait for a manager", async () => {
    const submitCount = vi.fn().mockResolvedValue({
      stockCountId: "c2",
      status: "pending_approval",
      lines: [
        { productId: "rice", batchId: null, bookQty: 6, countedQty: 2, variance: -4, needsApproval: true },
        { productId: "milk", batchId: "b2", bookQty: 6, countedQty: 7, variance: 1, needsApproval: false },
      ],
    });
    render(<CountShelf api={fakeApi({ submitCount })} storeId="s1" locationId="a1" />);
    const user = await scan("111");
    await user.click(screen.getByRole("button", { name: "Finish count" }));
    expect(await screen.findByRole("heading", { name: "Saved, waiting for approval" })).toBeInTheDocument();
    expect(screen.getByText("Rice 5kg: 4 fewer than recorded")).toBeInTheDocument();
    expect(screen.getByText("Milk 1L lot L2: 1 more than recorded")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Count another shelf" })).toHaveAttribute("href", "#/stores/s1/count");
  });

  it("keeps the counts and the key when the server refuses, and shows why", async () => {
    const submitCount = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(0, "offline", "No connection. Check the Wi-Fi and try again."))
      .mockRejectedValueOnce(new ApiError(409, "insufficient_stock", "The shelf holds fewer than orders have reserved"));
    render(<CountShelf api={fakeApi({ submitCount })} storeId="s1" locationId="a1" />);
    const user = await scan("111");
    await user.click(screen.getByRole("button", { name: "Finish count" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No connection");
    await user.click(screen.getByRole("button", { name: "Finish count" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("fewer than orders have reserved");
    expect(submitCount.mock.calls[1]![2]).toBe(submitCount.mock.calls[0]![2]);
    expect(countOf("Rice 5kg")).toHaveTextContent("1");
  });
});
