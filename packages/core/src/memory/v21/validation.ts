/**
 * Memory v21 — Validation + bao loi ro rang.
 *
 * Moi validation tra ve danh sach issue co `path` + `code` +
 * `message` + severity, de UI/tool hien thi dung cho user sua —
 * khong bao loi chung chung kieu "file loi". Loi nghiem trong
 * (error) chan import/convert; canh bao (warning) chi ghi log.
 */
import type {
  V21PortableRecord,
  V21ValidationCode,
  V21ValidationIssue,
  V21ValidationResult,
} from './types';
import {
  V21_MAX_BODY_CHARS,
  V21_MAX_CODE_REFS,
  V21_MAX_SOURCES,
  V21_MAX_TAGS,
  V21_MAX_TITLE_CHARS,
  V21_RECORD_TYPES,
} from './types';
import { isIsoDateV21, isRecordStaleV21, parseOkfDocumentV21 } from './okfFormat';
import { parseMemfsBlockHeaderV21 } from './memfsFormat';

function issue(
  path: string,
  code: V21ValidationCode,
  message: string,
  severity: 'error' | 'warning' = 'error',
): V21ValidationIssue {
  return { path, code, message, severity };
}

function summarizeV21(issues: V21ValidationIssue[]): V21ValidationResult {
  return {
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
  };
}

/** Validate mot portable record (dang chuan hoa noi bo). */
export function validatePortableRecordV21(
  record: Partial<V21PortableRecord> & { id?: string },
  path = 'record',
): V21ValidationResult {
  const issues: V21ValidationIssue[] = [];
  if (!record.id || typeof record.id !== 'string' || !record.id.trim()) {
    issues.push(issue(`${path}.id`, 'bad_id', 'id bat buoc, la chuoi khong rong'));
  } else if (!/^[a-z0-9][a-z0-9\-_]*$/.test(record.id)) {
    issues.push(
      issue(`${path}.id`, 'bad_id', `id "${record.id}" phai la slug (chu thuong, so, -, _)`, 'warning'),
    );
  }
  if (!record.type) {
    issues.push(issue(`${path}.type`, 'missing_type', 'field `type` la bat buoc'));
  } else if (!(V21_RECORD_TYPES as readonly string[]).includes(record.type)) {
    issues.push(issue(`${path}.type`, 'unknown_type', `type "${record.type}" khong hop le — cho phep: ${V21_RECORD_TYPES.join(', ')}`));
  }
  if (!record.title || typeof record.title !== 'string' || !record.title.trim()) {
    issues.push(issue(`${path}.title`, 'empty_title', 'title bat buoc, khong duoc de trong'));
  } else if (record.title.length > V21_MAX_TITLE_CHARS) {
    issues.push(issue(`${path}.title`, 'empty_title', `title dai ${record.title.length} ky tu, vuot ${V21_MAX_TITLE_CHARS}`, 'warning'));
  }
  if (!record.body || typeof record.body !== 'string' || !record.body.trim()) {
    issues.push(issue(`${path}.body`, 'empty_body', 'body bat buoc, khong duoc de trong'));
  } else if (record.body.length > V21_MAX_BODY_CHARS) {
    issues.push(issue(`${path}.body`, 'empty_body', `body dai ${record.body.length} ky tu, vuot ${V21_MAX_BODY_CHARS}`, 'warning'));
  }
  if (record.tags !== undefined) {
    if (!Array.isArray(record.tags) || !record.tags.every((t) => typeof t === 'string')) {
      issues.push(issue(`${path}.tags`, 'bad_source', 'tags phai la danh sach chuoi'));
    } else if (record.tags.length > V21_MAX_TAGS) {
      issues.push(issue(`${path}.tags`, 'bad_source', `tags co ${record.tags.length} muc, vuot ${V21_MAX_TAGS}`, 'warning'));
    }
  }
  if (record.sources !== undefined) {
    if (!Array.isArray(record.sources) || !record.sources.every((s) => typeof s === 'string' && s.trim())) {
      issues.push(issue(`${path}.sources`, 'bad_source', 'sources phai la danh sach chuoi khong rong'));
    } else if (record.sources.length > V21_MAX_SOURCES) {
      issues.push(issue(`${path}.sources`, 'bad_source', `sources co ${record.sources.length} muc, vuot ${V21_MAX_SOURCES}`, 'warning'));
    }
  }
  if (record.verified !== undefined) {
    const v = record.verified;
    if (!v || typeof v.by !== 'string' || !v.by.trim() || typeof v.at !== 'number' || v.at <= 0) {
      issues.push(issue(`${path}.verified`, 'bad_verified', 'verified can {by: chuoi khong rong, at: epoch ms > 0}'));
    }
  }
  if (record.staleAfter !== undefined) {
    if (!isIsoDateV21(record.staleAfter)) {
      issues.push(issue(`${path}.staleAfter`, 'bad_stale_after', `staleAfter "${record.staleAfter}" phai la ngay ISO YYYY-MM-DD hop le`));
    } else if (record.version !== undefined && isRecordStaleV21(record as V21PortableRecord)) {
      issues.push(issue(`${path}.staleAfter`, 'stale_record', `record da qua han stale_after ${record.staleAfter} — nen xem lai truoc khi dung`, 'warning'));
    }
  }
  if (record.codeRefs !== undefined) {
    if (!Array.isArray(record.codeRefs) || !record.codeRefs.every((c) => typeof c === 'string')) {
      issues.push(issue(`${path}.codeRefs`, 'bad_code_ref', 'codeRefs phai la danh sach chuoi'));
    } else {
      if (record.codeRefs.length > V21_MAX_CODE_REFS) {
        issues.push(issue(`${path}.codeRefs`, 'bad_code_ref', `codeRefs co ${record.codeRefs.length} muc, vuot ${V21_MAX_CODE_REFS}`, 'warning'));
      }
      for (const ref of record.codeRefs) {
        if (!/^[\w./\-]+$/.test(ref) || ref.includes('..')) {
          issues.push(issue(`${path}.codeRefs`, 'bad_code_ref', `code_ref "${ref}" khong giong duong dan source hop le`, 'warning'));
        }
      }
    }
  }
  if (record.version !== undefined && (!Number.isInteger(record.version) || record.version < 1)) {
    issues.push(issue(`${path}.version`, 'bad_version', `version phai la so nguyen >= 1 (nhan ${String(record.version)})`));
  }
  return summarizeV21(issues);
}

