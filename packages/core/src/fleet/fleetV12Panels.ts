/**
 * Fleet panels v12 — view-model cho 3 panel riêng của platform/fleet
 * v12 (v1.15, Đội T6): AG-UI/A2UI, memory v12, router.
 *
 * Các panel này là panel RIÊNG, không nhồi vào màn chat chính (theo
 * hướng UI: chat/bot list/tool browsing/settings quen Grok Bot, tính
 * năng nâng cao sau panel/menu — progressive disclosure). Module này
 * chỉ xây VIEW-MODEL thuần (dữ liệu đã lọc/sắp xếp + quyền + tóm tắt)
 * từ dữ liệu thật của các tầng dưới; component React ở
 * `apps/desktop/src/renderer/components/FleetV12*Panel.tsx` render từ đó.
 *
 * - AG-UI/A2UI panel: từ event stream AG-UI (`agui/types.ts` — 16
 *   event type chuẩn) xây timeline theo run (run/step/tool/interrupt),
 *   gom text delta thành message hoàn chỉnh, liệt kê interrupt đang
 *   chờ quyết định (GENERATIVE_UI kind `confirm` có `blocking`, hoặc
 *   ACTIVITY `waiting-approval`), và generative surfaces A2UI
 *   (GENERATIVE_UI chưa có response). Quyết định approve/reject được
 *   validate trước khi host gửi GENERATIVE_UI_RESPONSE.
 * - Memory panel v12: fact list (tìm kiếm/lọc theo độ tin cậy +
 *   nguồn), temporal KG view đơn giản (entity/relation kèm khoảng
 *   hiệu lực + superseded), quarantine review (fact/entity đang cách
 *   ly kèm provenance, approve = đưa về lại / reject = xóa), và kế
 *   hoạch GDPR erasure cho một user (những gì sẽ bị xóa, đếm theo
 *   loại, bước xác nhận).
 * - Router panel: model đang load (từ router state do caller truyền
 *   vào — module không đọc router thật, T3 sở hữu router), RAM từng
 *   model + tổng, routing decision log (lọc theo model/lý do), và
 *   budget/spend (đã dùng / giới hạn / còn lại, cảnh báo khi vượt
 *   80%).
 *
 * Tất cả hàm đều thuần, không đọc file, không chạm mạng. Dữ liệu mock
 * chỉ xuất hiện ở component demo — module này không chứa mock.
 */

import type {
  AgUiEvent,
  AgUiGenerativeUiData,
} from '../agui/types';

// ---------------------------------------------------------------------------
// AG-UI / A2UI panel
// ---------------------------------------------------------------------------

/** Một dòng trong timeline của một run. */
export interface FleetV12AguiTimelineRow {
  sequence: number;
  at: string;
  kind: 'run' | 'text' | 'tool' | 'state' | 'genui' | 'activity' | 'custom';
  label: string;
  detail: string;
  status: 'ok' | 'error' | 'pending' | 'info';
}

/** Một run trong panel AG-UI (đã gom event theo runId). */
export interface FleetV12AguiRunRow {
  runId: string;
  botId: string;
  title: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'cancelled' | 'waiting';
  startedAt: string | null;
  finishedAt: string | null;
  steps: number;
  toolCalls: number;
  tokensUsed: number | null;
  textPreview: string;
  timeline: FleetV12AguiTimelineRow[];
}

/** Một interrupt đang chờ user quyết định. */
export interface FleetV12AguiInterrupt {
  /** Id component (GENERATIVE_UI) hoặc runId (ACTIVITY waiting-approval). */
  id: string;
  runId: string;
  kind: 'confirm' | 'approval' | 'form' | 'options';
  title: string;
  description: string;
  /** true = run đang block chờ quyết định này. */
  blocking: boolean;
  at: string;
}

/** Một generative surface A2UI (component agent yêu cầu renderer vẽ). */
export interface FleetV12A2uiSurface {
  componentId: string;
  runId: string;
  kind: string;
  title: string;
  description: string;
  /** true = đã có response từ user (đã trả lời). */
  answered: boolean;
  blocking: boolean;
}

/** View-model panel AG-UI/A2UI. */
export interface FleetV12AguiPanel {
  runs: FleetV12AguiRunRow[];
  interrupts: FleetV12AguiInterrupt[];
  surfaces: FleetV12A2uiSurface[];
  pendingInterruptCount: number;
  runningRunCount: number;
  summary: string;
}

