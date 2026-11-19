/**
 * Protocols v7 — UCP read-only adapter (v1.38, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v138.md: UCP v2026-08-25 (Google + Shopify +
 * Stripe) covers catalog search, cart, identity linking,
 * checkout and order management. Huy's standing direction drops
 * payments / accounts / cloud — so v7 implements UCP READ-ONLY:
 *
 *   - Implemented: catalog/search, catalog/get, catalog/list,
 *     cart/get, order/get, order/list, identity/status.
 *   - REFUSED by construction: checkout/create, checkout/
 *     complete, payment/authorize, payment/capture, payment/
 *     refund, order/place, cart/add, cart/checkout. These are
 *     not "unimplemented yet" — the adapter has no code path
 *     that moves money, and `attemptOperation()` refuses them
 *     with a typed error.
 *
 * The adapter wraps a host-supplied read-only backend
 * (`UcpV7ReadOnlyBackend`). A small in-memory demo backend
 * (`UcpV7MemoryBackend`) ships with clearly-labelled demo
 * catalog data for tests and offline use. No credentials are
 * stored, no payment instrument is ever accepted, and no
 * account is ever created or linked by this module.
 *
 * No code, text or asset from any other repo is copied here.
 */

import {
  UCP_V7_CURRENT_VERSION,
  UCP_V7_READ_OPERATIONS,
  UCP_V7_REFUSED_OPERATIONS,
  UCP_V7_REFUSAL_NOTE,
  type UcpV7ReadOperation,
  type UcpV7RefusedOperation,
} from './versions';

/** Error raised when a caller attempts a money-moving UCP operation. */
export class UcpV7MoneyRefusedError extends Error {
  readonly operation: string;
  constructor(operation: string) {
    super(`UCP operation "${operation}" is refused: ${UCP_V7_REFUSAL_NOTE}`);
    this.name = 'UcpV7MoneyRefusedError';
    this.operation = operation;
  }
}

/** Error raised by the UCP read-only layer (bad input, missing item). */
export class UcpV7ReadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UcpV7ReadError';
    this.code = code;
  }
}

/** Money: minor-unit amount + ISO 4217 currency. */
export interface UcpV7Money {
  /** Amount in minor units (e.g. cents for USD, dong for VND). */
  amountMinor: number;
  /** ISO 4217 currency code (e.g. `USD`, `VND`). */
  currency: string;
}

/** One catalog item. */
export interface UcpV7CatalogItem {
  id: string;
  title: string;
  description: string;
  price: UcpV7Money;
  /** In-stock quantity (0 = out of stock). */
  stock: number;
  /** Seller / merchant name. */
  seller: string;
  /** Product URL (when the backend knows one). */
  url?: string;
  /** Image URL (when the backend knows one). */
  imageUrl?: string;
  /** Category tags. */
  categories?: string[];
}

/** One line in a cart / order. */
export interface UcpV7LineItem {
  itemId: string;
  title: string;
  quantity: number;
  unitPrice: UcpV7Money;
  /** Line total (unitPrice * quantity). */
  lineTotal: UcpV7Money;
}

/** A cart (read-only view). */
export interface UcpV7Cart {
  id: string;
  /** Owner identity (opaque id, never an account handle). */
  ownerId: string;
  items: UcpV7LineItem[];
  subtotal: UcpV7Money;
  currency: string;
  updatedAtMs: number;
}

/** Order status (read-only view). */
export type UcpV7OrderStatus = 'created' | 'confirmed' | 'shipped' | 'delivered' | 'canceled' | 'refunded';

/** An order (read-only view). */
export interface UcpV7Order {
  id: string;
  ownerId: string;
  status: UcpV7OrderStatus;
  items: UcpV7LineItem[];
  total: UcpV7Money;
  currency: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** Tracking number (when shipped). */
  trackingNumber?: string;
}

/** Identity linking status (read-only: never links or unlinks). */
export interface UcpV7IdentityStatus {
  ownerId: string;
  /** Whether an identity is linked at the merchant. */
  linked: boolean;
  /** Merchant the identity is linked to (when linked). */
  merchant?: string;
  /** When the link was last verified (ms since epoch). */
  lastVerifiedMs?: number;
}

/** Catalog search result page. */
export interface UcpV7CatalogPage {
  items: UcpV7CatalogItem[];
  /** Total matches (before paging). */
  total: number;
  /** Offset of this page. */
  offset: number;
  /** Page size. */
  limit: number;
  /** Query that produced this page (echoed). */
  query: string;
}

/** Order list page. */
export interface UcpV7OrderPage {
  orders: UcpV7Order[];
  total: number;
  offset: number;
  limit: number;
}

