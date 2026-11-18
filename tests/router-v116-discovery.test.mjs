/**
 * Router v2 discovery tests (v1.16, Doi T3 — node:test, no network,
 * no GPU, no real model).
 *
 * Covers:
 * - GGUF header parse: v3 fixture (metadata that) -> name/arch/
 *   context/block/kv-head; v2 fixture; non-GGUF -> null; truncated -> null.
 * - scanModelsDir: tim .gguf de quy, bo qua file khac, id on dinh,
 *   dedupe nhieu dir.
 * - Preset INI: parse section model:/preset:, clamp vuot gioi han,
 *   key la -> warning, extra args loc ky tu nguy hiem, merge + validate.
 * - Resource estimator: KV cache cong thuc, footprint = GGUF + KV +
 *   overhead, parse nvidia-smi, ResourceBudget fit/khong fit.
 * - buildLlamaServerArgs: argv dung (host loopback, ctx, kv, sampler).
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v116-discovery.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GGUF_MAGIC,
  buildDiscoveredModel,
  buildLlamaServerArgs,
  estimateFootprint,
  estimateKvCacheBytes,
  loadPresetFile,
  mergeFlags,
  modelIdFromFileName,
  parseGgufHeader,
  parseNvidiaSmiOutput,
  parsePresetIni,
  presetForModel,
  ResourceBudget,
  scanModelsDir,
  scanModelsDirs,
  splitArgs,
  validateFlags,
  DEFAULT_PER_MODEL_FLAGS,
} from '../packages/core/dist/routerV2/index.js';

const GB = 1024 * 1024 * 1024;

/** Build mot file GGUF toi thieu (header + metadata that). */
function buildGgufBuffer(version, kvs) {
  const parts = [];
  const header = Buffer.alloc(version === 2 ? 16 : 24);
  header.writeUInt32LE(GGUF_MAGIC, 0);
  header.writeUInt32LE(version, 4);
  if (version === 2) {
    header.writeUInt32LE(0, 8); // tensor_count
    header.writeUInt32LE(kvs.length, 12);
  } else {
    header.writeBigUInt64LE(0n, 8);
    header.writeBigUInt64LE(BigInt(kvs.length), 16);
  }
  parts.push(header);
  for (const [key, valueType, value] of kvs) {
    const keyBuf = Buffer.from(key, 'utf8');
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64LE(BigInt(keyBuf.length));
    parts.push(lenBuf, keyBuf);
    const typeBuf = Buffer.alloc(4);
    typeBuf.writeUInt32LE(valueType);
    parts.push(typeBuf);
    if (valueType === 8) {
      const vBuf = Buffer.from(value, 'utf8');
      const vLen = Buffer.alloc(8);
      vLen.writeBigUInt64LE(BigInt(vBuf.length));
      parts.push(vLen, vBuf);
    } else if (valueType === 4) {
      const vBuf = Buffer.alloc(4);
      vBuf.writeUInt32LE(value);
      parts.push(vBuf);
    }
  }
  return Buffer.concat(parts);
}

const SAMPLE_KVS = [
  ['general.name', 8, 'Qwen3 4B Test'],
  ['general.architecture', 8, 'qwen3'],
  ['llama.context_length', 4, 32768],
  ['llama.block_count', 4, 36],
  ['llama.attention.head_count_kv', 4, 8],
  ['llama.attention.head_count', 4, 32],
  ['llama.embedding_length', 4, 2560],
];

test('gguf header: v3 fixture parses metadata', () => {
  const meta = parseGgufHeader(buildGgufBuffer(3, SAMPLE_KVS));
  assert.ok(meta);
  assert.equal(meta.ggufVersion, 3);
  assert.equal(meta.name, 'Qwen3 4B Test');
  assert.equal(meta.architecture, 'qwen3');
  assert.equal(meta.contextLength, 32768);
  assert.equal(meta.blockCount, 36);
  assert.equal(meta.kvHeadCount, 8);
  assert.equal(meta.headCount, 32);
  assert.equal(meta.embeddingLength, 2560);
});

test('gguf header: v2 fixture parses; non-GGUF and truncated return null', () => {
  const meta2 = parseGgufHeader(buildGgufBuffer(2, SAMPLE_KVS));
  assert.ok(meta2);
  assert.equal(meta2.ggufVersion, 2);
  assert.equal(meta2.name, 'Qwen3 4B Test');
  assert.equal(parseGgufHeader(Buffer.from('NOPE' + 'x'.repeat(40))), null);
  assert.equal(parseGgufHeader(Buffer.alloc(10)), null);
  assert.equal(parseGgufHeader(buildGgufBuffer(3, SAMPLE_KVS).subarray(0, 30)), null);
});