/** Quyết định của user cho một interrupt. */
export type FleetV12InterruptDecision = 'approve' | 'reject';

export const FLEET_V12_INTERRUPT_DECISIONS: readonly FleetV12InterruptDecision[] = [
  'approve',
  'reject',
];

/** Tối đa event xử lý trong một lần build panel (chống stream quá lớn). */
export const FLEET_V12_MAX_AGUI_EVENTS = 2000;
/** Tối đa run hiển thị trong panel. */
export const FLEET_V12_MAX_AGUI_RUNS = 50;

function timelineKind(type: AgUiEvent['type']): FleetV12AguiTimelineRow['kind'] {
  if (type === 'RUN_STARTED' || type === 'RUN_FINISHED' || type === 'RUN_ERROR') return 'run';
  if (type.startsWith('TEXT_MESSAGE')) return 'text';
  if (type.startsWith('TOOL_CALL')) return 'tool';
  if (type.startsWith('STATE_')) return 'state';
  if (type.startsWith('GENERATIVE_UI')) return 'genui';
  if (type === 'ACTIVITY') return 'activity';
  return 'custom';
}

function eventLabel(event: AgUiEvent): { label: string; detail: string; status: FleetV12AguiTimelineRow['status'] } {
  const d = event.data as Record<string, unknown>;
  switch (event.type) {
    case 'RUN_STARTED':
      return {
        label: 'Run bắt đầu',
        detail: typeof d.title === 'string' ? d.title : '',
        status: 'info',
      };
    case 'RUN_FINISHED':
      return {
        label: `Run kết thúc (${typeof d.status === 'string' ? d.status : 'completed'})`,
        detail: typeof d.finalText === 'string' ? d.finalText.slice(0, 200) : '',
        status: d.status === 'failed' ? 'error' : 'ok',
      };
    case 'RUN_ERROR':
      return {
        label: 'Run lỗi',
        detail: typeof d.message === 'string' ? d.message : '',
        status: 'error',
      };
    case 'TEXT_MESSAGE_START':
      return { label: 'Tin nhắn bắt đầu', detail: '', status: 'info' };
    case 'TEXT_MESSAGE_CONTENT':
      return {
        label: 'Text',
        detail: typeof d.delta === 'string' ? d.delta.slice(0, 200) : '',
        status: 'info',
      };
    case 'TEXT_MESSAGE_END':
      return {
        label: 'Tin nhắn xong',
        detail: typeof d.fullText === 'string' ? d.fullText.slice(0, 200) : '',
        status: 'ok',
      };
    case 'TOOL_CALL_START':
      return {
        label: `Tool: ${typeof d.toolName === 'string' ? d.toolName : '?'}`,
        detail: '',
        status: 'pending',
      };
    case 'TOOL_CALL_ARGS':
      return {
        label: `Tool args: ${typeof d.toolName === 'string' ? d.toolName : '?'}`,
        detail: Array.isArray(d.argKeys) ? `keys: ${d.argKeys.join(', ')}` : '',
        status: 'info',
      };
    case 'TOOL_CALL_END':
      return {
        label: `Tool xong: ${typeof d.toolName === 'string' ? d.toolName : '?'}`,
        detail: typeof d.status === 'string' ? d.status : '',
        status: d.status === 'ok' ? 'ok' : 'error',
      };
    case 'TOOL_CALL_RESULT':
      return {
        label: `Tool kết quả: ${typeof d.toolName === 'string' ? d.toolName : '?'}`,
        detail: typeof d.outputPreview === 'string' ? d.outputPreview.slice(0, 200) : '',
        status: d.ok === true ? 'ok' : 'error',
      };
    case 'STATE_SNAPSHOT':
      return { label: 'State snapshot', detail: '', status: 'info' };
    case 'STATE_DELTA':
      return {
        label: 'State delta',
        detail: Array.isArray(d.operations) ? `${d.operations.length} thao tác` : '',
        status: 'info',
      };
    case 'GENERATIVE_UI': {
      const data = event.data as AgUiGenerativeUiData;
      return {
        label: `Generative UI: ${data.kind} — ${data.title}`,
        detail: data.description ?? '',
        status: data.blocking === true ? 'pending' : 'info',
      };
    }
    case 'GENERATIVE_UI_RESPONSE':
      return {
        label: 'User trả lời generative UI',
        detail: typeof d.action === 'string' ? d.action : '',
        status: 'ok',
      };
    case 'ACTIVITY':
      return {
        label: typeof d.label === 'string' ? d.label : 'Hoạt động',
        detail: typeof d.detail === 'string' ? d.detail : '',
        status: d.kind === 'waiting-approval' || d.kind === 'waiting-user' ? 'pending' : 'info',
      };
    case 'CUSTOM':
      return {
        label: `Custom: ${typeof d.name === 'string' ? d.name : '?'}`,
        detail: '',
        status: 'info',
      };
    default:
      return { label: event.type, detail: '', status: 'info' };
  }
}

