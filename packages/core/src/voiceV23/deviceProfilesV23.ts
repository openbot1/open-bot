/**
 * Per-device profiles for voice v23 (v1.36, Team T5).
 *
 * v22 voice profiles describe *how the agent sounds*
 * (prosody, locale, engine). v23 device profiles describe
 * *what the user speaks into*: the laptop mic, the headset,
 * the phone, the car kit — each with its own gain, noise
 * threshold, echo-cancellation and sample rate, fitted by
 * the calibration engine and stored per device so the user
 * is not re-calibrated every time they switch hardware.
 *
 * Built-in presets are starting points, not measurements:
 * applying a calibration result overwrites the fitted fields
 * (gain, threshold, environment) and stamps the profile as
 * calibrated. Matching picks the best preset for a device
 * fingerprint (kind + echo cancellation + sample rate).
 */
import type { VoiceV23DeviceKind, VoiceV23Environment } from './types';
import { clampV23, round2V23, round4V23 } from './types';
import type { VoiceV23CalibrationResult } from './calibrationV23';

export interface VoiceV23DeviceProfile {
  id: string;
  kind: VoiceV23DeviceKind;
  label: string;
  /** Gain multiplier applied to captured audio (0.5..4). */
  gain: number;
  /** Speech energy threshold for this device (0.05..0.9). */
  noiseThreshold: number;
  /** True when the device does its own echo cancellation. */
  echoCancellation: boolean;
  /** Capture sample rate, Hz. */
  sampleRate: number;
  /** Environment the profile was last calibrated in (null = never). */
  environment: VoiceV23Environment | null;
  /** True when gain/threshold came from a calibration run. */
  calibrated: boolean;
  /** True for the shipped presets (cannot be removed). */
  builtin: boolean;
}

/** Fingerprint a device presents when it connects. */
export interface VoiceV23DeviceFingerprint {
  kind: VoiceV23DeviceKind;
  echoCancellation?: boolean;
  sampleRate?: number;
  label?: string;
}

export function builtinDeviceProfilesV23(): VoiceV23DeviceProfile[] {
  return [
    { id: 'device-laptop', kind: 'laptop', label: 'Laptop microphone', gain: 1.2, noiseThreshold: 0.18, echoCancellation: false, sampleRate: 16000, environment: null, calibrated: false, builtin: true },
    { id: 'device-desktop', kind: 'desktop', label: 'Desktop microphone', gain: 1.0, noiseThreshold: 0.15, echoCancellation: false, sampleRate: 16000, environment: null, calibrated: false, builtin: true },
    { id: 'device-headset', kind: 'headset', label: 'Headset', gain: 1.0, noiseThreshold: 0.12, echoCancellation: true, sampleRate: 16000, environment: null, calibrated: false, builtin: true },
    { id: 'device-phone', kind: 'phone', label: 'Phone', gain: 1.4, noiseThreshold: 0.22, echoCancellation: true, sampleRate: 16000, environment: null, calibrated: false, builtin: true },
    { id: 'device-speaker', kind: 'speaker', label: 'Smart speaker', gain: 1.5, noiseThreshold: 0.25, echoCancellation: true, sampleRate: 16000, environment: null, calibrated: false, builtin: true },
    { id: 'device-car', kind: 'car', label: 'Car kit', gain: 1.8, noiseThreshold: 0.3, echoCancellation: true, sampleRate: 16000, environment: null, calibrated: false, builtin: true },
  ];
}

export function clampDeviceProfileV23(p: Partial<Pick<VoiceV23DeviceProfile, 'gain' | 'noiseThreshold' | 'sampleRate'>>): {
  gain?: number;
  noiseThreshold?: number;
  sampleRate?: number;
} {
  const out: { gain?: number; noiseThreshold?: number; sampleRate?: number } = {};
  if (p.gain !== undefined) out.gain = round2V23(clampV23(p.gain, 0.5, 4));
  if (p.noiseThreshold !== undefined) out.noiseThreshold = round4V23(clampV23(p.noiseThreshold, 0.05, 0.9));
  if (p.sampleRate !== undefined) out.sampleRate = [8000, 16000, 22050, 44100, 48000].includes(p.sampleRate) ? p.sampleRate : 16000;
  return out;
}

export function validateDeviceProfileV23(p: Partial<VoiceV23DeviceProfile> & { id?: string }): string[] {
  const errors: string[] = [];
  if (typeof p.id !== 'string' || p.id.trim() === '') errors.push('id must be a non-empty string');
  else if (!/^[A-Za-z0-9_-]+$/.test(p.id)) errors.push(`id "${p.id}" must match [A-Za-z0-9_-]`);
  if (typeof p.label !== 'string' || p.label.trim() === '') errors.push('label must be a non-empty string');
  if (p.kind !== undefined && !['laptop', 'desktop', 'phone', 'headset', 'speaker', 'car', 'unknown'].includes(p.kind)) {
    errors.push(`unknown kind "${p.kind}"`);
  }
  if (p.gain !== undefined && !(p.gain >= 0.5 && p.gain <= 4)) errors.push('gain must be 0.5..4');
  if (p.noiseThreshold !== undefined && !(p.noiseThreshold >= 0.05 && p.noiseThreshold <= 0.9)) {
    errors.push('noiseThreshold must be 0.05..0.9');
  }
  if (p.sampleRate !== undefined && ![8000, 16000, 22050, 44100, 48000].includes(p.sampleRate)) {
    errors.push(`sampleRate ${p.sampleRate} is not supported`);
  }
  return errors;
}

