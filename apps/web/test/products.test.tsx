import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError, type ProductDetail } from "../src/api";
import { Products } from "../src/screens/Products";

const product = (over: Partial<ProductDetail> = {}): ProductDetail => ({
  productId: "milk",
  sku: "MILK-500",
  name: "Milk 500ml",
  category: "Dairy",
  unitOfMeasure: "each",
  batchTracked: true,
  status: "active",
  barcodes: ["8901"],
  ...over,
});

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    catalogue: vi.fn().mockResolvedValue([product(), product({ productId: "oil", sku: "OIL-1", name: "Oil 1L", status: "inactive", batchTracked: false, barcodes: [] })]),
    createProduct: vi.fn(async (_s: string, body: ProductDetail) => ({ ...body, productId: "new", status: "active" })),
    updateProduct: vi.fn(async (_s: string, _id: string, body: Partial<ProductDetail>) => ({ ...product(), ...body })),
    addBarcode: vi.fn(async (_s: string, _id: string, code: string) => product({ barcodes: ["8901", code] })),
    ...overrides,
  } as unknown as Api;
}

describe("products screen", () => {
  it("lists products and searches by what was typed or scanned", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Products api={api} storeId="s1" />);
    expect(await screen.findByText("Milk 500ml")).toBeInTheDocument();
    expect(screen.getByText("Oil 1L").closest("li")).toHaveTextContent("Not sold");
    await user.type(screen.getByLabelText("Find a product"), "8901{Enter}");
    expect(api.catalogue).toHaveBeenLastCalledWith("s1", "8901");
  });

  it("adds a product with barcodes; Enter in the barcode box adds the code, not the product", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Products api={api} storeId="s1" />);
    await screen.findByText("Milk 500ml");
    await user.click(screen.getByRole("button", { name: "New product" }));
    const dialog = screen.getByRole("dialog", { name: "New product" });
    await user.type(within(dialog).getByLabelText("SKU"), " CURD-400 ");
    await user.type(within(dialog).getByLabelText("Name"), "Curd 400g");
    await user.type(within(dialog).getByLabelText("Category"), "Dairy");
    await user.click(within(dialog).getByLabelText(/Has a lot and expiry date/));
    await user.type(within(dialog).getByLabelText("Barcode"), "111{Enter}222{Enter}333{Enter}");
    expect(api.createProduct).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Remove 222" }));
    await user.click(within(dialog).getByRole("button", { name: "Add product" }));

    await waitFor(() =>
      expect(api.createProduct).toHaveBeenCalledWith(
        "s1",
        { sku: "CURD-400", name: "Curd 400g", category: "Dairy", unitOfMeasure: "each", batchTracked: true, barcodes: ["111", "333"] },
        expect.any(String),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Added Curd 400g");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the form open and shows why when the server refuses", async () => {
    const api = fakeApi({ createProduct: vi.fn().mockRejectedValue(new ApiError(409, "conflict", "A product with this SKU already exists")) });
    const user = userEvent.setup();
    render(<Products api={api} storeId="s1" />);
    await screen.findByText("Milk 500ml");
    await user.click(screen.getByRole("button", { name: "New product" }));
    const dialog = screen.getByRole("dialog", { name: "New product" });
    await user.type(within(dialog).getByLabelText("SKU"), "MILK-500");
    await user.type(within(dialog).getByLabelText("Name"), "Milk");
    await user.type(within(dialog).getByLabelText("Category"), "Dairy");
    await user.click(within(dialog).getByRole("button", { name: "Add product" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A product with this SKU already exists");
    expect(within(dialog).getByRole("button", { name: "Add product" })).toBeEnabled();
  });

  it("edits only what changed and adds a barcode straight away", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Products api={api} storeId="s1" />);
    const row = (await screen.findByText("Milk 500ml")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Milk 500ml" });

    await user.type(within(dialog).getByLabelText("Add barcode"), "8902{Enter}");
    expect(api.addBarcode).toHaveBeenCalledWith("s1", "milk", "8902", expect.any(String));
    expect(await within(dialog).findByText("8902")).toBeInTheDocument();
    expect(api.updateProduct).not.toHaveBeenCalled();

    await user.selectOptions(within(dialog).getByLabelText("Status"), "inactive");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateProduct).toHaveBeenCalledWith("s1", "milk", { status: "inactive" }, expect.any(String)));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Milk 500ml");
  });
});
