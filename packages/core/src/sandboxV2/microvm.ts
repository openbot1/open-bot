/**
 * Sandbox v2 — microVM descriptor, Firecracker-style (v1.34, Đội T2).
 *
 * Idea (from the v1.34 survey §3): a Firecracker microVM runs the
 * code under its OWN kernel via KVM — boot ~125ms, overhead <5MB,
 * snapshot resume — so an attacker must escape both the guest kernel
 * AND the hypervisor. That is the gold tier for untrusted code.
 *
 * This module builds, validates and dry-runs the DESCRIPTOR only:
 * kernel path, rootfs path, vCPU/RAM sizing, kernel cmdline, drives
 * and an optional snapshot id. It NEVER boots a VM, NEVER spawns
 * firecracker, NEVER touches /dev/kvm for real. `dryRun()` answers
 * "could this boot on this host?" with blockers + warnings + boot
 * estimates, so the runner (and the UI) can decide honestly on an
 * OS without KVM instead of failing at boot time.
 *
 * Sizing rules (from the survey's published Firecracker numbers):
 *  - cold boot ~125ms with KVM; without KVM there is no boot at all
 *    (blocker, not a slowdown).
 *  - snapshot resume is ~5–10x faster than cold boot.
 *  - guest RAM must leave the host at least 512MB free.
 *  - vCPU count must not exceed host CPUs.
 */

import * as fs from 'node:fs';
import type { SandboxV2HostCapabilities, SandboxV2MicroVmFeasibility, SandboxV2MicroVmSpec } from './types';

/** Firecracker-class cold-boot time with KVM, ms (survey: ~125ms). */
export const SANDBOX_V2_MICROVM_COLD_BOOT_MS = 125;

/** Snapshot resume is roughly 8x faster than a cold boot. */
export const SANDBOX_V2_MICROVM_RESUME_DIVISOR = 8;

/** Guest RAM bounds, MiB. */
export const SANDBOX_V2_MICROVM_MIN_MEMORY_MIB = 128;
export const SANDBOX_V2_MICROVM_MAX_MEMORY_MIB = 32768;

/** vCPU bounds. */
export const SANDBOX_V2_MICROVM_MIN_VCPU = 1;
export const SANDBOX_V2_MICROVM_MAX_VCPU = 32;

/** Host RAM that must stay free after the guest takes its share, bytes. */
export const SANDBOX_V2_MICROVM_HOST_RESERVE_BYTES = 512 * 1024 * 1024;

/** Default kernel command line for the guest. */
export const SANDBOX_V2_MICROVM_DEFAULT_CMDLINE =
  'console=ttyS0 reboot=k panic=1 pci=off';

/** Default microVM spec for one vCPU + 512MiB (sane starting point). */
export function defaultMicroVmSpec(overrides: Partial<SandboxV2MicroVmSpec> = {}): SandboxV2MicroVmSpec {
  return {
    kernelPath: overrides.kernelPath ?? '',
    rootfsPath: overrides.rootfsPath ?? '',
    vcpuCount: overrides.vcpuCount ?? 1,
    memoryMiB: overrides.memoryMiB ?? 512,
    kernelCmdline: overrides.kernelCmdline ?? SANDBOX_V2_MICROVM_DEFAULT_CMDLINE,
    ...(overrides.snapshotId !== undefined ? { snapshotId: overrides.snapshotId } : {}),
    networkHosts: overrides.networkHosts ?? [],
    drives: overrides.drives ?? [],
  };
}

/** Validation result for a microVM spec. */
export interface SandboxV2MicroVmValidation {
  valid: boolean;
  problems: string[];
  warnings: string[];
}

/**
 * Validate a microVM spec (shape + sizing only — file existence is
 * checked by dryRun(), which knows the host).
 */
