/**
 * Protocols v7 — UCP read-only adapter tests (v1.38, Team T2).
 *
 * Covers packages/core/src/protocolsV7/ucpReadOnlyV7.ts:
 * catalog search/get/list, cart/order/identity reads, money
 * formatting, and the refusal of every money-moving operation
 * (checkout / payment / order placement) by construction.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v138-ucp.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UcpV7MemoryBackend,
  UcpV7MoneyRefusedError,
  UcpV7ReadOnlyAdapter,
  addUcpV7Money,
  formatUcpV7Money,
  isUcpV7ReadOperation,
  isUcpV7RefusedOperation,
  multiplyUcpV7Money,
  summarizeUcpV7Item,
  summarizeUcpV7Order,
} from '../packages/core/dist/index.js';

function seededAdapter() {
  const backend = new UcpV7MemoryBackend();
  const now = Date.now();
  backend.seedCart({
    id: 'cart-1',
    ownerId: 'owner-1',
    items: [{
      itemId: 'demo-notebook-001', title: 'Demo Notebook (A5, dotted)', quantity: 2,
      unitPrice: { amountMinor: 1299, currency: 'USD' },
      lineTotal: { amountMinor: 2598, currency: 'USD' },
    }],
    subtotal: { amountMinor: 2598, currency: 'USD' },
    currency: 'USD',
    updatedAtMs: now,
  });
  backend.seedOrder({
    id: 'order-1',
    ownerId: 'owner-1',
    status: 'shipped',
    items: [{
      itemId: 'demo-lamp-002', title: 'Demo Desk Lamp (USB-C)', quantity: 1,
      unitPrice: { amountMinor: 3499, currency: 'USD' },
      lineTotal: { amountMinor: 3499, currency: 'USD' },
    }],
    total: { amountMinor: 3499, currency: 'USD' },
    currency: 'USD',
    createdAtMs: now - 86400000,
    updatedAtMs: now - 3600000,
    trackingNumber: 'TRACK-123',
  });
  backend.seedOrder({
    id: 'order-2',
    ownerId: 'owner-1',
    status: 'delivered',
    items: [],
    total: { amountMinor: 0, currency: 'USD' },
    currency: 'USD',
    createdAtMs: now - 2 * 86400000,
    updatedAtMs: now - 86400000,
  });
  backend.seedLinkedOwner('owner-1', 'Demo Store');
  return new UcpV7ReadOnlyAdapter(backend);
}

test('operation classification: reads implemented, money refused', () => {
  assert.equal(isUcpV7ReadOperation('catalog/search'), true);
  assert.equal(isUcpV7ReadOperation('order/get'), true);
  assert.equal(isUcpV7ReadOperation('checkout/create'), false);
  assert.equal(isUcpV7RefusedOperation('checkout/create'), true);
  assert.equal(isUcpV7RefusedOperation('payment/refund'), true);
  assert.equal(isUcpV7RefusedOperation('order/place'), true);
  assert.equal(isUcpV7RefusedOperation('cart/add'), true);
  assert.equal(isUcpV7RefusedOperation('catalog/search'), false);
  const adapter = seededAdapter();
  assert.equal(adapter.version, '2026-08-25');
  assert.equal(adapter.implementation, 'read-only');
  assert.ok(adapter.readOperations().includes('catalog/search'));
  assert.ok(adapter.refusedOperations().includes('payment/capture'));
});

test('catalog: search / get / list with paging', async () => {
  const adapter = seededAdapter();
  const demo = await adapter.searchCatalog('demo');
  assert.equal(demo.total, 4);
  assert.equal(demo.items.length, 4);
  const notebook = await adapter.searchCatalog('notebook');
  assert.equal(notebook.total, 1);
  assert.equal(notebook.items[0].id, 'demo-notebook-001');
  const none = await adapter.searchCatalog('zzz-no-such-thing');
  assert.equal(none.total, 0);
  await assert.rejects(() => adapter.searchCatalog(''), /non-empty query/);
  const page = await adapter.searchCatalog('demo', { offset: 2, limit: 2 });
  assert.equal(page.items.length, 2);
  assert.equal(page.offset, 2);
  const item = await adapter.getCatalogItem('demo-lamp-002');
  assert.equal(item.title, 'Demo Desk Lamp (USB-C)');
  assert.equal(item.stock, 7);
  assert.match(summarizeUcpV7Item(item), /Demo Desk Lamp/);
  assert.match(summarizeUcpV7Item(item), /7 in stock/);
  await assert.rejects(() => adapter.getCatalogItem('nope'), /does not exist/);
  const list = await adapter.listCatalog({ limit: 2 });
  assert.equal(list.total, 4);
  assert.equal(list.items.length, 2);
  const outOfStock = await adapter.getCatalogItem('demo-tea-003');
  assert.match(summarizeUcpV7Item(outOfStock), /out of stock/);
});

test('cart / order / identity reads', async () => {
  const adapter = seededAdapter();
  const cart = await adapter.getCart('cart-1');
  assert.equal(cart.ownerId, 'owner-1');
  assert.equal(cart.subtotal.amountMinor, 2598);
  await assert.rejects(() => adapter.getCart('nope'), /does not exist/);
  const order = await adapter.getOrder('order-1');
  assert.equal(order.status, 'shipped');
  assert.equal(order.trackingNumber, 'TRACK-123');
  assert.match(summarizeUcpV7Order(order), /shipped/);
  await assert.rejects(() => adapter.getOrder('nope'), /does not exist/);
  const orders = await adapter.listOrders('owner-1');
  assert.equal(orders.total, 2);
  assert.equal(orders.orders[0].id, 'order-1');
  const empty = await adapter.listOrders('owner-nobody');
  assert.equal(empty.total, 0);
  await assert.rejects(() => adapter.listOrders(''), /owner id/);
  const linked = await adapter.identityStatus('owner-1');
  assert.equal(linked.linked, true);
  assert.equal(linked.merchant, 'Demo Store');
  const unlinked = await adapter.identityStatus('owner-2');
  assert.equal(unlinked.linked, false);
});

test('attemptOperation: reads run, money operations throw the typed refusal', async () => {
  const adapter = seededAdapter();
  const found = await adapter.attemptOperation('catalog/search', { query: 'lamp' });
  assert.equal(found.total, 1);
  for (const op of ['checkout/create', 'checkout/complete', 'payment/authorize', 'payment/capture', 'payment/refund', 'order/place', 'cart/add', 'cart/checkout']) {
    await assert.rejects(
      () => adapter.attemptOperation(op, {}),
      (err) => err instanceof UcpV7MoneyRefusedError && err.operation === op,
    );
  }
  await assert.rejects(() => adapter.attemptOperation('teleport/now', {}), /Unknown UCP operation/);
});

test('money helpers: format / add / multiply', () => {
  assert.match(formatUcpV7Money({ amountMinor: 1299, currency: 'USD' }), /12\.99/);
  assert.match(formatUcpV7Money({ amountMinor: 250000, currency: 'VND' }), /250,?000/);
  assert.deepEqual(
    addUcpV7Money({ amountMinor: 100, currency: 'USD' }, { amountMinor: 50, currency: 'USD' }),
    { amountMinor: 150, currency: 'USD' },
  );
  assert.throws(
    () => addUcpV7Money({ amountMinor: 1, currency: 'USD' }, { amountMinor: 1, currency: 'VND' }),
    (err) => err instanceof Error && err.code === 'currency-mismatch',
  );
  assert.deepEqual(
    multiplyUcpV7Money({ amountMinor: 1299, currency: 'USD' }, 3),
    { amountMinor: 3897, currency: 'USD' },
  );
  assert.throws(() => multiplyUcpV7Money({ amountMinor: 1, currency: 'USD' }, -1), /Quantity/);
  assert.throws(() => multiplyUcpV7Money({ amountMinor: 1, currency: 'USD' }, 1.5), /Quantity/);
});
