/**
 * Memory v22 — Patterns: tong hop pattern lap lai thanh fact ben
 * (v1.37, Doi T1).
 *
 * Y tuong (Mem0 Dream "tong hop pattern lap lai thanh fact ben"
 * + Anthropic Dreams "sua ghi chu sai, xay representation"):
 * mot quan sat xuat hien mot lan co the la noise; cung mot
 * dieu lap lai o nhieu session / nhieu lan quan sat thi dang
 * tin — dream tong hop no thanh MỘT fact ben kind `pattern`,
 * confidence duoc boost theo so session, nguon + session hop
 * nhat lai de truy vet.
 *
 * Hai co che phat hien (xac dinh, khong can model):
 *  1. LAP TEXT: cung text chuan hoa xuat hien o >=
 *     `patternMinObservations` lan quan sat (dem theo so fact
 *     goc, khong phai so session) va >= `patternMinSessions`
 *     session khac nhau.
 *  2. LAP TOPIC+VALUE: cung topic + value lap lai o nhieu
 *     session (vd user noi thich ca phe o 3 session khac nhau,
 *     bang 3 cach dien dat khac nhau).
 *
 * Pattern fact co text tong hop dang:
 *   `Pattern (N quan sat, M session): <text dai dien>`
 * va luu `patternKey` trong tag (`pattern:<key>`) de lan dream
 * sau nhan ra pattern cu ma CAP NHAT (tang version, refresh
 * so lieu) thay vi tao trung. Fact goc KHONG bi xoa — van
 * active de truy vet; pattern chi la lop tong hop ben tren.
 */
import type { V22DreamChange, V22DreamFact } from './types';
import { V22_DREAM_DEFAULT_CONFIG, V22_MAX_PATTERN_CONFIDENCE } from './types';
import { normalizeDreamTextV22 } from './dedupe';
import { normalizeTopicV22, normalizeValueV22, type V22DreamStore } from './store';

/** Tuy chon tong hop pattern. */
export interface V22PatternOptions {
  /** So session toi thieu de tong hop. Mac dinh 2. */
  patternMinSessions?: number;
  /** So lan quan sat toi thieu de tong hop. Mac dinh 3. */
  patternMinObservations?: number;
  /** Muc boost confidence moi session them (mac dinh 0.05). */
  sessionBoost?: number;
  /** Confidence toi da cua pattern fact. Mac dinh 0.95. */
  maxConfidence?: number;
  /** Chi xet fact active (mac dinh true). */
  onlyActive?: boolean;
  /** So fact toi da xet trong mot lan. */
  maxFacts?: number;
  /** Epoch ms ghi change (mac dinh Date.now()). */
  now?: number;
}

export const V22_PATTERN_DEFAULTS: Required<
  Pick<V22PatternOptions, 'sessionBoost' | 'maxConfidence'>
> = {
  sessionBoost: 0.05,
  maxConfidence: V22_MAX_PATTERN_CONFIDENCE,
};

/** Mot nhom quan sat lap lai du dieu kien tong hop. */
export interface V22PatternGroup {
  /** Khoa nhan dang pattern (on dinh giua cac lan dream). */
  patternKey: string;
  /** Co che phat hien: lap text hay lap topic+value. */
  mechanism: 'repeat_text' | 'repeat_topic_value';
  /** Text dai dien (fact manh nhat trong nhom). */
  representativeText: string;
  /** Topic (khi co). */
  topic?: string;
  /** Value (khi co). */
  value?: string;
  /** Cac fact goc trong nhom. */
  members: V22DreamFact[];
  /** Tong so lan quan sat (tong so cap fact/session — xem buildGroup). */
  observations: number;
  /** So session khac nhau. */
  sessions: number;
  /** Session ids (sap xep). */
  sessionIds: string[];
  /** Confidence de xuat cho pattern fact. */
  confidence: number;
  /** Pattern fact da ton tai (de cap nhat thay vi tao moi). */
  existingPattern?: V22DreamFact;
}

/** Ket qua mot pass tong hop pattern. */
export interface V22PatternResult {
  groups: V22PatternGroup[];
  created: V22DreamFact[];
  updated: V22DreamFact[];
  changes: V22DreamChange[];
  skipped: string[];
}

/** Tag danh dau pattern fact + khoa cua no. */
export function patternTagV22(patternKey: string): string {
  return `pattern:${patternKey}`;
}

