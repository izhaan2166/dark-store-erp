/** Thin client for the ERP API. Every write carries an idempotency key. */

export type Permission = string;

export interface StoreAccess {
  storeId: string;
  code: string;
  name: string;
  roles: string[];
  permissions: Permission[];
}

export interface Session {
  token: string;
  expiresAt: string;
  user: { id: string; email: string; name: string };
  stores: StoreAccess[];
}

export interface OrderSummary {
  orderId: string;
  externalRef: string;
  status: string;
  createdAt: string;
  lineCount: number;
  requestedUnits: number;
  pickedUnits: number;
  openShortages: number;
}

export interface PickTask {
  locationId: string;
  locationCode: string;
  batchId: string | null;
  lotCode: string | null;
  expiryDate: string | null;
  quantity: number;
}

export interface FulfilmentLine {
  orderItemId: string;
  lineNo: number;
  productId: string;
  sku: string;
  name: string;
  requestedQty: number;
  reservedQty: number;
  pickedQty: number;
  fulfilledQty: number;
  openShortageQty: number;
  substitutesItemId: string | null;
  tasks: PickTask[];
}

export interface FulfilmentView {
  orderId: string;
  status: string;
  lines: FulfilmentLine[];
  openShortages: { shortageId: string; orderItemId: string; source: string; quantity: number; escalatedAt: string | null }[];
}

export interface Product {
  productId: string;
  sku: string;
  name: string;
  batchTracked?: boolean;
}

/** A product as the catalogue screens edit it. */
export interface ProductDetail extends Product {
  category: string;
  unitOfMeasure: string;
  batchTracked: boolean;
  status: "active" | "inactive";
  barcodes: string[];
}

export interface NewProduct {
  sku: string;
  name: string;
  category: string;
  unitOfMeasure: string;
  batchTracked: boolean;
  barcodes: string[];
}

export interface NewLocation {
  code: string;
  kind: "zone" | "rack" | "shelf" | "bin";
  purpose: "storage" | "receiving" | "packing" | "quarantine";
  allocatable?: boolean;
}

export interface OpenShortage {
  shortageId: string;
  orderId: string;
  externalRef: string;
  orderStatus: string;
  orderItemId: string;
  productId: string;
  sku: string;
  name: string;
  source: string;
  quantity: number;
  createdAt: string;
  escalatedAt: string | null;
}

/** What accepting an order reserved: a line's shortQty is waiting under Missing items. */
export interface AcceptedOrder {
  orderId: string;
  status: string;
  fullyReserved: boolean;
  lines: { productId: string; requestedQty: number; reservedQty: number; shortQty: number }[];
}

export interface ProductStock {
  productId: string;
  availableToPromise: number;
}

export type Resolution =
  | { resolution: "reallocate"; reason: string }
  | { resolution: "remove"; reason: string }
  | { resolution: "substitute"; reason: string; substituteProductId: string; quantity: number };

export interface PurchaseOrderSummary {
  purchaseOrderId: string;
  poNumber: string;
  supplierName: string;
  status: string;
  createdAt: string;
  lineCount: number;
  orderedUnits: number;
  outstandingUnits: number;
  pendingReceipts: number;
}

export interface PurchaseOrderLine {
  purchaseOrderLineId: string;
  lineNo: number;
  productId: string;
  sku: string;
  name: string;
  batchTracked: boolean;
  orderedQty: number;
  receivedQty: number;
  outstandingQty: number;
}

export interface PurchaseOrderView {
  purchaseOrderId: string;
  poNumber: string;
  supplierName: string;
  status: string;
  pendingReceipts: number;
  lines: PurchaseOrderLine[];
}

export interface ReceiptLine {
  productId: string;
  acceptedQty: number;
  damagedQty: number;
  rejectedQty: number;
  lotCode?: string;
  expiryDate?: string;
}

export interface ReceiptView {
  goodsReceiptId: string;
  status: "pending_approval" | "posted" | "cancelled";
  receivingLocationId: string;
  lines: { productId: string; expectedQty: number; acceptedQty: number; needsApproval: boolean }[];
  discrepancies: { goodsReceiptLineId: string; kind: string; quantity: number }[];
}

