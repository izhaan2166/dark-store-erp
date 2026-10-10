import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError, type FulfilmentView } from "../src/api";
import { PickOrder, stops } from "../src/screens/PickOrder";

const line = (over: Partial<FulfilmentView["lines"][number]> = {}): FulfilmentView["lines"][number] => ({
  orderItemId: "item-1",
  lineNo: 1,
  productId: "milk",
  sku: "MILK-1L",
  name: "Milk 1L",
  requestedQty: 2,
  reservedQty: 2,
  pickedQty: 0,
  fulfilledQty: 0,
  openShortageQty: 0,
  substitutesItemId: null,
  tasks: [{ locationId: "bin-b", locationCode: "B-01", batchId: null, lotCode: null, expiryDate: null, quantity: 2 }],
  ...over,
});

const view = (over: Partial<FulfilmentView> = {}): FulfilmentView => ({
  orderId: "order-1",
  status: "picking",
  lines: [line()],
  openShortages: [],
  ...over,
});

function fakeApi(overrides: Partial<Record<keyof Api, unknown>>): Api {
  return {
    fulfilment: vi.fn().mockResolvedValue(view()),
    product: vi.fn().mockResolvedValue({ productId: "milk", sku: "MILK-1L", name: "Milk 1L" }),
    ...overrides,
  } as unknown as Api;
}

const scan = async (code: string) => {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Scan an item"), `${code}{Enter}`);
};

describe("pick order screen", () => {
  it("lists stops in bin order", () => {
    const v = view({
      lines: [
        line(),
        line({
          orderItemId: "item-2",
          lineNo: 2,
          productId: "eggs",
          name: "Eggs",
          tasks: [{ locationId: "bin-a", locationCode: "A-01", batchId: null, lotCode: null, expiryDate: null, quantity: 1 }],
        }),
      ],
    });
    expect(stops(v).map((s) => s.task.locationCode)).toEqual(["A-01", "B-01"]);
  });

  it("picks one unit from the item's bin for each scan", async () => {
    const pick = vi.fn().mockResolvedValue(view({ lines: [line({ reservedQty: 1, pickedQty: 1, tasks: [{ ...line().tasks[0]!, quantity: 1 }] })] }));
    const api = fakeApi({ pick });
    render(<PickOrder api={api} storeId="s1" orderId="order-1" />);
    await scan("4000001");
    await waitFor(() => expect(pick).toHaveBeenCalledTimes(1));
    expect(pick).toHaveBeenCalledWith(
      "s1",
      "order-1",
      { orderItemId: "item-1", locationId: "bin-b", barcode: "4000001", quantity: 1 },
      expect.any(String),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Picked 1 × Milk 1L from B-01");
  });

  it("warns about an item that is not in the order without picking anything", async () => {
    const pick = vi.fn();
    const api = fakeApi({ pick, product: vi.fn().mockResolvedValue({ productId: "bread", sku: "BREAD", name: "Bread" }) });
    render(<PickOrder api={api} storeId="s1" orderId="order-1" />);
    await scan("5000001");
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong item");
    expect(pick).not.toHaveBeenCalled();
  });

  it("shows the server's reason when a pick is refused", async () => {
    const pick = vi.fn().mockRejectedValue(new ApiError(422, "wrong_item", "That barcode is not this item"));
    render(<PickOrder api={fakeApi({ pick })} storeId="s1" orderId="order-1" />);
    await scan("4000001");
    expect(await screen.findByRole("alert")).toHaveTextContent("That barcode is not this item");
  });

  it("reports missing units with a reason", async () => {
    const shortPick = vi.fn().mockResolvedValue(view({ lines: [line({ reservedQty: 0, openShortageQty: 2, tasks: [] })] }));
    render(<PickOrder api={fakeApi({ shortPick })} storeId="s1" orderId="order-1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Can't find" }));
    await user.click(screen.getByLabelText("Damaged"));
    await user.click(screen.getByRole("button", { name: "Report missing" }));
    await waitFor(() =>
      expect(shortPick).toHaveBeenCalledWith(
        "s1",
        "order-1",
        { orderItemId: "item-1", locationId: "bin-b", quantity: 2, reason: "Damaged" },
        expect.any(String),
      ),
    );
    expect(await screen.findByText(/A manager will decide/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish picking" })).toBeInTheDocument();
  });

  it("starts an accepted order before scanning", async () => {
    const startPicking = vi.fn().mockResolvedValue(view());
    render(<PickOrder api={fakeApi({ fulfilment: vi.fn().mockResolvedValue(view({ status: "accepted" })), startPicking })} storeId="s1" orderId="order-1" />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Start picking" }));
    expect(await screen.findByLabelText("Scan an item")).toBeInTheDocument();
    expect(startPicking).toHaveBeenCalledTimes(1);
  });
});
