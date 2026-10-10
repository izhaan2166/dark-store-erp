import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError, type Location } from "../src/api";
import { codeRange, Shelves } from "../src/screens/Shelves";

const LOCATIONS: Location[] = [
  { locationId: "a1", code: "A-01-01", kind: "bin", purpose: "storage", status: "active", allocatable: true },
  { locationId: "a2", code: "A-01-02", kind: "bin", purpose: "storage", status: "active", allocatable: false },
  { locationId: "a3", code: "A-01-03", kind: "bin", purpose: "storage", status: "inactive", allocatable: true },
  { locationId: "r1", code: "DOCK-1", kind: "zone", purpose: "receiving", status: "active", allocatable: false },
];

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    locations: vi.fn().mockResolvedValue(LOCATIONS),
    updateLocation: vi.fn(async (_s: string, id: string, body: Partial<Location>) => ({ ...LOCATIONS.find((l) => l.locationId === id)!, ...body })),
    createLocation: vi.fn(async (_s: string, body: Location) => ({ ...body, locationId: body.code, status: "active" })),
    ...overrides,
  } as unknown as Api;
}

describe("codeRange", () => {
  it("counts up the last number, keeping its zero padding", () => {
    expect(codeRange("A-01-08", "11")).toEqual(["A-01-08", "A-01-09", "A-01-10", "A-01-11"]);
    expect(codeRange("B7", "9")).toEqual(["B7", "B8", "B9"]);
    expect(codeRange(" DOCK-1 ", "")).toEqual(["DOCK-1"]);
  });

  it("refuses runs that make no sense or are too long", () => {
    expect(codeRange("", "")).toBeNull();
    expect(codeRange("DOCK", "3")).toBeNull();
    expect(codeRange("A-05", "3")).toBeNull();
    expect(codeRange("A-05", "x")).toBeNull();
    expect(codeRange("A-001", "100")).toHaveLength(100);
    expect(codeRange("A-001", "101")).toBeNull();
  });
});

describe("shelves screen", () => {
  it("groups shelves by use and switches them on, off and out of orders", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Shelves api={api} storeId="s1" />);
    const storage = (await screen.findByRole("heading", { name: "Storage shelves" })).closest("section") as HTMLElement;
    expect(screen.getByRole("heading", { name: "Unloading areas" }).closest("section")).toHaveTextContent("DOCK-1");
    expect(within(storage).getByText("A-01-02").closest("li")).toHaveTextContent("Not for orders");
    expect(within(storage).getByText("A-01-03").closest("li")).toHaveTextContent("Turned off");

    const first = within(storage).getByText("A-01-01").closest("li") as HTMLElement;
    await user.click(within(first).getByRole("button", { name: "Stop using for orders" }));
    expect(api.updateLocation).toHaveBeenCalledWith("s1", "a1", { allocatable: false }, expect.any(String));
    expect(await within(first).findByRole("button", { name: "Use for orders" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("A-01-01: orders will no longer take stock from here");

    const off = within(storage).getByText("A-01-03").closest("li") as HTMLElement;
    await user.click(within(off).getByRole("button", { name: "Turn on" }));
    expect(api.updateLocation).toHaveBeenCalledWith("s1", "a3", { status: "active" }, expect.any(String));
  });

  it("says why a shelf holding stock cannot be turned off", async () => {
    const api = fakeApi({
      updateLocation: vi.fn().mockRejectedValue(new ApiError(409, "conflict", "Move the stock out before deactivating this location")),
    });
    const user = userEvent.setup();
    render(<Shelves api={api} storeId="s1" />);
    const first = (await screen.findByText("A-01-01")).closest("li") as HTMLElement;
    await user.click(within(first).getByRole("button", { name: "Turn off" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A-01-01: Move the stock out before deactivating this location");
    expect(within(first).getByRole("button", { name: "Turn off" })).toBeEnabled();
  });

  it("filters by code", async () => {
    const user = userEvent.setup();
    render(<Shelves api={fakeApi()} storeId="s1" />);
    await screen.findByText("DOCK-1");
    await user.type(screen.getByLabelText("Find a shelf"), "dock");
    expect(screen.queryByText("A-01-01")).not.toBeInTheDocument();
    expect(screen.getByText("DOCK-1")).toBeInTheDocument();
  });

  it("adds a numbered run of shelves one at a time and reports any that already exist", async () => {
    const createLocation = vi.fn(async (_s: string, body: Location) => {
      if (body.code === "B-02") throw new ApiError(409, "conflict", "A location with this code already exists");
      return { ...body, locationId: body.code, status: "active" };
    });
    const api = fakeApi({ createLocation });
    const user = userEvent.setup();
    render(<Shelves api={api} storeId="s1" />);
    await screen.findByText("A-01-01");
    await user.click(screen.getByRole("button", { name: "Add shelves" }));
    const dialog = screen.getByRole("dialog", { name: "Add shelves" });
    await user.type(within(dialog).getByLabelText("Code"), "B-01");
    await user.type(within(dialog).getByLabelText(/Up to number/), "3");
    expect(dialog).toHaveTextContent("Adds 3: B-01 to B-03");
    await user.click(within(dialog).getByLabelText("Orders can take stock from here"));
    await user.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(createLocation).toHaveBeenCalledTimes(3));
    expect(createLocation.mock.calls.map((c) => c[1])).toEqual(
      ["B-01", "B-02", "B-03"].map((code) => ({ code, purpose: "storage", kind: "bin", allocatable: false })),
    );
    const keys = createLocation.mock.calls.map((c) => (c as unknown[])[2]);
    expect(new Set(keys).size).toBe(3);
    expect(await screen.findByRole("alert")).toHaveTextContent("Added 2 of 3. B-02: A location with this code already exists");
    expect(api.locations).toHaveBeenCalledTimes(2);
  });

  it("never marks a non-storage area as stock for orders", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Shelves api={api} storeId="s1" />);
    await screen.findByText("A-01-01");
    await user.click(screen.getByRole("button", { name: "Add shelves" }));
    const dialog = screen.getByRole("dialog", { name: "Add shelves" });
    await user.type(within(dialog).getByLabelText("Code"), "QUAR-2");
    await user.selectOptions(within(dialog).getByLabelText("Used for"), "quarantine");
    await user.selectOptions(within(dialog).getByLabelText("Type"), "zone");
    expect(within(dialog).queryByLabelText("Orders can take stock from here")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(api.createLocation).toHaveBeenCalledWith("s1", { code: "QUAR-2", purpose: "quarantine", kind: "zone", allocatable: false }, expect.any(String)),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Added QUAR-2");
  });
});
