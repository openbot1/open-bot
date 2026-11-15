/**
 * Consolidation v10 — bước 2 của pipeline kiểu Mem0 (v1.10, Đội T1).
 *
 * So từng fact ứng viên với fact hiện có trong bi-temporal graph và
 * quyết định một trong 6 đường:
 *  - NOISE  — ứng viên là noise (salience thấp / turn noise) → drop,
 *    không chạm tới store.
 *  - SKIP   — fact đã có y hệt (trùng active) → không ghi lại; chỉ
 *    tăng nhẹ confidence của fact cũ (tối đa 0.99) vì được nhắc lại.
 *  - ADD    — fact mới hoàn toàn → thêm vào graph.
 *  - UPDATE — cùng subject+predicate nhưng object khác → fact mới
 *    được thêm, fact cũ bị SUPERSEDE (đóng cửa sổ validity, không
 *    ghi đè, không xoá) — lịch sử còn nguyên.
 *  - DELETE — ứng viên phủ định ("không còn thích X nữa") khớp fact
 *    active cùng subject+predicate+object → fact cũ bị xoá logic
 *    (đóng cửa sổ + status deleted).
 *  - QUARANTINE — mâu thuẫn với fact cũ có confidence CAO (>= 0.9)
 *    trong khi ứng viên yếu (<= 0.75), hoặc khớp mẫu nghi ngờ
 *    (lệnh "quên hết", "bỏ qua hướng dẫn") → KHÔNG áp dụng tự động,
 *    ghi vào quarantine để user duyệt (chống memory poisoning,
 *    cùng nguyên tắc graph v0.98).
 *
 * Consolidation là hàm thuần trên graph đã có (không tự tạo graph
 * mới), trả về báo cáo đếm từng đường để UI/tool hiển thị.
 */

import { normalizeV10Text, type V10ConsolidationAction, type V10ConsolidationResult, type V10ExtractedCandidate, type V10QuarantineItem } from './types';
import type { MemoryScope } from '../graph/types';
import type { BiTemporalGraphV10 } from './biTemporalGraph';

/** Mẫu nghi ngờ (prompt-injection vào memory): lệnh quên/xoá toàn
 *  bộ hoặc bỏ qua hướng dẫn trước — bao giờ cũng vào quarantine. */
const SUSPICIOUS_PATTERNS = [
  /quên\s+(hết|tất cả|mọi thứ)/iu,
  /xóa\s+(hết|tất cả|mọi thứ)/iu,
  /bỏ\s+qua\s+(hướng dẫn|chỉ dẫn|quy tắc)/iu,
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/iu,
  /forget\s+(everything|all)/iu,
  /delete\s+(all|everything)/iu,
];

export function isSuspiciousCandidate(candidate: V10ExtractedCandidate): boolean {
  return SUSPICIOUS_PATTERNS.some((re) => re.test(candidate.sourceText));
}

/** Ngưỡng quarantine: fact cũ tin cậy cao + ứng viên yếu = mâu thuẫn
 *  đáng ngờ, không tự động thay thế. */
export const V10_QUARANTINE_OLD_CONFIDENCE = 0.9;
export const V10_QUARANTINE_NEW_CONFIDENCE = 0.75;

export interface V10ConsolidateOptions {
  scope: MemoryScope;
  /** User/bot/run ghi fact (cho provenance). */
  provenance: { episodeId: string; turnId: string; runId: string; botId: string; userId: string; at: string };
  /** Bỏ qua quarantine và ép UPDATE ngay cả khi mâu thuẫn mạnh
   *  (chỉ dùng khi user đã duyệt thủ công — mặc định false). */
  forceUpdate?: boolean;
}

export interface V10ConsolidateOutcome {
  result: V10ConsolidationResult;
  /** Quarantine item mới tạo trong lần này (nếu có). */
  quarantine: V10QuarantineItem[];
}

let quarantineCounter = 0;

/**
 * Consolidate một loạt ứng viên (đã qua extraction) vào graph.
 * Hàm này MUTATE graph (thêm/supersede/xoá fact) và trả báo cáo.
 */
