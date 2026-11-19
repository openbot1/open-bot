/**
 * Memory v23 — procedural memory (v1.38, Doi T1).
 *
 * Y tuong CoALA: procedural memory la loai memory rieng — cach lam
 * viec (workflow/skill), khong phai fact. Module nay ghi lai workflow
 * da chay thanh cong va nang cap thanh skill tai dung duoc:
 *  - Ghi attempt: moi lan chay workflow (steps, tools, outcome,
 *    duration) duoc luu vao lich su cua workflow do.
 *  - Promote: workflow dat nguong (mac dinh >= 3 success, ti le
 *    >= 0.66) thi len skill `candidate` -> nguoi dung / he thong
 *    duyet -> `active`. Skill chua dat nguong van o dang lich su,
 *    khong mat.
 *  - Version: khi workflow chay thanh cong voi steps khac (cai tien)
 *    va ti le tot hon, skill tang version (steps moi thang steps cu).
 *  - Rating: nguoi dung cham 1..5; rating trung binh + success rate
 *    quyet dinh skill co bi deprecate khong (rating < 2 sau >= 3
 *    luot, hoac success rate < 0.4 sau >= 5 lan chay).
 *  - Search: tim skill theo tu khoa trong workflow/trigger/steps
 *    (keyword overlap, khong can embedding).
 *
 * Luu file JSON (mot file, ghi nguyen tu nhu store v23). Khong goi
 * model, khong goi mang.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { contentTokensV23, createV23Id, makeV23Scope } from './types';
import type { V23ProceduralSkill, V23SkillStatus, V23WorkflowAttempt } from './types';

/** Tuy chon procedural store. */
export interface V23ProceduralStoreOptions {
  /** Duong dan file JSON (khong co = chi RAM). */
  filePath?: string;
  /** So success toi thieu de promote (mac dinh 3). */
  minSuccessToPromote?: number;
  /** Ti le success toi thieu de promote (mac dinh 0.66). */
  minSuccessRateToPromote?: number;
  /** So luot rating toi thieu truoc khi xet deprecate (mac dinh 3). */
  minRatingsToDeprecate?: number;
  /** Ham lay thoi gian (test truyen clock co dinh). */
  now?: () => number;
}

/** Lich su chay cua mot workflow (noi bo). */
interface V23WorkflowHistory {
  workflow: string;
  attempts: V23WorkflowAttempt[];
}

/** Ban luu tren dia. */
interface V23ProceduralFileData {
  format: 'openbot-procedural-v23';
  version: 1;
  savedAt: number;
  skills: V23ProceduralSkill[];
  histories: V23WorkflowHistory[];
}

/** Ket qua ghi skill/attempt (co cau truc). */
export interface V23ProceduralWriteResult {
  ok: boolean;
  skill?: V23ProceduralSkill;
  error?: string;
}

/** Chuẩn hoa ten workflow thanh slug dung lam id. */
export function slugWorkflowV23(workflow: string): string {
  const slug = workflow
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'workflow';
}

/**
 * Store procedural memory: skills + lich su attempt theo workflow.
 */
export class V23ProceduralStore {
  private readonly skills = new Map<string, V23ProceduralSkill>();
  private readonly histories = new Map<string, V23WorkflowHistory>();
  private readonly filePath?: string;
  private readonly minSuccessToPromote: number;
  private readonly minSuccessRateToPromote: number;
  private readonly minRatingsToDeprecate: number;
  private readonly now: () => number;

  constructor(opts: V23ProceduralStoreOptions = {}) {
    this.filePath = opts.filePath;
    this.minSuccessToPromote = opts.minSuccessToPromote ?? 3;
    this.minSuccessRateToPromote = opts.minSuccessRateToPromote ?? 0.66;
    this.minRatingsToDeprecate = opts.minRatingsToDeprecate ?? 3;
    this.now = opts.now ?? Date.now;
    if (this.filePath && existsSync(this.filePath)) this.loadFromFile();
  }

  /** So skill (mac dinh chi dem active + candidate). */
  size(activeOnly = true): number {
    if (!activeOnly) return this.skills.size;
    let n = 0;
    for (const s of this.skills.values()) {
      if (s.status === 'active' || s.status === 'candidate') n += 1;
    }
    return n;
  }

