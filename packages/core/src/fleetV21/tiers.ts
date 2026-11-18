/**
 * Sandbox isolation tiers cho fleet v21 (v1.34, Đội T6).
 *
 * Tier cách ly được định nghĩa RIÊNG trong fleetV21 — KHÔNG phụ thuộc
 * code sandboxV2 của đội T2 sóng này (đội T2 làm sandboxV2 độc lập).
 * Mô hình tier khớp nhau về ý nghĩa để scheduler v21 và sandbox v2
 * nói cùng một ngôn ngữ khi gộp: một run yêu cầu tier tối thiểu, một
 * node quảng cáo tier tối đa nó hỗ trợ; node hỗ trợ tier đó thì cũng
 * hỗ trợ mọi tier thấp hơn.
 *
 * Thứ tự mạnh dần (số càng lớn càng cách ly mạnh, càng tốn tài nguyên):
 *
 * - `bwrap` (0): bubblewrap namespace — process + mount + net riêng,
 *   nhẹ, chạy được ở mọi node Linux có bwrap.
 * - `syscall-policy` (1): bwrap + chính sách syscall (seccomp) siết
 *   theo profile — chặn syscall nguy hiểm, vẫn chia sẻ kernel host.
 * - `microvm` (2): máy ảo siêu nhẹ (Firecracker/microVM) — kernel
 *   riêng, cách ly mạnh nhất, chỉ node có hypervisor mới hỗ trợ.
 *
 * Quy tắc scheduler dùng trực tiếp:
 * - Node có `maxTier = T` thì đặt được mọi run yêu cầu `minTier <= T`.
 * - Run yêu cầu tier cao hơn mọi node → bị từ chối kèm lý do rõ ràng
 *   (xem `scheduler.ts`: không bao giờ hạ tier lén để chạy cho được).
 * - Khi 2 node ngang điểm, ưu tiên node có maxTier vừa đủ (tier-fit):
 *   giữ node microVM cho run thật sự cần nó, đừng phí vào run nhẹ.
 */

/** Ba tier cách ly, theo thứ tự mạnh dần. */
export type SandboxTierV21 = 'bwrap' | 'syscall-policy' | 'microvm';

/** Mọi tier theo thứ tự mạnh dần — dùng để duyệt / validate. */
export const SANDBOX_TIERS_V21: readonly SandboxTierV21[] = ['bwrap', 'syscall-policy', 'microvm'];

/** Cấp số của tier (0 = nhẹ nhất, 2 = cách ly mạnh nhất). */
export const SANDBOX_TIER_RANK_V21: Readonly<Record<SandboxTierV21, number>> = {
  bwrap: 0,
  'syscall-policy': 1,
  microvm: 2,
};

/** Mô tả ngắn từng tier (cho UI/panel — chuỗi hiển thị dùng i18n `fleet.v21.*`). */
export const SANDBOX_TIER_DESCRIPTION_V21: Readonly<Record<SandboxTierV21, string>> = {
  bwrap: 'Bubblewrap namespace: process, mount và net riêng, nhẹ nhất.',
  'syscall-policy': 'Bubblewrap + chính sách syscall (seccomp) siết theo profile.',
  microvm: 'Máy ảo siêu nhẹ (kernel riêng), cách ly mạnh nhất, cần hypervisor.',
};

/** true khi `value` là một tier hợp lệ (guard cho dữ liệu từ file/UI). */
export function isSandboxTierV21(value: unknown): value is SandboxTierV21 {
  return typeof value === 'string' && (SANDBOX_TIERS_V21 as readonly string[]).includes(value);
}

/** Chuẩn hoá tier từ input ngoài: không hợp lệ → undefined (không đoán). */
export function parseSandboxTierV21(value: unknown): SandboxTierV21 | undefined {
  return isSandboxTierV21(value) ? value : undefined;
}

/**
 * So sánh 2 tier: âm khi `a` yếu hơn `b`, 0 khi bằng, dương khi mạnh hơn.
 * Dùng để sắp xếp node/run theo tier mà không hard-code thứ tự ở nơi khác.
 */
export function compareSandboxTierV21(a: SandboxTierV21, b: SandboxTierV21): number {
  return SANDBOX_TIER_RANK_V21[a] - SANDBOX_TIER_RANK_V21[b];
}

/**
 * true khi node có `maxTier` đặt được run yêu cầu `minTier`
 * (node hỗ trợ tier đó và mọi tier thấp hơn).
 */