/**
 * Xây view-model panel AG-UI/A2UI từ event stream (hàm thuần).
 * Event được sắp theo (runId, sequence); run nào có RUN_FINISHED/
 * RUN_ERROR thì đóng, run có interrupt blocking chưa response thì
 * `waiting`. Text delta được gom thành textPreview của run.
 */
export function buildFleetV12AguiPanel(events: AgUiEvent[]): FleetV12AguiPanel {
  const capped = events.slice(-FLEET_V12_MAX_AGUI_EVENTS);
  const runsById = new Map<string, FleetV12AguiRunRow>();
  const textByRun = new Map<string, string>();
  const answeredComponents = new Set<string>();
  for (const e of capped) {
    if (e.type === 'GENERATIVE_UI_RESPONSE') {
      const d = e.data as Record<string, unknown>;
      if (typeof d.componentId === 'string') answeredComponents.add(d.componentId);
    }
  }
  const interrupts: FleetV12AguiInterrupt[] = [];
  const surfaces: FleetV12A2uiSurface[] = [];
  const seenInterruptIds = new Set<string>();
  for (const e of capped) {
    let run = runsById.get(e.runId);
    if (!run) {
      run = {
        runId: e.runId,
        botId: e.botId ?? '',
        title: '',
        status: 'running',
        startedAt: null,
        finishedAt: null,
        steps: 0,
        toolCalls: 0,
        tokensUsed: null,
        textPreview: '',
        timeline: [],
      };
      runsById.set(e.runId, run);
    }
    const { label, detail, status } = eventLabel(e);
    run.timeline.push({
      sequence: typeof e.sequence === 'number' ? e.sequence : run.timeline.length,
      at: e.timestamp,
      kind: timelineKind(e.type),
      label,
      detail,
      status,
    });
    const d = e.data as Record<string, unknown>;
    if (e.type === 'RUN_STARTED') {
      run.startedAt = e.timestamp;
      if (typeof d.title === 'string') run.title = d.title;
      if (typeof d.model === 'string' && d.model) run.title = run.title || d.model;
    } else if (e.type === 'RUN_FINISHED') {
      run.finishedAt = e.timestamp;
      run.status =
        d.status === 'failed'
          ? 'failed'
          : d.status === 'stopped'
            ? 'stopped'
            : d.status === 'cancelled'
              ? 'cancelled'
              : 'completed';
      if (typeof d.steps === 'number') run.steps = d.steps;
      if (typeof d.toolCalls === 'number') run.toolCalls = d.toolCalls;
      if (typeof d.tokensUsed === 'number') run.tokensUsed = d.tokensUsed;
    } else if (e.type === 'RUN_ERROR') {
      run.finishedAt = e.timestamp;
      run.status = 'failed';
    } else if (e.type === 'TEXT_MESSAGE_CONTENT') {
      if (typeof d.delta === 'string') {
        textByRun.set(e.runId, (textByRun.get(e.runId) ?? '') + d.delta);
      }
    } else if (e.type === 'TOOL_CALL_START') {
      run.toolCalls += 1;
    } else if (e.type === 'GENERATIVE_UI') {
      const data = e.data as AgUiGenerativeUiData;
      const answered = answeredComponents.has(data.componentId);
      surfaces.push({
        componentId: data.componentId,
        runId: e.runId,
        kind: data.kind,
        title: data.title,
        description: data.description ?? '',
        answered,
        blocking: data.blocking === true,
      });
      if (data.kind === 'confirm' && data.blocking === true && !answered) {
        const key = `genui:${data.componentId}`;
        if (!seenInterruptIds.has(key)) {
          seenInterruptIds.add(key);
          interrupts.push({
            id: data.componentId,
            runId: e.runId,
            kind: 'confirm',
            title: data.title,
            description: data.description ?? '',
            blocking: true,
            at: e.timestamp,
          });
        }
      }
    } else if (e.type === 'ACTIVITY') {
      if (d.kind === 'waiting-approval') {
        const key = `activity:${e.runId}`;
        if (!seenInterruptIds.has(key)) {
          seenInterruptIds.add(key);
          interrupts.push({
            id: e.runId,
            runId: e.runId,
            kind: 'approval',
            title: typeof d.label === 'string' ? d.label : 'Chờ phê duyệt',
            description: typeof d.detail === 'string' ? d.detail : '',
            blocking: true,
            at: e.timestamp,
          });
        }
      }
    }
  }
  const runs = [...runsById.values()]
    .map((r) => {
      const text = textByRun.get(r.runId) ?? '';
      const pendingBlocking = interrupts.some((i) => i.runId === r.runId && i.blocking);
      return {
        ...r,
        textPreview: text.slice(0, 300),
        status: pendingBlocking && r.status === 'running' ? ('waiting' as const) : r.status,
        timeline: [...r.timeline].sort((a, b) => a.sequence - b.sequence),
      };
    })
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    .slice(0, FLEET_V12_MAX_AGUI_RUNS);
  const runningRunCount = runs.filter((r) => r.status === 'running' || r.status === 'waiting').length;
  const summary =
    runs.length === 0
      ? 'Chưa có event AG-UI nào.'
      : `${runs.length} run (${runningRunCount} đang chạy/chờ), ${interrupts.length} interrupt đang chờ quyết định, ${surfaces.length} generative surface.`;
  return {
    runs,
    interrupts,
    surfaces,
    pendingInterruptCount: interrupts.length,
    runningRunCount,
    summary,
  };
}

