/**
 * Composio sandbox boundary v1.29 (v1.29, Doi T4 — Composio v6).
 *
 * Ranh gioi sandbox theo tung conversation: moi conversation co mot
 * boundary rieng gioi han nhung gi Composio duoc lam trong cuoc tro
 * chuyen do — toolkit nao duoc goi, tool ghi co duoc phep khong, bao
 * nhieu call/job/poll, bao nhieu byte ket qua, bao lau. Vuot gioi
 * han -> tu choi truoc khi goi (fail-closed), ghi audit.
 *
 * Thiet ke:
 * - Boundary la du lieu thuan: `admit*` chi kiem tra (khong doi
 *   state), `record*` tra boundary moi da cap nhat usage — host
 *   luu lai qua store. Khong co side effect an.
 * - Gioi han mac dinh chat (conservative): 200 call, 5 job chay
 *   cung luc, 1 MB ket qua tich luy, 1000 poll, 30 phut wall-clock.
 *   Host/user co the mo rong khi tao boundary (co ghi audit).
 * - allowedToolkits rong = cho phep tat ca toolkit trong catalog
 *   (live + mock); deniedToolkits luon thang allowed (deny thang
 *   allow). allowWrite = false thi moi tool ghi bi chan du toolkit
 *   co trong allowlist.
 * - Audit append-only, toi da 200 entry/boundary (entry cu nhat bi
 *   cat) — du de truy vet ma khong phong store vo han.
 * - Wall-clock: window tinh tu createdAtMs; het maxWallMs thi moi
 *   call deu bi tu choi (boundary het han), ke ca khi chua het quota.
 */

import { mockComposioV129ToolNeedsApproval } from './toolkitsV129';

/** Version checkpoint JSON cua sandbox boundary v129. */
export const COMPOSIO_V129_SANDBOX_VERSION = 1;

/** So audit entry toi da giu lai moi boundary. */
export const COMPOSIO_V129_SANDBOX_MAX_AUDIT_ENTRIES = 200;

/** Gioi han mac dinh (chat) cho mot conversation sandbox. */
export const DEFAULT_COMPOSIO_V129_SANDBOX_LIMITS = {
  /** So call Composio toi da trong conversation. */
  maxCalls: 200,
  /** So long job chay cung luc toi da. */
  maxConcurrentJobs: 5,
  /** Tong byte ket qua tich luy toi da. */
  maxTotalResultBytes: 1_000_000,
  /** So lan poll toi da (tat ca job cong lai). */
  maxPolls: 1000,
  /** Tuoi tho boundary: 30 phut tu luc tao. */
  maxWallMs: 30 * 60 * 1000,
  /** Tool ghi (create/update/delete/...) co duoc phep khong. */
  allowWrite: false,
} as const;

export interface ComposioV129SandboxLimits {
  maxCalls?: number;
  maxConcurrentJobs?: number;
  maxTotalResultBytes?: number;
  maxPolls?: number;
  maxWallMs?: number;
  allowWrite?: boolean;
}

export function resolveComposioV129SandboxLimits(
  limits: ComposioV129SandboxLimits = {},
): Required<ComposioV129SandboxLimits> {
  return {
    maxCalls: limits.maxCalls ?? DEFAULT_COMPOSIO_V129_SANDBOX_LIMITS.maxCalls,
    maxConcurrentJobs:
      limits.maxConcurrentJobs ?? DEFAULT_COMPOSIO_V129_SANDBOX_LIMITS.maxConcurrentJobs,
    maxTotalResultBytes:
      limits.maxTotalResultBytes ?? DEFAULT_COMPOSIO_V129_SANDBOX_LIMITS.maxTotalResultBytes,
    maxPolls: limits.maxPolls ?? DEFAULT_COMPOSIO_V129_SANDBOX_LIMITS.maxPolls,
    maxWallMs: limits.maxWallMs ?? DEFAULT_COMPOSIO_V129_SANDBOX_LIMITS.maxWallMs,
    allowWrite: limits.allowWrite ?? DEFAULT_COMPOSIO_V129_SANDBOX_LIMITS.allowWrite,
  };
}

