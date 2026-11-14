/**
 * Deprecation migration guide (v1.04, Team T2).
 *
 * MCP 2.0 (SEP-2577) deprecates sampling, roots and logging — plus
 * the server-initiated `elicitation/create` that MRTR replaces.
 * `deprecation.ts` already warns when the old surface is used;
 * this module is the migration path those warnings point to:
 *
 *   - `DEPRECATION_MIGRATION_GUIDES`: one structured guide per
 *     deprecated method — what replaces it, the concrete steps to
 *     move, and how much work it is. The steps are written for
 *     open-bot's own codebase (which modules to touch), not for
 *     the spec in the abstract.
 *   - `migrationGuideFor(method)` / `allMigrationGuides()`:
 *     lookups for the settings UI (show the guide next to the
 *     warning) and for tests.
 *   - `buildDeprecationReport(notices)`: turn the notices a
 *     `DeprecationShim` collected into a summary — which old
 *     methods are still in use, how often, and what replaces each
 *     one — so the operator sees the migration backlog in one
 *     place instead of scattered warnings.
 *   - `buildDeprecationMigrationMarkdown()`: render the whole
 *     guide as Markdown — the source of
 *     `docs/mcp-2.0-migration.md`. The doc is generated from this
 *     module so the guide and the code can never drift apart:
 *     regenerate the doc when a guide changes.
 *
 * Nothing is removed here: the earliest removal date is
 * 2027-07-28 and removal is a 2027 decision, not a v1.04 one.
 * Ideas only — no code copied from any MCP implementation, SDK,
 * or the Grok Bot / Cursor installers.
 */

import {
  DEPRECATED_MCP_METHODS,
  MCP_DEPRECATION_REMOVE_AFTER,
  getDeprecatedMethod,
  type DeprecationNotice,
  type DeprecatedMcpMethod,
} from './deprecation';

/** One step of a migration guide. */
export interface MigrationStep {
  /** Short imperative title (Vietnamese). */
  title: string;
  /** What to do, concretely (Vietnamese). */
  detail: string;
}

/** Effort estimate for one migration. */
export type MigrationEffort = 'nhỏ' | 'trung bình' | 'lớn';

/** Full migration guide for one deprecated method. */
export interface DeprecationMigrationGuide {
  method: string;
  capability: string;
  deprecatedIn: string;
  removeAfter: string;
  replacement: string;
  reason: string;
  /** Who is affected: server authors, client authors, or both. */
  affects: 'server' | 'client' | 'cả hai';
  effort: MigrationEffort;
  steps: MigrationStep[];
}

/** Where in open-bot the replacement already lives. */
const REPLACEMENT_MODULE: Record<string, string> = {
  'sampling/createMessage': 'mrtr.ts (needs_sampling) + provider trực tiếp',
  'roots/list': 'mrtr.ts (needs_roots) + config workspace local',
  'roots/subscribe': 'file watcher của host',
  'notifications/message': 'stderr / OpenTelemetry + notifications/progress',
  'logging/setLevel': 'cấu hình server / biến môi trường',
  'elicitation/create': 'mrtr.ts (needs_elicitation) + mrtrClient.ts',
};