export function validateMicroVmSpec(spec: SandboxV2MicroVmSpec): SandboxV2MicroVmValidation {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!spec || typeof spec !== 'object') {
    return { valid: false, problems: ['microVM spec must be an object'], warnings };
  }
  if (typeof spec.kernelPath !== 'string' || spec.kernelPath.trim() === '') {
    problems.push('kernelPath must be a non-empty string');
  }
  if (typeof spec.rootfsPath !== 'string' || spec.rootfsPath.trim() === '') {
    problems.push('rootfsPath must be a non-empty string');
  }
  if (!Number.isInteger(spec.vcpuCount) || spec.vcpuCount < SANDBOX_V2_MICROVM_MIN_VCPU || spec.vcpuCount > SANDBOX_V2_MICROVM_MAX_VCPU) {
    problems.push(`vcpuCount must be an integer ${SANDBOX_V2_MICROVM_MIN_VCPU}–${SANDBOX_V2_MICROVM_MAX_VCPU}, got ${String(spec.vcpuCount)}`);
  }
  if (!Number.isInteger(spec.memoryMiB) || spec.memoryMiB < SANDBOX_V2_MICROVM_MIN_MEMORY_MIB || spec.memoryMiB > SANDBOX_V2_MICROVM_MAX_MEMORY_MIB) {
    problems.push(`memoryMiB must be an integer ${SANDBOX_V2_MICROVM_MIN_MEMORY_MIB}–${SANDBOX_V2_MICROVM_MAX_MEMORY_MIB}, got ${String(spec.memoryMiB)}`);
  }
  if (typeof spec.kernelCmdline !== 'string') {
    problems.push('kernelCmdline must be a string');
  }
  if (spec.snapshotId !== undefined && (typeof spec.snapshotId !== 'string' || spec.snapshotId.trim() === '')) {
    problems.push('snapshotId must be a non-empty string when set');
  }
  if (!Array.isArray(spec.networkHosts)) {
    problems.push('networkHosts must be an array');
  } else {
    for (const host of spec.networkHosts) {
      if (typeof host !== 'string' || host.trim() === '' || host.includes('/') || host.includes(' ')) {
        problems.push(`networkHosts entries must be plain hostnames, got ${JSON.stringify(host)}`);
      }
    }
    if (spec.networkHosts.length > 0) {
      warnings.push('microVM network is allow-list only — the guest gets no egress except to listed hosts');
    }
  }
  if (!Array.isArray(spec.drives)) {
    problems.push('drives must be an array');
  } else {
    for (const drive of spec.drives) {
      if (!drive || typeof drive !== 'object') {
        problems.push('drives entries must be objects');
        continue;
      }
      if (typeof drive.hostPath !== 'string' || drive.hostPath.trim() === '') {
        problems.push('drives[].hostPath must be a non-empty string');
      }
      if (typeof drive.guestPath !== 'string' || drive.guestPath.trim() === '') {
        problems.push('drives[].guestPath must be a non-empty string');
      }
      if (typeof drive.readOnly !== 'boolean') {
        problems.push('drives[].readOnly must be a boolean');
      }
      if (drive.hostPath && drive.hostPath.includes('..')) {
        problems.push(`drive hostPath "${drive.hostPath}" must not contain ".."`);
      }
    }
  }
  if (spec.memoryMiB > 4096) {
    warnings.push(`guest memory ${spec.memoryMiB}MiB is large for an agent sandbox — prefer ≤4096MiB`);
  }
  return { valid: problems.length === 0, problems, warnings };
}

/** File-existence check override for tests (defaults to fs.existsSync). */
export type SandboxV2FileExistsFn = (filePath: string) => boolean;

/**
 * Dry-run feasibility: could this spec boot on this host? Never
 * boots anything. `feasible === false` always comes with at least
 * one blocker explaining why, so the UI can show the real reason
 * instead of a generic failure.
 */
