// Shared platform rules for the live TTS scripts (v1.04, Team T5).
//
// The v0.82/v0.83 scripts asserted a hard `espeak-ng` engine, which is
// only true on Linux machines that installed it. CI runs on three OSes
// and the engine that actually exists differs per platform:
//
//   - Linux:   `espeak-ng` / `espeak` / `spd-say` / `flite`
//   - macOS:   `say` (espeak-ng only if the user installed it)
//   - Windows: none of the above on a stock machine — the script must
//     SKIP (exit 0), not fail. A missing speech engine is a machine
//     fact, not a product bug; the unit tests already cover the
//     no-engine path (`{ spoken: false, reason: 'no-engine-available' }`).
//
// Rules both live scripts follow (see also
// `packages/core/src/voice/tts.ts`, whose `SystemTtsEngine` already
// picks the first candidate binary on PATH in this order):
//
//   1. No engine on PATH → print SKIP and exit 0.
//   2. Engine present → its id must be one of the known system ids
//      (the same list as `SYSTEM_TTS_ENGINE_IDS` in
//      `packages/core/src/voice/localVoiceEngines.ts`); never assert
//      a specific id.
//   3. Assertions that only make sense for the eSpeak family (voice
//      list, the `vi` voice, `vi-vn-x-south`) run only when the
//      engine IS eSpeak; other engines get a generic equivalent
//      (listVoices must not throw, a rate-only speak works).
//   4. Process-leftover checks need `pgrep`, which exists on Linux
//      and macOS but not on Windows — on Windows that check is
//      skipped with a note instead of failing on a missing binary.
import { execSync } from 'node:child_process';

/**
 * The system speech binaries `SystemTtsEngine` can pick, in priority
 * order. Keep in sync with `SYSTEM_TTS_ENGINE_IDS` in
 * `packages/core/src/voice/localVoiceEngines.ts`.
 */
export const KNOWN_SYSTEM_TTS_ENGINE_IDS = [
  'espeak-ng',
  'espeak',
  'spd-say',
  'say',
  'flite',
];

/** Engines whose CLI supports `--voices` and `-v <voice>` selection. */
export const ESPEAK_FAMILY_IDS = ['espeak-ng', 'espeak'];

/** True when the engine id is one of the known system TTS engines. */
export function isKnownSystemTtsEngine(engineId) {
  return KNOWN_SYSTEM_TTS_ENGINE_IDS.includes(engineId);
}

/** True when the engine is eSpeak / eSpeak NG (voice list supported). */
export function isEspeakFamily(engineId) {
  return ESPEAK_FAMILY_IDS.includes(engineId);
}

/**
 * Lines of `pgrep -a -x <binary>` output, or '' when the listing is
 * unavailable (Windows has no pgrep; a missing pgrep is not an
 * error). The binary name is the engine id for every candidate
 * (`espeak-ng`, `say`, …), so callers pass `engine.id`.
 */
export function listNamedProcesses(binary) {
  if (process.platform === 'win32') return '';
  try {
    return execSync(`pgrep -a -x ${binary} || true`, {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

/** True when a process-leftover check can run on this platform. */
export function canListProcesses() {
  return process.platform !== 'win32';
}

/**
 * Log the skip and exit 0 when no system speech engine is present.
 * Returns true when the caller should stop (skipped), false when a
 * live engine exists and the script should continue. `engine` is a
 * `SystemTtsEngine` (already constructed by the caller).
 */
export async function skipLiveTtsIfNoEngine(engine) {
  const available = await engine.isAvailable();
  console.log(
    'platform:',
    process.platform,
    'engine:',
    engine.id,
    engine.name,
    'available:',
    available,
  );
  if (!available) {
    console.log(
      `SKIP live TTS: no system speech engine on ${process.platform} ` +
        '(espeak-ng/espeak/spd-say/say/flite all absent from PATH) — ' +
        'not a failure, the no-engine path is covered by unit tests.',
    );
    process.exit(0);
    return true;
  }
  return false;
}