/** Trich patternKey tu tag cua mot fact (undefined neu khong phai pattern). */
export function patternKeyOfFactV22(fact: V22DreamFact): string | undefined {
  const tag = fact.tags.find((t) => t.startsWith('pattern:'));
  return tag ? tag.slice('pattern:'.length) : undefined;
}

/**
 * Tim cac nhom lap lai du dieu kien tong hop. Nhom duoc xet tu
 * fact active (tru ca pattern fact cu — pattern khong tong hop
 * tu pattern), gom theo text chuan hoa truoc, roi theo
 * topic+value cho nhung fact con lai chua vao nhom text.
 */
export function findPatternGroupsV22(
  store: V22DreamStore,
  options: V22PatternOptions = {},
): V22PatternGroup[] {
  const minSessions = options.patternMinSessions ?? V22_DREAM_DEFAULT_CONFIG.patternMinSessions;
  const minObservations = options.patternMinObservations ?? V22_DREAM_DEFAULT_CONFIG.patternMinObservations;
  const sessionBoost = options.sessionBoost ?? V22_PATTERN_DEFAULTS.sessionBoost;
  const maxConfidence = options.maxConfidence ?? V22_PATTERN_DEFAULTS.maxConfidence;
  const onlyActive = options.onlyActive ?? true;
  const maxFacts = options.maxFacts ?? V22_DREAM_DEFAULT_CONFIG.maxFactsPerDream;
  const pool = store
    .list(onlyActive ? { status: 'active' } : {})
    .filter((f) => f.kind !== 'pattern')
    .slice(0, maxFacts);
  const existingPatterns = store.list({ status: 'active', kind: 'pattern' });
  const patternByKey = new Map<string, V22DreamFact>();
  for (const p of existingPatterns) {
    const key = patternKeyOfFactV22(p);
    if (key) patternByKey.set(key, p);
  }
  const groups: V22PatternGroup[] = [];
  const grouped = new Set<string>();

  const buildGroup = (
    patternKey: string,
    mechanism: V22PatternGroup['mechanism'],
    members: V22DreamFact[],
    topic?: string,
    value?: string,
  ): V22PatternGroup | undefined => {
    const sessionIds = [...new Set(members.flatMap((m) => m.sessionIds))].sort();
    const sessions = sessionIds.length;
    // So lan quan sat = tong so (fact, session) — fact sau dedupe
    // van giu sessionIds cua cac ban goc no da gop, nen mot keeper
    // quan sat o 3 session van dem la 3 quan sat (khong mat
    // pattern chi vi dedupe chay truoc). Fact khong ghi session
    // thi dem la 1 quan sat.
    const observations = members.reduce((n, m) => n + Math.max(1, m.sessionIds.length), 0);
    if (sessions < minSessions || observations < minObservations) return undefined;
    const sorted = [...members].sort((a, b) => b.confidence - a.confidence || b.observedAt - a.observedAt);
    const base = sorted[0].confidence;
    const confidence = Math.min(maxConfidence, base + sessionBoost * Math.max(0, sessions - 1));
    return {
      patternKey,
      mechanism,
      representativeText: sorted[0].text,
      ...(topic !== undefined ? { topic } : {}),
      ...(value !== undefined ? { value } : {}),
      members: sorted,
      observations,
      sessions,
      sessionIds,
      confidence,
      ...(patternByKey.get(patternKey) ? { existingPattern: patternByKey.get(patternKey) as V22DreamFact } : {}),
    };
  };

  // 1. Lap text: cung text chuan hoa.
  const byText = new Map<string, V22DreamFact[]>();
  for (const fact of pool) {
    const key = normalizeDreamTextV22(fact.text);
    if (!key) continue;
    const list = byText.get(key) ?? [];
    list.push(fact);
    byText.set(key, list);
  }
  for (const [normText, members] of [...byText.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const obsCount = members.reduce((n, m) => n + Math.max(1, m.sessionIds.length), 0);
    if (obsCount < minObservations) continue;
    const patternKey = `text:${normText.slice(0, 80).replace(/\s+/g, '_')}`;
    const group = buildGroup(patternKey, 'repeat_text', members);
    if (!group) continue;
    groups.push(group);
    for (const m of members) grouped.add(m.id);
  }

  // 2. Lap topic+value: cung topic + value, dien dat khac nhau.
  const byTopicValue = new Map<string, V22DreamFact[]>();
  for (const fact of pool) {
    if (grouped.has(fact.id)) continue;
    if (typeof fact.topic !== 'string' || typeof fact.value !== 'string') continue;
    if (!fact.topic.trim() || !fact.value.trim()) continue;
    const key = `${normalizeTopicV22(fact.topic)}=${normalizeValueV22(fact.value)}`;
    const list = byTopicValue.get(key) ?? [];
    list.push(fact);
    byTopicValue.set(key, list);
  }
  for (const [key, members] of [...byTopicValue.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const obsCount = members.reduce((n, m) => n + Math.max(1, m.sessionIds.length), 0);
    if (obsCount < minObservations) continue;
    const [topic, value] = key.split('=');
    const group = buildGroup(`topic:${key}`, 'repeat_topic_value', members, topic, value);
    if (!group) continue;
    groups.push(group);
    for (const m of members) grouped.add(m.id);
  }
  return groups;
}

/** Text tong hop cua pattern fact (xac dinh, co so lieu). */
export function renderPatternTextV22(group: V22PatternGroup): string {
  return `Pattern (${group.observations} quan sat, ${group.sessions} session): ${group.representativeText}`;
}

/**
 * Ap dung mot pass tong hop pattern len store: nhom moi thi
 * tao pattern fact; nhom da co pattern thi CAP NHAT pattern cu
 * (text + so lieu + confidence + session, tang version) thay
 * vi tao trung.
 */
export function applyPatternsV22(
  store: V22DreamStore,
  options: V22PatternOptions = {},
): V22PatternResult {
  const now = options.now ?? Date.now();
  const groups = findPatternGroupsV22(store, options);
  const created: V22DreamFact[] = [];
  const updated: V22DreamFact[] = [];
  const changes: V22DreamChange[] = [];
  const skipped: string[] = [];
  let changeSeq = 0;
  for (const group of groups) {
    const text = renderPatternTextV22(group);
    const sources = [...new Set(group.members.flatMap((m) => m.sources))];
    const tags = [
      patternTagV22(group.patternKey),
      ...new Set(group.members.flatMap((m) => m.tags.filter((t) => !t.startsWith('pattern:')))),
    ];
    if (group.existingPattern) {
      const existing = group.existingPattern;
      const res = store.updateFact(
        existing.id,
        { text, confidence: group.confidence, sources, tags, sessionIds: group.sessionIds },
        now,
      );
      if (res.ok && res.data) {
        updated.push(res.data);
        changeSeq += 1;
        changes.push({
          id: `chg-pattern-${changeSeq}`,
          kind: 'pattern',
          factIdsBefore: [existing.id, ...group.members.map((m) => m.id)],
          factIdsAfter: [existing.id],
          reason: `Cap nhat pattern "${existing.id}" (${group.mechanism}): nay ${group.observations} quan sat / ${group.sessions} session (truoc ${existing.text.match(/\((\d+) quan sat/)?.[1] ?? '?'} quan sat) — confidence ${group.confidence.toFixed(2)}.`,
          detail: `khoa pattern: ${group.patternKey}; fact goc van active de truy vet.`,
          at: now,
        });
      } else {
        skipped.push(`khong cap nhat duoc pattern "${existing.id}": ${res.error ?? 'loi khong ro'}`);
      }
      continue;
    }
    const res = store.addFact(
      {
        kind: 'pattern',
        text,
        ...(group.topic !== undefined ? { topic: group.topic } : {}),
        ...(group.value !== undefined ? { value: group.value } : {}),
        confidence: group.confidence,
        sources: [...sources, `dream:pattern:${group.patternKey}`],
        tags,
        sessionIds: group.sessionIds,
        observedAt: now,
        origin: 'pattern',
      },
      now,
    );
    if (res.ok && res.data) {
      created.push(res.data);
      changeSeq += 1;
      changes.push({
        id: `chg-pattern-${changeSeq}`,
        kind: 'pattern',
        factIdsBefore: group.members.map((m) => m.id),
        factIdsAfter: [res.data.id],
        reason: `Tong hop pattern moi "${res.data.id}" (${group.mechanism}): ${group.observations} quan sat / ${group.sessions} session — confidence ${group.confidence.toFixed(2)}.`,
        detail: `khoa pattern: ${group.patternKey}; fact goc van active de truy vet.`,
        at: now,
      });
    } else {
      skipped.push(`khong tao duoc pattern cho nhom ${group.patternKey}: ${res.error ?? 'loi khong ro'}`);
    }
  }
  return { groups, created, updated, changes, skipped };
}
