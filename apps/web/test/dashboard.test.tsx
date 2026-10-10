import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Api, type Dashboard as View } from "../src/api";
import { attentionItems, Dashboard } from "../src/screens/Dashboard";

const view = (over: { kpis?: Partial<View["kpis"]>; exceptions?: Partial<View["exceptions"]> } = {}): View => ({
  today: "2026-10-10",
  expiryAlertDays: 3,
  kpis: { handedOverToday: 42, medianFulfilmentMinutes: 14, awaitingFulfilment: 6, outOfStock: 2, expiryAlerts: 1, ...over.kpis },
  exceptions: {
    openShortages: 0,
    escalatedShortages: 0,
    receiptsAwaitingApproval: 0,
    countsAwaitingApproval: 0,
    requestsAwaitingApproval: 0,
    unitsAwaitingPutaway: 0,
    problemOrders: 0,
    ...over.exceptions,
  },
});

function fakeApi(v: View = view()): Api {
  return {
    dashboard: vi.fn().mockResolvedValue(v),
    handedOverToday: vi.fn().mockResolvedValue([
      { orderId: "o1", externalRef: "ZP-1001", createdAt: "2026-10-10T09:00:00Z", handedOverAt: "2026-10-10T09:14:00Z", minutes: 14 },
    ]),
    outOfStock: vi.fn().mockResolvedValue([
      { productId: "milk", sku: "MILK-1L", name: "Milk 1L", openShortageUnits: 3 },
      { productId: "ghee", sku: "GHEE", name: "Ghee 500ml", openShortageUnits: 0 },
    ]),
    expiring: vi.fn().mockResolvedValue([
      { productId: "curd", sku: "CURD", name: "Curd 400g", batchId: "b1", lotCode: "C9", expiryDate: "2026-10-09", locationCode: "A-01", status: "expired", onHand: 2 },
      { productId: "curd", sku: "CURD", name: "Curd 400g", batchId: "b2", lotCode: "C10", expiryDate: "2026-10-12", locationCode: "QUAR-1", status: "quarantined", onHand: 1 },
    ]),
  } as unknown as Api;
}

describe("what needs attention", () => {
  it("is empty when nothing waits", () => {
    expect(attentionItems(view(), "s1")).toEqual([]);
  });

  it("puts late missing items and stuck orders first and adds up approvals", () => {
    const items = attentionItems(
      view({ exceptions: { openShortages: 3, escalatedShortages: 1, receiptsAwaitingApproval: 1, countsAwaitingApproval: 2, unitsAwaitingPutaway: 12, problemOrders: 1 } }),
      "s1",
    );
    expect(items.map((i) => [i.text, i.urgent])).toEqual([
      ["3 missing items on orders, 1 waiting too long", true],
      ["1 order stuck with a problem", true],
      ["Waiting for approval: 1 delivery, 2 counts", false],
      ["12 units in the unloading area to put away", false],
    ]);
    expect(items[0]!.route).toEqual({ screen: "shortages", storeId: "s1" });
    expect(items[1]).toMatchObject({ route: { screen: "orders", storeId: "s1" }, permission: "orders.create" });
  });
});

describe("dashboard screen", () => {
  it("shows today's numbers and lists the records behind one when tapped", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Dashboard api={api} storeId="s1" permissions={["dashboard.view"]} />);
    const sent = await screen.findByRole("button", { name: /42 orders sent out/ });
    expect(sent).toHaveTextContent("usually 14 min");
    expect(screen.getByText("orders still to go out").closest(".kpi")).toHaveTextContent("6");
    expect(screen.getByText("Nothing is waiting.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /2 items out of stock/ }));
    const details = await screen.findByRole("region", { name: "Details" });
    expect(await within(details).findByText("Milk 1L")).toBeInTheDocument();
    expect(within(details).getByText("3 wanted on orders")).toBeInTheDocument();
    expect(api.outOfStock).toHaveBeenCalledWith("s1");

    await user.click(screen.getByRole("button", { name: /1 lot expiring/ }));
    expect(await within(details).findByText("Expired 2026-10-09")).toBeInTheDocument();
    expect(within(details).getByText("Expires 2026-10-12")).toBeInTheDocument();
    expect(within(details).getByText(/QUAR-1 · blocked/)).toBeInTheDocument();
    expect(within(details).queryByText("Milk 1L")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /1 lot expiring/ }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Details" })).not.toBeInTheDocument());
  });

  it("links an exception to its screen only for someone who can open it", async () => {
    const v = view({ exceptions: { openShortages: 2, unitsAwaitingPutaway: 5 } });
    const { unmount } = render(<Dashboard api={fakeApi(v)} storeId="s1" permissions={["dashboard.view", "orders.resolve_shortage"]} />);
    expect(await screen.findByRole("link", { name: "2 missing items on orders" })).toHaveAttribute("href", "#/stores/s1/shortages");
    expect(screen.queryByRole("link", { name: /put away/ })).not.toBeInTheDocument();
    expect(screen.getByText("5 units in the unloading area to put away")).toBeInTheDocument();
    unmount();
  });
});
