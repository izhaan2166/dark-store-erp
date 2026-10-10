import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Api, type Location, type StockRow } from "../src/api";
import { actionsFor, movable, StockControl } from "../src/screens/StockControl";

const LOCATIONS: Location[] = [
  { locationId: "a1", code: "A-01", purpose: "storage", status: "active" },
  { locationId: "b1", code: "B-01", purpose: "storage", status: "active" },
  { locationId: "q1", code: "QUAR-1", purpose: "quarantine", status: "active" },
  { locationId: "p1", code: "PACK-1", purpose: "packing", status: "active" },
];
const BY_ID = new Map(LOCATIONS.map((l) => [l.locationId, l]));

const row = (over: Partial<StockRow> = {}): StockRow => ({
  productId: "curd",
  sku: "CURD",
  name: "Curd 400g",
  locationId: "q1",
  locationCode: "QUAR-1",
  batchId: "c1",
  lotCode: "C1",
  expiryDate: "2026-10-20",
  status: "quarantined",
  onHand: 3,
  free: 3,
  ...over,
});

const ON_SHELF = row({ locationId: "a1", locationCode: "A-01", status: "available", onHand: 5, free: 2 });
const DAMAGED = row({ productId: "oil", name: "Oil 1L", sku: "OIL", batchId: null, lotCode: null, expiryDate: null, status: "damaged", onHand: 2, free: 2 });

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    stockRows: vi.fn(async (_s: string, filter: { status?: string; productId?: string }) => {
      if (filter.status === "quarantined") return [row()];
      if (filter.status === "damaged") return [DAMAGED];
      if (filter.productId === "curd") return [ON_SHELF, row(), row({ status: "receiving", locationId: "r1" })];
      return [];
    }),
    locations: vi.fn().mockResolvedValue(LOCATIONS),
    pendingRequests: vi.fn().mockResolvedValue([]),
    product: vi.fn().mockResolvedValue({ productId: "curd", sku: "CURD", name: "Curd 400g" }),
    quarantine: vi.fn().mockResolvedValue({}),
    requestRelease: vi.fn().mockResolvedValue({}),
    requestWriteOff: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as Api;
}

describe("problem stock helpers", () => {
  it("offers only what the stock's state and place allow", () => {
    expect(actionsFor(ON_SHELF, BY_ID)).toEqual(["block", "write_off"]);
    expect(actionsFor(row(), BY_ID)).toEqual(["release", "write_off"]);
    expect(actionsFor(DAMAGED, BY_ID)).toEqual(["write_off"]);
    expect(actionsFor(row({ status: "available", locationId: "p1" }), BY_ID)).toEqual([]);
  });

  it("never blocks units that orders have reserved", () => {
    expect(movable(ON_SHELF, "block")).toBe(2);
    expect(movable(ON_SHELF, "write_off")).toBe(5);
  });
});

describe("problem stock screen", () => {
  it("lists blocked and damaged stock and asks a manager to put blocked stock back on sale", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<StockControl api={api} storeId="s1" />);
    const blocked = (await screen.findByText("3 × Curd 400g")).closest("li") as HTMLElement;
    expect(within(blocked).getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("2 × Oil 1L").closest("li")).toHaveTextContent("Damaged");

    await user.click(within(blocked).getByRole("button", { name: "Put back on sale" }));
    const dialog = screen.getByRole("dialog", { name: "Put back on sale" });
    expect(dialog).toHaveTextContent("A Store Manager must approve this");
    const confirm = within(dialog).getByRole("button", { name: "Put back on sale" });
    await user.type(within(dialog).getByLabelText("Reason"), "Seal intact");
    expect(confirm).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText("Back to shelf"), "b1");
    await user.clear(within(dialog).getByLabelText("How many (up to 3)"));
    await user.type(within(dialog).getByLabelText("How many (up to 3)"), "2");
    await user.click(confirm);
    await waitFor(() =>
      expect(api.requestRelease).toHaveBeenCalledWith(
        "s1",
        { productId: "curd", batchId: "c1", quantity: 2, reason: "Seal intact", fromLocationId: "q1", toLocationId: "b1" },
        expect.any(String),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Asked a Store Manager to put back on sale: 2 × Curd 400g");
  });

  it("blocks unreserved stock from a scanned item straight into the only quarantine area", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<StockControl api={api} storeId="s1" />);
    await user.type(await screen.findByLabelText("Scan an item to block or write off"), "555{Enter}");
    const section = (await screen.findByRole("heading", { name: "All stock of Curd 400g" })).closest("section") as HTMLElement;
    expect(within(section).getAllByRole("listitem")).toHaveLength(2);
    const shelfRow = within(section).getByText("5 × Curd 400g").closest("li") as HTMLElement;
    expect(shelfRow).toHaveTextContent("3 reserved for orders");
    await user.click(within(shelfRow).getByRole("button", { name: "Block" }));
    const dialog = screen.getByRole("dialog", { name: "Block" });
    expect(within(dialog).getByLabelText("How many (up to 2)")).toHaveValue(2);
    expect(within(dialog).getByLabelText("Move to")).toHaveValue("q1");
    await user.type(within(dialog).getByLabelText("Reason"), "Swollen packs");
    await user.click(within(dialog).getByRole("button", { name: "Block" }));
    await waitFor(() =>
      expect(api.quarantine).toHaveBeenCalledWith(
        "s1",
        { productId: "curd", batchId: "c1", quantity: 2, reason: "Swollen packs", fromLocationId: "a1", toLocationId: "q1" },
        expect.any(String),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Blocked: 2 × Curd 400g");
  });

  it("asks to write off damaged stock and marks stock already waiting for a manager", async () => {
    const api = fakeApi({
      pendingRequests: vi.fn().mockResolvedValue([{ productId: "oil", batchId: null, fromLocationId: "q1", fromStatus: "damaged" }]),
    });
    const user = userEvent.setup();
    render(<StockControl api={api} storeId="s1" />);
    const damaged = (await screen.findByText("2 × Oil 1L")).closest("li") as HTMLElement;
    expect(await within(damaged).findByText("Waiting for a manager")).toBeInTheDocument();
    await user.click(within(damaged).getByRole("button", { name: "Write off" }));
    const dialog = screen.getByRole("dialog", { name: "Write off" });
    expect(within(dialog).queryByLabelText("Back to shelf")).toBeNull();
    await user.type(within(dialog).getByLabelText("Reason"), "Leaking");
    await user.click(within(dialog).getByRole("button", { name: "Write off" }));
    await waitFor(() =>
      expect(api.requestWriteOff).toHaveBeenCalledWith(
        "s1",
        { productId: "oil", batchId: null, quantity: 2, reason: "Leaking", locationId: "q1", status: "damaged" },
        expect.any(String),
      ),
    );
  });
});
