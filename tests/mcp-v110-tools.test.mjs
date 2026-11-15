/**
 * Test v1.10 T2: tools mcp_mrtr_* / mcp_tasks_* / mcp_files_* (node:test).
 * Local only, no live MCP server: the Files tools + the pure MRTR
 * validate tool run against a temp workspace; the remote tools are
 * checked for registration (name, approval flag, params) only.
 *
 * Build core + tools first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/mcp-v110-tools.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMcpV110Tools, MCP_V110_TOOLS } from '../packages/tools/dist/mcpV110Tools.js';

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'mcp-v110-tools-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function toolByName(tools, name) {
  const found = tools.find((t) => t.definition.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

const ctxFor = (workspaceDir) => ({ workspaceDir });

test('registration: 10 tools, expected names + approval flags', () => {
  const tools = createMcpV110Tools();
  assert.equal(tools.length, 10);
  assert.deepEqual(
    tools.map((t) => t.definition.name),
    [
      'mcp_mrtr_input_required',
      'mcp_mrtr_validate_result',
      'mcp_tasks_wait',
      'mcp_tasks_send_input',
      'mcp_tasks_auto_background',
      'mcp_files_upload',
      'mcp_files_download',
      'mcp_files_info',
      'mcp_files_list',
      'mcp_files_delete',
    ],
  );
  assert.deepEqual(MCP_V110_TOOLS.map((t) => t.definition.name), tools.map((t) => t.definition.name));
  const needsApproval = (name) => toolByName(tools, name).needsApproval;
  assert.equal(needsApproval('mcp_mrtr_input_required'), true);
  assert.equal(needsApproval('mcp_mrtr_validate_result'), false);
  assert.equal(needsApproval('mcp_tasks_wait'), true);
  assert.equal(needsApproval('mcp_tasks_send_input'), true);
  assert.equal(needsApproval('mcp_tasks_auto_background'), true);
  assert.equal(needsApproval('mcp_files_upload'), true);
  assert.equal(needsApproval('mcp_files_download'), false);
  assert.equal(needsApproval('mcp_files_info'), false);
  assert.equal(needsApproval('mcp_files_list'), false);
  assert.equal(needsApproval('mcp_files_delete'), true);
  // Every tool declares object params with additionalProperties: false.
  for (const t of tools) {
    assert.equal(t.definition.parameters.type, 'object');
    assert.equal(t.definition.parameters.additionalProperties, false);
  }
});

test('mcp_mrtr_validate_result: accepts 2026 results, rejects legacy ones', async () => {
  const tools = createMcpV110Tools();
  const validate = toolByName(tools, 'mcp_mrtr_validate_result');
  const ctx = ctxFor(tempWorkspace());
  try {
    assert.match(
      await validate.execute({ result: { resultType: 'complete', result: { ok: 1 } } }, ctx),
      /Valid: resultType "complete"/,
    );
    assert.match(
      await validate.execute(
        { result: { resultType: 'input_required', input: { prompt: 'City?', schema: { type: 'object' } } } },
        ctx,
      ),
      /Valid: resultType "input_required"/,
    );
    assert.match(
      await validate.execute({ result: { content: [{ type: 'text', text: 'legacy' }] } }, ctx),
      /^Invalid:/,
    );
    assert.match(
      await validate.execute({ result: { resultType: 'needs_input' } }, ctx),
      /^Invalid:/,
    );
    assert.match(await validate.execute({ result: 'plain string' }, ctx), /^Invalid:/);
  } finally {
    cleanup(ctx.workspaceDir);
  }
});

test('mcp_files_*: upload -> info -> download -> list -> delete round-trip', async () => {
  const ws = tempWorkspace();
  const ctx = ctxFor(ws);
  try {
    const tools = createMcpV110Tools();
    const upload = toolByName(tools, 'mcp_files_upload');
    const info = toolByName(tools, 'mcp_files_info');
    const download = toolByName(tools, 'mcp_files_download');
    const list = toolByName(tools, 'mcp_files_list');
    const remove = toolByName(tools, 'mcp_files_delete');

    assert.match(await list.execute({}, ctx), /Files store is empty/);
    const content = Buffer.from('hello from the files tool', 'utf8').toString('base64');
    const up = await upload.execute({ name: 'note.txt', contentBase64: content }, ctx);
    const fileId = up.match(/fileId: (file-[0-9a-f]{16})/)[1];
    assert.match(up, /Uploaded "note\.txt"/);
    assert.match(await info.execute({ fileId }, ctx), /name: note\.txt/);
    assert.match(await info.execute({ fileId }, ctx), /sha256:/);
    const listed = await list.execute({}, ctx);
    assert.match(listed, /1 file\(s\) in the Files store/);
    assert.match(listed, new RegExp(fileId));
    const dl = await download.execute({ fileId, offset: 0, length: 5 }, ctx);
    assert.match(dl, /bytes 0\.\.4 of 25/);
    assert.ok(dl.includes(Buffer.from('hello').toString('base64')));
    const full = await download.execute({ fileId }, ctx);
    assert.ok(full.includes(content), 'full download returns the whole content');
    assert.match(await remove.execute({ fileId }, ctx), new RegExp(`Deleted file ${fileId}`));
    assert.match(await remove.execute({ fileId }, ctx), /No file/);
    assert.match(await info.execute({ fileId }, ctx), /^Error:/);
    assert.match(await list.execute({}, ctx), /Files store is empty/);
  } finally {
    cleanup(ws);
  }
});

test('mcp_files_upload: traversal name and oversize content are refused', async () => {
  const ws = tempWorkspace();
  const ctx = ctxFor(ws);
  try {
    const tools = createMcpV110Tools();
    const upload = toolByName(tools, 'mcp_files_upload');
    assert.match(
      await upload.execute({ name: '../escape.txt', contentBase64: 'aGk=' }, ctx),
      /^Error:/,
    );
    assert.match(
      await upload.execute({ name: 'a.txt', contentBase64: '!!!not-base64!!!' }, ctx),
      /^Error:/,
    );
    const huge = Buffer.alloc(11 * 1024 * 1024, 0).toString('base64');
    assert.match(await upload.execute({ name: 'big.bin', contentBase64: huge }, ctx), /exceeds/);
    assert.match(await toolByName(tools, 'mcp_files_list').execute({}, ctx), /Files store is empty/);
  } finally {
    cleanup(ws);
  }
});

test('mcp_files_download: bad fileId errors instead of reading outside the store', async () => {
  const ws = tempWorkspace();
  const ctx = ctxFor(ws);
  try {
    const tools = createMcpV110Tools();
    const download = toolByName(tools, 'mcp_files_download');
    assert.match(
      await download.execute({ fileId: '../../etc/passwd' }, ctx),
      /^Error:/,
    );
    assert.match(
      await download.execute({ fileId: 'file-0000000000000000' }, ctx),
      /^Error:.*không có file/,
    );
  } finally {
    cleanup(ws);
  }
});