export function validateComposioV129SandboxLimits(limits: ComposioV129SandboxLimits): string[] {
  const errors: string[] = [];
  const resolved = resolveComposioV129SandboxLimits(limits);
  if (!Number.isInteger(resolved.maxCalls) || resolved.maxCalls < 0) errors.push('maxCalls must be an integer >= 0');
  if (!Number.isInteger(resolved.maxConcurrentJobs) || resolved.maxConcurrentJobs < 0) errors.push('maxConcurrentJobs must be an integer >= 0');
  if (!Number.isInteger(resolved.maxTotalResultBytes) || resolved.maxTotalResultBytes < 0) errors.push('maxTotalResultBytes must be an integer >= 0');
  if (!Number.isInteger(resolved.maxPolls) || resolved.maxPolls < 0) errors.push('maxPolls must be an integer >= 0');
  if (!Number.isFinite(resolved.maxWallMs) || resolved.maxWallMs <= 0) errors.push('maxWallMs must be a positive number');
  if (typeof resolved.allowWrite !== 'boolean') errors.push('allowWrite must be a boolean');
  return errors;
}

/** Loai hanh dong audit trong sandbox. */
export type ComposioV129SandboxAuditAction =
  | 'boundary-created'
  | 'call-allowed'
  | 'call-denied'
  | 'job-submitted'
  | 'job-finished'
  | 'job-cancelled'
  | 'poll'
  | 'limit-hit'
  | 'boundary-expired';

export interface ComposioV129SandboxAuditEntry {
  seq: number;
  atMs: number;
  action: ComposioV129SandboxAuditAction;
  detail: string;
  outcome: 'allowed' | 'denied' | 'info';
}

/** Muc dich su dung tich luy cua boundary. */
export interface ComposioV129SandboxUsage {
  calls: number;
  jobsSubmitted: number;
  jobsRunning: number;
  jobsFinished: number;
  totalResultBytes: number;
  polls: number;
  deniedCalls: number;
  firstCallAtMs?: number;
  lastCallAtMs?: number;
}

function emptyUsage(): ComposioV129SandboxUsage {
  return {
    calls: 0,
    jobsSubmitted: 0,
    jobsRunning: 0,
    jobsFinished: 0,
    totalResultBytes: 0,
    polls: 0,
    deniedCalls: 0,
  };
}

/** Ranh gioi sandbox cua mot conversation. */
export interface ComposioV129SandboxBoundary {
  id: string;
  conversationId: string;
  /** Toolkit duoc phep (rong = tat ca); denied luon thang allowed. */
  allowedToolkits: string[];
  deniedToolkits: string[];
  limits: Required<ComposioV129SandboxLimits>;
  usage: ComposioV129SandboxUsage;
  audit: ComposioV129SandboxAuditEntry[];
  createdAtMs: number;
  updatedAtMs: number;
}

/** Input tao boundary moi. */
export interface ComposioV129CreateSandboxInput {
  conversationId: string;
  allowedToolkits?: string[];
  deniedToolkits?: string[];
  limits?: ComposioV129SandboxLimits;
  id?: string;
}

/** Id xac dinh tu seed (de test/dedupe). */
export function composioV129SandboxId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `sandbox-v129-${hash.toString(36)}`;
}

function appendAudit(
  boundary: ComposioV129SandboxBoundary,
  atMs: number,
  action: ComposioV129SandboxAuditAction,
  detail: string,
  outcome: ComposioV129SandboxAuditEntry['outcome'],
): ComposioV129SandboxAuditEntry[] {
  const seq = boundary.audit.length > 0 ? boundary.audit[boundary.audit.length - 1]!.seq + 1 : 1;
  const next = [...boundary.audit, { seq, atMs, action, detail, outcome }];
  return next.length > COMPOSIO_V129_SANDBOX_MAX_AUDIT_ENTRIES
    ? next.slice(next.length - COMPOSIO_V129_SANDBOX_MAX_AUDIT_ENTRIES)
    : next;
}