export interface CountLine {
  productId: string;
  batchId: string | null;
  countedQty: number;
}

export interface CountView {
  stockCountId: string;
  status: "pending_approval" | "posted" | "rejected";
  lines: { productId: string; batchId: string | null; bookQty: number; countedQty: number; variance: number; needsApproval: boolean }[];
}

export interface Location {
  locationId: string;
  code: string;
  purpose: string;
  status: string;
  kind?: string;
  allocatable?: boolean;
}

export interface StockRow {
  productId: string;
  sku: string;
  name: string;
  locationId: string;
  locationCode: string;
  batchId: string | null;
  lotCode: string | null;
  expiryDate: string | null;
  status: string;
  onHand: number;
  /** On hand minus what orders have reserved. */
  free: number;
}

export interface ReceiptSummary {
  goodsReceiptId: string;
  createdAt: string;
  poNumber: string | null;
  supplierName: string;
  receivedByName: string;
  lines: {
    productId: string;
    sku: string;
    name: string;
    lotCode: string | null;
    expiryDate: string | null;
    expectedQty: number;
    acceptedQty: number;
    damagedQty: number;
    rejectedQty: number;
    needsApproval: boolean;
  }[];
}

export interface CountSummary {
  stockCountId: string;
  createdAt: string;
  locationCode: string;
  countedByName: string;
  lines: {
    productId: string;
    sku: string;
    name: string;
    lotCode: string | null;
    bookQty: number;
    countedQty: number;
    variance: number;
    varianceValuePaise: number | null;
    needsApproval: boolean;
  }[];
}

export interface StockRequestSummary {
  id: string;
  kind: "release" | "write_off";
  productId: string;
  batchId: string | null;
  fromLocationId: string;
  quantity: number;
  reason: string;
  fromStatus: string;
  createdAt: string;
  sku: string;
  productName: string;
  lotCode: string | null;
  expiryDate: string | null;
  fromLocationCode: string;
  toLocationCode: string | null;
  requestedByName: string;
}

export type Decision = "approve" | "reject";

