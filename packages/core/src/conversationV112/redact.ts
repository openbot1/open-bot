/**
 * Redaction cho conversation log v112 (Đội T2).
 *
 * Trước khi persist, mọi text đi qua đây:
 * - Secret rõ ràng (API key, token, password, Bearer, AWS/GH key…)
 *   bị thay bằng `[REDACTED]` — giống tripwire của skill loader nhưng
 *   ở đây là *xoá* khỏi bản lưu (không reject cả event, vì message
 *   của user vẫn cần lưu phần còn lại).
 * - Text dài bị cắt ngắn ở giới hạn cấu hình, kèm ghi chú số ký tự gốc.
 *
 * Redaction là best-effort theo mẫu: không đảm bảo bắt mọi secret
 * (vd key đã mã hoá/base64 không có prefix nhận diện). Ghi rõ trong
 * doc để host không coi log là "đã sạch tuyệt đối".
 */

/** Mẫu secret rõ ràng — thay toàn bộ match bằng `[REDACTED]`. */
export const CONVERSATION_V112_SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bsk-[A-Za-z0-9]{16,}\b/g, label: 'openai-key' },
  { pattern: /\bxai-[A-Za-z0-9]{16,}\b/g, label: 'xai-key' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws-key' },
  { pattern: /\bghp_[A-Za-z0-9]{20,}\b/g, label: 'github-pat' },
  { pattern: /\bgho_[A-Za-z0-9]{20,}\b/g, label: 'github-oauth' },
  { pattern: /\bBearer\s+[A-Za-z0-9_.-]{16,}/g, label: 'bearer' },
  {
    pattern: /\b(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|private[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_-]{8,}['"]?/gi,
    label: 'key-assignment',
  },
  {
    pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*['"]?\S{6,}['"]?/gi,
    label: 'password',
  },
];

/** Text thay cho secret đã redact. */
export const REDACTED_V112_TEXT = '[REDACTED]';

/** Kết quả redact: text đã sạch + số secret đã thay. */
export interface RedactV112Result {
  text: string;
  redactedCount: number;
  labels: string[];
}

/** Thay mọi secret rõ ràng trong text bằng `[REDACTED]`. */
export function redactSecretsV112(text: string): RedactV112Result {
  let out = text;
  let redactedCount = 0;
  const labels: string[] = [];
  for (const { pattern, label } of CONVERSATION_V112_SECRET_PATTERNS) {
    // RegExp global có state lastIndex — reset trước mỗi lần dùng.
    pattern.lastIndex = 0;
    let replaced = false;
    out = out.replace(pattern, () => {
      replaced = true;
      redactedCount += 1;
      return REDACTED_V112_TEXT;
    });
    if (replaced && !labels.includes(label)) labels.push(label);
  }
  return { text: out, redactedCount, labels };
}

/** Kiểm tra nhanh text có chứa secret rõ ràng không (không sửa text). */
export function containsSecretV112(text: string): boolean {
  return CONVERSATION_V112_SECRET_PATTERNS.some((entry) => {
    entry.pattern.lastIndex = 0;
    return entry.pattern.test(text);
  });
}

/**
 * Cắt text về tối đa `maxChars` ký tự (giữ nguyên phần đầu). Trả về
 * text đã cắt + số ký tự gốc. Không cắt khi text đã ngắn hơn giới hạn.
 */
export function truncateV112(
  text: string,
  maxChars: number,
): { text: string; originalChars: number; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, originalChars: text.length, truncated: false };
  }
  return {
    text: text.slice(0, maxChars),
    originalChars: text.length,
    truncated: true,
  };
}

/**
 * Pipeline đầy đủ cho text lưu vào log: redact secret rồi cắt ngắn.
 * Thứ tự này quan trọng: redact trước để secret ở cuối text dài vẫn
 * bị xoá thay vì chỉ bị cắt khỏi bản lưu một cách tình cờ.
 */
export function sanitizeTextForLogV112(
  text: string,
  maxChars: number,
): { text: string; originalChars: number; truncated: boolean; redactedCount: number } {
  const redacted = redactSecretsV112(text);
  const cut = truncateV112(redacted.text, maxChars);
  return {
    text: cut.text,
    originalChars: text.length,
    truncated: cut.truncated,
    redactedCount: redacted.redactedCount,
  };
}