/** Tao boundary moi cho mot conversation (luon ghi audit created). */
export function createComposioV129SandboxBoundary(
  input: ComposioV129CreateSandboxInput,
  nowMs: number,
): ComposioV129SandboxBoundary {
  if (!input || typeof input !== 'object') throw new Error('Invalid Composio v129 sandbox: input must be an object');
  if (typeof input.conversationId !== 'string' || input.conversationId.trim() === '') {
    throw new Error('Invalid Composio v129 sandbox: conversationId must be a non-empty string');
  }
  const limitErrors = validateComposioV129SandboxLimits(input.limits ?? {});
  if (limitErrors.length > 0) {
    throw new Error(`Invalid Composio v129 sandbox limits: ${limitErrors.join('; ')}`);
  }
  const allowedToolkits = [...(input.allowedToolkits ?? [])];
  const deniedToolkits = [...(input.deniedToolkits ?? [])];
  for (const slug of [...allowedToolkits, ...deniedToolkits]) {
    if (typeof slug !== 'string' || slug.trim() === '') {
      throw new Error('Invalid Composio v129 sandbox: toolkit slugs must be non-empty strings');
    }
  }
  const boundary: ComposioV129SandboxBoundary = {
    id: input.id ?? composioV129SandboxId(`${input.conversationId}:${nowMs}`),
    conversationId: input.conversationId,
    allowedToolkits,
    deniedToolkits,
    limits: resolveComposioV129SandboxLimits(input.limits),
    usage: emptyUsage(),
    audit: [],
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  return {
    ...boundary,
    audit: appendAudit(boundary, nowMs, 'boundary-created', `Sandbox created for conversation ${input.conversationId}.`, 'info'),
  };
}

/** true khi boundary da het han wall-clock. */
export function isComposioV129SandboxExpired(
  boundary: ComposioV129SandboxBoundary,
  nowMs: number,
): boolean {
  return nowMs - boundary.createdAtMs >= boundary.limits.maxWallMs;
}

/** true khi slug la tool ghi (can approval) — cung luat nhu job v129. */
export function composioV129SandboxNeedsApproval(slug: string): boolean {
  return mockComposioV129ToolNeedsApproval(slug);
}

/** true khi toolkit duoc phep trong boundary (deny thang allow). */
export function isComposioV129ToolkitAllowed(
  boundary: ComposioV129SandboxBoundary,
  toolkit: string,
): boolean {
  if (boundary.deniedToolkits.includes(toolkit)) return false;
  if (boundary.allowedToolkits.length === 0) return true;
  return boundary.allowedToolkits.includes(toolkit);
}

/** Loai call can kiem tra truoc khi chay. */
export type ComposioV129SandboxCallKind = 'call' | 'job-submit' | 'poll';

/** Input kiem tra admit. */
export interface ComposioV129SandboxCall {
  toolkit: string;
  slug: string;
  kind: ComposioV129SandboxCallKind;
  /** Byte ket qua uoc tinh (de kiem tra maxTotalResultBytes truoc). */
  bytesEstimate?: number;
}

export interface ComposioV129AdmitResult {
  allowed: boolean;
  /** Ly do tu choi (khi allowed = false). */
  reason?: string;
}

/**
 * Kiem tra mot call co duoc phep chay trong boundary khong (thuan,
 * khong doi state). Thu tu kiem tra (fail-closed):
 * 1. het han wall-clock -> deny
 * 2. toolkit bi deny/khong trong allowlist -> deny
 * 3. tool ghi ma allowWrite = false -> deny
 * 4. het quota call -> deny (poll khong tinh vao maxCalls ma tinh
 *    vao maxPolls; job-submit tinh ca hai)
 * 5. job-submit khi da du maxConcurrentJobs -> deny
 * 6. poll khi da het maxPolls -> deny
 * 7. bytes uoc tinh vuot maxTotalResultBytes -> deny
 */
export function admitComposioV129SandboxCall(
  boundary: ComposioV129SandboxBoundary,
  call: ComposioV129SandboxCall,
  nowMs: number,
): ComposioV129AdmitResult {
  if (isComposioV129SandboxExpired(boundary, nowMs)) {
    return { allowed: false, reason: `Sandbox expired: wall-clock limit ${boundary.limits.maxWallMs}ms reached.` };
  }
  if (!isComposioV129ToolkitAllowed(boundary, call.toolkit)) {
    return { allowed: false, reason: `Toolkit '${call.toolkit}' is not allowed in this conversation sandbox.` };
  }
  if (composioV129SandboxNeedsApproval(call.slug) && !boundary.limits.allowWrite) {
    return { allowed: false, reason: `Write tool '${call.slug}' needs approval but this sandbox disallows writes (allowWrite=false).` };
  }
  if (call.kind !== 'poll' && boundary.usage.calls >= boundary.limits.maxCalls) {
    return { allowed: false, reason: `Call quota exceeded: ${boundary.usage.calls}/${boundary.limits.maxCalls} calls.` };
  }
  if (call.kind === 'job-submit' && boundary.usage.jobsRunning >= boundary.limits.maxConcurrentJobs) {
    return { allowed: false, reason: `Concurrent job limit reached: ${boundary.usage.jobsRunning}/${boundary.limits.maxConcurrentJobs} running.` };
  }
  if (call.kind === 'poll' && boundary.usage.polls >= boundary.limits.maxPolls) {
    return { allowed: false, reason: `Poll quota exceeded: ${boundary.usage.polls}/${boundary.limits.maxPolls} polls.` };
  }
  const bytesEstimate = call.bytesEstimate ?? 0;
  if (bytesEstimate > 0 && boundary.usage.totalResultBytes + bytesEstimate > boundary.limits.maxTotalResultBytes) {
    return {
      allowed: false,
      reason: `Result size limit exceeded: ${boundary.usage.totalResultBytes + bytesEstimate}/${boundary.limits.maxTotalResultBytes} bytes.`,
    };
  }
  return { allowed: true };
}

/**
 * Ghi nhan mot call da chay (sau khi admit + thuc thi): tang usage
 * + audit. `resultBytes` = kich thuoc ket qua that (0 khi khong
 * biet). Tra boundary moi.
 */
export function recordComposioV129SandboxCall(
  boundary: ComposioV129SandboxBoundary,
  call: ComposioV129SandboxCall,
  resultBytes: number,
  nowMs: number,
): ComposioV129SandboxBoundary {
  const usage: ComposioV129SandboxUsage = {
    ...boundary.usage,
    totalResultBytes: boundary.usage.totalResultBytes + Math.max(0, Math.floor(resultBytes)),
    firstCallAtMs: boundary.usage.firstCallAtMs ?? nowMs,
    lastCallAtMs: nowMs,
  };
  if (call.kind === 'poll') {
    usage.polls += 1;
  } else {
    usage.calls += 1;
    if (call.kind === 'job-submit') {
      usage.jobsSubmitted += 1;
      usage.jobsRunning += 1;
    }
  }
  const next: ComposioV129SandboxBoundary = { ...boundary, usage, updatedAtMs: nowMs };
  return {
    ...next,
    audit: appendAudit(next, nowMs, call.kind === 'poll' ? 'poll' : 'call-allowed', `${call.toolkit}/${call.slug} (${call.kind}) — ${Math.max(0, Math.floor(resultBytes))} bytes.`, 'allowed'),
  };
}

/** Ghi nhan mot call bi tu choi (tang deniedCalls + audit). */
export function recordComposioV129SandboxDenial(
  boundary: ComposioV129SandboxBoundary,
  call: ComposioV129SandboxCall,
  reason: string,
  nowMs: number,
): ComposioV129SandboxBoundary {
  const next: ComposioV129SandboxBoundary = {
    ...boundary,
    usage: { ...boundary.usage, deniedCalls: boundary.usage.deniedCalls + 1 },
    updatedAtMs: nowMs,
  };
  return {
    ...next,
    audit: appendAudit(next, nowMs, 'call-denied', `${call.toolkit}/${call.slug} (${call.kind}) denied: ${reason}`, 'denied'),
  };
}

/** Ghi nhan mot job ket thuc (giai phong slot concurrent + audit). */
export function recordComposioV129SandboxJobFinished(
  boundary: ComposioV129SandboxBoundary,
  jobId: string,
  status: string,
  nowMs: number,
): ComposioV129SandboxBoundary {
  const next: ComposioV129SandboxBoundary = {
    ...boundary,
    usage: {
      ...boundary.usage,
      jobsRunning: Math.max(0, boundary.usage.jobsRunning - 1),
      jobsFinished: boundary.usage.jobsFinished + 1,
    },
    updatedAtMs: nowMs,
  };
  return {
    ...next,
    audit: appendAudit(next, nowMs, status === 'cancelled' ? 'job-cancelled' : 'job-finished', `Job ${jobId} finished: ${status}.`, 'info'),
  };
}

/** Tom tat boundary cho UI/agent: usage vs limit + headroom + audit cuoi. */
export function summarizeComposioV129Sandbox(
  boundary: ComposioV129SandboxBoundary,
  nowMs: number,
  auditTail = 5,
): Record<string, unknown> {
  const expired = isComposioV129SandboxExpired(boundary, nowMs);
  return {
    id: boundary.id,
    conversationId: boundary.conversationId,
    expired,
    ageMs: nowMs - boundary.createdAtMs,
    wallLeftMs: Math.max(0, boundary.limits.maxWallMs - (nowMs - boundary.createdAtMs)),
    allowedToolkits: [...boundary.allowedToolkits],
    deniedToolkits: [...boundary.deniedToolkits],
    limits: { ...boundary.limits },
    usage: { ...boundary.usage },
    headroom: {
      callsLeft: Math.max(0, boundary.limits.maxCalls - boundary.usage.calls),
      concurrentJobsLeft: Math.max(0, boundary.limits.maxConcurrentJobs - boundary.usage.jobsRunning),
      resultBytesLeft: Math.max(0, boundary.limits.maxTotalResultBytes - boundary.usage.totalResultBytes),
      pollsLeft: Math.max(0, boundary.limits.maxPolls - boundary.usage.polls),
    },
    auditTail: boundary.audit.slice(-auditTail),
    auditTotal: boundary.audit.length,
  };
}

/** Loc audit theo action (de UI loc lich su). */
export function filterComposioV129SandboxAudit(
  boundary: ComposioV129SandboxBoundary,
  action?: ComposioV129SandboxAuditAction,
): ComposioV129SandboxAuditEntry[] {
  if (!action) return [...boundary.audit];
  return boundary.audit.filter((entry) => entry.action === action);
}

export function validateComposioV129SandboxBoundary(boundary: unknown): string[] {
  const errors: string[] = [];
  if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary)) {
    errors.push('boundary must be an object');
    return errors;
  }
  const b = boundary as Record<string, unknown>;
  if (typeof b['id'] !== 'string' || (b['id'] as string).trim() === '') errors.push('id must be a non-empty string');
  if (typeof b['conversationId'] !== 'string' || (b['conversationId'] as string).trim() === '') errors.push('conversationId must be a non-empty string');
  if (!Array.isArray(b['allowedToolkits']) || (b['allowedToolkits'] as unknown[]).some((t) => typeof t !== 'string')) errors.push('allowedToolkits must be an array of strings');
  if (!Array.isArray(b['deniedToolkits']) || (b['deniedToolkits'] as unknown[]).some((t) => typeof t !== 'string')) errors.push('deniedToolkits must be an array of strings');
  errors.push(...validateComposioV129SandboxLimits((b['limits'] as ComposioV129SandboxLimits) ?? {}).map((e) => `limits: ${e}`));
  if (!b['usage'] || typeof b['usage'] !== 'object') errors.push('usage must be an object');
  if (!Array.isArray(b['audit'])) errors.push('audit must be an array');
  if (typeof b['createdAtMs'] !== 'number' || !Number.isFinite(b['createdAtMs'] as number)) errors.push('createdAtMs must be a finite number');
  if (typeof b['updatedAtMs'] !== 'number' || !Number.isFinite(b['updatedAtMs'] as number)) errors.push('updatedAtMs must be a finite number');
  return errors;
}

