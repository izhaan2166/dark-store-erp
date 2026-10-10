import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError, type PurchaseOrderLine, type PurchaseOrderView } from "../src/api";
import { differences, type Entry, missingLotInfo, ReceiveOrder, receiptLines } from "../src/screens/ReceiveOrder";

const line = (over: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine => ({
  purchaseOrderLineId: "pol-1",
  lineNo: 1,
  productId: "rice",
  sku: "RICE-5",
  name: "Rice 5kg",
  batchTracked: false,
  orderedQty: 3,
  receivedQty: 0,
  outstandingQty: 3,
  ...over,
});

const MILK = line({ purchaseOrderLineId: "pol-2", lineNo: 2, productId: "milk", sku: "MILK-1L", name: "Milk 1L", batchTracked: true, orderedQty: 2, outstandingQty: 2 });

const po = (over: Partial<PurchaseOrderView> = {}): PurchaseOrderView => ({
  purchaseOrderId: "po-1",
  poNumber: "PO-77",
  supplierName: "Fresh Farms",
  status: "open",
  pendingReceipts: 0,
  lines: [line(), MILK],
  ...over,
});

const entry = (over: Partial<Entry> = {}): Entry => ({ accepted: 0, damaged: 0, rejected: 0, lotCode: "", expiryDate: "", ...over });

const PRODUCTS: Record<string, string> = { "111": "rice", "222": "milk", "333": "bread" };
const RECEIVING = { locationId: "recv-1", code: "RECV-1", purpose: "receiving", status: "active" };

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    purchaseOrder: vi.fn().mockResolvedValue(po()),
    locations: vi.fn().mockResolvedValue([RECEIVING, { locationId: "a1", code: "A-01", purpose: "storage", status: "active" }]),
    product: vi.fn(async (_s: string, code: string) => {
      if (!PRODUCTS[code]) throw new ApiError(404, "not_found", "Product not found");
      return { productId: PRODUCTS[code], sku: code, name: code };
    }),
    recordReceipt: vi.fn().mockResolvedValue({ goodsReceiptId: "grn-1", status: "posted", receivingLocationId: "recv-1", lines: [], discrepancies: [] }),
    ...overrides,
  } as unknown as Api;
}

async function scan(...codes: string[]) {
  const user = userEvent.setup();
  const box = await screen.findByLabelText("Scan each good item as you unload");
  for (const code of codes) await user.type(box, `${code}{Enter}`);
  return user;
}

describe("receipt helpers", () => {
  it("sends only lines with units, with lot and expiry only for batch-tracked items", () => {
    const entries = new Map([
      ["pol-1", entry({ accepted: 3, lotCode: "ignored" })],
      ["pol-2", entry({ accepted: 1, damaged: 1, lotCode: " L9 ", expiryDate: "2026-12-01" })],
    ]);
    expect(receiptLines([line(), MILK], entries)).toEqual([
      { productId: "rice", acceptedQty: 3, damagedQty: 0, rejectedQty: 0 },
      { productId: "milk", acceptedQty: 1, damagedQty: 1, rejectedQty: 0, lotCode: "L9", expiryDate: "2026-12-01" },
    ]);
    expect(receiptLines([line(), MILK], new Map([["pol-1", entry()]]))).toEqual([]);
  });

  it("asks for lot and expiry only where units were counted on a batch-tracked line", () => {
    expect(missingLotInfo([line(), MILK], new Map([["pol-1", entry({ accepted: 1 })]]))).toEqual([]);
    expect(missingLotInfo([MILK], new Map([["pol-2", entry({ rejected: 1, lotCode: "L1" })]]))).toEqual([MILK]);
  });

  it("lists lines whose good units differ from what is still expected", () => {
    const found = differences([line(), MILK], new Map([["pol-1", entry({ accepted: 3 })]]));
    expect(found).toEqual([{ line: MILK, counted: 0 }]);
  });
});