/**
 * Validate quyết định approve/reject cho một interrupt (hàm thuần):
 * interrupt phải đang chờ (có trong panel), decision phải là
 * approve/reject, actor phải là `user` (agent không tự duyệt interrupt
 * của chính nó). Trả về lỗi ('' = hợp lệ) + payload response gửi về
 * agent (GENERATIVE_UI_RESPONSE).
 */
export function validateFleetV12InterruptDecision(
  panel: FleetV12AguiPanel,
  interruptId: string,
  decision: string,
  actor: string,
): { ok: boolean; error: string; response: Record<string, unknown> | null } {
  if (actor !== 'user') {
    return { ok: false, error: 'chỉ người dùng mới được duyệt/từ chối interrupt', response: null };
  }
  if (decision !== 'approve' && decision !== 'reject') {
    return { ok: false, error: 'decision phải là approve hoặc reject', response: null };
  }
  const interrupt = panel.interrupts.find((i) => i.id === interruptId);
  if (!interrupt) {
    return { ok: false, error: `không tìm thấy interrupt đang chờ: ${interruptId}`, response: null };
  }
  return {
    ok: true,
    error: '',
    response: {
      componentId: interrupt.id,
      action: decision === 'approve' ? 'confirm' : 'dismiss',
      decision,
      decidedBy: 'user',
    },
  };
}

// ---------------------------------------------------------------------------
// Memory panel v12
// ---------------------------------------------------------------------------

/** Một fact trong memory (input do caller truyền — T1 sở hữu store thật). */
export interface FleetV12MemoryFact {
  id: string;
  text: string;
  /** Độ tin cậy 0–1. */
  confidence: number;
  /** Nguồn: user nói / agent suy ra / import / ... */
  source: string;
  /** Bot/user nào tạo fact. */
  createdBy: string;
  createdAt: number;
  /** true = đang bị cách ly (quarantine) vì nghi poisoning. */
  quarantined: boolean;
  /** Lý do quarantine ('' khi không cách ly). */
  quarantineReason: string;
}

/** Một entity trong temporal KG (input đơn giản, có khoảng hiệu lực). */
export interface FleetV12KgEntity {
  id: string;
  name: string;
  kind: string;
  /** Ngày bắt đầu hiệu lực (ISO, '' = không rõ). */
  validFrom: string;
  /** Ngày hết hiệu lực (ISO, '' = còn hiệu lực). */
  validTo: string;
  /** true = đã bị supersede bởi entity khác (có `supersededBy`). */
  superseded: boolean;
  supersededBy: string;
  quarantined: boolean;
}