export function serializeComposioV129SandboxBoundary(boundary: ComposioV129SandboxBoundary): string {
  return JSON.stringify({ version: COMPOSIO_V129_SANDBOX_VERSION, boundary });
}

export function parseComposioV129SandboxBoundary(text: string): ComposioV129SandboxBoundary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid Composio v129 sandbox checkpoint: not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Composio v129 sandbox checkpoint: expected an object');
  }
  const { version, boundary } = parsed as { version?: unknown; boundary?: unknown };
  if (version !== COMPOSIO_V129_SANDBOX_VERSION) {
    throw new Error(`Unsupported Composio v129 sandbox version: ${String(version)}`);
  }
  const errors = validateComposioV129SandboxBoundary(boundary);
  if (errors.length > 0) throw new Error(`Invalid Composio v129 sandbox: ${errors.join('; ')}`);
  return boundary as ComposioV129SandboxBoundary;
}

// ---------------------------------------------------------------------------
// Store trong bo nho — host giu mot instance dung chung trong session
// ---------------------------------------------------------------------------

/**
 * Store boundary trong bo nho, key theo conversationId (moi
 * conversation toi da mot boundary — tao moi se thay the boundary cu
 * cua cung conversation).
 */
export class MemoryComposioV129SandboxStore {
  private readonly byConversation = new Map<string, ComposioV129SandboxBoundary>();
  private readonly byId = new Map<string, ComposioV129SandboxBoundary>();

