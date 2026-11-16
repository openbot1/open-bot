/**
 * Memory v14 — GDPR erasure path (v1.15, Doi T1).
 *
 * Y tuong hoc tu GDPR "right to erasure" (Art. 17) va rui ro
 * "cross-tenant leakage / GDPR erasure" trong khao sat v1.15 —
 * tu thiet ke lai hoan toan cho open-bot, KHONG copy code/text/
 * tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `removeFactHard` / `removeEpisodeHard` /
 *    `removeQuarantineHard` cua TemporalGraphStore (them o v1.15
 *    cho dung muc dich nay): xoa CUNG khoi file, embedding nam
 *    trong fact nen bi xoa cung.
 *  - `TemporalGraphStore.exportFile()` de liet ke toan bo ban ghi
 *    (khong gioi han limit cua listFacts).
 *  - `removeEntity` cua store (chi xoa entity mo coi — khong con
 *    fact nao tro toi).
 *
 * Luat v14:
 *  1. Xoa theo 2 muc: theo USER (toan bo du lieu cua userId) hoac
 *     theo SUBJECT (toan bo fact/quarantine ve mot entity, vd mot
 *     nguoi — dung khi user yeu cau xoa thong tin ve nguoi do).
 *  2. Xoa CUNG (hard delete), khong phai xoa mem: fact (moi
 *     status, ke ca superseded/deleted), episode, quarantine,
 *     embedding (trong fact), entity mo coi sau khi xoa.
 *  3. Bat buoc xac nhan: caller phai truyen `confirm` trung khop
 *     target (userId / ten subject) — tranh goi nham.
 *  4. Co dry-run (chi dem, khong xoa) va receipt + verify sau
 *     khi xoa: quet lai toan bo file, bao dam khong con ban ghi
 *     nao khop target. Moi lan xoa ghi audit JSONL.
 *  5. Audit log erasure KHONG chua noi dung fact (chi id + so
 *     luong + target) — log cung khong duoc roi rrot du lieu da xoa.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';

/** Loi erasure v14 — message tieng Viet. */
export class V14ErasureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V14ErasureError';
  }
}

export type V14ErasureKind = 'user' | 'subject';

export interface V14ErasureCounts {
  facts: number;
  episodes: number;
  quarantine: number;
  entities: number;
  /** So fact co embedding bi xoa cung (embedding nam trong fact). */
  embeddings: number;
}

export interface V14ErasureReceipt {
  kind: V14ErasureKind;
  target: string;
  actor: string;
  at: string;
  dryRun: boolean;
  counts: V14ErasureCounts;
  /** Id fact da xoa (de doi chieu; khong chua noi dung fact). */
  erasedFactIds: string[];
  /** true = quet lai khong con ban ghi nao khop target. */
  verified: boolean;
  /** So ban ghi con sot sau khi xoa (phai = 0 khi verified). */
  remaining: number;
}

export interface V14ErasureOptions {
  /** Bat buoc: phai === target (userId / ten subject) moi duoc xoa. */
  confirm: string;
  /** Actor thuc hien (vd 'user' / 'system:gdpr'). */
  actor?: string;
  /** true = chi dem, khong xoa that. */
  dryRun?: boolean;
  /** Thu muc workspace (de ghi audit JSONL). */
  workspaceDir?: string;
  /** Thoi diem "bay gio" (de test xac dinh). */
  now?: Date;
}

export const V14_ERASURE_AUDIT_REL_PATH = path.join(
  '.open-bot',
  'memory-v14-erasure-audit.jsonl',
);
export const V14_MAX_ERASURE_AUDIT_LINES = 1000;

function requireConfirm(target: string, confirm: string | undefined): void {
  if ((confirm ?? '') !== target || target === '') {
    throw new V14ErasureError(
      'Xoa du lieu can xac nhan: `confirm` phai trung khop target (userId / ten subject).',
    );
  }
}

function appendErasureAudit(workspaceDir: string, receipt: V14ErasureReceipt): void {
  const file = path.join(workspaceDir, V14_ERASURE_AUDIT_REL_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry = {
    at: receipt.at,
    kind: receipt.kind,
    target: receipt.target,
    actor: receipt.actor,
    dryRun: receipt.dryRun,
    counts: receipt.counts,
    erasedFactIds: receipt.erasedFactIds,
    verified: receipt.verified,
    remaining: receipt.remaining,
  };
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf-8');
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '');
  if (lines.length > V14_MAX_ERASURE_AUDIT_LINES) {
    fs.writeFileSync(
      file,
      `${lines.slice(lines.length - V14_MAX_ERASURE_AUDIT_LINES).join('\n')}\n`,
      'utf-8',
    );
  }
}

/**
 * Quet lai toan bo file: con bao nhieu ban ghi khop target?
 * Dung de verify sau khi xoa (phai = 0).
 */