test('scanModelsDir: finds .gguf recursively, stable ids, ignores others', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-scan-'));
  const sub = join(dir, 'sub');
  mkdirSync(sub);
  writeFileSync(join(dir, 'Qwen3-4B-Q4_K_M.gguf'), buildGgufBuffer(3, SAMPLE_KVS));
  writeFileSync(join(sub, 'embed.gguf'), buildGgufBuffer(3, []));
  writeFileSync(join(dir, 'notes.txt'), 'not a model');
  writeFileSync(join(dir, 'bad.gguf'), Buffer.from('not gguf at all, just text........'));
  const found = scanModelsDir(dir);
  assert.equal(found.length, 3);
  const qwen = found.find((f) => f.fileName === 'Qwen3-4B-Q4_K_M.gguf');
  assert.ok(qwen);
  assert.equal(qwen.id, 'qwen3-4b-q4-k-m');
  assert.equal(qwen.validMagic, true);
  assert.equal(qwen.metadataContextLength, 32768);
  assert.equal(qwen.headDim, 80); // 2560 / 32
  const bad = found.find((f) => f.fileName === 'bad.gguf');
  assert.equal(bad.validMagic, false);
  assert.equal(bad.ggufVersion, null);
  assert.equal(modelIdFromFileName('My Model v2.GGUF'), 'my-model-v2');
});

test('scanModelsDirs: dedupes overlapping dirs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-scan2-'));
  writeFileSync(join(dir, 'a.gguf'), buildGgufBuffer(3, []));
  const all = scanModelsDirs([dir, dir]);
  assert.equal(all.length, 1);
});

test('preset INI: parse model + preset sections, clamp, warnings', () => {
  const ini = `
# comment
[model:qwen3-4b]
context_size = 16384
kv_cache_type = q8_0
gpu_layers = 99
temperature = 0.7
top_p = 0.95
unknown_key = 123
context_size_too_big = 1

[preset:fast-chat]
context_size = 4096
temperature = 0.9
extra_args = --mlock "--foo bar"
`;
  const { presets } = parsePresetIni(ini, '/tmp/test.ini');
  assert.equal(presets.length, 2);
  const model = presetForModel(presets, 'qwen3-4b');
  assert.ok(model);
  assert.equal(model.flags.contextSize, 16384);
  assert.equal(model.flags.kvCacheType, 'q8_0');
  assert.equal(model.flags.gpuLayers, 99);
  assert.equal(model.sampler.temperature, 0.7);
  assert.equal(model.sampler.topP, 0.95);
  assert.ok(model.warnings.some((w) => w.includes('unknown_key')));
  const fast = presets.find((p) => p.name === 'fast-chat');
  assert.ok(fast);
  assert.equal(fast.flags.contextSize, 4096);
  assert.deepEqual(fast.extraArgs, ['--mlock', '--foo bar']);

  const clamped = parsePresetIni('[model:x]\ncontext_size = 99999999\ntemperature = 9\nthreads = -5\n', '/tmp/c.ini');
  const px = clamped.presets[0];
  assert.equal(px.flags.contextSize, 1_048_576);
  assert.equal(px.sampler.temperature, 2);
  assert.equal(px.flags.threads, 0);
  assert.ok(px.warnings.length >= 3);
});

test('preset INI: invalid kv type warned; dangerous extra args stripped', () => {
  const { presets } = parsePresetIni('[model:x]\nkv_cache_type = bogus\nextra_args = --ok; rm -rf /\n', '/tmp/d.ini');
  assert.equal(presets[0].flags.kvCacheType, undefined);
  assert.ok(presets[0].warnings.some((w) => w.includes('kv_cache_type')));
  assert.deepEqual(presets[0].extraArgs, []);
  assert.deepEqual(splitArgs('--a "b c" --d'), ['--a', 'b c', '--d']);
});

test('loadPresetFile: missing file reports error', () => {
  const res = loadPresetFile('/tmp/does-not-exist-router-v2.ini');
  assert.equal(res.presets.length, 0);
  assert.ok(res.error);
});