/** The read-only backend interface (host-supplied). */
export interface UcpV7ReadOnlyBackend {
  /** Search the catalog (case-insensitive substring over title/description/seller). */
  searchCatalog(query: string, offset: number, limit: number): Promise<UcpV7CatalogPage> | UcpV7CatalogPage;
  /** Get one catalog item (null when missing). */
  getCatalogItem(id: string): Promise<UcpV7CatalogItem | null> | UcpV7CatalogItem | null;
  /** List catalog items (paged, newest first by id order). */
  listCatalog(offset: number, limit: number): Promise<UcpV7CatalogPage> | UcpV7CatalogPage;
  /** Get a cart (null when missing). */
  getCart(id: string): Promise<UcpV7Cart | null> | UcpV7Cart | null;
  /** Get an order (null when missing). */
  getOrder(id: string): Promise<UcpV7Order | null> | UcpV7Order | null;
  /** List orders for one owner (paged, newest first). */
  listOrders(ownerId: string, offset: number, limit: number): Promise<UcpV7OrderPage> | UcpV7OrderPage;
  /** Identity linking status for one owner. */
  identityStatus(ownerId: string): Promise<UcpV7IdentityStatus> | UcpV7IdentityStatus;
}

/** True when the operation is a read operation (implemented). */
export function isUcpV7ReadOperation(operation: string): operation is UcpV7ReadOperation {
  return (UCP_V7_READ_OPERATIONS as readonly string[]).includes(operation);
}

/** True when the operation moves money (refused). */
export function isUcpV7RefusedOperation(operation: string): operation is UcpV7RefusedOperation {
  return (UCP_V7_REFUSED_OPERATIONS as readonly string[]).includes(operation);
}

/**
 * Format money for display: `123.45 USD`, `250000 VND` (VND
 * has no minor units — the amount is already whole dong).
 * Never formats a value the adapter does not hold.
 */
export function formatUcpV7Money(money: UcpV7Money, locale = 'en-US'): string {
  const zeroDecimal = new Set(['VND', 'JPY', 'KRW']);
  const divisor = zeroDecimal.has(money.currency.toUpperCase()) ? 1 : 100;
  const major = money.amountMinor / divisor;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: money.currency,
      minimumFractionDigits: divisor === 1 ? 0 : 2,
      maximumFractionDigits: divisor === 1 ? 0 : 2,
    }).format(major);
  } catch {
    return `${major} ${money.currency}`;
  }
}

/** Add two money values (same currency required). */
export function addUcpV7Money(a: UcpV7Money, b: UcpV7Money): UcpV7Money {
  if (a.currency !== b.currency) {
    throw new UcpV7ReadError('currency-mismatch', `Cannot add ${a.currency} and ${b.currency}.`);
  }
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

/** Multiply money by a quantity (line totals). */
export function multiplyUcpV7Money(money: UcpV7Money, quantity: number): UcpV7Money {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new UcpV7ReadError('invalid-quantity', 'Quantity must be a non-negative integer.');
  }
  return { amountMinor: money.amountMinor * quantity, currency: money.currency };
}

/**
 * Read-only UCP adapter: validates inputs, enforces paging
 * limits, and refuses money operations before any backend is
 * touched. Every method is read-only — the adapter holds no
 * write path at all.
 */
export class UcpV7ReadOnlyAdapter {
  private backend: UcpV7ReadOnlyBackend;
  /** UCP version this adapter speaks. */
  readonly version = UCP_V7_CURRENT_VERSION;
  /** Implementation kind: always `read-only`. */
  readonly implementation = 'read-only' as const;

  constructor(backend: UcpV7ReadOnlyBackend) {
    this.backend = backend;
  }

  /** The read operations this adapter implements. */
  readOperations(): readonly UcpV7ReadOperation[] {
    return UCP_V7_READ_OPERATIONS;
  }

  /** The operations this adapter refuses (money-moving). */
  refusedOperations(): readonly UcpV7RefusedOperation[] {
    return UCP_V7_REFUSED_OPERATIONS;
  }

  /**
   * Attempt any UCP operation by name. Read operations run;
   * money operations throw `UcpV7MoneyRefusedError`; unknown
   * operations throw `UcpV7ReadError`. Useful for the tool
   * layer, which passes the agent's requested operation through.
   */
  async attemptOperation(
    operation: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (isUcpV7RefusedOperation(operation)) {
      throw new UcpV7MoneyRefusedError(operation);
    }
    switch (operation) {
      case 'catalog/search':
        return this.searchCatalog(String(params.query ?? ''), params);
      case 'catalog/get':
        return this.getCatalogItem(String(params.id ?? ''));
      case 'catalog/list':
        return this.listCatalog(params);
      case 'cart/get':
        return this.getCart(String(params.id ?? ''));
      case 'order/get':
        return this.getOrder(String(params.id ?? ''));
      case 'order/list':
        return this.listOrders(String(params.ownerId ?? ''), params);
      case 'identity/status':
        return this.identityStatus(String(params.ownerId ?? ''));
      default:
        throw new UcpV7ReadError('unknown-operation', `Unknown UCP operation "${operation}".`);
    }
  }

