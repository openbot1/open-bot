/**
 * JSON Canonicalization Scheme — RFC 8785 (JCS), v1.07 Đội T3.
 *
 * A2A v1.0 ký Agent Card bằng JWS (RFC 7515) trên nội dung đã
 * canonicalise theo RFC 8785: hai bên ký / verify phải tính cùng
 * một chuỗi byte từ cùng một nội dung JSON, bất kể thứ tự key lúc
 * build object hay cách serializer của ngôn ngữ. Module `signing.ts`
 * trước đây tự viết `canonicalJson` (sắp key + JSON.stringify) —
 * gần đúng nhưng CHƯA phải RFC 8785:
 *
 *  - Số: RFC 8785 dùng đúng thuật toán ECMAScript Number::toString
 *    (vd `-0` → `"0"`, `1e21` → `"1e+21"`); JSON.stringify cũng
 *    gần vậy, nhưng số nguyên lớn / số thập phân cần cùng một
 *    serializer — ở đây dùng Number::toString tường minh.
 *  - Chuỗi: JCS escape MỌI ký tự điều khiển (U+0000–U+001F) bằng
 *    `\b \t \n \f \r` hoặc `\u00xx`, escape `"` và `\`, và escape
 *    lone surrogate (half của surrogate pair đứng một mình) thành
 *    `\uXXXX` — JSON.stringify để nguyên lone surrogate, hai
 *    implementation khác nhau sẽ ký khác nhau.
 *  - Key object: sắp theo thứ tự UTF-16 code unit (mặc định của
 *    so sánh chuỗi JS), không theo locale.
 *  - Giá trị không thuộc JSON (`undefined`, function, symbol,
 *    bigint, NaN, ±Infinity, circular) → THROW thay vì lặng lẽ
 *    bỏ qua như JSON.stringify (bỏ qua sẽ làm hai nội dung khác
 *    nhau cho cùng một chữ ký — lỗ hổng).
 *  - Object: key `undefined`-valued bị bỏ (như JSON.stringify);
 *    array: `undefined`/function/symbol → `null` (như JSON).
 *
 * Chỉ dùng Node stdlib, không dependency ngoài. Hàm chính:
 * `canonicalizeJson(value)` → chuỗi UTF-8 (trả về string JS;
 * caller encode UTF-8 khi ký — `Buffer.from(str, 'utf8')`).
 */

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
};

/** Escape một chuỗi theo RFC 8785 §3.2.2.2 (JSON string + lone surrogate). */
export function canonicalizeJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const code = value.charCodeAt(i);
    if (ch === '"' || ch === '\\' || ch === '\b' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r') {
      out += ESCAPES[ch];
    } else if (code < 0x20) {
      // Ký tự điều khiển còn lại: \u00xx (chữ hex thường, đúng RFC 8785).
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: chỉ giữ nguyên khi đi kèm low surrogate hợp lệ.
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += ch + value[i + 1];
        i++;
      } else {
        out += `\\u${code.toString(16).padStart(4, '0')}`;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate đứng một mình (high đã xử lý ở trên).
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

/**
 * Serialize một số theo RFC 8785 §3.2.2.3 — đúng ECMAScript
 * Number::toString, với `-0` thành `"0"`. Throw với NaN/Infinity
 * (không phải JSON hợp lệ).
 */
export function canonicalizeJsonNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`RFC 8785: cannot canonicalize non-finite number (${String(value)}).`);
  }
  if (value === 0) return '0'; // -0 và +0 đều → "0"
  return String(value); // ECMAScript Number::toString
}

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalizeValue(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return canonicalizeJsonNumber(value);
    case 'string':
      return canonicalizeJsonString(value);
    case 'undefined':
    case 'function':
    case 'symbol':
      // Chỉ tới được đây ở vị trí object-value (đã bỏ qua trước) hoặc
      // top-level: JCS không có biểu diễn → throw rõ ràng.
      throw new Error(`RFC 8785: cannot canonicalize value of type ${typeof value}.`);
    case 'bigint':
      throw new Error('RFC 8785: cannot canonicalize bigint.');
    case 'object': {
      if (seen.has(value as object)) {
        throw new Error('RFC 8785: cannot canonicalize circular structure.');
      }
      seen.add(value as object);
      try {
        if (Array.isArray(value)) {
          const parts: string[] = [];
          for (const item of value as unknown[]) {
            if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
              parts.push('null');
            } else {
              parts.push(canonicalizeValue(item, seen));
            }
          }
          return `[${parts.join(',')}]`;
        }
        if (isPlainObjectLike(value)) {
          // toJSON (Date...) được gọi trước như JSON.stringify.
          const maybeToJson = (value as { toJSON?: unknown }).toJSON;
          if (typeof maybeToJson === 'function') {
            return canonicalizeValue(
              (maybeToJson as (key: string) => unknown).call(value, ''),
              seen,
            );
          }
          const keys = Object.keys(value as Record<string, unknown>).sort();
          const parts: string[] = [];
          for (const key of keys) {
            const v = (value as Record<string, unknown>)[key];
            if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
            parts.push(`${canonicalizeJsonString(key)}:${canonicalizeValue(v, seen)}`);
          }
          return `{${parts.join(',')}}`;
        }
        // Object không phải plain (Map, Set, class instance...): JCS chỉ
        // định nghĩa cho JSON data — serialize theo own enumerable keys
        // như một object thường để không lặng lẽ mất dữ liệu.
        const keys = Object.keys(value as Record<string, unknown>).sort();
        const parts: string[] = [];
        for (const key of keys) {
          const v = (value as Record<string, unknown>)[key];
          if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
          parts.push(`${canonicalizeJsonString(key)}:${canonicalizeValue(v, seen)}`);
        }
        return `{${parts.join(',')}}`;
      } finally {
        seen.delete(value as object);
      }
    }
    default:
      throw new Error(`RFC 8785: cannot canonicalize value of type ${typeof value}.`);
  }
}

/**
 * Canonicalise một giá trị JSON theo RFC 8785 (JCS). Deterministic:
 * cùng nội dung → cùng chuỗi, bất kể thứ tự key hay serializer.
 * Throw với giá trị không biểu diễn được bằng JSON.
 */
export function canonicalizeJson(value: unknown): string {
  return canonicalizeValue(value, new Set());
}

/**
 * True khi giá trị canonicalise được (không throw). Dùng để kiểm tra
 * nhanh payload trước khi ký mà không cần try/catch ở caller.
 */
export function isCanonicalizableJson(value: unknown): boolean {
  try {
    canonicalizeJson(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * So sánh hai giá trị JSON theo dạng canonical: bằng nhau khi chuỗi
 * canonical bằng nhau. Rẻ hơn deep-equal tự viết và khớp đúng thứ
 * mà chữ ký JWS sẽ ký.
 */
export function canonicalJsonEquals(a: unknown, b: unknown): boolean {
  try {
    return canonicalizeJson(a) === canonicalizeJson(b);
  } catch {
    return false;
  }
}