export function consolidateCandidates(
  candidates: V10ExtractedCandidate[],
  graph: BiTemporalGraphV10,
  opts: V10ConsolidateOptions,
): V10ConsolidateOutcome {
  const now = new Date().toISOString();
  const actions: V10ConsolidationAction[] = [];
  const quarantine: V10QuarantineItem[] = [];
  let added = 0;
  let updated = 0;
  let deleted = 0;
  let quarantined = 0;
  let skipped = 0;
  let noiseDropped = 0;

  for (const candidate of candidates) {
    // 1. Noise → drop, không chạm store.
    if (candidate.isNoise) {
      noiseDropped += 1;
      actions.push({
        decision: 'NOISE',
        candidate,
        reason: `Noise (${candidate.noiseReason ?? 'low-salience'}), salience ${candidate.salience} < ngưỡng — drop, không ghi.`,
      });
      continue;
    }

    // 2. Mẫu nghi ngờ → quarantine, không áp dụng.
    if (isSuspiciousCandidate(candidate)) {
      quarantined += 1;
      quarantineCounter += 1;
      const item: V10QuarantineItem = {
        id: `v10q-${Date.now()}-${quarantineCounter}`,
        candidate,
        detail: 'Khớp mẫu nghi ngờ (lệnh quên/xoá toàn bộ hoặc bỏ qua hướng dẫn) — cần user duyệt trước khi áp dụng.',
        status: 'pending',
        scope: { ...opts.scope },
        createdAt: now,
      };
      quarantine.push(item);
      actions.push({ decision: 'QUARANTINE', candidate, reason: item.detail });
      continue;
    }

    const scopeFilter = { userId: opts.scope.userId, botId: opts.scope.botId, runId: opts.scope.runId };

    // 3. Phủ định → DELETE fact active khớp hệt.
    if (candidate.isNegation) {
      const target = graph.findDuplicateActive(candidate, scopeFilter);
      if (target) {
        graph.deleteFact(target.id);
        deleted += 1;
        actions.push({
          decision: 'DELETE',
          candidate,
          factId: target.id,
          affectedFactId: target.id,
          reason: `Phủ định ("${candidate.sourceText.slice(0, 80)}") khớp fact active ${target.id} — xoá logic (đóng cửa sổ validity, giữ lịch sử).`,
        });
      } else {
        // Không có fact nào để xoá → noise theo nghĩa "không có tác dụng".
        noiseDropped += 1;
        actions.push({
          decision: 'NOISE',
          candidate,
          reason: 'Phủ định nhưng không tìm thấy fact active nào khớp để xoá — drop.',
        });
      }
      continue;
    }

    // 4. Trùng hệt → SKIP (bump confidence nhẹ vì được nhắc lại).
    const duplicate = graph.findDuplicateActive(candidate, scopeFilter);
    if (duplicate) {
      const bumped = Math.min(0.99, duplicate.confidence + 0.02);
      graph.bumpConfidence(duplicate.id, bumped);
      skipped += 1;
      actions.push({
        decision: 'SKIP',
        candidate,
        factId: duplicate.id,
        reason: `Fact đã có y hệt (${duplicate.id}) — bỏ qua, confidence bump ${duplicate.confidence} → ${bumped}.`,
      });
      continue;
    }

    // 5. Mâu thuẫn (cùng subject+predicate, object khác).
    const conflicts = graph.findConflictingActive(candidate, scopeFilter);
    if (conflicts.length > 0) {
      const strongest = conflicts.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      const needsQuarantine =
        !opts.forceUpdate &&
        strongest.confidence >= V10_QUARANTINE_OLD_CONFIDENCE &&
        candidate.confidence <= V10_QUARANTINE_NEW_CONFIDENCE;
      if (needsQuarantine) {
        quarantined += 1;
        quarantineCounter += 1;
        const item: V10QuarantineItem = {
          id: `v10q-${Date.now()}-${quarantineCounter}`,
          candidate,
          conflictingFactId: strongest.id,
          detail: `Mâu thuẫn với fact cũ tin cậy cao (${strongest.subject} —${strongest.predicate}→ ${strongest.object}, confidence ${strongest.confidence}) trong khi ứng viên mới chỉ ${candidate.confidence} — cần user duyệt.`,
          status: 'pending',
          scope: { ...opts.scope },
          createdAt: now,
        };
        quarantine.push(item);
        actions.push({ decision: 'QUARANTINE', candidate, affectedFactId: strongest.id, reason: item.detail });
        continue;
      }
      // UPDATE: thêm fact mới, supersede fact cũ mạnh nhất; các fact
      // mâu thuẫn còn lại (nếu có) cũng bị supersede cùng lúc để
      // không còn 2 fact active mâu thuẫn nhau. Cửa sổ cũ đóng tại
      // validFrom của fact mới khi nó ở quá khứ ("từ tháng 3 sống ở
      // Đà Nẵng" → Hà Nội hết đúng từ tháng 3, không phải từ hôm nay
      // hệ thống mới học được) — nếu không, truy vấn "tháng 3 ở đâu"
      // sẽ thấy cả hai cùng đúng. validFrom ở tương lai thì đóng tại
      // bây giờ (fact cũ hết đúng khi hệ thống biết chuyện thay đổi).
      const created = graph.addFact({
        candidate,
        scope: opts.scope,
        provenance: { ...opts.provenance, sourceText: candidate.sourceText, extractor: 'v10-rule-based' },
      });
      const supersedeAt = new Date(Math.min(Date.now(), Date.parse(created.validFrom)));
      graph.supersedeFact(strongest.id, created, supersedeAt);
      for (const other of conflicts) {
        if (other.id !== strongest.id) graph.supersedeFact(other.id, created, supersedeAt);
      }
      updated += 1;
      actions.push({
        decision: 'UPDATE',
        candidate,
        factId: created.id,
        affectedFactId: strongest.id,
        reason: `Mâu thuẫn với ${conflicts.length} fact active — fact mới ${created.id} thay thế, fact cũ ${strongest.id} bị supersede (đóng cửa sổ validity, không xoá).`,
      });
      continue;
    }

    // 6. Mới hoàn toàn → ADD.
    const created = graph.addFact({
      candidate,
      scope: opts.scope,
      provenance: { ...opts.provenance, sourceText: candidate.sourceText, extractor: 'v10-rule-based' },
    });
    added += 1;
    actions.push({
      decision: 'ADD',
      candidate,
      factId: created.id,
      reason: `Fact mới: ${candidate.subject} —${candidate.predicate}→ ${candidate.object} (salience ${candidate.salience}).`,
    });
  }

  return {
    result: {
      episodeId: opts.provenance.episodeId,
      actions,
      added,
      updated,
      deleted,
      quarantined,
      skipped,
      noiseDropped,
      consolidatedAt: now,
    },
    quarantine,
  };
}

export { normalizeV10Text };