export function dryRunMicroVm(
  spec: SandboxV2MicroVmSpec,
  host: SandboxV2HostCapabilities,
  fileExists: SandboxV2FileExistsFn = (p: string) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  },
): SandboxV2MicroVmFeasibility {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const validation = validateMicroVmSpec(spec);
  blockers.push(...validation.problems);
  warnings.push(...validation.warnings);

  if (host.platform !== 'linux') {
    blockers.push(`microVM needs Linux + KVM; this host runs ${host.platform}`);
  }
  if (!host.kvmAvailable) {
    blockers.push('/dev/kvm is not readable on this host — KVM acceleration unavailable, microVM cannot boot');
  }
  if (!host.firecrackerAvailable) {
    warnings.push('firecracker binary not found on PATH — a real boot would need it installed');
  }
  if (spec.kernelPath !== '' && !fileExists(spec.kernelPath)) {
    blockers.push(`kernel image not found: ${spec.kernelPath}`);
  }
  if (spec.rootfsPath !== '' && !fileExists(spec.rootfsPath)) {
    blockers.push(`rootfs image not found: ${spec.rootfsPath}`);
  }
  if (host.cpuCount > 0 && spec.vcpuCount > host.cpuCount) {
    blockers.push(`vcpuCount ${spec.vcpuCount} exceeds host CPU count ${host.cpuCount}`);
  }
  if (host.totalMemoryBytes > 0) {
    const guestBytes = spec.memoryMiB * 1024 * 1024;
    if (guestBytes + SANDBOX_V2_MICROVM_HOST_RESERVE_BYTES > host.totalMemoryBytes) {
      blockers.push(
        `guest memory ${spec.memoryMiB}MiB leaves less than 512MiB free on a host with ` +
          `${Math.round(host.totalMemoryBytes / 1024 / 1024)}MiB total`,
      );
    }
  }
  for (const drive of spec.drives ?? []) {
    if (drive.hostPath !== '' && !fileExists(drive.hostPath)) {
      blockers.push(`drive host path not found: ${drive.hostPath}`);
    }
    if (!drive.readOnly) {
      warnings.push(`drive ${drive.hostPath} is writable inside the guest — prefer readOnly for untrusted code`);
    }
  }

  const feasible = blockers.length === 0;
  const estimatedBootMs = feasible ? SANDBOX_V2_MICROVM_COLD_BOOT_MS : 0;
  const result: SandboxV2MicroVmFeasibility = {
    feasible,
    estimatedBootMs,
    ...(spec.snapshotId !== undefined && feasible
      ? { estimatedResumeMs: Math.ceil(SANDBOX_V2_MICROVM_COLD_BOOT_MS / SANDBOX_V2_MICROVM_RESUME_DIVISOR) }
      : {}),
    blockers,
    warnings,
    host: {
      platform: host.platform,
      kvmAvailable: host.kvmAvailable,
      cpuCount: host.cpuCount,
      totalMemoryBytes: host.totalMemoryBytes,
      firecrackerAvailable: host.firecrackerAvailable,
    },
  };
  return result;
}

/** Render a microVM spec as the JSON a Firecracker-class launcher would consume. */
export function renderMicroVmConfigJson(spec: SandboxV2MicroVmSpec): string {
  const config = {
    'boot-source': {
      kernel_image_path: spec.kernelPath,
      boot_args: spec.kernelCmdline || SANDBOX_V2_MICROVM_DEFAULT_CMDLINE,
    },
    'machine-config': {
      vcpu_count: spec.vcpuCount,
      mem_size_mib: spec.memoryMiB,
    },
    drives: [
      {
        drive_id: 'rootfs',
        path_on_host: spec.rootfsPath,
        is_root_device: true,
        is_read_only: false,
      },
      ...spec.drives.map((drive, index) => ({
        drive_id: `extra-${index}`,
        path_on_host: drive.hostPath,
        is_root_device: false,
        is_read_only: drive.readOnly,
      })),
    ],
    ...(spec.snapshotId !== undefined ? { snapshot: { snapshot_id: spec.snapshotId } } : {}),
    network: {
      enabled: spec.networkHosts.length > 0,
      allow_hosts: spec.networkHosts,
    },
  };
  return JSON.stringify(config, null, 2);
}

/**
 * Describe a snapshot: what resuming it would restore. Snapshots
 * are descriptors here (no disk state is written by this module) —
 * the launcher owns the snapshot files; this just validates the id
 * and estimates the resume time.
 */
export function describeMicroVmSnapshot(snapshotId: string): { snapshotId: string; estimatedResumeMs: number; note: string } {
  if (typeof snapshotId !== 'string' || snapshotId.trim() === '') {
    throw new Error('snapshotId must be a non-empty string');
  }
  return {
    snapshotId,
    estimatedResumeMs: Math.ceil(SANDBOX_V2_MICROVM_COLD_BOOT_MS / SANDBOX_V2_MICROVM_RESUME_DIVISOR),
    note: 'Snapshot resume restores vCPU + memory state; the guest kernel is not re-booted. The launcher must verify the snapshot file exists before resuming.',
  };
}
