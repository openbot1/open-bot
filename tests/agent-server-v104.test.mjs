/**
 * Test v1.04 (Đội T4): agent server REST v2 — HTTP thật trên loopback.
 *
 * - /v2/health không cần auth; mọi route khác thiếu/sai token → 401.
 * - Tạo/liệt kê/đọc conversation; gửi message append event.
 * - pause/resume đổi status (paused/running); cancel → aborted.
 * - fork → conversation con có parentRunId.
 * - condense (summarize) trả báo cáo token saved đo thật.
 * - snapshot trả digest.
 * - SSE stream: kết nối, gửi message mới, event mới chảy về qua SSE.
 * - 404/405/400 rõ ràng.
 * - Host không phải loopback → từ chối ngay lúc khởi động.
 *
 * Chỉ test local (không mạng ngoài). Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/agent-server-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { startAgentServerV2 } from '../packages/core/dist/agent-server/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-agentserver-v104-'));
}

async function startServer() {
  const dir = tmpDir();
  const handle = await startAgentServerV2({
    logDir: path.join(dir, 'run-logs'),
    ssePollMs: 50,
    sseHeartbeatMs: 60_000,
  });
  return { dir, handle };
}

function req(handle, method, p, body, token = handle.token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(`${handle.url}${p}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function reqJson(handle, method, p, body, token) {
  const res = await req(handle, method, p, body, token);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function createConversation(handle, prompt = 'Làm giúp tôi việc X') {
  const { status, json } = await reqJson(handle, 'POST', '/v2/conversations', {
    botId: 'bot-test',
    prompt,
  });
  assert.equal(status, 201);
  return json;
}

test('health không cần auth; route khác thiếu token → 401', async () => {
  const { handle } = await startServer();
  try {
    const health = await fetch(`${handle.url}/v2/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, version: 'v2' });
    const noToken = await req(handle, 'GET', '/v2/conversations', undefined, null);
    assert.equal(noToken.status, 401);
    const badToken = await req(handle, 'GET', '/v2/conversations', undefined, 'sai-token');
    assert.equal(badToken.status, 401);
  } finally {
    await handle.close();
  }
});

test('tạo/liệt kê/đọc conversation + gửi message', async () => {
  const { handle } = await startServer();
  try {
    const created = await createConversation(handle);
    assert.ok(created.id);
    assert.equal(created.botId, 'bot-test');
    assert.equal(created.status, 'running');
    assert.equal(created.prompt, 'Làm giúp tôi việc X');
    assert.equal(created.eventCount, 2);

    const list = await reqJson(handle, 'GET', '/v2/conversations');
    assert.equal(list.status, 200);
    assert.equal(list.json.conversations.length, 1);

    const msg = await reqJson(handle, 'POST', `/v2/conversations/${created.id}/messages`, {
      text: 'Thêm chi tiết nữa',
    });
    assert.equal(msg.status, 200);
    assert.equal(msg.json.seq, 3);

    const events = await reqJson(handle, 'GET', `/v2/conversations/${created.id}/events?types=run.prompt`);
    assert.equal(events.status, 200);
    assert.equal(events.json.total, 2);
    assert.equal(events.json.events[1].payload.text, 'Thêm chi tiết nữa');
  } finally {
    await handle.close();
  }
});

test('pause/resume/cancel đổi trạng thái qua event log', async () => {
  const { handle } = await startServer();
  try {
    const created = await createConversation(handle);
    const paused = await reqJson(handle, 'POST', `/v2/conversations/${created.id}/pause`, { reason: 'user bấm pause' });
    assert.equal(paused.status, 200);
    assert.equal(paused.json.changed, true);
    const afterPause = await reqJson(handle, 'GET', `/v2/conversations/${created.id}`);
    assert.equal(afterPause.json.status, 'paused');

    const resumed = await reqJson(handle, 'POST', `/v2/conversations/${created.id}/resume`, {});
    assert.equal(resumed.status, 200);
    const afterResume = await reqJson(handle, 'GET', `/v2/conversations/${created.id}`);
    assert.equal(afterResume.json.status, 'running');

    const cancelled = await reqJson(handle, 'POST', `/v2/conversations/${created.id}/cancel`, {
      message: 'user huỷ',
    });
    assert.equal(cancelled.status, 200);
    const afterCancel = await reqJson(handle, 'GET', `/v2/conversations/${created.id}`);
    assert.equal(afterCancel.json.status, 'aborted');
  } finally {
    await handle.close();
  }
});

test('fork tạo conversation con nối cha', async () => {
  const { handle } = await startServer();
  try {
    const created = await createConversation(handle);
    const forked = await reqJson(handle, 'POST', `/v2/conversations/${created.id}/fork`, { atSeq: 2 });
    assert.equal(forked.status, 201);
    assert.ok(forked.json.childRunId);
    assert.equal(forked.json.parentRunId, created.id);
    const child = await reqJson(handle, 'GET', `/v2/conversations/${forked.json.childRunId}`);
    assert.equal(child.json.parentRunId, created.id);
    assert.equal(child.json.forkFromSeq, 2);
    assert.equal(child.json.prompt, 'Làm giúp tôi việc X');
  } finally {
    await handle.close();
  }
});

test('condense + snapshot trả số đo thật', async () => {
  const { handle } = await startServer();
  try {
    const created = await createConversation(handle);
    // Thêm vài message để log đủ dài cho condense có ý nghĩa.
    for (let i = 0; i < 5; i += 1) {
      await reqJson(handle, 'POST', `/v2/conversations/${created.id}/messages`, { text: `bổ sung ${i}` });
    }
    const condensed = await reqJson(handle, 'POST', `/v2/conversations/${created.id}/condense`, {
      strategy: 'summarize',
    });
    assert.equal(condensed.status, 200);
    assert.equal(condensed.json.strategy, 'summarize');
    assert.ok(condensed.json.tokensBefore > 0);
    assert.equal(
      condensed.json.tokensSaved,
      condensed.json.tokensBefore - condensed.json.tokensAfter,
    );
    const snap = await reqJson(handle, 'GET', `/v2/conversations/${created.id}/snapshot`);
    assert.equal(snap.status, 200);
    assert.ok(typeof snap.json.digest === 'string' && snap.json.digest.length === 64);
  } finally {
    await handle.close();
  }
});

test('SSE stream: event mới chảy về sau khi kết nối', async () => {
  const { handle } = await startServer();
  const abort = new AbortController();
  try {
    const created = await createConversation(handle);
    const res = await fetch(`${handle.url}/v2/conversations/${created.id}/stream?fromSeq=1`, {
      headers: { Authorization: `Bearer ${handle.token}` },
      signal: abort.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Pump nền: đọc liên tục, append vào buffer; waitFor chỉ poll buffer.
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        }
      } catch {
        // Ngắt kết nối (abort) — pump dừng, buffer giữ nguyên.
      }
    })();
    const waitFor = async (needle, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (buffer.includes(needle)) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return buffer.includes(needle);
    };
    // Replay từ đầu: thấy run.started + run.prompt ngay.
    assert.equal(await waitFor('run.started'), true);
    assert.equal(await waitFor('run.prompt'), true);
    // Gửi message mới → event mới chảy về live.
    await reqJson(handle, 'POST', `/v2/conversations/${created.id}/messages`, { text: 'tin live qua SSE' });
    assert.equal(await waitFor('tin live qua SSE'), true);
    reader.cancel();
    await pump;
  } finally {
    abort.abort();
    await handle.close();
  }
});

test('404/405/400 rõ ràng; host ngoài loopback bị từ chối', async () => {
  const { handle } = await startServer();
  try {
    const missing = await reqJson(handle, 'GET', '/v2/conversations/khong-co');
    assert.equal(missing.status, 404);
    const badRoute = await reqJson(handle, 'GET', '/v2/khong-co');
    assert.equal(badRoute.status, 404);
    const badMethod = await reqJson(handle, 'DELETE', '/v2/conversations');
    assert.equal(badMethod.status, 404);
    const emptyPrompt = await reqJson(handle, 'POST', '/v2/conversations', { prompt: '   ' });
    assert.equal(emptyPrompt.status, 400);
    const badStrategy = await reqJson(handle, 'POST', '/v2/conversations/x/condense', { strategy: 'sai' });
    assert.equal(badStrategy.status, 400);
  } finally {
    await handle.close();
  }
  await assert.rejects(
    startAgentServerV2({ logDir: path.join(tmpDir(), 'run-logs'), host: '0.0.0.0' }),
    /chỉ bind loopback/,
  );
});