export function countRemainingV14(
  store: TemporalGraphStore,
  kind: V14ErasureKind,
  target: string,
): V14ErasureCounts {
  const file = store.exportFile();
  const counts: V14ErasureCounts = { facts: 0, episodes: 0, quarantine: 0, entities: 0, embeddings: 0 };
  if (kind === 'user') {
    counts.facts = file.facts.filter((f) => f.scope.userId === target).length;
    counts.episodes = file.episodes.filter((e) => e.userId === target).length;
    counts.quarantine = file.quarantine.filter((q) => q.scope.userId === target).length;
    counts.embeddings = file.facts.filter(
      (f) => f.scope.userId === target && Array.isArray(f.embedding),
    ).length;
  } else {
    const norm = normalizeGraphText(target);
    const entity = file.entities.find((e) => normalizeGraphText(e.name) === norm);
    const entityIds = new Set<string>();
    if (entity) entityIds.add(entity.id);
    // Ca alias cung tinh la cung subject.
    for (const e of file.entities) {
      if (e.aliases.some((a) => normalizeGraphText(a) === norm)) entityIds.add(e.id);
    }
    counts.facts = file.facts.filter(
      (f) => entityIds.has(f.subjectId) || (f.objectId !== undefined && entityIds.has(f.objectId)),
    ).length;
    counts.quarantine = file.quarantine.filter(
      (q) => normalizeGraphText(q.candidate.subjectName) === norm,
    ).length;
    counts.entities = entityIds.size;
    counts.embeddings = file.facts.filter(
      (f) =>
        (entityIds.has(f.subjectId) || (f.objectId !== undefined && entityIds.has(f.objectId))) &&
        Array.isArray(f.embedding),
    ).length;
  }
  return counts;
}

function totalOf(counts: V14ErasureCounts): number {
  return counts.facts + counts.episodes + counts.quarantine + counts.entities;
}

/**
 * Xoa toan bo du lieu cua mot userId (facts, episodes, quarantine,
 * embeddings trong fact). Entity chi bi xoa khi mo coi sau khi
 * xoa fact (entity dung chung voi user khac thi giu lai).
 */
export function eraseUserV14(
  store: TemporalGraphStore,
  userId: string,
  opts: V14ErasureOptions,
): V14ErasureReceipt {
  const target = (userId ?? '').trim();
  if (target === '') throw new V14ErasureError('userId khong duoc rong.');
  requireConfirm(target, opts.confirm);
  const actor = (opts.actor ?? 'user').trim() || 'user';
  const at = (opts.now ?? new Date()).toISOString();
  const dryRun = opts.dryRun === true;
  const file = store.exportFile();

  const factIds = file.facts.filter((f) => f.scope.userId === target).map((f) => f.id);
  const episodeIds = file.episodes.filter((e) => e.userId === target).map((e) => e.id);
  const quarantineIds = file.quarantine.filter((q) => q.scope.userId === target).map((q) => q.id);
  const embeddings = file.facts.filter(
    (f) => f.scope.userId === target && Array.isArray(f.embedding),
  ).length;

  // Entity mo coi: sau khi xoa fact cua user nay, entity nao khong
  // con fact nao (cua bat ky ai) tro toi thi moi xoa duoc.
  const remainingFacts = file.facts.filter((f) => f.scope.userId !== target);
  const referenced = new Set<string>();
  for (const f of remainingFacts) {
    referenced.add(f.subjectId);
    if (f.objectId) referenced.add(f.objectId);
  }
  const orphanEntityIds = file.entities
    .filter((e) => !referenced.has(e.id))
    // Chi xoa entity "cua rieng" user nay: entity xuat hien trong
    // fact cua user (tranh xoa entity dung chung toan cuc nhu
    // 'user' khi user khac van dung).
    .filter((e) =>
      file.facts.some(
        (f) => f.scope.userId === target && (f.subjectId === e.id || f.objectId === e.id),
      ),
    )
    .map((e) => e.id);

  const counts: V14ErasureCounts = {
    facts: factIds.length,
    episodes: episodeIds.length,
    quarantine: quarantineIds.length,
    entities: orphanEntityIds.length,
    embeddings,
  };

  if (!dryRun) {
    for (const id of factIds) store.removeFactHard(id);
    for (const id of episodeIds) store.removeEpisodeHard(id);
    for (const id of quarantineIds) store.removeQuarantineHard(id);
    for (const id of orphanEntityIds) {
      try {
        store.removeEntity(id);
      } catch {
        // Entity van con fact tro toi (do race) -> bo qua, verify se bao.
      }
    }
  }

  const remaining = dryRun ? totalOf(counts) : totalOf(countRemainingV14(store, 'user', target));
  const receipt: V14ErasureReceipt = {
    kind: 'user',
    target,
    actor,
    at,
    dryRun,
    counts,
    erasedFactIds: dryRun ? [] : factIds,
    verified: dryRun ? false : remaining === 0,
    remaining,
  };
  if (opts.workspaceDir) appendErasureAudit(opts.workspaceDir, receipt);
  return receipt;
}

