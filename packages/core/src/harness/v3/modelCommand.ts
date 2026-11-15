/**
 * Lệnh `/model` trong chat (v1.07, Đội T2).
 *
 * Ý tưởng học từ survey v1.07 phần 1 (OpenHands v1.38 lệnh `/model` —
 * chỉ học ý tưởng, không copy code/text/tài sản của repo nào): gõ
 * `/model` trong chat để liệt kê profile LLM đã lưu và đổi ngay,
 * không cần mở Settings cấu hình lại.
 *
 * Cú pháp:
 * - `/model`            → profile đang dùng + danh sách (đánh dấu active).
 * - `/model list`       → chỉ danh sách.
 * - `/model <id>`       → đổi sang profile `<id>` ngay.
 * - `/model help`       → hướng dẫn.
 *
 * Module này KHÔNG import loop/coordinator (giống slash.ts): host
 * (coordinator/chat) gọi `handleModelCommand(input, store)` trên
 * input của user; khi `handled === true` thì hiển thị `reply` trong
 * chat và KHÔNG đưa input vào vòng lặp agent. `registerModelSlashCommand`
 * đăng ký `/model` vào `SlashCommandRegistry` hiện có để menu `/`
 * tự liệt kê được lệnh này.
 */

import type { SlashCommandRegistry } from '../../agent/slash';
import type { LlmProfile, LlmProfileStore } from './llmProfiles';

export type ModelCommandKind = 'current' | 'list' | 'switch' | 'help';

export interface ParsedModelCommand {
  kind: ModelCommandKind;
  /** Id profile khi kind = 'switch'. */
  profileId?: string;
}

export interface ModelCommandResult {
  /** True khi input là lệnh /model (host không đưa vào agent loop). */
  handled: boolean;
  /** Text trả lời để hiển thị trong chat (markdown). */
  reply: string;
  /** True khi lệnh vừa đổi profile active. */
  switched: boolean;
  /** Profile vừa được chọn (khi switched). */
  profile?: LlmProfile;
}

/**
 * Phân tích input: "/model", "/model list", "/model <id>",
 * "/model help". Trả null khi input không phải lệnh /model.
 * Tên profile không phân biệt hoa/thường khi so khớp id.
 */
export function parseModelCommand(input: string): ParsedModelCommand | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith('/model')) return null;
  const rest = trimmed.slice('/model'.length);
  // "/modelx" không phải lệnh /model (cần hết chuỗi hoặc khoảng trắng sau).
  if (rest !== '' && !/^\s/.test(rest)) return null;
  const arg = rest.trim();
  if (arg === '') return { kind: 'current' };
  const lower = arg.toLowerCase();
  if (lower === 'list' || lower === 'ls') return { kind: 'list' };
  if (lower === 'help' || lower === '--help' || lower === '-h') return { kind: 'help' };
  return { kind: 'switch', profileId: lower };
}

function formatProfileLine(profile: LlmProfile, active: boolean): string {
  const mark = active ? '● ' : '○ ';
  const params: string[] = [];
  if (profile.temperature !== undefined) params.push(`temp ${profile.temperature}`);
  if (profile.maxTokens !== undefined) {
    params.push(`max ${profile.maxTokens.toLocaleString('en-US')} token`);
  }
  const paramText = params.length > 0 ? ` (${params.join(', ')})` : '';
  const notes = profile.notes !== undefined ? ` — ${profile.notes}` : '';
  return `${mark}\`${profile.id}\` — ${profile.name} (${profile.providerId} / ${profile.model})${paramText}${notes}`;
}

function listReply(store: LlmProfileStore): string {
  const profiles = store.list();
  const activeId = store.activeProfileId;
  if (profiles.length === 0) {
    return (
      'Chưa có profile LLM nào. Tạo profile trong Settings → Model profiles ' +
      'hoặc dùng nút "Tạo profile mẫu" để có sẵn danh sách đổi nhanh.'
    );
  }
  const lines = ['**Profile LLM đã lưu:**'];
  for (const profile of profiles) {
    lines.push(formatProfileLine(profile, profile.id === activeId));
  }
  lines.push('');
  lines.push('Gõ `/model <id>` để đổi ngay (vd `/model grok-nhanh`).');
  return lines.join('\n');
}

/**
 * Xử lý một input của user: khi là lệnh /model thì đổi/liệt kê và
 * trả reply; khi không phải thì `handled: false` (host đưa input vào
 * agent loop như thường). Không throw vì profile không tồn tại —
 * trả reply báo lỗi để chat hiển thị.
 */
export function handleModelCommand(
  input: string,
  store: LlmProfileStore,
): ModelCommandResult {
  const parsed = parseModelCommand(input);
  if (parsed === null) {
    return { handled: false, reply: '', switched: false };
  }
  if (parsed.kind === 'help') {
    return {
      handled: true,
      reply:
        '**Lệnh /model — đổi profile LLM trong chat:**\n' +
        '- `/model` — xem profile đang dùng + danh sách.\n' +
        '- `/model list` — chỉ liệt kê profile đã lưu.\n' +
        '- `/model <id>` — đổi sang profile `<id>` ngay, không cần cấu hình lại.\n' +
        '- Tạo/sửa profile trong Settings → Model profiles.',
      switched: false,
    };
  }
  if (parsed.kind === 'current' || parsed.kind === 'list') {
    const active = store.active();
    const head =
      parsed.kind === 'current'
        ? active === undefined
          ? 'Đang dùng model mặc định của bot (chưa chọn profile).\n\n'
          : `Đang dùng profile \`${active.id}\` — ${active.name} (${active.providerId} / ${active.model}).\n\n`
        : '';
    return { handled: true, reply: `${head}${listReply(store)}`, switched: false };
  }
  const profileId = parsed.profileId ?? '';
  try {
    const profile = store.setActive(profileId);
    return {
      handled: true,
      reply:
        `Đã đổi sang profile \`${profile.id}\` — ${profile.name} ` +
        `(${profile.providerId} / ${profile.model}). ` +
        `Turn tiếp theo sẽ dùng profile này.`,
      switched: true,
      profile,
    };
  } catch (err) {
    const available = store.list();
    const hint =
      available.length > 0
        ? `\n\nProfile có sẵn: ${available.map((p) => `\`${p.id}\``).join(', ')}.`
        : '\n\nChưa có profile nào — tạo trong Settings → Model profiles.';
    return {
      handled: true,
      reply: `Không đổi được profile: ${(err as Error).message}${hint}`,
      switched: false,
    };
  }
}

/**
 * Đăng ký `/model` vào SlashCommandRegistry hiện có (để menu `/`
 * liệt kê + `parse()` nhận ra). Trả def đã đăng ký. Registry đã có
 * `/model` thì throw SlashCommandError (theo registry).
 */
export function registerModelSlashCommand(
  registry: SlashCommandRegistry,
  store: LlmProfileStore,
): void {
  registry.register({
    name: 'model',
    description: 'Liệt kê và đổi profile LLM đã lưu ngay trong chat.',
    source: 'plugin',
    promptTemplate: '',
    run: (args) => {
      const input = args === '' ? '/model' : `/model ${args}`;
      return handleModelCommand(input, store).reply;
    },
  });
}
