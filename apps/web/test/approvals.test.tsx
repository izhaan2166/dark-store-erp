import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError, type CountSummary, type ReceiptSummary, type StockRequestSummary } from "../src/api";
import { Approvals, requestText, rupees } from "../src/screens/Approvals";

const RECEIPT: ReceiptSummary = {
  goodsReceiptId: "grn-1",
  createdAt: "2026-10-10T09:00:00Z",
  poNumber: "PO-77",
  supplierName: "Fresh Farms",
  receivedByName: "Sana",
  lines: [
    { productId: "oil", sku: "OIL", name: "Oil 1L", lotCode: null, expiryDate: null, expectedQty: 100, acceptedQty: 50, damagedQty: 2, rejectedQty: 0, needsApproval: true },
    { productId: "rice", sku: "RICE", name: "Rice 5kg", lotCode: null, expiryDate: null, expectedQty: 10, acceptedQty: 10, damagedQty: 0, rejectedQty: 0, needsApproval: false },
  ],
};

const COUNT: CountSummary = {
  stockCountId: "cnt-1",
  createdAt: "2026-10-10T09:30:00Z",
  locationCode: "A-01",
  countedByName: "Kiran",
  lines: [
    { productId: "milk", sku: "MILK", name: "Milk 1L", lotCode: "L1", bookQty: 10, countedQty: 4, variance: -6, varianceValuePaise: -36000, needsApproval: true },
    { productId: "jam", sku: "JAM", name: "Jam", lotCode: null, bookQty: 3, countedQty: 3, variance: 0, varianceValuePaise: 0, needsApproval: false },
  ],
};

const WRITE_OFF: StockRequestSummary = {
  id: "req-1",
  kind: "write_off",
  productId: "curd",
  batchId: "c1",
  fromLocationId: "q1",
  quantity: 1,
  reason: "Lid broken",
  fromStatus: "quarantined",
  createdAt: "2026-10-10T10:00:00Z",
  sku: "CURD",
  productName: "Curd 400g",
  lotCode: "C1",
  expiryDate: "2026-10-20",
  fromLocationCode: "QUAR-1",
  toLocationCode: null,
  requestedByName: "Kiran",
};
const RELEASE: StockRequestSummary = { ...WRITE_OFF, id: "req-2", kind: "release", quantity: 2, toLocationCode: "B-01", reason: "Seal intact" };

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    pendingReceipts: vi.fn().mockResolvedValue([RECEIPT]),
    pendingCounts: vi.fn().mockResolvedValue([COUNT]),
    pendingRequests: vi.fn().mockResolvedValue([WRITE_OFF, RELEASE]),
    decideReceipt: vi.fn().mockResolvedValue({}),
    decideCount: vi.fn().mockResolvedValue({}),
    decideRequest: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as Api;
}

const card = async (text: string) => (await screen.findByText(text, { exact: false })).closest("li.card") as HTMLElement;

async function decide(cardText: string, button: string, reason: string) {
  const user = userEvent.setup();
  await user.click(within(await card(cardText)).getByRole("button", { name: button }));
  const dialog = screen.getByRole("dialog", { name: button });
  const confirm = within(dialog).getByRole("button", { name: button });
  expect(confirm).toBeDisabled();
  await user.type(within(dialog).getByLabelText("Reason"), reason);
  await user.click(confirm);
}

describe("approval helpers", () => {
  it("shows money in whole rupees with Indian grouping", () => {
    expect(rupees(-36000)).toBe("−₹360");
    expect(rupees(12345678)).toBe("₹1,23,457");
  });

  it("says what a request will do", () => {
    expect(requestText(WRITE_OFF)).toBe("Write off 1 × Curd 400g lot C1 (quarantined) in QUAR-1");
    expect(requestText(RELEASE)).toBe("Put 2 × Curd 400g lot C1 back on sale: QUAR-1 to B-01");
  });
});

describe("approvals screen", () => {
  it("shows each waiting item with what needs a decision flagged", async () => {
    render(<Approvals api={fakeApi()} storeId="s1" />);
    const delivery = await card("PO-77 · Fresh Farms");
    expect(within(delivery).getByText("Oil 1L: expected 100, accepted 50, damaged 2")).toHaveClass("flag");
    expect(within(delivery).getByText("Rice 5kg: expected 10, accepted 10")).not.toHaveClass("flag");
    const count = await card("Shelf A-01");
    expect(within(count).getByText("Milk 1L lot L1: recorded 10, counted 4 (−6, −₹360)")).toHaveClass("flag");
    expect(within(count).queryByText(/Jam/)).toBeNull();
    expect(await card("Write off 1 × Curd")).toHaveTextContent("“Lid broken” · asked by Kiran");
  });

  it("accepts a delivery with a typed reason and reloads", async () => {
    const api = fakeApi();
    render(<Approvals api={api} storeId="s1" />);
    await decide("PO-77 · Fresh Farms", "Accept delivery", "Supplier short, rest next week");
    await waitFor(() =>
      expect(api.decideReceipt).toHaveBeenCalledWith("s1", "grn-1", "approve", "Supplier short, rest next week", expect.any(String)),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Delivery PO-77 accepted");
    expect(api.pendingReceipts).toHaveBeenCalledTimes(2);
  });

  it("rejects a count and approves a write-off", async () => {
    const api = fakeApi();
    render(<Approvals api={api} storeId="s1" />);
    await decide("Shelf A-01", "Reject count", "Recount, the back row was missed");
    await waitFor(() => expect(api.decideCount).toHaveBeenCalledWith("s1", "cnt-1", "reject", "Recount, the back row was missed", expect.any(String)));
    expect(await screen.findByRole("status")).toHaveTextContent("Count of A-01 rejected. Stock is unchanged.");
    await decide("Write off 1 × Curd", "Approve", "Checked, lid is broken");
    await waitFor(() => expect(api.decideRequest).toHaveBeenCalledWith("s1", "req-1", "approve", "Checked, lid is broken", expect.any(String)));
    expect(await screen.findByRole("status")).toHaveTextContent("Written off 1 × Curd 400g.");
  });

  it("keeps the dialog open with the server's reason when a decision fails", async () => {
    const api = fakeApi({ decideRequest: vi.fn().mockRejectedValue(new ApiError(409, "invalid_state", "This request is not waiting for approval")) });
    render(<Approvals api={api} storeId="s1" />);
    await decide("Put 2 × Curd", "Approve", "Fine");
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("not waiting for approval");
  });

  it("says when nothing is waiting", async () => {
    const empty = vi.fn().mockResolvedValue([]);
    render(<Approvals api={fakeApi({ pendingReceipts: empty, pendingCounts: empty, pendingRequests: empty })} storeId="s1" />);
    expect(await screen.findByText("Nothing is waiting for you.")).toBeInTheDocument();
  });
});