  getSkill(id: string): V23ProceduralSkill | undefined {
    const found = this.skills.get(id);
    return found ? { ...found, steps: [...found.steps], toolsUsed: [...found.toolsUsed], scope: { ...found.scope } } : undefined;
  }

  listSkills(filter: { status?: V23SkillStatus; workflow?: string; limit?: number } = {}): V23ProceduralSkill[] {
    const out: V23ProceduralSkill[] = [];
    for (const skill of this.skills.values()) {
      if (filter.status && skill.status !== filter.status) continue;
      if (filter.workflow && skill.workflow !== filter.workflow) continue;
      out.push(skill);
    }
    out.sort((a, b) => b.successRate - a.successRate || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const limit = filter.limit ?? 0;
    return (limit > 0 ? out.slice(0, limit) : out).map((s) => ({
      ...s,
      steps: [...s.steps],
      toolsUsed: [...s.toolsUsed],
      scope: { ...s.scope },
    }));
  }

  /** Lich su attempt cua mot workflow (moi nhat truoc). */
  history(workflow: string): V23WorkflowAttempt[] {
    const h = this.histories.get(slugWorkflowV23(workflow));
    if (!h) return [];
    return [...h.attempts].sort((a, b) => b.ranAt - a.ranAt);
  }

  /**
   * Ghi mot attempt. Neu workflow chua co skill, tao skill o dang
   * `candidate` (steps = steps cua attempt dau tien thanh cong).
   * Neu attempt thanh cong voi steps khac skill hien tai va ti le
   * tot hon, skill tang version (steps moi). Tra skill hien tai
   * (hoac loi neu input sai).
   */
  recordAttempt(attempt: V23WorkflowAttempt): V23ProceduralWriteResult {
    const workflow = (attempt.workflow ?? '').trim();
    if (!workflow) return { ok: false, error: 'Thieu ten workflow.' };
    if (!Array.isArray(attempt.steps) || attempt.steps.length === 0) {
      return { ok: false, error: 'Workflow phai co it nhat 1 step.' };
    }
    if (attempt.outcome !== 'success' && attempt.outcome !== 'failure') {
      return { ok: false, error: 'outcome phai la success hoac failure.' };
    }
    const id = slugWorkflowV23(workflow);
    const now = this.now();
    const cleanSteps = attempt.steps.map((s) => s.trim()).filter(Boolean);
    const cleanTools = [...new Set((attempt.toolsUsed ?? []).map((t) => t.trim()).filter(Boolean))];
    const stored: V23WorkflowAttempt = {
      workflow,
      steps: cleanSteps,
      toolsUsed: cleanTools,
      outcome: attempt.outcome,
      durationMs: Math.max(0, attempt.durationMs ?? 0),
      ...(attempt.note ? { note: attempt.note } : {}),
      ...(attempt.scope ? { scope: attempt.scope } : {}),
      ranAt: attempt.ranAt ?? now,
    };
    let history = this.histories.get(id);
    if (!history) {
      history = { workflow, attempts: [] };
      this.histories.set(id, history);
    }
    history.attempts.push(stored);
    // Chi giu 100 attempt gan nhat moi workflow (tranh file phình).
    if (history.attempts.length > 100) {
      history.attempts = history.attempts.slice(-100);
    }

    const successCount = history.attempts.filter((a) => a.outcome === 'success').length;
    const totalCount = history.attempts.length;
    const successRate = totalCount === 0 ? 0 : successCount / totalCount;
    const avgDurationMs = Math.round(
      history.attempts.reduce((sum, a) => sum + a.durationMs, 0) / totalCount,
    );
    const existing = this.skills.get(id);
    if (!existing) {
      if (attempt.outcome !== 'success') {
        this.persist();
        return { ok: true, skill: undefined };
      }
      const skill: V23ProceduralSkill = {
        id,
        workflow,
        version: 1,
        status: 'candidate',
        steps: cleanSteps,
        toolsUsed: cleanTools,
        trigger: `Khi can ${workflow}`,
        successCount,
        totalCount,
        successRate: Math.round(successRate * 1000) / 1000,
        avgDurationMs,
        rating: 0,
        ratingCount: 0,
        scope: makeV23Scope(attempt.scope ?? {}),
        createdAt: now,
        updatedAt: now,
      };
      this.skills.set(id, skill);
      this.persist();
      return { ok: true, skill: this.getSkill(id) };
    }

    // Skill da co: cap nhat thong ke; cai tien steps neu attempt tot hon.
    const stepsChanged = JSON.stringify(cleanSteps) !== JSON.stringify(existing.steps);
    const improved = attempt.outcome === 'success' && stepsChanged && attempt.durationMs < existing.avgDurationMs;
    const updated: V23ProceduralSkill = {
      ...existing,
      successCount,
      totalCount,
      successRate: Math.round(successRate * 1000) / 1000,
      avgDurationMs,
      ...(improved
        ? {
            version: existing.version + 1,
            steps: cleanSteps,
            toolsUsed: [...new Set([...existing.toolsUsed, ...cleanTools])],
          }
        : {}),
      updatedAt: now,
    };
    this.skills.set(id, updated);
    this.persist();
    return { ok: true, skill: this.getSkill(id) };
  }

  /** Duyet skill candidate -> active (nguoi dung / he thong xac nhan). */
  approve(id: string): V23ProceduralWriteResult {
    const skill = this.skills.get(id);
    if (!skill) return { ok: false, error: `Khong co skill "${id}".` };
    if (skill.status === 'active') return { ok: true, skill: this.getSkill(id) };
    if (skill.status !== 'candidate') {
      return { ok: false, error: `Skill "${id}" o trang thai ${skill.status}, khong duyet duoc.` };
    }
    const updated: V23ProceduralSkill = { ...skill, status: 'active', updatedAt: this.now() };
    this.skills.set(id, updated);
    this.persist();
    return { ok: true, skill: this.getSkill(id) };
  }

  /** Cham diem skill 1..5 (trung binh chay). */
  rate(id: string, stars: number): V23ProceduralWriteResult {
    const skill = this.skills.get(id);
    if (!skill) return { ok: false, error: `Khong co skill "${id}".` };
    if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
      return { ok: false, error: 'rating phai trong [1, 5].' };
    }
    const ratingCount = skill.ratingCount + 1;
    const rating = Math.round(((skill.rating * skill.ratingCount + stars) / ratingCount) * 100) / 100;
    const updated: V23ProceduralSkill = { ...skill, rating, ratingCount, updatedAt: this.now() };
    this.skills.set(id, updated);
    this.persist();
    return { ok: true, skill: this.getSkill(id) };
  }