function guideFor(meta: DeprecatedMcpMethod): DeprecationMigrationGuide {
  switch (meta.method) {
    case 'sampling/createMessage':
      return {
        method: meta.method,
        capability: meta.capability,
        deprecatedIn: meta.deprecatedIn,
        removeAfter: meta.removeAfter,
        replacement: meta.replacement,
        reason: meta.reason,
        affects: 'server',
        effort: 'trung bình',
        steps: [
          {
            title: 'Gọi LLM API trực tiếp từ server',
            detail:
              'Server cần completion thì gọi provider đã cấu hình (OpenAI-compatible / Gemini / Ollama local) thay vì nhờ client sampling hộ. Credentials nằm ở server, không đi qua MCP channel.',
          },
          {
            title: 'Hoặc trả MRTR needs_sampling',
            detail:
              'Khi server không có key riêng: tool handler trả `{ resultType: "needs_sampling", need: { prompt } }` (xem `mrtr.ts: buildMrtrResult` + `mrtrClient.ts: extractMrtrToolResult`); client nối `onNeedsSampling` vào model của user và gọi lại. Không còn callback giữa chừng.',
          },
          {
            title: 'Bỏ capability sampling khỏi initialize',
            detail:
              'Không quảng cáo `sampling` trong capabilities nữa — server nào còn quảng cáo sẽ bị `DeprecationShim` ghi notice mỗi lần kết nối.',
          },
        ],
      };
    case 'roots/list':
      return {
        method: meta.method,
        capability: meta.capability,
        deprecatedIn: meta.deprecatedIn,
        removeAfter: meta.removeAfter,
        replacement: meta.replacement,
        reason: meta.reason,
        affects: 'server',
        effort: 'nhỏ',
        steps: [
          {
            title: 'Đọc workspace từ cấu hình local của server',
            detail:
              'Server tự biết thư mục làm việc của nó (workspaceDir khi khởi động McpServer) — không cần hỏi client qua roots/list.',
          },
          {
            title: 'Hoặc nhận roots qua MRTR needs_roots',
            detail:
              'Khi roots do user chọn lúc chạy: tool handler trả `{ resultType: "needs_roots" }`; client trả danh sách roots ở round tiếp theo (xem `mrtrClient.ts: buildDefaultMrtrHandlers`).',
          },
          {
            title: 'Ghi roots vào _meta của request',
            detail:
              'Client stateless có thể kèm roots trong `_meta` của từng request (xem `stateless.ts: StatelessRequestMeta`) thay vì chờ server hỏi.',
          },
        ],
      };
    case 'roots/subscribe':
      return {
        method: meta.method,
        capability: meta.capability,
        deprecatedIn: meta.deprecatedIn,
        removeAfter: meta.removeAfter,
        replacement: meta.replacement,
        reason: meta.reason,
        affects: 'server',
        effort: 'nhỏ',
        steps: [
          {
            title: 'Dùng file watcher của host',
            detail:
              'Thay subscription qua MCP bằng watcher file hệ thống (chokidar / fs.watch) ở phía host — thay đổi workspace được phát hiện trực tiếp, không qua round-trip MCP.',
          },
          {
            title: 'Bỏ handler roots/subscribe',
            detail:
              'Xoá đăng ký handler `roots/subscribe` ở client; server nào còn gửi sẽ nhận -32601 thay vì treo.',
          },
        ],
      };
    case 'notifications/message':
      return {
        method: meta.method,
        capability: meta.capability,
        deprecatedIn: meta.deprecatedIn,
        removeAfter: meta.removeAfter,
        replacement: meta.replacement,
        reason: meta.reason,
        affects: 'server',
        effort: 'nhỏ',
        steps: [
          {
            title: 'Log ra stderr hoặc OpenTelemetry',
            detail:
              'Log vận hành (debug/info) đi ra stderr (stdio server) hoặc OpenTelemetry — không đi qua MCP channel nữa. `McpServer` đã có `onLog` cho việc này.',
          },
          {
            title: 'Tiến độ cho user thì dùng notifications/progress',
            detail:
              'Thứ user cần thấy (tiến độ tool dài) gửi qua `notifications/progress` với `progressToken` trong `_meta`, không phải `notifications/message`.',
          },
        ],
      };
    case 'logging/setLevel':
      return {
        method: meta.method,
        capability: meta.capability,
        deprecatedIn: meta.deprecatedIn,
        removeAfter: meta.removeAfter,
        replacement: meta.replacement,
        reason: meta.reason,
        affects: 'client',
        effort: 'nhỏ',
        steps: [
          {
            title: 'Đặt log level ở cấu hình server',
            detail:
              'Log level là cấu hình triển khai: đặt trong file cấu hình server hoặc biến môi trường khi khởi động, không điều khiển qua MCP lúc chạy.',
          },
          {
            title: 'Bỏ gọi logging/setLevel sau initialize',
            detail:
              'Client không gửi `logging/setLevel` nữa; server giữ level mặc định `info` (xem `McpServer` — `logLevel`) trừ khi cấu hình nói khác.',
          },
        ],
      };
    case 'elicitation/create':
    default:
      return {
        method: meta.method,
        capability: meta.capability,
        deprecatedIn: meta.deprecatedIn,
        removeAfter: meta.removeAfter,
        replacement: meta.replacement,
        reason: meta.reason,
        affects: 'server',
        effort: 'trung bình',
        steps: [
          {
            title: 'Trả MRTR needs_elicitation thay vì callback',
            detail:
              'Tool handler cần giá trị từ user thì trả `{ resultType: "needs_elicitation", need: { prompt, schema } }` (xem `mrtr.ts: buildMrtrResult`); client hỏi user ở round tiếp theo qua `onNeedsElicitation` rồi gọi lại. Không còn `elicitation/create` giữa chừng.',
          },
          {
            title: 'Nối elicitation prompt cũ vào MRTR handler',
            detail:
              'Hàm hỏi user đã có (`elicitation.ts: ElicitationPrompt`) được nối vào `buildDefaultMrtrHandlers({ onNeedsElicitation })` trong `mrtrClient.ts` — UI hỏi user không đổi, chỉ đường gọi đổi.',
          },
          {
            title: 'Bỏ capability elicitation khỏi initialize',
            detail:
              'Không quảng cáo `elicitation` nữa; client chỉ nhận follow-up MRTR khi đã đăng ký handler tương ứng.',
          },
        ],
      };
  }
}