test('mergeFlags + validateFlags', () => {
  const { presets } = parsePresetIni('[model:m]\ncontext_size = 4096\ntemperature = 0.5\n', '/tmp/m.ini');
  const merged = mergeFlags(presets[0], { threads: 4, sampler: { topP: 0.8 } });
  assert.equal(merged.contextSize, 4096);
  assert.equal(merged.sampler.temperature, 0.5);
  assert.equal(merged.sampler.topP, 0.8);
  assert.equal(merged.threads, 4);
  assert.deepEqual(validateFlags(merged), []);
  const bad = { ...DEFAULT_PER_MODEL_FLAGS, contextSize: 10, kvCacheType: 'bogus' };
  assert.ok(validateFlags(bad).length >= 2);
});

test('resource estimator: KV formula + footprint + nvidia-smi parse', () => {
  // 2 * 32 layers * 8 kv heads * 128 dim * 8192 ctx * 2 byte = 1 GiB.
  assert.equal(estimateKvCacheBytes(8192, 'f16', 32, 8, 128), 1 * GB);
  assert.equal(estimateKvCacheBytes(8192, 'q8_0', 32, 8, 128), 512 * 1024 * 1024);
  const file = {
    id: 'qwen3-4b', fileName: 'q.gguf', absolutePath: '/tmp/q.gguf',
    sizeBytes: 2.5 * GB, validMagic: true, ggufVersion: 3,
    blockCount: 32, kvHeadCount: 8, headDim: 128, discoveredAt: Date.now(),
  };
  const est = estimateFootprint(file, { ...DEFAULT_PER_MODEL_FLAGS, contextSize: 8192, kvCacheType: 'f16' });
  assert.equal(est.kvBytes, 1 * GB);
  assert.equal(est.totalBytes, 2.5 * GB + 1 * GB + 256 * 1024 * 1024);
  assert.deepEqual(parseNvidiaSmiOutput('24576, 20000\n'), { totalBytes: 24576 * 1024 * 1024, freeBytes: 20000 * 1024 * 1024 });
  assert.equal(parseNvidiaSmiOutput('garbage\n'), null);
  assert.equal(parseNvidiaSmiOutput(''), null);
});

test('ResourceBudget: fits within budget, blocked when over', () => {
  const budget = new ResourceBudget({
    readRam: () => ({ totalBytes: 16 * GB, freeBytes: 12 * GB }),
    maxRamBytes: 8 * GB,
  });
  assert.equal(budget.fitsRam(2 * GB, 4 * GB), true);
  assert.equal(budget.fitsRam(5 * GB, 4 * GB), false); // 4 + 5 > 8
  assert.equal(budget.fitsRam(2 * GB, 7 * GB), false);
  assert.deepEqual(budget.checkFit(9 * GB, 0, 0, null).fits, false);
  assert.equal(budget.checkFit(1 * GB, 0, 0, 512 * 1024 * 1024).fits, false); // VRAM
  assert.equal(budget.checkFit(1 * GB, 0, 0, null).fits, true); // VRAM unknown -> RAM only
  assert.ok(budget.availableRam(0) > 0);
});

test('buildDiscoveredModel: preset caps context at metadata limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-disc-'));
  writeFileSync(join(dir, 'm.gguf'), buildGgufBuffer(3, SAMPLE_KVS));
  const [file] = scanModelsDir(dir);
  const discovered = buildDiscoveredModel(file, () => ({
    name: 'qwen3-4b', modelId: 'qwen3-4b-q4-k-m', flags: { contextSize: 65536 },
    sampler: {}, extraArgs: [], warnings: [], sourcePath: '/tmp/p.ini',
  }));
  // Metadata context 32768 caps the 65536 preset request.
  assert.equal(discovered.effectiveFlags.contextSize, 32768);
  assert.ok(discovered.estimatedFootprintBytes > 0);
  assert.ok(discovered.estimatedKvBytes > 0);
});

test('buildLlamaServerArgs: loopback host, ctx, kv, sampler, extras', () => {
  const args = buildLlamaServerArgs('/models/q.gguf', {
    ...DEFAULT_PER_MODEL_FLAGS, contextSize: 4096, kvCacheType: 'q8_0', threads: 4, gpuLayers: 10,
    sampler: { temperature: 0.5 }, extraArgs: ['--mlock'],
  }, 18100);
  assert.deepEqual(args.slice(0, 6), ['-m', '/models/q.gguf', '--port', '18100', '--host', '127.0.0.1']);
  assert.ok(args.includes('--ctx-size') && args.includes('4096'));
  assert.ok(args.includes('--cache-type-k') && args.includes('q8_0'));
  assert.ok(args.includes('--threads') && args.includes('4'));
  assert.ok(args.includes('--n-gpu-layers') && args.includes('10'));
  assert.ok(args.includes('--temp') && args.includes('0.5'));
  assert.ok(args.includes('--mlock'));
});
