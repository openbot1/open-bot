/**
 * Test v1.10 T2: Files extension draft io.modelcontextprotocol/files (node:test).
 * Local only, no live network: McpFilesStore on a temp dir.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-files-v110.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createMcpFilesMethodHandler,
  guessMimeType,
  isValidFileId,
  isValidFileName,
  isValidUploadId,
  McpFilesError,
  McpFilesStore,
  resolveFilesPath,
  MCP_FILES_METHODS,
  MCP_FILES_EXTENSION,
} from '../packages/core/dist/mcp/files.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'mcp-files-v110-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

const HELLO = Buffer.from('hello files extension', 'utf8');
const HELLO_B64 = HELLO.toString('base64');

test('extension constants + method list', () => {
  assert.equal(MCP_FILES_EXTENSION, 'io.modelcontextprotocol/files');
  assert.deepEqual([...MCP_FILES_METHODS], [
    'files/upload/begin',
    'files/upload/chunk',
    'files/upload/complete',
    'files/upload/abort',
    'files/download',
    'files/info',
    'files/list',
    'files/delete',
  ]);
});

test('validators: fileId / uploadId / fileName reject traversal', () => {
  assert.equal(isValidFileId('file-0123456789abcdef'), true);
  assert.equal(isValidFileId('file-0123456789abcdeg'), false);
  assert.equal(isValidFileId('../../../etc/passwd'), false);
  assert.equal(isValidFileId('file-0123456789abcdef/../../x'), false);
  assert.equal(isValidUploadId('upl-0123456789abcdef'), true);
  assert.equal(isValidUploadId('../upl-0123456789abcdef'), false);
  assert.equal(isValidFileName('report.md'), true);
  assert.equal(isValidFileName('../escape.txt'), false);
  assert.equal(isValidFileName('a/b.txt'), false);
  assert.equal(isValidFileName('..'), false);
  assert.equal(isValidFileName(''), false);
  assert.equal(isValidFileName('a\\b.txt'), false);
});

test('guessMimeType', () => {
  assert.equal(guessMimeType('a.md'), 'text/plain');
  assert.equal(guessMimeType('a.json'), 'application/json');
  assert.equal(guessMimeType('a.png'), 'image/png');
  assert.equal(guessMimeType('a.bin'), 'application/octet-stream');
});

test('uploadBytes + downloadBytes round-trip with sha256 metadata', () => {
  const root = tempRoot();
  try {
    const store = new McpFilesStore(root);
    const meta = store.uploadBytes('hello.txt', HELLO_B64);
    assert.match(meta.fileId, /^file-[0-9a-f]{16}$/);
    assert.equal(meta.name, 'hello.txt');
    assert.equal(meta.sizeBytes, HELLO.length);
    assert.equal(meta.mimeType, 'text/plain');
    assert.equal(meta.chunks, 1);
    assert.equal(meta.sha256Hex.length, 64);
    const back = store.downloadBytes(meta.fileId);
    assert.equal(back.dataBase64, HELLO_B64);
    assert.deepEqual(back.metadata, meta);
    // Same content => same fileId (content-addressed).
    const meta2 = store.uploadBytes('other-name.txt', HELLO_B64);
    assert.equal(meta2.fileId, meta.fileId);
  } finally {
    cleanup(root);
  }
});

test('chunked upload: sequential index enforced, complete validates totalBytes', () => {
  const root = tempRoot();
  try {
    const store = new McpFilesStore(root, { maxChunkBytes: 4 });
    const { uploadId } = store.beginUpload({ name: 'a.txt', totalBytes: 10 });
    // Out-of-order chunk rejected.
    assert.throws(
      () => store.writeChunk(uploadId, 1, Buffer.from('xxxx').toString('base64')),
      (err) => err instanceof McpFilesError && /lệch thứ tự/.test(err.message),
    );
    store.writeChunk(uploadId, 0, Buffer.from('hell').toString('base64'));
    store.writeChunk(uploadId, 1, Buffer.from('o fi').toString('base64'));
    // Declared 10 bytes, only 8 received => incomplete.
    assert.throws(
      () => store.completeUpload(uploadId),
      (err) => err instanceof McpFilesError && /thiếu byte/.test(err.message),
    );
    store.writeChunk(uploadId, 2, Buffer.from('le').toString('base64'));
    const meta = store.completeUpload(uploadId);
    assert.equal(meta.sizeBytes, 10);
    assert.equal(store.downloadBytes(meta.fileId).dataBase64, Buffer.from('hello file').toString('base64'));
  } finally {
    cleanup(root);
  }
});

test('chunked upload: oversize chunk / file rejected', () => {
  const root = tempRoot();
  try {
    const store = new McpFilesStore(root, { maxChunkBytes: 4, maxFileBytes: 8 });
    const { uploadId } = store.beginUpload({ name: 'a.txt' });
    assert.throws(
      () => store.writeChunk(uploadId, 0, Buffer.from('12345').toString('base64')),
      (err) => err instanceof McpFilesError && /vượt giới hạn/.test(err.message),
    );
    store.writeChunk(uploadId, 0, Buffer.from('1234').toString('base64'));
    store.writeChunk(uploadId, 1, Buffer.from('5678').toString('base64'));
    assert.throws(
      () => store.writeChunk(uploadId, 2, Buffer.from('9').toString('base64')),
      (err) => err instanceof McpFilesError && /vượt giới hạn file/.test(err.message),
    );
    // Invalid base64 rejected.
    assert.throws(
      () => store.writeChunk(uploadId, 2, '!!!not-base64!!!'),
      (err) => err instanceof McpFilesError && /base64/.test(err.message),
    );
  } finally {
    cleanup(root);
  }
});

test('beginUpload: bad name / totalBytes rejected early', () => {
  const root = tempRoot();
  try {
    const store = new McpFilesStore(root);
    assert.throws(() => store.beginUpload({ name: '../x.txt' }), /tên file không hợp lệ/);
    assert.throws(() => store.beginUpload({ name: 'a.txt', totalBytes: 999_999_999 }), /totalBytes/);
    assert.throws(() => store.beginUpload({ name: 'a.txt', totalBytes: -1 }), /totalBytes/);
  } finally {
    cleanup(root);
  }
});

test('downloadChunk: paging, clamping, eof, offset validation', () => {
  const root = tempRoot();
  try {
    const store = new McpFilesStore(root);
    const meta = store.uploadBytes('a.txt', Buffer.from('0123456789').toString('base64'));
    const first = store.downloadChunk(meta.fileId, 0, 4);
    assert.equal(first.dataBase64, Buffer.from('0123').toString('base64'));
    assert.equal(first.length, 4);
    assert.equal(first.totalBytes, 10);
    assert.equal(first.eof, false);
    const tail = store.downloadChunk(meta.fileId, 8, 100);
    assert.equal(tail.length, 2);
    assert.equal(tail.eof, true);
    assert.equal(tail.dataBase64, Buffer.from('89').toString('base64'));
    assert.throws(() => store.downloadChunk(meta.fileId, 11, 1), /offset/);
    assert.throws(() => store.downloadChunk(meta.fileId, -1, 1), /offset/);
    assert.throws(() => store.downloadChunk(meta.fileId, 0, -1), /length/);
    assert.throws(() => store.downloadChunk('../etc/passwd', 0, 1), /fileId không hợp lệ/);
    assert.throws(() => store.downloadChunk('file-0000000000000000', 0, 1), /không có file/);
  } finally {
    cleanup(root);
  }
});

test('getFile / listFiles / deleteFile', () => {
  const root = tempRoot();
  try {
    const store = new McpFilesStore(root);
    assert.deepEqual(store.listFiles(), []);
    const a = store.uploadBytes('a.txt', Buffer.from('a').toString('base64'));
    const b = store.uploadBytes('b.txt', Buffer.from('bb').toString('base64'));
    assert.equal(store.listFiles().length, 2);
    assert.equal(store.getFile(a.fileId).name, 'a.txt');
    assert.equal(store.deleteFile(a.fileId), true);
    assert.equal(store.deleteFile(a.fileId), false);
    assert.throws(() => store.getFile(a.fileId), /không có file/);
    assert.equal(store.listFiles().length, 1);
    assert.equal(store.listFiles()[0].fileId, b.fileId);
  } finally {
    cleanup(root);
  }
});

test('maxFiles pruning keeps newest files', () => {
  const root = tempRoot();
  try {
    let now = 1000;
    const store = new McpFilesStore(root, { maxFiles: 2, now: () => now });
    store.uploadBytes('a.txt', Buffer.from('a').toString('base64'));
    now += 1000;
    store.uploadBytes('b.txt', Buffer.from('b').toString('base64'));
    now += 1000;
    store.uploadBytes('c.txt', Buffer.from('c').toString('base64'));
    const files = store.listFiles();
    assert.equal(files.length, 2);
    assert.deepEqual(files.map((f) => f.name), ['c.txt', 'b.txt']);
  } finally {
    cleanup(root);
  }
});

test('abortUpload + pruneStaleUploads', () => {
  const root = tempRoot();
  try {
    let now = 1000;
    const store = new McpFilesStore(root, { uploadTtlMs: 1000, now: () => now });
    const u1 = store.beginUpload({ name: 'a.txt' });
    assert.equal(store.abortUpload(u1.uploadId), true);
    assert.equal(store.abortUpload(u1.uploadId), false);
    assert.equal(store.abortUpload('upl-0000000000000000'), false);
    const u2 = store.beginUpload({ name: 'b.txt' });
    now += 2000;
    assert.equal(store.pruneStaleUploads(), 1);
    assert.throws(() => store.writeChunk(u2.uploadId, 0, HELLO_B64), /không có upload/);
  } finally {
    cleanup(root);
  }
});

test('resolveFilesPath blocks traversal and symlink escape', () => {
  const root = tempRoot();
  try {
    // Lexical traversal blocked.
    assert.throws(() => resolveFilesPath(root, '../outside.txt'), /thoát khỏi files root/);
    assert.throws(() => resolveFilesPath(root, 'a/../../outside.txt'), /thoát khỏi files root/);
    // Symlink inside the store pointing outside is caught.
    symlinkSync('/etc', join(root, 'escape-link'));
    assert.throws(() => resolveFilesPath(root, 'escape-link/passwd'), /thoát khỏi files root/);
  } finally {
    cleanup(root);
  }
});

test('dispatcher: full files/* method round-trip + error shapes', () => {
  const root = tempRoot();
  try {
    const store = new McpFilesStore(root);
    const handle = createMcpFilesMethodHandler(store);
    const begin = handle('files/upload/begin', { name: 'x.txt', totalBytes: HELLO.length });
    assert.equal(begin.ok, true);
    const uploadId = begin.result.uploadId;
    const chunk = handle('files/upload/chunk', { uploadId, index: 0, dataBase64: HELLO_B64 });
    assert.equal(chunk.ok, true);
    assert.equal(chunk.result.receivedBytes, HELLO.length);
    const done = handle('files/upload/complete', { uploadId });
    assert.equal(done.ok, true);
    const fileId = done.result.fileId;
    const info = handle('files/info', { fileId });
    assert.equal(info.ok, true);
    assert.equal(info.result.name, 'x.txt');
    const dl = handle('files/download', { fileId, offset: 0, length: 5 });
    assert.equal(dl.ok, true);
    assert.equal(dl.result.length, 5);
    const list = handle('files/list', {});
    assert.equal(list.ok, true);
    assert.equal(list.result.files.length, 1);
    const del = handle('files/delete', { fileId });
    assert.equal(del.ok, true);
    assert.equal(del.result.deleted, true);
    // Errors never throw: missing params, unknown method, traversal id.
    assert.equal(handle('files/info', {}).ok, false);
    assert.equal(handle('files/info', { fileId: '../../etc/passwd' }).ok, false);
    const unknown = handle('files/nope', {});
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, -32601);
    assert.equal(handle('files/download', { fileId }).ok, false); // deleted file
  } finally {
    cleanup(root);
  }
});
