/**
 * Phân loại thời gian cho memory v6 (v1.05, Đội T1).
 *
 * Ý tưởng học từ Mem0 v3 (retrieval tự phân loại thời gian: recency
 * decay + temporal bucket) — tự thiết kế lại hoàn toàn cho open-bot,
 * 100% local, không copy code/text/tài sản của bất kỳ repo nào.
 *
 * Bucket (tính theo tuổi so với "bây giờ"):
 *  - today:     < 1 ngày  (vừa ghi hôm nay)
 *  - this_week: < 7 ngày
 *  - this_month:< 30 ngày
 *  - older:     >= 30 ngày
 *
 * Recency decay: hàm mũ với half-life cấu hình được
 * (mặc định 30 ngày — sau 30 ngày hệ số còn 0.5, sau 60 ngày 0.25).
 * Decay là HỆ SỐ NHÂN trong fused retrieval, không phải điểm cộng:
 * bản ghi rất cũ vẫn tìm thấy được nếu khớp từ khoá/entity mạnh,
 * nhưng bị hạ hạng so với bản ghi mới tương đương.
 */

import type { V6Record, V6TemporalBucket, V6TemporalClass } from './types';
import { DEFAULT_V6_RECENCY_HALF_LIFE_DAYS } from './types';

/** Ngưỡng bucket tính bằng ngày (today < 1, this_week < 7, this_month < 30). */
export const V6_BUCKET_TODAY_DAYS = 1;
export const V6_BUCKET_WEEK_DAYS = 7;
export const V6_BUCKET_MONTH_DAYS = 30;

/** Số ms trong một ngày. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Tuổi của một thời điểm ISO so với `now` (ngày, số thực, >= 0). */
export function ageInDays(iso: string, now: Date = new Date()): number {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - at) / MS_PER_DAY);
}

/** Bucket thời gian theo tuổi (ngày). */
export function bucketForAgeDays(ageDays: number): V6TemporalBucket {
  if (!Number.isFinite(ageDays)) return 'older';
  if (ageDays < V6_BUCKET_TODAY_DAYS) return 'today';
  if (ageDays < V6_BUCKET_WEEK_DAYS) return 'this_week';
  if (ageDays < V6_BUCKET_MONTH_DAYS) return 'this_month';
  return 'older';
}

/**
 * Recency decay dạng mũ: 0.5 ^ (ageDays / halfLifeDays).
 * halfLife <= 0 -> không decay (luôn 1). Tuổi vô cực -> 0.
 */
export function recencyDecay(ageDays: number, halfLifeDays: number = DEFAULT_V6_RECENCY_HALF_LIFE_DAYS): number {
  if (!Number.isFinite(ageDays)) return 0;
  if (!(halfLifeDays > 0)) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Phân loại thời gian đầy đủ của một bản ghi lúc `now`. */
export function classifyTemporal(
  record: Pick<V6Record, 'createdAt'>,
  now: Date = new Date(),
  halfLifeDays: number = DEFAULT_V6_RECENCY_HALF_LIFE_DAYS,
): V6TemporalClass {
  const ageDays = ageInDays(record.createdAt, now);
  return {
    bucket: bucketForAgeDays(ageDays),
    ageDays,
    recencyDecay: recencyDecay(ageDays, halfLifeDays),
  };
}

/** Nhãn hiển thị của bucket (tiếng Việt, dùng cho UI/debug). */
export function bucketLabel(bucket: V6TemporalBucket): string {
  switch (bucket) {
    case 'today':
      return 'Hôm nay';
    case 'this_week':
      return 'Tuần này';
    case 'this_month':
      return 'Tháng này';
    case 'older':
      return 'Cũ hơn';
  }
}

/** Mô tả ngắn một phân loại thời gian (vd "Tuần này · 3,2 ngày trước · decay 0,93"). */
export function describeTemporal(temporal: V6TemporalClass): string {
  const age =
    temporal.ageDays < 1
      ? `${Math.round(temporal.ageDays * 24)} giờ trước`
      : `${temporal.ageDays.toFixed(1)} ngày trước`;
  return `${bucketLabel(temporal.bucket)} · ${age} · decay ${temporal.recencyDecay.toFixed(2)}`;
}

/**
 * Lọc một danh sách bản ghi theo bucket (giữ nguyên thứ tự).
 * Hữu ích khi UI muốn hiện riêng "hôm nay" / "tuần này".
 */
export function filterByBucket<T extends Pick<V6Record, 'createdAt'>>(
  records: T[],
  bucket: V6TemporalBucket,
  now: Date = new Date(),
): T[] {
  return records.filter((r) => bucketForAgeDays(ageInDays(r.createdAt, now)) === bucket);
}

/**
 * Gom bản ghi theo bucket (mỗi bucket một mảng, giữ nguyên thứ tự
 * trong bucket). Bucket rỗng vẫn có key với mảng rỗng.
 */
export function groupByBucket<T extends Pick<V6Record, 'createdAt'>>(
  records: T[],
  now: Date = new Date(),
): Record<V6TemporalBucket, T[]> {
  const out: Record<V6TemporalBucket, T[]> = {
    today: [],
    this_week: [],
    this_month: [],
    older: [],
  };
  for (const r of records) {
    out[bucketForAgeDays(ageInDays(r.createdAt, now))].push(r);
  }
  return out;
}