/** All migration guides, one per deprecated method. */
export const DEPRECATION_MIGRATION_GUIDES: readonly DeprecationMigrationGuide[] =
  DEPRECATED_MCP_METHODS.map(guideFor);

/** Migration guide for one method, or null when it is current. */
export function migrationGuideFor(method: string): DeprecationMigrationGuide | null {
  const meta = getDeprecatedMethod(method);
  return meta ? guideFor(meta) : null;
}

/** All migration guides (same order as `DEPRECATED_MCP_METHODS`). */
export function allMigrationGuides(): DeprecationMigrationGuide[] {
  return [...DEPRECATION_MIGRATION_GUIDES];
}

/** Which module implements the replacement for a method. */
export function replacementModuleFor(method: string): string | undefined {
  return REPLACEMENT_MODULE[method];
}

/** One row of a deprecation report: a still-used old method. */
export interface DeprecationReportRow {
  method: string;
  capability: string;
  callCount: number;
  firstSeenMs: number;
  lastSeenMs: number;
  replacement: string;
  effort: MigrationEffort;
  /** Guide steps (so the UI can show them without another lookup). */
  steps: MigrationStep[];
}

/** Summary of the migration backlog from shim notices. */
export interface DeprecationReport {
  /** Total calls to deprecated methods. */
  totalCalls: number;
  /** Distinct deprecated methods still in use. */
  methodsInUse: number;
  /** Earliest date any of them may be removed. */
  removeAfter: string;
  rows: DeprecationReportRow[];
}

/**
 * Build the migration backlog from `DeprecationShim` notices
 * (`shim.getNotices()`). Empty notices → an empty report, not an
 * error: "nothing deprecated in use" is the good state.
 */