  /**
   * Xet deprecate: skill active/candidate bi ha cap khi (rating < 2
   * sau >= minRatings luot) hoac (success rate < 0.4 sau >= 5 lan
   * chay). Tra danh sach id vua deprecate.
   */
  reviewDeprecations(): string[] {
    const deprecated: string[] = [];
    for (const skill of this.skills.values()) {
      if (skill.status !== 'active' && skill.status !== 'candidate') continue;
      const badRating = skill.ratingCount >= this.minRatingsToDeprecate && skill.rating > 0 && skill.rating < 2;
      const badRate = skill.totalCount >= 5 && skill.successRate < 0.4;
      if (badRating || badRate) {
        this.skills.set(skill.id, { ...skill, status: 'deprecated', updatedAt: this.now() });
        deprecated.push(skill.id);
      }
    }
    if (deprecated.length > 0) this.persist();
    return deprecated;
  }

  /** Dat lai trigger (mo ta khi nao dung skill). */
  setTrigger(id: string, trigger: string): V23ProceduralWriteResult {
    const skill = this.skills.get(id);
    if (!skill) return { ok: false, error: `Khong co skill "${id}".` };
    const clean = trigger.trim();
    if (!clean) return { ok: false, error: 'trigger rong.' };
    const updated: V23ProceduralSkill = { ...skill, trigger: clean, updatedAt: this.now() };
    this.skills.set(id, updated);
    this.persist();
    return { ok: true, skill: this.getSkill(id) };
  }

