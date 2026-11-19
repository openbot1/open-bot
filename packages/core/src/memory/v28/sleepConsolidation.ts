/**
 * Memory v28 — sleep-time consolidation, client-side subagent
 * (v1.44, Doi T1).
 *
 * Y tuong hoc tu Letta v0.16.7 sleep-time agents (survey v144
 * muc 2, chi y tuong, KHONG copy code/text/tai san): agent
 * consolidation chay nhu SUBAGENT PHIA CLIENT khi user ranh —
 * gom, khu trung, tom tat memory trong luc nghi — khong bao
 * gio chen vao turn dang chay. Ke thua sleepAgent v0.97 (chay
 * sau turn, mac dinh TAT, khong chay cho bot mock/CLI) va
 * consolidate v0.96 (dedupe + conflict + promote vao block).
 *
 * Mot run lam gi (hoan toan deterministic, khong goi model,
 * khong goi mang):
 *  1. Quet episode moi: tach cau, pattern rule (so thich,
 *     danh tinh, noi o, cong viec, ...) trich candidate fact.
 *  2. Khu trung: candidate giong fact active san co (Jaccard
 *     >= nguong) hoac giong candidate khac trong cung run thi
 *     bo qua — ghi ro vao report.
 *  3. Xung dot: candidate cung (subject, predicate) nhung
 *     object khac fact active -> SUPERSEDE fact cu (invalidate,
 *     giu lai) roi moi them fact moi.
 *  4. Tom tat: gom candidate theo subject, viet 1 dong tom tat
 *     moi nhom, append vao block tom tat (mac dinh `human`)
 *     duoi muc `## Sleep consolidation <ngay>` — block nay
 *     duoc commit qua git store nhu moi lan ghi khac.
 *  5. Bao cao day du: quet/trich/trung/them/vo hieu, loi gap,
 *     ghi chu doc duoc tung quyet dinh.
 *
 * Dieu kien chay (shouldRunNow): config bat + du idle +
 * (neu onlyInQuietHours thi phai trong quiet hours) + khong
 * co bot nao dang chay turn + bot nam trong allowedBotIds
 * (neu danh sach nay khong rong). `dryRun` chi trich xuat va
 * bao cao, khong ghi gi.
 */
import { V28FactStore } from './invalidation';
import { V28GitBlockStore } from './gitStore';
import { V28SharedBlockRegistry } from './sharedBlocks';
import {
  DEFAULT_V28_SLEEP_CONFIG,
  isQuietHoursV28,
  jaccardV28,
  makeV28Id,
  normalizeTextV28,
  parseIsoV28,
  tokenizeV28,
  V28_LIMITS,
  type V28SleepCandidate,
  type V28SleepConfig,
  type V28SleepEpisode,
  type V28SleepRunReport,
} from './types';

/** Phu thuoc cua sleep consolidator. */
export interface V28SleepDeps {
  factStore: V28FactStore;
  gitStore: V28GitBlockStore;
  registry: V28SharedBlockRegistry;
}

/** Trang thai luc quyet dinh co chay sleep run khong. */
export interface V28SleepIdleState {
  /** Thoi diem hien tai. */
  now: Date;
  /** So phut ke tu lan user/bot tuong tac cuoi. */
  idleMinutes: number;
  /** So bot dang chay turn luc nay (0 = khong ai ban). */
  activeBots: number;
  /** Thoi diem sleep run gan nhat (null = chua chay bao gio). */
  lastRunAt: string | null;
  /** Bot dinh chay run nay. */
  botId: string;
}

/** Ket qua kiem tra dieu kien chay. */
export interface V28ShouldRunResult {
  run: boolean;
  reason: string;
}

/** Mot pattern trich xuat: regex + cach map capture ve (subject, predicate, object). */
interface V28ExtractPattern {
  name: string;
  /** Regex phai co 2 nhom: (subject) (object). Predicate lay tu ten pattern. */
  regex: RegExp;
  predicate: string;
  confidence: number;
}

/**
 * Pattern trich xuat deterministic (EN + VI). Subject mac dinh
 * la `user` khi cau noi ve "I/toi" — nguoi dung la chu the cua
 * memory ca nhan. Khong dung model, chi regex tren cau da tach.
 */