export function buildDeprecationReport(notices: readonly DeprecationNotice[]): DeprecationReport {
  const rows: DeprecationReportRow[] = [];
  let totalCalls = 0;
  for (const notice of notices) {
    totalCalls += notice.callCount;
    const guide = migrationGuideFor(notice.method);
    rows.push({
      method: notice.method,
      capability: notice.capability,
      callCount: notice.callCount,
      firstSeenMs: notice.firstSeenMs,
      lastSeenMs: notice.lastSeenMs,
      replacement: notice.replacement,
      effort: guide?.effort ?? 'trung bình',
      steps: guide?.steps ?? [],
    });
  }
  rows.sort((a, b) => b.callCount - a.callCount);
  return {
    totalCalls,
    methodsInUse: rows.length,
    removeAfter: MCP_DEPRECATION_REMOVE_AFTER,
    rows,
  };
}

/** One-line summary of a report, for logs / the settings UI. */
export function describeDeprecationReport(report: DeprecationReport): string {
  if (report.methodsInUse === 0) {
    return 'Không có method MCP deprecated nào đang được dùng.';
  }
  return (
    `${report.methodsInUse} method MCP deprecated đang được dùng ` +
    `(${report.totalCalls} lần gọi) — sớm nhất bị gỡ sau ${report.removeAfter}. ` +
    report.rows.map((row) => `${row.method} (${row.callCount} lần)`).join(', ') + '.'
  );
}

/**
 * Render the full migration guide as Markdown — the source of
 * `docs/mcp-2.0-migration.md`. Generated from the guide data so
 * the doc and the code can never drift apart.
 */
export function buildDeprecationMigrationMarkdown(): string {
  const lines: string[] = [];
  lines.push('# MCP 2.0 — Migration guide (deprecation SEP-2577)');
  lines.push('');
  lines.push(
    'MCP 2.0 (spec 2026-07-28) deprecates sampling, roots, logging và ' +
      'server-initiated elicitation. Các method cũ **vẫn chạy** — không gì bị gỡ ' +
      `trước **${MCP_DEPRECATION_REMOVE_AFTER}** — nhưng code mới không nên dùng chúng nữa.`,
  );
  lines.push('');
  lines.push('> Tài liệu này được sinh từ `packages/core/src/mcp/deprecationMigration.ts`');
  lines.push('> (`buildDeprecationMigrationMarkdown()`). Sửa guide ở đó rồi sinh lại file này,');
  lines.push('> đừng sửa tay — nếu không guide trong code và doc sẽ lệch nhau.');
  lines.push('');
  lines.push('## Tổng quan');
  lines.push('');
  lines.push('| Method | Thay bằng | Ảnh hưởng | Effort |');
  lines.push('|---|---|---|---|');
  for (const guide of DEPRECATION_MIGRATION_GUIDES) {
    lines.push(
      `| \`${guide.method}\` | ${guide.replacement} | ${guide.affects} | ${guide.effort} |`,
    );
  }
  lines.push('');
  for (const guide of DEPRECATION_MIGRATION_GUIDES) {
    lines.push(`## \`${guide.method}\``);
    lines.push('');
    lines.push(`- **Capability:** \`${guide.capability}\``);
    lines.push(`- **Deprecated từ:** ${guide.deprecatedIn} — **gỡ sớm nhất:** ${guide.removeAfter}`);
    lines.push(`- **Lý do:** ${guide.reason}`);
    lines.push(`- **Thay bằng:** ${guide.replacement}`);
    lines.push(`- **Module thay thế trong open-bot:** ${replacementModuleFor(guide.method) ?? '—'}`);
    lines.push(`- **Effort:** ${guide.effort}`);
    lines.push('');
    guide.steps.forEach((step, index) => {
      lines.push(`${index + 1}. **${step.title}** — ${step.detail}`);
    });
    lines.push('');
  }
  lines.push('## Kiểm tra còn dùng method cũ ở đâu');
  lines.push('');
  lines.push(
    'Server ghi notice qua `DeprecationShim` mỗi khi client quảng cáo capability cũ ' +
      'hoặc gọi method cũ (`server.ts`). Dùng `buildDeprecationReport(shim.getNotices())` ' +
      'để lấy backlog migration: method nào còn dùng, bao nhiêu lần, thay bằng gì.',
  );
  lines.push('');
  return lines.join('\n');
}
