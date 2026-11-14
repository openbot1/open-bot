// Live TTS stop test (v0.83a, platform-aware since v1.04): the real
// system speech engine on THIS machine, no fake binary.
//
// Machine fact (checked 2026-11-11): this VM has NO audio device
// (/dev/snd absent, no PulseAudio/PipeWire) — plain `espeak-ng`
// fails its ALSA open and exits in ~40 ms with code 0, however long
// the text is. So a "long utterance" cannot stay in flight here the
// way it would on a real desktop with speakers, and `stop()` after
// 500 ms correctly finds nothing to kill. The true in-flight kill
// is proven at process level by tests/tts-stop-v083.test.mjs (real
// spawned slow binary); this script proves the live side instead:
//   1. a short speak works through the real binary;
//   2. a stop raced right after starting a long speak never crashes
//      and never hangs — the promise settles as spoken:true (it
//      finished first) or 'stopped' (killed in flight), and no
//      process of this test is left behind;
//   3. stop() with nothing speaking is { stopped: false };
//   4. the engine still speaks after a stop.
//
// Platform rules (v1.04 — the v0.83 version asserted a hard
// `espeak-ng` and a hard `pgrep -a -x espeak-ng`, both Linux-only):
//   - no engine on PATH → SKIP (exit 0), not a failure (Windows has
//     no eSpeak binary; macOS uses `say`);
//   - engine present → its id must be a known system id, and the
//     leftover-process check lists processes named after THAT
//     engine (`engine.id` is the binary name for every candidate);
//   - the leftover check needs `pgrep` (Linux/macOS); on Windows it
//     is skipped with a note instead of failing on a missing binary.
// Run: npm run build --workspace=@open-bot/core && node scripts/tts-live-v083/live-test.mjs
import { SystemTtsEngine, TtsHarness } from '../../packages/core/dist/voice/tts.js';
import assert from 'node:assert/strict';
import {
  canListProcesses,
  isKnownSystemTtsEngine,
  listNamedProcesses,
  skipLiveTtsIfNoEngine,
} from '../tts-live-platform.mjs';

const engine = new SystemTtsEngine();
await skipLiveTtsIfNoEngine(engine);
assert.ok(
  isKnownSystemTtsEngine(engine.id),
  `engine id ${engine.id} must be a known system TTS engine`,
);

const harness = new TtsHarness([engine]);
const r1 = await harness.speak('Xin chào open-bot, đây là giọng đọc thật từ hệ thống.');
console.log('short speak:', JSON.stringify(r1));
assert.equal(r1.spoken, true, 'real speak() must report spoken:true');
assert.deepEqual(await harness.stop(), { stopped: false, engineId: null });
console.log('stop when idle:', JSON.stringify(await harness.stop()));

// Race stop against a long utterance: the binary exits fast on this
// audio-less machine, so either outcome is legitimate — what must
// hold is: no crash, no hang, no leftover process OF THIS TEST.
// (Sibling test files run in parallel under `npm test` and may
// legitimately have their own engine process in flight — the v0.83
// full suite caught `scripts/tts-live-v082/live-test.mjs` speaking
// "Hello from open-bot" at this exact moment — so the check filters
// on this test's own distinctive text instead of asserting that no
// speech process exists anywhere on the machine.)
const longText = 'Đây là một câu trả lời rất dài để kiểm tra nút dừng. '.repeat(30);
const t0 = Date.now();
const speaking = harness.speak(longText);
const stopRes = await harness.stop();
const res = await speaking;
console.log('race stop:', JSON.stringify(stopRes), 'speak:', JSON.stringify(res), `${Date.now() - t0}ms`);
assert.ok(
  (stopRes.stopped === true && res.reason === 'stopped') ||
    (stopRes.stopped === false && res.spoken === true),
  'race outcome must be consistent (killed => stopped, finished => spoken)',
);
assert.ok(Date.now() - t0 < 10_000, 'race settles in seconds');
if (canListProcesses()) {
  const allLeft = listNamedProcesses(engine.id);
  console.log(`${engine.id} processes left:`, JSON.stringify(allLeft));
  // Only this test's own utterance counts: filter on the distinctive
  // phrase in its argv ('rất dài' sits ~30 chars into the text, so it
  // survives any cmdline truncation in pgrep output).
  const ownLeft = allLeft
    .split('\n')
    .filter((line) => line.includes('rất dài'));
  assert.equal(ownLeft.length, 0, `no ${engine.id} process of this test survives the race`);
} else {
  console.log(
    `leftover-process check skipped on ${process.platform} (no pgrep) — ` +
      'the race consistency assertion above is the check on this platform.',
  );
}
// The engine still works after a stop.
const r2 = await harness.speak('Xin chào, giọng đọc vẫn hoạt động sau khi dừng.');
console.log('speak after stop:', JSON.stringify(r2));
assert.equal(r2.spoken, true);
console.log(`LIVE TTS STOP OK (engine: ${engine.id}, platform: ${process.platform})`);