  create(input: ComposioV129CreateSandboxInput, nowMs: number): ComposioV129SandboxBoundary {
    const boundary = createComposioV129SandboxBoundary(input, nowMs);
    const old = this.byConversation.get(boundary.conversationId);
    if (old) this.byId.delete(old.id);
    if (this.byId.has(boundary.id)) {
      throw new Error(`Composio v129 sandbox id already exists: ${boundary.id}`);
    }
    this.byConversation.set(boundary.conversationId, boundary);
    this.byId.set(boundary.id, boundary);
    return boundary;
  }

  getByConversation(conversationId: string): ComposioV129SandboxBoundary | undefined {
    return this.byConversation.get(conversationId);
  }

  getById(id: string): ComposioV129SandboxBoundary | undefined {
    return this.byId.get(id);
  }

  /** Ghi de boundary (sau record/admit-denial) — throw khi chua co. */
  save(boundary: ComposioV129SandboxBoundary): void {
    if (!this.byId.has(boundary.id)) throw new Error(`Unknown Composio v129 sandbox: ${boundary.id}`);
    this.byConversation.set(boundary.conversationId, boundary);
    this.byId.set(boundary.id, boundary);
  }

  list(): ComposioV129SandboxBoundary[] {
    return [...this.byConversation.values()];
  }