  /** Search the catalog (query required, paged). */
  async searchCatalog(query: string, options: { offset?: number; limit?: number } = {}): Promise<UcpV7CatalogPage> {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new UcpV7ReadError('invalid-query', 'Catalog search needs a non-empty query.');
    }
    const { offset, limit } = this.pageOptions(options);
    return this.backend.searchCatalog(query.trim(), offset, limit);
  }

  /** Get one catalog item (throws when missing). */
  async getCatalogItem(id: string): Promise<UcpV7CatalogItem> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new UcpV7ReadError('invalid-id', 'Catalog item id is required.');
    }
    const item = await this.backend.getCatalogItem(id);
    if (!item) throw new UcpV7ReadError('not-found', `Catalog item ${id} does not exist.`);
    return item;
  }

  /** List catalog items (paged). */
  async listCatalog(options: { offset?: number; limit?: number } = {}): Promise<UcpV7CatalogPage> {
    const { offset, limit } = this.pageOptions(options);
    return this.backend.listCatalog(offset, limit);
  }

  /** Get a cart (throws when missing). */
  async getCart(id: string): Promise<UcpV7Cart> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new UcpV7ReadError('invalid-id', 'Cart id is required.');
    }
    const cart = await this.backend.getCart(id);
    if (!cart) throw new UcpV7ReadError('not-found', `Cart ${id} does not exist.`);
    return cart;
  }

  /** Get an order (throws when missing). */
  async getOrder(id: string): Promise<UcpV7Order> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new UcpV7ReadError('invalid-id', 'Order id is required.');
    }
    const order = await this.backend.getOrder(id);
    if (!order) throw new UcpV7ReadError('not-found', `Order ${id} does not exist.`);
    return order;
  }

  /** List orders for one owner (paged, newest first). */
  async listOrders(ownerId: string, options: { offset?: number; limit?: number } = {}): Promise<UcpV7OrderPage> {
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
      throw new UcpV7ReadError('invalid-owner', 'Order list needs an owner id.');
    }
    const { offset, limit } = this.pageOptions(options);
    return this.backend.listOrders(ownerId, offset, limit);
  }

  /** Identity linking status (read-only: never links or unlinks). */
  async identityStatus(ownerId: string): Promise<UcpV7IdentityStatus> {
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
      throw new UcpV7ReadError('invalid-owner', 'Identity status needs an owner id.');
    }
    return this.backend.identityStatus(ownerId);
  }

  private pageOptions(options: { offset?: number; limit?: number }): { offset: number; limit: number } {
    const offset = options.offset === undefined ? 0 : Math.max(0, Math.floor(options.offset));
    const limit = options.limit === undefined ? 20 : Math.max(1, Math.min(100, Math.floor(options.limit)));
    return { offset, limit };
  }
}

/** Demo catalog item seed (clearly demo data — no real merchant). */
export const UCP_V7_DEMO_CATALOG: UcpV7CatalogItem[] = [
  {
    id: 'demo-notebook-001',
    title: 'Demo Notebook (A5, dotted)',
    description: 'Demo catalog item for offline UCP read-only tests. Not a real product.',
    price: { amountMinor: 1299, currency: 'USD' },
    stock: 42,
    seller: 'Demo Store',
    categories: ['stationery', 'demo'],
  },
  {
    id: 'demo-lamp-002',
    title: 'Demo Desk Lamp (USB-C)',
    description: 'Demo catalog item for offline UCP read-only tests. Not a real product.',
    price: { amountMinor: 3499, currency: 'USD' },
    stock: 7,
    seller: 'Demo Store',
    categories: ['home', 'demo'],
  },
  {
    id: 'demo-tea-003',
    title: 'Demo Green Tea (100g)',
    description: 'Demo catalog item for offline UCP read-only tests. Not a real product.',
    price: { amountMinor: 850, currency: 'USD' },
    stock: 0,
    seller: 'Demo Tea House',
    categories: ['food', 'demo'],
  },
  {
    id: 'demo-keyboard-004',
    title: 'Demo Mechanical Keyboard',
    description: 'Demo catalog item for offline UCP read-only tests. Not a real product.',
    price: { amountMinor: 8999, currency: 'USD' },
    stock: 15,
    seller: 'Demo Store',
    categories: ['electronics', 'demo'],
  },
];