/** Một relation trong temporal KG. */
export interface FleetV12KgRelation {
  id: string;
  fromId: string;
  toId: string;
  label: string;
  validFrom: string;
  validTo: string;
  superseded: boolean;
  quarantined: boolean;
}

/** Filter cho fact list. */
export interface FleetV12MemoryFilter {
  query?: string;
  /** Chỉ fact có confidence >= minConfidence (0 = tất cả). */
  minConfidence?: number;
  source?: string;
  /** 'all' | 'quarantined' | 'clean'. */
  quarantined?: 'all' | 'quarantined' | 'clean';
}

/** Một dòng fact đã lọc cho panel. */
export interface FleetV12MemoryFactRow {
  id: string;
  text: string;
  confidence: number;
  source: string;
  createdBy: string;
  createdAt: number;
  quarantined: boolean;
  quarantineReason: string;
}

/** View-model panel memory v12. */
export interface FleetV12MemoryPanel {
  facts: FleetV12MemoryFactRow[];
  totalFacts: number;
  quarantinedCount: number;
  entities: FleetV12KgEntity[];
  relations: FleetV12KgRelation[];
  activeEntityCount: number;
  supersededCount: number;
  summary: string;
}

/** Tối đa fact hiển thị trong panel. */
export const FLEET_V12_MAX_MEMORY_FACTS = 200;
/** Tối đa entity/relation hiển thị trong KG view. */
export const FLEET_V12_MAX_KG_ITEMS = 100;

/**
 * Xây view-model memory panel v12: lọc fact theo query/confidence/
 * nguồn/quarantine, sắp xếp theo confidence giảm dần; KG view chỉ
 * hiện entity/relation chưa supersede trước, rồi tới superseded.
 */