  size(): number {
    return this.byConversation.size;
  }

  /** Xoa boundary cua mot conversation; tra true khi xoa duoc. */
  removeByConversation(conversationId: string): boolean {
    const boundary = this.byConversation.get(conversationId);
    if (!boundary) return false;
    this.byConversation.delete(conversationId);
    this.byId.delete(boundary.id);
    return true;
  }

  snapshot(): string {
    return JSON.stringify({ version: COMPOSIO_V129_SANDBOX_VERSION, boundaries: this.list() });
  }

  restore(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Invalid Composio v129 sandbox snapshot: not JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid Composio v129 sandbox snapshot: expected an object');
    }
    const { version, boundaries } = parsed as { version?: unknown; boundaries?: unknown };
    if (version !== COMPOSIO_V129_SANDBOX_VERSION) {
      throw new Error(`Unsupported Composio v129 sandbox snapshot version: ${String(version)}`);
    }
    if (!Array.isArray(boundaries)) throw new Error('Invalid Composio v129 sandbox snapshot: boundaries must be an array');
    const byConversation = new Map<string, ComposioV129SandboxBoundary>();
    const byId = new Map<string, ComposioV129SandboxBoundary>();
    for (const boundary of boundaries) {
      const errors = validateComposioV129SandboxBoundary(boundary);
      if (errors.length > 0) throw new Error(`Invalid Composio v129 sandbox in snapshot: ${errors.join('; ')}`);
      const typed = boundary as ComposioV129SandboxBoundary;
      if (byConversation.has(typed.conversationId)) throw new Error(`Duplicate Composio v129 sandbox conversation in snapshot: ${typed.conversationId}`);
      if (byId.has(typed.id)) throw new Error(`Duplicate Composio v129 sandbox id in snapshot: ${typed.id}`);
      byConversation.set(typed.conversationId, typed);
      byId.set(typed.id, typed);
    }
    this.byConversation.clear();
    this.byId.clear();
    for (const [key, value] of byConversation) this.byConversation.set(key, value);
    for (const [key, value] of byId) this.byId.set(key, value);
  }
}