/** An error the API explained, e.g. `wrong_item` or `insufficient_stock`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

const BASE = "/api";

export const newKey = (): string => crypto.randomUUID();

export class Api {
  constructor(
    private readonly token: string | null,
    private readonly onSignedOut: () => void = () => {},
  ) {}

  login(email: string, password: string): Promise<Session> {
    return this.call("POST", "/auth/login", { body: { email, password } });
  }

  logout(): Promise<void> {
    return this.call("POST", "/auth/logout", { key: newKey() });
  }

  orders(storeId: string, status = "accepted,picking"): Promise<OrderSummary[]> {
    return this.call("GET", `/stores/${storeId}/orders?status=${encodeURIComponent(status)}`);
  }

  acceptOrder(storeId: string, body: { externalRef: string; lines: { productId: string; quantity: number }[] }, key: string): Promise<AcceptedOrder> {
    return this.call("POST", `/stores/${storeId}/orders`, { body, key });
  }

  cancelOrder(storeId: string, orderId: string, reason: string, key: string): Promise<unknown> {
    return this.call("POST", `/stores/${storeId}/orders/${orderId}/cancel`, { body: { reason }, key });
  }

  fulfilment(storeId: string, orderId: string): Promise<FulfilmentView> {
    return this.call("GET", `/stores/${storeId}/orders/${orderId}/fulfilment`);
  }

  product(storeId: string, barcode: string): Promise<Product> {
    return this.call("GET", `/stores/${storeId}/barcodes/${encodeURIComponent(barcode)}`);
  }

  startPicking(storeId: string, orderId: string, key: string): Promise<FulfilmentView> {
    return this.call("POST", `/stores/${storeId}/orders/${orderId}/start-picking`, { key });
  }

  pick(
    storeId: string,
    orderId: string,
    body: { orderItemId: string; locationId: string; barcode: string; quantity: number },
    key: string,
  ): Promise<FulfilmentView> {
    return this.call("POST", `/stores/${storeId}/orders/${orderId}/picks`, { body, key });
  }

  shortPick(
    storeId: string,
    orderId: string,
    body: { orderItemId: string; locationId: string; quantity: number; reason: string },
    key: string,
  ): Promise<FulfilmentView> {
    return this.call("POST", `/stores/${storeId}/orders/${orderId}/short-picks`, { body, key });
  }

  completePicking(storeId: string, orderId: string, key: string): Promise<FulfilmentView> {
    return this.call("POST", `/stores/${storeId}/orders/${orderId}/complete-picking`, { key });
  }

  shortages(storeId: string): Promise<OpenShortage[]> {
    return this.call("GET", `/stores/${storeId}/shortages`);
  }

  resolveShortage(storeId: string, orderId: string, shortageId: string, body: Resolution, key: string): Promise<FulfilmentView> {
    return this.call("POST", `/stores/${storeId}/orders/${orderId}/shortages/${shortageId}/resolve`, { body, key });
  }

  searchProducts(storeId: string, q: string): Promise<Product[]> {
    return this.call<{ items: Product[] }>(
      "GET",
      `/stores/${storeId}/products?status=active&limit=10&q=${encodeURIComponent(q)}`,
    ).then((r) => r.items);
  }

  stock(storeId: string, productId: string): Promise<ProductStock> {
    return this.call("GET", `/stores/${storeId}/inventory/products/${productId}`);
  }

  pack(storeId: string, orderId: string, lines: { orderItemId: string; quantity: number }[], key: string): Promise<FulfilmentView> {
    return this.call("POST", `/stores/${storeId}/orders/${orderId}/pack`, { body: { lines }, key });
  }

  handover(storeId: string, orderId: string, key: string): Promise<FulfilmentView> {
    return this.call("POST", `/stores/${storeId}/orders/${orderId}/handover`, { key });
  }

  purchaseOrders(storeId: string): Promise<PurchaseOrderSummary[]> {
    return this.call("GET", `/stores/${storeId}/purchase-orders?status=open`);
  }

  purchaseOrder(storeId: string, purchaseOrderId: string): Promise<PurchaseOrderView> {
    return this.call("GET", `/stores/${storeId}/purchase-orders/${purchaseOrderId}`);
  }

  recordReceipt(
    storeId: string,
    body: { purchaseOrderId: string; receivingLocationId: string; lines: ReceiptLine[] },
    key: string,
  ): Promise<ReceiptView> {
    return this.call("POST", `/stores/${storeId}/goods-receipts`, { body, key });
  }

  locations(storeId: string): Promise<Location[]> {
    return this.call("GET", `/stores/${storeId}/locations`);
  }

  stockRows(storeId: string, filter: { status?: string; productId?: string; locationId?: string }): Promise<StockRow[]> {
    const query = new URLSearchParams({ limit: "500" });
    for (const [name, value] of Object.entries(filter)) if (value) query.set(name, value);
    return this.call<{ items: StockRow[] }>("GET", `/stores/${storeId}/inventory?${query}`).then((r) => r.items);
  }

  putaway(
    storeId: string,
    body: { productId: string; batchId: string | null; fromLocationId: string; toLocationId: string; quantity: number },
    key: string,
  ): Promise<{ putawayId: string }> {
    return this.call("POST", `/stores/${storeId}/putaways`, { body, key });
  }

  submitCount(storeId: string, body: { locationId: string; lines: CountLine[] }, key: string): Promise<CountView> {
    return this.call("POST", `/stores/${storeId}/stock-counts`, { body, key });
  }

  pendingReceipts(storeId: string): Promise<ReceiptSummary[]> {
    return this.call("GET", `/stores/${storeId}/goods-receipts?status=pending_approval`);
  }

  pendingCounts(storeId: string): Promise<CountSummary[]> {
    return this.call("GET", `/stores/${storeId}/stock-counts?status=pending_approval`);
  }

  pendingRequests(storeId: string): Promise<StockRequestSummary[]> {
    return this.call("GET", `/stores/${storeId}/stock-requests?status=pending_approval`);
  }

  /** Approving a receipt posts its stock; rejecting cancels it. */
  decideReceipt(storeId: string, id: string, decision: Decision, reason: string, key: string): Promise<unknown> {
    const action = decision === "approve" ? "approve" : "cancel";
    return this.call("POST", `/stores/${storeId}/goods-receipts/${id}/${action}`, { body: { reason }, key });
  }

  decideCount(storeId: string, id: string, decision: Decision, reason: string, key: string): Promise<unknown> {
    return this.call("POST", `/stores/${storeId}/stock-counts/${id}/${decision}`, { body: { reason }, key });
  }

  decideRequest(storeId: string, id: string, decision: Decision, reason: string, key: string): Promise<unknown> {
    return this.call("POST", `/stores/${storeId}/stock-requests/${id}/${decision}`, { body: { reason }, key });
  }

  quarantine(
    storeId: string,
    body: { productId: string; batchId: string | null; fromLocationId: string; toLocationId: string; quantity: number; reason: string },
    key: string,
  ): Promise<unknown> {
    return this.call("POST", `/stores/${storeId}/quarantines`, { body, key });
  }

  requestRelease(
    storeId: string,
    body: { productId: string; batchId: string | null; fromLocationId: string; toLocationId: string; quantity: number; reason: string },
    key: string,
  ): Promise<unknown> {
    return this.call("POST", `/stores/${storeId}/stock-requests/release`, { body, key });
  }

  requestWriteOff(
    storeId: string,
    body: { productId: string; batchId: string | null; locationId: string; status: string; quantity: number; reason: string },
    key: string,
  ): Promise<unknown> {
    return this.call("POST", `/stores/${storeId}/stock-requests/write-off`, { body, key });
  }

  catalogue(storeId: string, q: string): Promise<ProductDetail[]> {
    const query = new URLSearchParams({ limit: "50" });
    if (q.trim()) query.set("q", q.trim());
    return this.call<{ items: ProductDetail[] }>("GET", `/stores/${storeId}/products?${query}`).then((r) => r.items);
  }

  createProduct(storeId: string, body: NewProduct, key: string): Promise<ProductDetail> {
    return this.call("POST", `/stores/${storeId}/products`, { body, key });
  }

  updateProduct(
    storeId: string,
    productId: string,
    body: Partial<Pick<ProductDetail, "name" | "category" | "unitOfMeasure" | "status">>,
    key: string,
  ): Promise<ProductDetail> {
    return this.call("PATCH", `/stores/${storeId}/products/${productId}`, { body, key });
  }

  addBarcode(storeId: string, productId: string, barcode: string, key: string): Promise<ProductDetail> {
    return this.call("POST", `/stores/${storeId}/products/${productId}/barcodes`, { body: { barcode }, key });
  }

  createLocation(storeId: string, body: NewLocation, key: string): Promise<Location> {
    return this.call("POST", `/stores/${storeId}/locations`, { body, key });
  }

  updateLocation(storeId: string, locationId: string, body: { status?: string; allocatable?: boolean }, key: string): Promise<Location> {
    return this.call("PATCH", `/stores/${storeId}/locations/${locationId}`, { body, key });
  }

  /**
   * Sends one request. A write is retried once with the same key if the
   * network drops, so a scan that reached the server is never applied twice.
   */
  private async call<T>(method: "GET" | "POST" | "PATCH", path: string, opts: { body?: unknown; key?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (opts.key) headers["Idempotency-Key"] = opts.key;
    const init: RequestInit = { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) };

    let response: Response;
    try {
      response = await fetch(BASE + path, init);
    } catch {
      if (method === "GET" || !opts.key) throw new ApiError(0, "offline", "No connection. Check the Wi-Fi and try again.");
      try {
        response = await fetch(BASE + path, init);
      } catch {
        throw new ApiError(0, "offline", "No connection. Check the Wi-Fi and try again.");
      }
    }

    if (response.status === 401 && this.token) this.onSignedOut();
    if (response.status === 204) return undefined as T;
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new ApiError(
        response.status,
        error?.code ?? "error",
        error?.message ?? `Request failed (${response.status})`,
        error?.details ?? null,
      );
    }
    return data as T;
  }
}