export interface VoiceV23DeviceProfileStats {
  total: number;
  builtin: number;
  custom: number;
  calibrated: number;
  byKind: Record<string, number>;
}

export class DeviceProfileRegistryV23 {
  private readonly profiles = new Map<string, VoiceV23DeviceProfile>();
  private currentId: string;
  private readonly userDefaults = new Map<string, string>();

  constructor() {
    for (const p of builtinDeviceProfilesV23()) this.profiles.set(p.id, { ...p });
    this.currentId = 'device-laptop';
  }

  list(): VoiceV23DeviceProfile[] {
    return [...this.profiles.values()].map((p) => ({ ...p }));
  }

  listByKind(kind: VoiceV23DeviceKind): VoiceV23DeviceProfile[] {
    return this.list().filter((p) => p.kind === kind);
  }

  get(id: string): VoiceV23DeviceProfile | null {
    const p = this.profiles.get(id);
    return p === undefined ? null : { ...p };
  }

  current(): string {
    return this.currentId;
  }

  currentProfile(): VoiceV23DeviceProfile | null {
    return this.get(this.currentId);
  }

  add(profile: VoiceV23DeviceProfile): string[] {
    const errors = validateDeviceProfileV23(profile);
    if (this.profiles.has(profile.id)) errors.push(`profile "${profile.id}" already exists`);
    if (errors.length > 0) return errors;
    this.profiles.set(profile.id, { ...profile, ...clampDeviceProfileV23(profile), builtin: false });
    return [];
  }

  update(id: string, patch: Partial<Omit<VoiceV23DeviceProfile, 'id' | 'builtin'>>): string[] {
    const existing = this.profiles.get(id);
    if (existing === undefined) return [`No device profile "${id}".`];
    const clamped = clampDeviceProfileV23(patch);
    const merged: VoiceV23DeviceProfile = {
      ...existing,
      ...patch,
      ...clamped,
      id: existing.id,
      builtin: existing.builtin,
    };
    const errors = validateDeviceProfileV23(merged);
    if (errors.length > 0) return errors;
    this.profiles.set(id, merged);
    return [];
  }

  remove(id: string): string[] {
    const existing = this.profiles.get(id);
    if (existing === undefined) return [`No device profile "${id}".`];
    if (existing.builtin) return [`Built-in device profile "${id}" cannot be removed.`];
    this.profiles.delete(id);
    if (this.currentId === id) this.currentId = 'device-laptop';
    for (const [user, def] of this.userDefaults) {
      if (def === id) this.userDefaults.delete(user);
    }
    return [];
  }

  switchTo(id: string): string[] {
    if (!this.profiles.has(id)) return [`No device profile "${id}".`];
    this.currentId = id;
    return [];
  }

  setUserDefault(userId: string, profileId: string): string[] {
    if (!this.profiles.has(profileId)) return [`No device profile "${profileId}".`];
    this.userDefaults.set(userId, profileId);
    return [];
  }

  userDefault(userId: string): string | null {
    return this.userDefaults.get(userId) ?? null;
  }

  profileForUser(userId: string): VoiceV23DeviceProfile | null {
    const def = this.userDefaults.get(userId);
    if (def !== undefined) {
      const p = this.get(def);
      if (p !== null) return p;
    }
    return this.currentProfile();
  }

  /**
   * Pick the best preset for a device fingerprint: same kind
   * first, then echo-cancellation match, then sample-rate
   * match. Unknown kinds fall back to the laptop preset.
   */
  match(fingerprint: VoiceV23DeviceFingerprint): { profile: VoiceV23DeviceProfile; score: number } {
    let best: VoiceV23DeviceProfile | null = null;
    let bestScore = -1;
    for (const p of this.profiles.values()) {
      let score = 0;
      if (p.kind === fingerprint.kind) score += 10;
      if (fingerprint.echoCancellation !== undefined && p.echoCancellation === fingerprint.echoCancellation) score += 3;
      if (fingerprint.sampleRate !== undefined && p.sampleRate === fingerprint.sampleRate) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    const profile = best ?? this.profiles.get('device-laptop');
    if (profile === undefined) throw new Error('No device profiles registered');
    return { profile: { ...profile }, score: bestScore };
  }

  /**
   * Apply a calibration result to a profile: gain, threshold
   * and environment come from the measurement, and the
   * profile is stamped calibrated.
   */
  applyCalibration(id: string, result: VoiceV23CalibrationResult): string[] {
    const existing = this.profiles.get(id);
    if (existing === undefined) return [`No device profile "${id}".`];
    const errors = this.update(id, {
      gain: result.gain,
      noiseThreshold: result.speechThreshold,
      environment: result.environment,
      calibrated: true,
    });
    return errors;
  }

  stats(): VoiceV23DeviceProfileStats {
    const all = [...this.profiles.values()];
    const byKind: Record<string, number> = {};
    for (const p of all) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
    return {
      total: all.length,
      builtin: all.filter((p) => p.builtin).length,
      custom: all.filter((p) => !p.builtin).length,
      calibrated: all.filter((p) => p.calibrated).length,
      byKind,
    };
  }

  summary(): string {
    const s = this.stats();
    return `device profiles: ${s.total} (${s.builtin} built-in, ${s.custom} custom, ${s.calibrated} calibrated), current ${this.currentId}`;
  }
}

export function createDeviceProfileRegistryV23(): DeviceProfileRegistryV23 {
  return new DeviceProfileRegistryV23();
}