/**
 * In-memory demo backend: serves the demo catalog plus carts /
 * orders the host seeds. Offline-only; nothing here talks to a
 * merchant. Carts and orders are read-only views — the backend
 * has no method that creates or changes them.
 */
export class UcpV7MemoryBackend implements UcpV7ReadOnlyBackend {
  private items: UcpV7CatalogItem[];
  private carts = new Map<string, UcpV7Cart>();
  private orders = new Map<string, UcpV7Order>();
  private linkedOwners = new Set<string>();

  constructor(items: UcpV7CatalogItem[] = UCP_V7_DEMO_CATALOG) {
    this.items = items.map((item) => ({ ...item, price: { ...item.price } }));
  }

  /** Seed a cart (test / demo setup — not a UCP operation). */
  seedCart(cart: UcpV7Cart): void {
    this.carts.set(cart.id, {
      ...cart,
      items: cart.items.map((i) => ({ ...i, unitPrice: { ...i.unitPrice }, lineTotal: { ...i.lineTotal } })),
      subtotal: { ...cart.subtotal },
    });
  }

  /** Seed an order (test / demo setup — not a UCP operation). */
  seedOrder(order: UcpV7Order): void {
    this.orders.set(order.id, {
      ...order,
      items: order.items.map((i) => ({ ...i, unitPrice: { ...i.unitPrice }, lineTotal: { ...i.lineTotal } })),
      total: { ...order.total },
    });
  }

  /** Mark an owner as identity-linked (test / demo setup). */
  seedLinkedOwner(ownerId: string, merchant = 'Demo Store'): void {
    this.linkedOwners.add(`${ownerId}::${merchant}`);
  }

  searchCatalog(query: string, offset: number, limit: number): UcpV7CatalogPage {
    const needle = query.toLowerCase();
    const matched = this.items.filter((item) =>
      item.title.toLowerCase().includes(needle)
      || item.description.toLowerCase().includes(needle)
      || item.seller.toLowerCase().includes(needle)
      || (item.categories ?? []).some((c) => c.toLowerCase().includes(needle)));
    const page = matched.slice(offset, offset + limit);
    return { items: page.map((i) => ({ ...i, price: { ...i.price } })), total: matched.length, offset, limit, query };
  }

  getCatalogItem(id: string): UcpV7CatalogItem | null {
    const item = this.items.find((i) => i.id === id);
    return item ? { ...item, price: { ...item.price } } : null;
  }

  listCatalog(offset: number, limit: number): UcpV7CatalogPage {
    const page = this.items.slice(offset, offset + limit);
    return { items: page.map((i) => ({ ...i, price: { ...i.price } })), total: this.items.length, offset, limit, query: '' };
  }

  getCart(id: string): UcpV7Cart | null {
    const cart = this.carts.get(id);
    if (!cart) return null;
    return {
      ...cart,
      items: cart.items.map((i) => ({ ...i, unitPrice: { ...i.unitPrice }, lineTotal: { ...i.lineTotal } })),
      subtotal: { ...cart.subtotal },
    };
  }

  getOrder(id: string): UcpV7Order | null {
    const order = this.orders.get(id);
    if (!order) return null;
    return {
      ...order,
      items: order.items.map((i) => ({ ...i, unitPrice: { ...i.unitPrice }, lineTotal: { ...i.lineTotal } })),
      total: { ...order.total },
    };
  }

  listOrders(ownerId: string, offset: number, limit: number): UcpV7OrderPage {
    const mine = [...this.orders.values()]
      .filter((o) => o.ownerId === ownerId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    const page = mine.slice(offset, offset + limit);
    return { orders: page.map((o) => ({ ...o, total: { ...o.total } })), total: mine.length, offset, limit };
  }

  identityStatus(ownerId: string): UcpV7IdentityStatus {
    const linkedEntry = [...this.linkedOwners].find((e) => e.startsWith(`${ownerId}::`));
    if (!linkedEntry) return { ownerId, linked: false };
    return { ownerId, linked: true, merchant: linkedEntry.split('::')[1], lastVerifiedMs: Date.now() };
  }
}

/** One-line summary of a catalog item, for logs and the UI. */
export function summarizeUcpV7Item(item: UcpV7CatalogItem): string {
  const stock = item.stock > 0 ? `${item.stock} in stock` : 'out of stock';
  return `${item.title} — ${formatUcpV7Money(item.price)} — ${stock} — ${item.seller}`;
}

/** One-line summary of an order, for logs and the UI. */
export function summarizeUcpV7Order(order: UcpV7Order): string {
  return `Order ${order.id} — ${order.status} — ${formatUcpV7Money(order.total)} — ${order.items.length} line(s)`;
}