export function tierSatisfiesV21(maxTier: SandboxTierV21, minTier: SandboxTierV21): boolean {
  return SANDBOX_TIER_RANK_V21[maxTier] >= SANDBOX_TIER_RANK_V21[minTier];
}

/**
 * Tier thấp nhất còn thiếu để đạt `minTier` khi node chỉ có `maxTier`
 * (undefined khi node đã đủ tier — không thiếu gì).
 */
export function tierShortfallV21(maxTier: SandboxTierV21, minTier: SandboxTierV21): SandboxTierV21 | undefined {
  return tierSatisfiesV21(maxTier, minTier) ? undefined : minTier;
}

/**
 * Tier mạnh nhất trong một danh sách (undefined khi danh sách rỗng).
 * Dùng để tính tier tối đa của cả fleet / của nhóm node.
 */
export function maxTierOfV21(tiers: Iterable<SandboxTierV21>): SandboxTierV21 | undefined {
  let best: SandboxTierV21 | undefined;
  for (const tier of tiers) {
    if (best === undefined || SANDBOX_TIER_RANK_V21[tier] > SANDBOX_TIER_RANK_V21[best]) best = tier;
  }
  return best;
}

/**
 * Tier yếu nhất trong một danh sách (undefined khi danh sách rỗng).
 * Dùng để biết "mặt bằng chung" của fleet: run yêu cầu cao hơn mức
 * này chỉ chạy được ở một số node, không phải mọi node.
 */
export function minTierOfV21(tiers: Iterable<SandboxTierV21>): SandboxTierV21 | undefined {
  let worst: SandboxTierV21 | undefined;
  for (const tier of tiers) {
    if (worst === undefined || SANDBOX_TIER_RANK_V21[tier] < SANDBOX_TIER_RANK_V21[worst]) worst = tier;
  }
  return worst;
}

/**
 * Chi phí tương đối của tier (0..1) — microVM tốn tài nguyên nhất nên
 * scheduler trừ điểm khi dùng tier cao hơn mức run cần (lãng phí), và
 * placement ưu tiên node vừa đủ tier. Con số là trọng số nội bộ, không
 * phải đo thực tế.
 */
export const SANDBOX_TIER_COST_V21: Readonly<Record<SandboxTierV21, number>> = {
  bwrap: 0.1,
  'syscall-policy': 0.35,
  microvm: 1,
};

/**
 * Tier khuyên dùng theo mức độ tin cậy của code sẽ chạy — helper cho UI
 * khi user tạo run mà chưa biết chọn tier nào. Không áp đặt: run vẫn
 * chạy được ở tier thấp hơn nếu user chọn rõ như vậy.
 *
 * - code nội bộ / đã review → `bwrap`
 * - code từ marketplace / plugin bên thứ ba → `syscall-policy`
 * - code lạ chưa tin / chạy shell tuỳ ý → `microvm`
 */
export function recommendedTierV21(trust: 'internal' | 'marketplace' | 'untrusted'): SandboxTierV21 {
  if (trust === 'untrusted') return 'microvm';
  if (trust === 'marketplace') return 'syscall-policy';
  return 'bwrap';
}

/**
 * Validate yêu cầu tier của một run: trả về danh sách lỗi (rỗng = hợp lệ).
 * `minTier` bắt buộc; `preferredTier` (nếu có) không được yếu hơn minTier.
 */
export function validateTierRequirementV21(input: {
  minTier?: unknown;
  preferredTier?: unknown;
}): string[] {
  const errors: string[] = [];
  if (!isSandboxTierV21(input.minTier)) {
    errors.push(`minTier phải là một trong: ${SANDBOX_TIERS_V21.join(', ')}.`);
  }
  if (input.preferredTier !== undefined) {
    if (!isSandboxTierV21(input.preferredTier)) {
      errors.push(`preferredTier phải là một trong: ${SANDBOX_TIERS_V21.join(', ')}.`);
    } else if (
      isSandboxTierV21(input.minTier) &&
      SANDBOX_TIER_RANK_V21[input.preferredTier] < SANDBOX_TIER_RANK_V21[input.minTier]
    ) {
      errors.push(
        `preferredTier (${input.preferredTier}) yếu hơn minTier (${input.minTier}) — preferredTier phải >= minTier.`,
      );
    }
  }
  return errors;
}
