/** Format helpers dùng chung cho report v10 (tách riêng để test dễ). */

/** Format ms thành chuỗi đọc được (vd `1.2s`, `350ms`). */
export function v10FormatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format tỉ lệ 0..1 thành phần trăm (vd `83.3%`). */
export function v10FormatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