export function buildFleetV12MemoryPanel(
  facts: FleetV12MemoryFact[],
  entities: FleetV12KgEntity[],
  relations: FleetV12KgRelation[],
  filter: FleetV12MemoryFilter = {},
): FleetV12MemoryPanel {
  const q = (filter.query ?? '').trim().toLowerCase();
  const minConfidence =
    typeof filter.minConfidence === 'number' && Number.isFinite(filter.minConfidence)
      ? Math.max(0, Math.min(1, filter.minConfidence))
      : 0;
  const source = (filter.source ?? '').trim().toLowerCase();
  const quarantined = filter.quarantined ?? 'all';
  const filtered = facts
    .filter((f) => {
      if (f.confidence < minConfidence) return false;
      if (source && f.source.toLowerCase() !== source) return false;
      if (quarantined === 'quarantined' && !f.quarantined) return false;
      if (quarantined === 'clean' && f.quarantined) return false;
      if (q && !f.text.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
    .slice(0, FLEET_V12_MAX_MEMORY_FACTS)
    .map((f) => ({
      id: f.id,
      text: f.text,
      confidence: f.confidence,
      source: f.source,
      createdBy: f.createdBy,
      createdAt: f.createdAt,
      quarantined: f.quarantined,
      quarantineReason: f.quarantineReason,
    }));
  const quarantinedCount = facts.filter((f) => f.quarantined).length;
  const sortedEntities = [...entities]
    .sort((a, b) => Number(a.superseded) - Number(b.superseded) || a.name.localeCompare(b.name))
    .slice(0, FLEET_V12_MAX_KG_ITEMS);
  const sortedRelations = [...relations]
    .sort((a, b) => Number(a.superseded) - Number(b.superseded) || a.label.localeCompare(b.label))
    .slice(0, FLEET_V12_MAX_KG_ITEMS);
  const activeEntityCount = entities.filter((e) => !e.superseded).length;
  const supersededCount =
    entities.filter((e) => e.superseded).length + relations.filter((r) => r.superseded).length;
  const summary =
    facts.length === 0
      ? 'Chưa có fact nào trong memory.'
      : `${facts.length} fact (${quarantinedCount} đang cách ly), ${entities.length} entity KG ` +
        `(${activeEntityCount} đang hiệu lực, ${supersededCount} đã supersede).`;
  return {
    facts: filtered,
    totalFacts: facts.length,
    quarantinedCount,
    entities: sortedEntities,
    relations: sortedRelations,
    activeEntityCount,
    supersededCount,
    summary,
  };
}

/** Quyết định review quarantine: đưa fact về lại hay xóa hẳn. */
export type FleetV12QuarantineDecision = 'restore' | 'delete';

export const FLEET_V12_QUARANTINE_DECISIONS: readonly FleetV12QuarantineDecision[] = [
  'restore',
  'delete',
];

/**
 * Validate quyết định review quarantine: fact phải đang quarantined,
 * decision phải là restore/delete, actor phải là `user` (agent không
 * tự gỡ cách ly fact nghi poisoning).
 */
export function validateFleetV12QuarantineDecision(
  fact: FleetV12MemoryFact | null | undefined,
  decision: string,
  actor: string,
): { ok: boolean; error: string } {
  if (actor !== 'user') {
    return { ok: false, error: 'chỉ người dùng mới được review quarantine' };
  }
  if (!fact) return { ok: false, error: 'không tìm thấy fact' };
  if (!fact.quarantined) {
    return { ok: false, error: `fact "${fact.id}" không đang bị cách ly` };
  }
  if (decision !== 'restore' && decision !== 'delete') {
    return { ok: false, error: 'decision phải là restore hoặc delete' };
  }
  return { ok: true, error: '' };
}

/** Kế hoạch GDPR erasure cho một user (những gì sẽ bị xóa). */
export interface FleetV12GdprErasurePlan {
  userId: string;
  factCount: number;
  entityCount: number;
  relationCount: number;
  /** Số fact quarantined của user cũng sẽ bị xóa. */
  quarantinedFactCount: number;
  /** Các bước xác nhận cần làm trước khi xóa (theo thứ tự). */
  steps: string[];
  /** true = có dữ liệu để xóa; false = user không có dữ liệu nào. */
  hasData: boolean;
  summary: string;
}

/**
 * Lập kế hoạch GDPR erasure cho một user (hàm thuần — chỉ ĐẾM và liệt
 * kê, KHÔNG xóa thật): fact/entity/relation thuộc về user đó
 * (createdBy === userId, hoặc entity/relation do user tạo — caller
 * truyền đúng tập đã lọc theo user). Việc xóa thật do store (T1) làm
 * sau khi user xác nhận đủ các bước.
 */
export function planFleetV12GdprErasure(
  userId: string,
  facts: FleetV12MemoryFact[],
  entities: FleetV12KgEntity[],
  relations: FleetV12KgRelation[],
): FleetV12GdprErasurePlan {
  const userFacts = facts.filter((f) => f.createdBy === userId);
  const userEntities = entities.filter((e) => e.id.startsWith(`user:${userId}:`) || e.id === userId);
  const userRelations = relations.filter(
    (r) => r.fromId.startsWith(`user:${userId}:`) || r.toId.startsWith(`user:${userId}:`),
  );
  const quarantinedFactCount = userFacts.filter((f) => f.quarantined).length;
  const hasData = userFacts.length + userEntities.length + userRelations.length > 0;
  const steps = hasData
    ? [
        `Xác nhận danh tính user "${userId}" (chỉ user đó hoặc admin mới được yêu cầu xóa).`,
        `Xuất bản sao dữ liệu của user trước khi xóa (fact: ${userFacts.length}, entity: ${userEntities.length}, relation: ${userRelations.length}).`,
        `Xóa ${userFacts.length} fact (gồm ${quarantinedFactCount} fact đang cách ly) khỏi memory store.`,
        `Xóa ${userEntities.length} entity + ${userRelations.length} relation khỏi temporal KG.`,
        'Ghi audit log erasure (userId + thời điểm + số lượng, không ghi nội dung đã xóa).',
      ]
    : ['Không có dữ liệu nào của user này để xóa.'];
  const summary = hasData
    ? `Sẽ xóa dữ liệu của user "${userId}": ${userFacts.length} fact, ${userEntities.length} entity, ${userRelations.length} relation.`
    : `User "${userId}" không có dữ liệu nào trong memory.`;
  return {
    userId,
    factCount: userFacts.length,
    entityCount: userEntities.length,
    relationCount: userRelations.length,
    quarantinedFactCount,
    steps,
    hasData,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Router panel
// ---------------------------------------------------------------------------

/** Một model đang load trên router (input do caller truyền — T3 sở hữu router). */
export interface FleetV12RouterModel {
  modelId: string;
  /** 'local' = GGUF local, 'cloud' = provider cloud. */
  kind: 'local' | 'cloud';
  status: 'loaded' | 'loading' | 'unloaded' | 'error';
  /** RAM đang chiếm (MB, 0 khi chưa load). */
  ramMb: number;
  /** Context window (token). */
  contextTokens: number;
  /** Số request đã phục vụ từ lúc load. */
  requestsServed: number;
  loadedAt: number | null;
}

/** Một dòng log quyết định routing. */
export interface FleetV12RoutingDecision {
  at: number;
  taskKind: string;
  chosenModelId: string;
  /** Lý do chọn: cost/latency/quality/local-first/... */
  reason: string;
  estimatedCostUsd: number;
  latencyMs: number | null;
}

/** View-model panel router. */
export interface FleetV12RouterPanel {
  models: FleetV12RouterModel[];
  loadedCount: number;
  totalRamMb: number;
  /** RAM giới hạn cho model local (MB, 0 = không giới hạn). */
  ramLimitMb: number;
  ramUsagePct: number | null;
  decisions: FleetV12RoutingDecision[];
  totalSpendUsd: number;
  budgetUsd: number;
  spendPct: number | null;
  budgetWarning: string;
  summary: string;
}

/**
 * Xây view-model router panel: model đang load + RAM, decision log
 * mới nhất trước, budget/spend (cảnh báo khi dùng >= 80% budget).
 */
export function buildFleetV12RouterPanel(
  models: FleetV12RouterModel[],
  decisions: FleetV12RoutingDecision[],
  opts: { ramLimitMb?: number; budgetUsd?: number },
): FleetV12RouterPanel {
  const loaded = models.filter((m) => m.status === 'loaded' || m.status === 'loading');
  const totalRamMb = models.reduce((a, m) => a + Math.max(0, m.ramMb), 0);
  const ramLimitMb =
    typeof opts.ramLimitMb === 'number' && Number.isFinite(opts.ramLimitMb)
      ? Math.max(0, Math.floor(opts.ramLimitMb))
      : 0;
  const ramUsagePct = ramLimitMb > 0 ? (totalRamMb / ramLimitMb) * 100 : null;
  const sortedDecisions = [...decisions]
    .sort((a, b) => b.at - a.at)
    .slice(0, 100);
  const totalSpendUsd = decisions.reduce(
    (a, d) => a + (Number.isFinite(d.estimatedCostUsd) ? Math.max(0, d.estimatedCostUsd) : 0),
    0,
  );
  const budgetUsd =
    typeof opts.budgetUsd === 'number' && Number.isFinite(opts.budgetUsd)
      ? Math.max(0, opts.budgetUsd)
      : 0;
  const spendPct = budgetUsd > 0 ? (totalSpendUsd / budgetUsd) * 100 : null;
  const budgetWarning =
    spendPct !== null && spendPct >= 100
      ? `Đã vượt budget ($${totalSpendUsd.toFixed(4)} / $${budgetUsd.toFixed(2)}).`
      : spendPct !== null && spendPct >= 80
        ? `Sắp hết budget: đã dùng ${spendPct.toFixed(0)}% ($${totalSpendUsd.toFixed(4)} / $${budgetUsd.toFixed(2)}).`
        : '';
  const summary =
    models.length === 0
      ? 'Router chưa load model nào.'
      : `${loaded.length}/${models.length} model đang load, RAM ${totalRamMb} MB` +
        (ramUsagePct !== null ? ` (${ramUsagePct.toFixed(0)}% giới hạn)` : '') +
        `, spend $${totalSpendUsd.toFixed(4)}` +
        (budgetUsd > 0 ? ` / $${budgetUsd.toFixed(2)} budget` : '') +
        `, ${decisions.length} quyết định routing.`;
  return {
    models: [...models].sort((a, b) => b.ramMb - a.ramMb),
    loadedCount: loaded.length,
    totalRamMb,
    ramLimitMb,
    ramUsagePct,
    decisions: sortedDecisions,
    totalSpendUsd,
    budgetUsd,
    spendPct,
    budgetWarning,
    summary,
  };
}