/** Validate mot file OKF (text). */
export function validateOkfTextV21(text: string, path = 'document'): V21ValidationResult {
  const parsed = parseOkfDocumentV21(text, path);
  if (!parsed.ok || !parsed.data) {
    const code: V21ValidationCode = parsed.errorCode === 'missing_frontmatter' || parsed.errorCode === 'yaml_error'
      ? 'yaml_error'
      : 'missing_type';
    return summarizeV21([issue(path, code, parsed.error ?? 'loi khong ro')]);
  }
  const issues = [...parsed.data.issues];
  if (!parsed.data.body.trim()) {
    issues.push(issue(`${path}.body`, 'empty_body', 'body OKF rong — file chi co frontmatter'));
  }
  return summarizeV21(issues);
}

/** Validate mot file block MemFS (text). */
export function validateMemfsTextV21(text: string, path = 'block'): V21ValidationResult {
  const parsed = parseMemfsBlockHeaderV21(text);
  if (!parsed.ok || !parsed.data) {
    return summarizeV21([issue(path, 'hash_mismatch', parsed.error ?? 'loi khong ro')]);
  }
  const issues: V21ValidationIssue[] = [];
  if (!parsed.data.body.trim()) {
    issues.push(issue(`${path}.body`, 'empty_body', 'body block MemFS rong'));
  }
  return summarizeV21(issues);
}

/** Validate ca bundle record: trung id + tung record. */
export function validateRecordBundleV21(
  records: (Partial<V21PortableRecord> & { id?: string })[],
): V21ValidationResult {
  const issues: V21ValidationIssue[] = [];
  const seen = new Map<string, number>();
  records.forEach((record, idx) => {
    const path = `records[${idx}]`;
    if (record.id) {
      if (seen.has(record.id)) {
        issues.push(
          issue(`${path}.id`, 'duplicate_id', `trung id "${record.id}" voi records[${String(seen.get(record.id))}]`),
        );
      } else {
        seen.set(record.id, idx);
      }
    }
    issues.push(...validatePortableRecordV21(record, path).issues);
  });
  return summarizeV21(issues);
}

/** Dinh dang danh sach issue thanh bao cao doc duoc (de hien thi). */
export function formatValidationIssuesV21(result: V21ValidationResult): string {
  if (result.issues.length === 0) return 'Hop le: khong co loi hay canh bao.';
  const lines = [
    `Ket qua: ${result.errorCount} loi, ${result.warningCount} canh bao.`,
  ];
  for (const item of result.issues) {
    const mark = item.severity === 'error' ? '[LOI]' : '[CANH BAO]';
    lines.push(`${mark} ${item.path} (${item.code}): ${item.message}`);
  }
  return lines.join('\n');
}