describe("receive screen", () => {
  it("counts scans per line and records the delivery in the only receiving area", async () => {
    const api = fakeApi();
    render(<ReceiveOrder api={api} storeId="s1" purchaseOrderId="po-1" />);
    const user = await scan("111", "111", "111");
    expect(screen.getByRole("status")).toHaveTextContent("Rice 5kg: 3 of 3");
    expect(screen.getByLabelText("Rice 5kg good")).toHaveTextContent("3");
    expect(screen.getByText("Milk 1L: expected 2, counted 0")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Finish receiving" }));
    await waitFor(() =>
      expect(api.recordReceipt).toHaveBeenCalledWith(
        "s1",
        { purchaseOrderId: "po-1", receivingLocationId: "recv-1", lines: [{ productId: "rice", acceptedQty: 3, damagedQty: 0, rejectedQty: 0 }] },
        expect.any(String),
      ),
    );
    expect(await screen.findByRole("heading", { name: "Received" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Put them away" })).toHaveAttribute("href", "#/stores/s1/putaway");
    expect(screen.getByLabelText("Rice 5kg good")).toHaveTextContent("0");
    expect(api.purchaseOrder).toHaveBeenCalledTimes(2);
  });

  it("refuses items that are not on the order or unknown", async () => {
    render(<ReceiveOrder api={fakeApi()} storeId="s1" purchaseOrderId="po-1" />);
    await scan("333");
    expect(await screen.findByRole("alert")).toHaveTextContent("Not on this purchase order");
    await scan("999");
    expect(await screen.findByRole("alert")).toHaveTextContent("Unknown barcode 999");
  });

  it("needs lot and expiry for batch-tracked items before it can finish", async () => {
    const api = fakeApi();
    render(<ReceiveOrder api={api} storeId="s1" purchaseOrderId="po-1" />);
    const user = await scan("222", "222");
    await user.click(screen.getByRole("button", { name: "One more damaged Milk 1L" }));
    const finish = screen.getByRole("button", { name: "Finish receiving" });
    expect(finish).toBeDisabled();
    expect(screen.getByText("Enter lot and expiry for Milk 1L.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Lot Milk 1L"), "L42");
    await user.type(screen.getByLabelText("Expiry Milk 1L"), "2026-12-31");
    await user.click(finish);
    await waitFor(() =>
      expect(api.recordReceipt).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({
          lines: [{ productId: "milk", acceptedQty: 2, damagedQty: 1, rejectedQty: 0, lotCode: "L42", expiryDate: "2026-12-31" }],
        }),
        expect.any(String),
      ),
    );
  });

  it("says when the delivery waits for a manager", async () => {
    const recordReceipt = vi.fn().mockResolvedValue({ goodsReceiptId: "g", status: "pending_approval", receivingLocationId: "recv-1", lines: [], discrepancies: [] });
    render(<ReceiveOrder api={fakeApi({ recordReceipt })} storeId="s1" purchaseOrderId="po-1" />);
    const user = await scan("111");
    await user.click(screen.getByRole("button", { name: "Finish receiving" }));
    expect(await screen.findByRole("heading", { name: "Saved, waiting for approval" })).toBeInTheDocument();
  });

  it("reuses the same key when the same delivery is submitted again after a failure", async () => {
    const recordReceipt = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(0, "offline", "No connection. Check the Wi-Fi and try again."))
      .mockResolvedValue({ goodsReceiptId: "g", status: "posted", receivingLocationId: "recv-1", lines: [], discrepancies: [] });
    render(<ReceiveOrder api={fakeApi({ recordReceipt })} storeId="s1" purchaseOrderId="po-1" />);
    const user = await scan("111");
    await user.click(screen.getByRole("button", { name: "Finish receiving" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No connection");
    await user.click(screen.getByRole("button", { name: "Finish receiving" }));
    await waitFor(() => expect(recordReceipt).toHaveBeenCalledTimes(2));
    expect(recordReceipt.mock.calls[1]![2]).toBe(recordReceipt.mock.calls[0]![2]);
  });

  it("asks which unloading area when there are several, and warns about a receipt awaiting approval", async () => {
    const api = fakeApi({
      purchaseOrder: vi.fn().mockResolvedValue(po({ pendingReceipts: 1 })),
      locations: vi.fn().mockResolvedValue([RECEIVING, { ...RECEIVING, locationId: "recv-2", code: "RECV-2" }]),
    });
    render(<ReceiveOrder api={api} storeId="s1" purchaseOrderId="po-1" />);
    expect(await screen.findByText(/An earlier delivery for this order is waiting for approval/)).toBeInTheDocument();
    const user = await scan("111");
    const finish = screen.getByRole("button", { name: "Finish receiving" });
    expect(finish).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Unloading area"), "recv-2");
    await user.click(finish);
    await waitFor(() =>
      expect(api.recordReceipt).toHaveBeenCalledWith("s1", expect.objectContaining({ receivingLocationId: "recv-2" }), expect.any(String)),
    );
  });

  it("puts a scan after tapping + back into the scan box", async () => {
    render(<ReceiveOrder api={fakeApi()} storeId="s1" purchaseOrderId="po-1" />);
    const user = userEvent.setup();
    await screen.findByLabelText("Scan each good item as you unload");
    await user.click(screen.getByRole("button", { name: "One more Rice 5kg" }));
    await user.keyboard("222{Enter}");
    expect(await screen.findByRole("status")).toHaveTextContent("Milk 1L: 1 of 2");
    expect(within(screen.getByLabelText("Rice 5kg good")).getByText("1")).toBeInTheDocument();
  });
});
