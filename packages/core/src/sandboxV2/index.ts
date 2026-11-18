// Sandbox v2 — tiered isolation model (v134-t2).
// Tier 1: bwrap (reuses sandbox v1). Tier 2: syscall-policy engine
// (gVisor-style filter, simulated in-process — no kernel code).
// Tier 3: microVM descriptor (Firecracker-style spec + dry-run
// feasibility report; never executes a real VM from here).
export * from './types';
export * from './policy';
export * from './tierSelector';
export * from './syscallPolicy';
export * from './tokenBroker';
export * from './killSwitch';
export * from './runReport';
export * from './runner';
export * from './microvm';