/**
 * Xoa toan bo fact/quarantine ve mot subject (vd mot nguoi) — dung
 * khi user yeu cau xoa thong tin ve nguoi do. Episode KHONG bi xoa
 * (episode la turn hoi thoai, khong phai fact ve subject), nhung
 * lien ket factIds trong episode duoc don sach.
 */
export function eraseSubjectV14(
  store: TemporalGraphStore,
  subjectName: string,
  opts: V14ErasureOptions,
): V14ErasureReceipt {
  const target = (subjectName ?? '').trim();
  if (target === '') throw new V14ErasureError('Ten subject khong duoc rong.');
  requireConfirm(target, opts.confirm);
  const actor = (opts.actor ?? 'user').trim() || 'user';
  const at = (opts.now ?? new Date()).toISOString();
  const dryRun = opts.dryRun === true;
  const file = store.exportFile();
  const norm = normalizeGraphText(target);
  const entityIds = new Set<string>();
  for (const e of file.entities) {
    if (normalizeGraphText(e.name) === norm || e.aliases.some((a) => normalizeGraphText(a) === norm)) {
      entityIds.add(e.id);
    }
  }
  const factIds = file.facts
    .filter((f) => entityIds.has(f.subjectId) || (f.objectId !== undefined && entityIds.has(f.objectId)))
    .map((f) => f.id);
  const quarantineIds = file.quarantine
    .filter((q) => normalizeGraphText(q.candidate.subjectName) === norm)
    .map((q) => q.id);
  const embeddings = file.facts.filter(
    (f) =>
      (entityIds.has(f.subjectId) || (f.objectId !== undefined && entityIds.has(f.objectId))) &&
      Array.isArray(f.embedding),
  ).length;
  // Episode nao tro toi fact bi xoa: don factIds (khong xoa episode).
  const affectedEpisodes = file.episodes.filter((e) =>
    e.factIds.some((id) => factIds.includes(id)),
  );

  const counts: V14ErasureCounts = {
    facts: factIds.length,
    episodes: 0,
    quarantine: quarantineIds.length,
    entities: entityIds.size,
    embeddings,
  };

  if (!dryRun) {
    for (const id of factIds) store.removeFactHard(id);
    for (const id of quarantineIds) store.removeQuarantineHard(id);
    for (const ep of affectedEpisodes) store.pruneEpisodeFacts(ep.id, factIds);
    for (const id of entityIds) {
      try {
        store.removeEntity(id);
      } catch {
        // Entity van con fact tro toi -> bo qua, verify se bao.
      }
    }
  }

  const remaining = dryRun ? totalOf(counts) : totalOf(countRemainingV14(store, 'subject', target));
  const receipt: V14ErasureReceipt = {
    kind: 'subject',
    target,
    actor,
    at,
    dryRun,
    counts,
    erasedFactIds: dryRun ? [] : factIds,
    verified: dryRun ? false : remaining === 0,
    remaining,
  };
  if (opts.workspaceDir) appendErasureAudit(opts.workspaceDir, receipt);
  return receipt;
}

/** Doc audit log erasure (moi nhat truoc, mac dinh 50 dong). */
export function readV14ErasureAudit(workspaceDir: string, limit = 50): V14ErasureReceipt[] {
  const file = path.join(workspaceDir, V14_ERASURE_AUDIT_REL_PATH);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '');
  const out: V14ErasureReceipt[] = [];
  for (const line of lines.slice(-Math.max(1, limit))) {
    try {
      const entry = JSON.parse(line) as {
        kind: V14ErasureKind;
        target: string;
        actor: string;
        at: string;
        dryRun: boolean;
        counts: V14ErasureCounts;
        erasedFactIds: string[];
        verified: boolean;
        remaining: number;
      };
      out.push(entry);
    } catch {
      // Dong hong thi bo qua.
    }
  }
  return out;
}

/** Tom tat receipt dang text (de hien UI / log). */
export function formatErasureReceiptV14(receipt: V14ErasureReceipt): string {
  const c = receipt.counts;
  return (
    `Erasure ${receipt.kind} "${receipt.target}" ` +
    `(${receipt.dryRun ? 'dry-run' : 'that'}): ` +
    `${c.facts} facts, ${c.episodes} episodes, ${c.quarantine} quarantine, ` +
    `${c.entities} entities, ${c.embeddings} embeddings` +
    (receipt.dryRun ? '' : receipt.verified ? ' — VERIFIED (khong con ban ghi).' : ` — CHUA SACH (con ${receipt.remaining} ban ghi).`)
  );
}
