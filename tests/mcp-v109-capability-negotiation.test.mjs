/**
 * MCP Apps/Tasks capability negotiation tests (v1.09, Team T3 — node:test, không mạng live).
 *
 * Covers packages/core/src/mcp/capabilityNegotiation.ts:
 *  - parseAppsSupport: dạng object đầy đủ / true tối thiểu / experimental / extensions
 *  - parseTasksSupport: 2026 full, 2025 partial, tasks=true theo protocol
 *  - negotiateServerCapabilities: notes fallback tiếng Việt cho từng mức
 *  - fallbackForToolCall: renderApp / runAsTask theo mức hỗ trợ
 *  - CapabilityNegotiator: record, downgrade khi Method not found,
 *    isDowngraded, snapshot, re-negotiate xoá downgrade cũ
 *  - isMethodNotFoundError
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v109-capability-negotiation.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CapabilityNegotiator,
  fallbackForToolCall,
  isMethodNotFoundError,
  negotiateServerCapabilities,
  parseAppsSupport,
  parseTasksSupport,
} from '../packages/core/dist/mcp/capabilityNegotiation.js';

// ---------------------------------------------------------------------------
// parseAppsSupport
// ---------------------------------------------------------------------------

test('negotiation: apps không khai báo -> none', () => {
  assert.equal(parseAppsSupport({}).level, 'none');
  assert.equal(parseAppsSupport(undefined).level, 'none');
  assert.equal(parseAppsSupport({ tools: {} }).level, 'none');
});

test('negotiation: apps đầy đủ -> full', () => {
  const support = parseAppsSupport({
    apps: { uiResources: true, templates: true, bridgeToolCalls: true, extension: 'io.modelcontextprotocol/apps' },
  });
  assert.equal(support.level, 'full');
  assert.equal(support.uiResources, true);
  assert.equal(support.templates, true);
  assert.equal(support.bridgeToolCalls, true);
});

test('negotiation: apps=true tối thiểu -> partial, uiResources true', () => {
  const support = parseAppsSupport({ apps: true });
  assert.equal(support.level, 'partial');
  assert.equal(support.uiResources, true);
  assert.equal(support.templates, false);
});

test('negotiation: apps qua experimental / extensions cũng nhận', () => {
  assert.equal(parseAppsSupport({ experimental: { apps: true } }).level, 'partial');
  assert.equal(parseAppsSupport({ extensions: ['io.modelcontextprotocol/apps'] }).level, 'partial');
  assert.equal(parseAppsSupport({ extensions: [{ name: 'io.modelcontextprotocol/apps' }] }).extensionName, 'io.modelcontextprotocol/apps');
});

// ---------------------------------------------------------------------------
// parseTasksSupport
// ---------------------------------------------------------------------------

test('negotiation: tasks 2026 đầy đủ -> full, get trả result, update ok, list không còn', () => {
  const support = parseTasksSupport({ tasks: { specVersion: '2026-07-28', update: true } }, '2026-07-28');
  assert.equal(support.level, 'full');
  assert.equal(support.specVersion, '2026-07-28');
  assert.equal(support.getReturnsResult, true);
  assert.equal(support.updateSupported, true);
  assert.equal(support.listSupported, false);
});

test('negotiation: tasks 2025 -> partial, list còn, update không', () => {
  const support = parseTasksSupport({ tasks: { specVersion: '2025-11-25' } }, '2025-11-25');
  assert.equal(support.level, 'partial');
  assert.equal(support.specVersion, '2025-11-25');
  assert.equal(support.listSupported, true);
  assert.equal(support.updateSupported, false);
});

test('negotiation: tasks=true theo protocol 2026 -> full; theo 2025 -> partial', () => {
  assert.equal(parseTasksSupport({ tasks: true }, '2026-07-28').level, 'full');
  assert.equal(parseTasksSupport({ tasks: true }, '2025-11-25').level, 'partial');
  assert.equal(parseTasksSupport({ tasks: true }, '2026-07-28').serverDirected, false);
  assert.equal(parseTasksSupport({ tasks: { serverDirected: true } }, '2026-07-28').serverDirected, true);
});

// ---------------------------------------------------------------------------
// negotiate + fallback
// ---------------------------------------------------------------------------

test('negotiation: server không hỗ trợ gì -> notes fallback rõ ràng', () => {
  const rec = negotiateServerCapabilities('srv', { protocolVersion: '2025-11-25', capabilities: {} });
  assert.equal(rec.apps.level, 'none');
  assert.equal(rec.tasks.level, 'none');
  assert.equal(rec.notes.length, 2);
  assert.match(rec.notes[0], /không hỗ trợ MCP Apps/);
  assert.match(rec.notes[1], /không hỗ trợ Tasks/);
});

test('negotiation: server 2026 full -> không có note fallback', () => {
  const rec = negotiateServerCapabilities('srv', {
    protocolVersion: '2026-07-28',
    capabilities: {
      apps: { uiResources: true, templates: true, bridgeToolCalls: true },
      tasks: { specVersion: '2026-07-28', update: true },
    },
  });
  assert.equal(rec.apps.level, 'full');
  assert.equal(rec.tasks.level, 'full');
  assert.deepEqual(rec.notes, []);
});

test('negotiation: fallbackForToolCall — none thì không render/không task, partial thì render có cảnh báo', () => {
  const none = negotiateServerCapabilities('srv', { protocolVersion: '2025-11-25', capabilities: {} });
  const fbNone = fallbackForToolCall(none, { app: true, task: true });
  assert.equal(fbNone.renderApp, false);
  assert.equal(fbNone.runAsTask, false);
  assert.equal(fbNone.reasons.length, 2);

  const partial = negotiateServerCapabilities('srv', {
    protocolVersion: '2026-07-28',
    capabilities: { apps: true, tasks: true },
  });
  const fbPartial = fallbackForToolCall(partial, { app: true, task: true });
  assert.equal(fbPartial.renderApp, true);
  assert.equal(fbPartial.runAsTask, true);
  assert.equal(fbPartial.reasons.length, 1);
});

// ---------------------------------------------------------------------------
// CapabilityNegotiator: downgrade
// ---------------------------------------------------------------------------

test('negotiation: isMethodNotFoundError nhận code -32601 ở cả hai dạng', () => {
  assert.equal(isMethodNotFoundError({ code: -32601 }), true);
  assert.equal(isMethodNotFoundError({ error: { code: -32601 } }), true);
  assert.equal(isMethodNotFoundError({ code: -32602 }), false);
  assert.equal(isMethodNotFoundError(new Error('x')), false);
});

test('negotiation: negotiator downgrade tasks/update khi server từ chối, snapshot phản ánh', () => {
  const negotiator = new CapabilityNegotiator({ now: () => 777 });
  negotiator.negotiate('srv', {
    protocolVersion: '2026-07-28',
    capabilities: {
      apps: { uiResources: true, templates: true, bridgeToolCalls: true },
      tasks: { specVersion: '2026-07-28', update: true },
    },
  });
  assert.equal(negotiator.snapshot('srv').tasksLevel, 'full');
  assert.equal(negotiator.isDowngraded('srv', 'tasks/update'), false);
  negotiator.recordMethodNotFound('srv', 'tasks/update');
  assert.equal(negotiator.isDowngraded('srv', 'tasks/update'), true);
  assert.equal(negotiator.get('srv').tasks.updateSupported, false);
  assert.equal(negotiator.snapshot('srv').tasksLevel, 'partial');
  assert.deepEqual(negotiator.snapshot('srv').downgradedMethods, ['tasks/update']);
  // Ghi trùng method không nhân đôi.
  negotiator.recordMethodNotFound('srv', 'tasks/update');
  assert.equal(negotiator.downgradedMethods('srv').length, 1);
});

test('negotiation: re-negotiate xoá downgrade cũ; remove xoá record', () => {
  const negotiator = new CapabilityNegotiator();
  negotiator.negotiate('srv', { protocolVersion: '2026-07-28', capabilities: { tasks: true } });
  negotiator.recordMethodNotFound('srv', 'tasks/get');
  assert.equal(negotiator.isDowngraded('srv', 'tasks/get'), true);
  negotiator.negotiate('srv', { protocolVersion: '2026-07-28', capabilities: { tasks: true } });
  assert.equal(negotiator.isDowngraded('srv', 'tasks/get'), false);
  assert.equal(negotiator.list().length, 1);
  assert.equal(negotiator.remove('srv'), true);
  assert.equal(negotiator.get('srv'), undefined);
  assert.equal(negotiator.snapshot('srv'), undefined);
});