  /** Retire skill (ngung dung, giu lich su). */
  retire(id: string): V23ProceduralWriteResult {
    const skill = this.skills.get(id);
    if (!skill) return { ok: false, error: `Khong co skill "${id}".` };
    const updated: V23ProceduralSkill = { ...skill, status: 'retired', updatedAt: this.now() };
    this.skills.set(id, updated);
    this.persist();
    return { ok: true, skill: this.getSkill(id) };
  }

  /**
   * Tim skill theo tu khoa: overlap token giua query va
   * workflow + trigger + steps. Chi tra skill active/candidate
   * (mac dinh), sap theo overlap giam dan.
   */
  searchSkills(query: string, limit = 5): { skill: V23ProceduralSkill; score: number }[] {
    const queryTokens = new Set(contentTokensV23(query));
    if (queryTokens.size === 0) return [];
    const out: { skill: V23ProceduralSkill; score: number }[] = [];
    for (const skill of this.skills.values()) {
      if (skill.status !== 'active' && skill.status !== 'candidate') continue;
      const haystack = contentTokensV23(
        `${skill.workflow} ${skill.trigger} ${skill.steps.join(' ')} ${skill.toolsUsed.join(' ')}`,
      );
      const haySet = new Set(haystack);
      let hits = 0;
      for (const token of queryTokens) if (haySet.has(token)) hits += 1;
      if (hits === 0) continue;
      const score = Math.round((hits / queryTokens.size) * 100) / 100;
      out.push({ skill: this.getSkill(skill.id) as V23ProceduralSkill, score });
    }
    out.sort((a, b) => b.score - a.score || b.skill.successRate - a.skill.successRate);
    return out.slice(0, Math.max(0, limit));
  }

  /** Xuat JSON (backup). */
  exportJson(): string {
    const data: V23ProceduralFileData = {
      format: 'openbot-procedural-v23',
      version: 1,
      savedAt: this.now(),
      skills: [...this.skills.values()].sort((a, b) => a.id.localeCompare(b.id)),
      histories: [...this.histories.values()].sort((a, b) => a.workflow.localeCompare(b.workflow)),
    };
    return JSON.stringify(data, null, 2);
  }

  /** Nhap JSON (bo qua skill loi). */
  importJson(json: string): { imported: number; skipped: number } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch {
      return { imported: 0, skipped: 0 };
    }
    const data = parsed as Partial<V23ProceduralFileData>;
    if (!Array.isArray(data.skills)) return { imported: 0, skipped: 0 };
    let imported = 0;
    let skipped = 0;
    for (const raw of data.skills) {
      if (!raw || typeof raw.id !== 'string' || !raw.id || !Array.isArray(raw.steps)) {
        skipped += 1;
        continue;
      }
      this.skills.set(raw.id, raw as V23ProceduralSkill);
      imported += 1;
    }
    if (Array.isArray(data.histories)) {
      for (const h of data.histories) {
        if (h && typeof h.workflow === 'string' && Array.isArray(h.attempts)) {
          this.histories.set(slugWorkflowV23(h.workflow), h as V23WorkflowHistory);
        }
      }
    }
    if (imported > 0) this.persist();
    return { imported, skipped };
  }

  persist(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      writeFileSync(tmp, this.exportJson(), 'utf8');
      renameSync(tmp, this.filePath);
    } catch {
      // Ghi file loi khong lam mat du lieu RAM.
    }
  }

  loadFromFile(): { loaded: number } {
    if (!this.filePath || !existsSync(this.filePath)) return { loaded: 0 };
    let raw = '';
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return { loaded: 0 };
    }
    this.skills.clear();
    this.histories.clear();
    const res = this.importJson(raw);
    return { loaded: res.imported };
  }

  /** Duong dan file luu mac dinh trong workspace (cho tool). */
  static defaultFilePath(workspaceDir: string): string {
    return join(workspaceDir, 'procedural-v23.json');
  }

  /** Tao id skill tam (khi can tham chieu truoc khi co workflow). */
  static tempId(workflow: string, now = Date.now()): string {
    return createV23Id(`skill-${slugWorkflowV23(workflow)}`, now);
  }
}