const V28_EXTRACT_PATTERNS: V28ExtractPattern[] = [
  { name: 'likes-en', regex: /\bI (?:really )?(?:like|love|enjoy|prefer)\s+(.+)/i, predicate: 'likes', confidence: 0.9 },
  { name: 'likes-vi', regex: /\btôi (?:rất )?(?:thích|yêu|mê)\s+(.+)/i, predicate: 'likes', confidence: 0.9 },
  { name: 'dislikes-en', regex: /\bI (?:really )?(?:hate|dislike|don't like|do not like)\s+(.+)/i, predicate: 'dislikes', confidence: 0.9 },
  { name: 'dislikes-vi', regex: /\btôi (?:rất )?(?:ghét|không thích|chẳng thích)\s+(.+)/i, predicate: 'dislikes', confidence: 0.9 },
  { name: 'name-en', regex: /\bmy name is\s+([A-ZÀ-Ỹ][\wÀ-ỹ' -]+)/i, predicate: 'name-is', confidence: 0.95 },
  { name: 'name-vi', regex: /\btên tôi là\s+([A-ZÀ-Ỹ][\wÀ-ỹ' -]+)/i, predicate: 'name-is', confidence: 0.95 },
  { name: 'lives-en', regex: /\bI live in\s+(.+)/i, predicate: 'lives-in', confidence: 0.9 },
  { name: 'lives-vi', regex: /\btôi (?:đang )?sống (?:ở|tại)\s+(.+)/i, predicate: 'lives-in', confidence: 0.9 },
  { name: 'works-en', regex: /\bI work (?:as|at)\s+(.+)/i, predicate: 'works-as', confidence: 0.85 },
  { name: 'works-vi', regex: /\btôi làm (?:việc|nghề)?\s*(.+)/i, predicate: 'works-as', confidence: 0.85 },
  { name: 'prefers-en', regex: /\bI prefer\s+(.+?)\s+over\s+(.+)/i, predicate: 'prefers', confidence: 0.85 },
  { name: 'speaks-en', regex: /\bI speak\s+(.+)/i, predicate: 'speaks', confidence: 0.85 },
  { name: 'speaks-vi', regex: /\btôi nói (?:được )?\s*(.+)/i, predicate: 'speaks', confidence: 0.85 },
  { name: 'uses-en', regex: /\bI use\s+(.+?)\s+for\s+(.+)/i, predicate: 'uses-for', confidence: 0.8 },
  { name: 'birthday-en', regex: /\bmy birthday is\s+(.+)/i, predicate: 'birthday-is', confidence: 0.95 },
  { name: 'birthday-vi', regex: /\bsinh nhật (?:của )?tôi (?:là|vào)\s+(.+)/i, predicate: 'birthday-is', confidence: 0.95 },
];

/** Tach text thanh cau (tach theo dau cham/cham than/cham hoi/xuong dong). */
export function splitSentencesMemoryV28(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim().replace(/[.!?]+$/, '').trim())
    .filter((s) => s.length >= 8 && tokenizeV28(s).length >= 3);
}

/**
 * Lam sach object trich duoc: cat bo menh de moi bat dau sau
 * "and I / và tôi ..." (regex tham `.+` nuot ca cau) va cat bo
 * trang ngu thoi gian o cuoi ("now", "today", "bây giờ", ...).
 * Khong cat "and" binh thuong trong danh sach ("pho and bun cha"
 * giu nguyen vi ve sau khong phai chu ngu moi).
 */
export function cleanObjectV28(object: string): string {
  let cleaned = object.trim();
  cleaned = cleaned.split(/\s+and\s+(?=(?:I|my|we|you|he|she|they)\b)/i)[0] as string;
  cleaned = cleaned.split(/\s+và\s+(?=(?:tôi|mình|tớ)\b)/i)[0] as string;
  cleaned = cleaned
    .replace(/\s+(now|today|currently|at the moment|hiện tại|bây giờ|lúc này)$/i, '')
    .replace(/[,;:]+$/, '')
    .trim();
  return cleaned;
}

/**
 * Trich candidate fact tu 1 episode (pure — khong ghi gi).
 * Mot cau co the chua nhieu fact ("I like pho and I live in
 * Saigon" -> likes + lives-in): tach cau thanh menh de o
 * "and I / và tôi ..." truoc khi match (regex tham `.+` se
 * nuot het cau neu khong tach), roi quet tiep phan con lai
 * cua menh de sau moi match; moi pattern chi khop 1 lan/menh de.
 */
export function extractSleepCandidatesV28(episode: V28SleepEpisode): V28SleepCandidate[] {
  const out: V28SleepCandidate[] = [];
  const clauses = splitSentencesMemoryV28(episode.text).flatMap((sentence) =>
    sentence.split(/\s+and\s+(?=(?:I|you|he|she|we|they|my)\b|(?:tôi|mình|tớ)\b)/i),
  );
  for (const sentence of clauses) {
    let rest = sentence;
    for (let guard = 0; guard < 8 && rest.trim().length > 0; guard += 1) {
      let matched = false;
      for (const pattern of V28_EXTRACT_PATTERNS) {
        const match = pattern.regex.exec(rest);
        if (!match) continue;
        const rawObject = (match[1] ?? '').trim();
        if (!rawObject || tokenizeV28(rawObject).length === 0) break;
        // Pattern `prefers ... over ...`: object gom ca 2 ve.
        const combined =
          match[2] !== undefined ? `${rawObject} over ${match[2].trim()}` : rawObject;
        const object = cleanObjectV28(combined);
        if (!object || tokenizeV28(object).length === 0) break;
        out.push({
          subject: 'user',
          predicate: pattern.predicate,
          object,
          text: sentence,
          confidence: pattern.confidence,
          episodeId: episode.id,
          pattern: pattern.name,
        });
        // Quet tiep phan sau match (co the con fact khac trong cung cau).
        rest = rest.slice((match.index ?? 0) + match[0].length);
        matched = true;
        break;
      }
      if (!matched) break;
    }
  }
  return out;
}

/** Khu trung trong batch: giu candidate dau tien moi nhom giong nhau. */
export function dedupeSleepCandidatesV28(
  candidates: V28SleepCandidate[],
  threshold: number,
): { kept: V28SleepCandidate[]; duplicates: V28SleepCandidate[] } {
  const kept: V28SleepCandidate[] = [];
  const duplicates: V28SleepCandidate[] = [];
  for (const candidate of candidates) {
    const duplicate = kept.some(
      (k) =>
        normalizeTextV28(k.subject) === normalizeTextV28(candidate.subject) &&
        normalizeTextV28(k.predicate) === normalizeTextV28(candidate.predicate) &&
        jaccardV28(tokenizeV28(k.text), tokenizeV28(candidate.text)) >= threshold,
    );
    if (duplicate) duplicates.push(candidate);
    else kept.push(candidate);
  }
  return { kept, duplicates };
}

/** Gom candidate theo subject -> 1 dong tom tat moi nhom (extractive). */
export function summarizeSleepCandidatesV28(candidates: V28SleepCandidate[]): string[] {
  const bySubject = new Map<string, V28SleepCandidate[]>();
  for (const candidate of candidates) {
    const list = bySubject.get(candidate.subject) ?? [];
    list.push(candidate);
    bySubject.set(candidate.subject, list);
  }
  const lines: string[] = [];
  for (const [subject, list] of [...bySubject.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const facts = list
      .map((c) => `${c.predicate} ${c.object}`)
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .sort();
    lines.push(`- ${subject}: ${facts.join('; ')}.`);
  }
  return lines;
}

/** Tieu de muc tom tat trong block (theo ngay chay). */
export function sleepSummaryHeadingV28(at: Date): string {
  return `## Sleep consolidation ${at.toISOString().slice(0, 10)}`;
}

/**
 * Kiem tra dieu kien chay sleep run. Thu tu kiem tra: config
 * bat -> bot duoc phep -> khong co bot dang chay -> du idle ->
 * quiet hours (neu bat). Ly do luon ghi ro de UI hien dung.
 */
export function shouldSleepRunNowV28(config: V28SleepConfig, state: V28SleepIdleState): V28ShouldRunResult {
  if (!config.enabled) return { run: false, reason: 'sleep consolidation dang tat (enabled=false)' };
  if (config.allowedBotIds.length > 0 && !config.allowedBotIds.includes(state.botId)) {
    return { run: false, reason: `bot "${state.botId}" khong nam trong allowedBotIds` };
  }
  if (state.activeBots > 0) {
    return { run: false, reason: `${state.activeBots} bot dang chay turn — doi ranh moi chay` };
  }
  if (state.idleMinutes < config.minIdleMinutes) {
    return {
      run: false,
      reason: `moi idle ${state.idleMinutes} phut, can toi thieu ${config.minIdleMinutes} phut`,
    };
  }
  if (config.onlyInQuietHours && !isQuietHoursV28(config, state.now)) {
    return {
      run: false,
      reason: `ngoai quiet hours (${config.quietHoursStart}:00-${config.quietHoursEnd}:00)`,
    };
  }
  if (state.lastRunAt) {
    const lastMs = parseIsoV28(state.lastRunAt);
    if (lastMs !== null && state.now.getTime() - lastMs < config.minIdleMinutes * 60_000) {
      return { run: false, reason: 'vua chay sleep run gan day, chua du khoang cach' };
    }
  }
  return { run: true, reason: 'du dieu kien: da bat, ranh, khong co bot dang chay' };
}

/** Thoi diem chay ke tiep (dung de UI hien lich). */
export function nextSleepRunAtV28(config: V28SleepConfig, lastRunAt: string | null, now: Date): Date {
  const base = lastRunAt ? parseIsoV28(lastRunAt) ?? now.getTime() : now.getTime();
  const next = new Date(Math.max(now.getTime(), base + config.minIdleMinutes * 60_000));
  if (config.onlyInQuietHours && !isQuietHoursV28(config, next)) {
    // Doi den gio bat dau quiet hours tiep theo.
    const candidate = new Date(next);
    candidate.setHours(config.quietHoursStart, 0, 0, 0);
    if (candidate.getTime() <= next.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }
  return next;
}

/**
 * Sleep consolidator — subagent phia client.
 *
 * Chay khi ranh (do caller quyet dinh thoi diem qua
 * shouldSleepRunNowV28 — class nay khong tu dat timer, de
 * host (desktop app) dieu phoi). `consolidate()` la diem vao
 * duy nhat: trich -> khu trung -> xu ly xung dot -> ghi fact
 * -> promote tom tat vao block -> bao cao.
 */
export class V28SleepConsolidator {
  readonly factStore: V28FactStore;
  readonly gitStore: V28GitBlockStore;
  readonly registry: V28SharedBlockRegistry;
  config: V28SleepConfig;
  lastRun: V28SleepRunReport | null = null;
  runsTotal = 0;

  constructor(deps: V28SleepDeps, config: Partial<V28SleepConfig> = {}) {
    this.factStore = deps.factStore;
    this.gitStore = deps.gitStore;
    this.registry = deps.registry;
    this.config = { ...DEFAULT_V28_SLEEP_CONFIG, ...config };
  }

  /** Doi cau hinh (chi giu cac key hop le, bo qua key la). */
  updateConfig(patch: Partial<V28SleepConfig>): V28SleepConfig {
    const next: V28SleepConfig = { ...this.config };
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch.quietHoursStart === 'number') {
      next.quietHoursStart = Math.max(0, Math.min(23, Math.floor(patch.quietHoursStart)));
    }
    if (typeof patch.quietHoursEnd === 'number') {
      next.quietHoursEnd = Math.max(0, Math.min(23, Math.floor(patch.quietHoursEnd)));
    }
    if (typeof patch.onlyInQuietHours === 'boolean') next.onlyInQuietHours = patch.onlyInQuietHours;
    if (typeof patch.minIdleMinutes === 'number') {
      next.minIdleMinutes = Math.max(1, Math.floor(patch.minIdleMinutes));
    }
    if (typeof patch.maxFactsPerRun === 'number') {
      next.maxFactsPerRun = Math.max(1, Math.min(V28_LIMITS.maxFactsPerRun, Math.floor(patch.maxFactsPerRun)));
    }
    if (typeof patch.dedupeThreshold === 'number') {
      next.dedupeThreshold = Math.max(0, Math.min(1, patch.dedupeThreshold));
    }
    if (typeof patch.summaryBlockLabel === 'string' && patch.summaryBlockLabel.trim()) {
      next.summaryBlockLabel = patch.summaryBlockLabel.trim();
    }
    if (Array.isArray(patch.allowedBotIds)) next.allowedBotIds = [...patch.allowedBotIds];
    this.config = next;
    return { ...next };
  }

  /**
   * Chay 1 lan consolidation tren cac episode moi.
   *
   * `dryRun=true` chi trich xuat + bao cao, khong ghi fact nao,
   * khong sua block nao. Loi trong tung buoc duoc gom vao
   * report.errors thay vi throw giua chung.
   */
  consolidate(
    episodes: V28SleepEpisode[],
    opts: { dryRun?: boolean; botId?: string; now?: Date } = {},
  ): V28SleepRunReport {
    const startedAt = new Date();
    const runId = makeV28Id('sleep');
    const botId = opts.botId ?? '';
    const dryRun = opts.dryRun === true;
    const notes: string[] = [];
    const errors: string[] = [];
    const report: V28SleepRunReport = {
      runId,
      botId,
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      durationMs: 0,
      dryRun,
      episodesScanned: 0,
      candidatesExtracted: 0,
      duplicatesSkipped: 0,
      factsAdded: 0,
      factsInvalidated: 0,
      factsSuperseded: 0,
      summaryPromoted: false,
      summaryBlockLabel: this.config.summaryBlockLabel,
      errors,
      notes,
    };
    const finish = (): V28SleepRunReport => {
      const finishedAt = new Date();
      report.finishedAt = finishedAt.toISOString();
      report.durationMs = finishedAt.getTime() - startedAt.getTime();
      if (!dryRun) {
        this.lastRun = { ...report };
        this.runsTotal += 1;
      }
      return report;
    };

    const scanned = episodes.slice(0, V28_LIMITS.maxEpisodesPerRun);
    report.episodesScanned = scanned.length;

    // 1. Trich candidate.
    let candidates: V28SleepCandidate[] = [];
    for (const episode of scanned) {
      try {
        candidates.push(...extractSleepCandidatesV28(episode));
      } catch (error) {
        errors.push(`trich xuat episode ${episode.id} loi: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    report.candidatesExtracted = candidates.length;
    if (candidates.length === 0) {
      notes.push('khong trich duoc candidate nao tu episode moi.');
      return finish();
    }

    // 2. Khu trung trong batch.
    const batchDeduped = dedupeSleepCandidatesV28(candidates, this.config.dedupeThreshold);
    candidates = batchDeduped.kept;
    report.duplicatesSkipped += batchDeduped.duplicates.length;
    if (batchDeduped.duplicates.length > 0) {
      notes.push(`bo ${batchDeduped.duplicates.length} candidate trung nhau trong cung run.`);
    }

    // 3. Khu trung voi fact active san co + phat hien xung dot.
    const toAdd: V28SleepCandidate[] = [];
    const toSupersede: Array<{ oldId: string; candidate: V28SleepCandidate }> = [];
    for (const candidate of candidates) {
      const duplicates = this.factStore.findDuplicates(candidate.text, this.config.dedupeThreshold);
      if (duplicates.length > 0) {
        report.duplicatesSkipped += 1;
        notes.push(`bo "${candidate.text}" — trung fact ${duplicates[0]?.fact.id}.`);
        continue;
      }
      const conflicts = this.factStore
        .factsForSubjectPredicate(candidate.subject, candidate.predicate)
        .filter(
          (f) =>
            f.status === 'active' &&
            normalizeTextV28(f.object) !== normalizeTextV28(candidate.object),
        );
      if (conflicts.length > 0) {
        // Xung dot: chi supersede fact giong nhat (confidence cao nhat).
        const old = conflicts.sort((a, b) => b.confidence - a.confidence)[0];
        if (old) toSupersede.push({ oldId: old.id, candidate });
        continue;
      }
      toAdd.push(candidate);
    }

    // Gioi han so fact ghi trong 1 run.
    const budget = this.config.maxFactsPerRun;
    const planned = toAdd.length + toSupersede.length;
    if (planned > budget) {
      notes.push(`vuot budget ${budget} fact/run: chi xu ly ${budget}/${planned} candidate.`);
    }
    const addSlice = toAdd.slice(0, budget);
    const supersedeSlice = toSupersede.slice(0, Math.max(0, budget - addSlice.length));
    if (dryRun) {
      report.factsAdded = addSlice.length;
      report.factsSuperseded = supersedeSlice.length;
      notes.push(`dry-run: se them ${addSlice.length} fact, supersede ${supersedeSlice.length} fact (chua ghi).`);
      return finish();
    }

    // 4. Ghi fact moi.
    const addedCandidates: V28SleepCandidate[] = [];
    for (const candidate of addSlice) {
      const added = this.factStore.addFact({
        subject: candidate.subject,
        predicate: candidate.predicate,
        object: candidate.object,
        text: candidate.text,
        source: 'sleep-agent',
        episodeId: candidate.episodeId,
        botId,
        confidence: candidate.confidence,
        tags: ['sleep-consolidation', `pattern:${candidate.pattern}`],
      });
      if (added.ok) {
        report.factsAdded += 1;
        addedCandidates.push(candidate);
      } else {
        errors.push(`them fact "${candidate.text}" loi: ${added.error}`);
      }
    }

    // 5. Supersede fact cu xung dot.
    for (const { oldId, candidate } of supersedeSlice) {
      const result = this.factStore.supersedeFact(
        oldId,
        {
          subject: candidate.subject,
          predicate: candidate.predicate,
          object: candidate.object,
          text: candidate.text,
          source: 'sleep-agent',
          episodeId: candidate.episodeId,
          botId,
          confidence: candidate.confidence,
          tags: ['sleep-consolidation', `pattern:${candidate.pattern}`],
        },
        { by: 'sleep-agent', reason: 'superseded' },
      );
      if (result.ok) {
        report.factsSuperseded += 1;
        report.factsInvalidated += 1;
        addedCandidates.push(candidate);
        notes.push(`supersede fact ${oldId}: "${candidate.text}".`);
      } else {
        errors.push(`supersede fact ${oldId} loi: ${result.error}`);
      }
    }

    // 6. Promote tom tat vao block (append muc theo ngay).
    if (addedCandidates.length > 0) {
      const summaryLines = summarizeSleepCandidatesV28(addedCandidates);
      const label = this.config.summaryBlockLabel;
      const existing = this.gitStore.readBlock(label);
      const heading = sleepSummaryHeadingV28(startedAt);
      const section = `${heading}\n${summaryLines.join('\n')}\n`;
      const base = existing ? existing.content : '';
      const nextContent = base.includes(heading)
        ? base
        : `${base}${base && !base.endsWith('\n') ? '\n' : ''}${base ? '\n' : ''}${section}`;
      if (nextContent !== base) {
        const written = this.gitStore.writeBlock(label, nextContent, {
          actor: 'sleep-agent',
          message: `sleep consolidation ${runId} (+${addedCandidates.length} facts)`,
          kind: existing?.meta.kind ?? 'human',
          description: existing?.meta.description ?? 'Tom tat boi sleep consolidation',
          scope: existing?.meta.scope ?? 'user',
          ownerBotId: existing?.meta.ownerBotId ?? botId,
        });
        if (written.ok) {
          report.summaryPromoted = true;
          notes.push(`da promote tom tat vao block "${label}" (v${written.value.version}).`);
        } else {
          errors.push(`promote tom tat vao block "${label}" loi: ${written.error}`);
        }
      } else {
        notes.push(`block "${label}" da co muc tom tat ngay ${startedAt.toISOString().slice(0, 10)} — khong ghi them.`);
      }
    }

    if (report.factsAdded === 0 && report.factsSuperseded === 0) {
      notes.push('khong co fact moi nao duoc ghi trong run nay.');
    }
    return finish();
  }
}
