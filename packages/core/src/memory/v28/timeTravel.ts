/**
 * Memory v28 — time-travel reads (v1.44, Doi T1).
 *
 * Y tuong hoc tu mnemograph (survey v144 muc 3, chi y tuong,
 * KHONG copy code/text/tai san): event-sourced knowledge graph,
 * version bang git, time-travel reads `get_state_at` /
 * `diff_timerange`. Tu thiet ke lai cho open-bot tren nen git
 * store v28 + fact store bi-temporal v28.
 *
 *  - `get_state_at(timestamp)`: toan bo trang thai memory tai
 *    thoi diem X — noi dung tung block tai X (qua git log +
 *    git show, fallback history.jsonl) + fact dung tai X (ca 2
 *    truc valid time + transaction time).
 *  - `diff_timerange(from, to)`: so sanh 2 trang thai — block
 *    them/bot/doi, fact them/vo hieu — moi muc ghi ro thoi diem
 *    va tom tat thay doi, khong tra noi dung day du (de nhe).
 *  - `blockTimeline(label)`: lich su version cua 1 block kem
 *    thoi gian, dung cho UI timeline.
 *  - `factTimeline(subject)`: lich su fact cua 1 subject kem
 *    cua so hieu luc — thay ro fact nao bi supersede khi nao.
 *
 * Khac biet voi time-travel chat cua v27: v27 chi tra fact +
 * gia tri block tai X; v28 tra TOAN BO state (tat ca block +
 * tat ca fact) va them diff theo khoang thoi gian.
 */
import { V28FactStore } from './invalidation';
import { V28GitBlockStore } from './gitStore';
import {
  errV28,
  hashContentV28,
  isoAtV28,
  okV28,
  parseIsoV28,
  type V28BlockVersion,
  type V28DiffEntry,
  type V28DiffRange,
  type V28Fact,
  type V28Result,
  type V28TimeTravelState,
} from './types';

/** Phu thuoc cua time-travel. */
export interface V28TimeTravelDeps {
  gitStore: V28GitBlockStore;
  factStore: V28FactStore;
}

/** Mot muc trong timeline cua block. */
export interface V28BlockTimelineEntry extends V28BlockVersion {
  /** Noi dung tai version nay (lay tu git show / fallback). */
  content: string | null;
}

/** Mot muc trong timeline cua fact. */
export interface V28FactTimelineEntry {
  fact: V28Fact;
  /** Fact dung trong khoang nay (valid time). */
  validWindow: string;
  /** He thong biet fact trong khoang nay (transaction time). */
  knownWindow: string;
}

/**
 * Time-travel tren memory v28.
 *
 * Khong giu state rieng — doc truc tiep tu git store + fact
 * store moi lan goi, nen ket qua luon moi nhat.
 */
export class V28TimeTravel {
  readonly gitStore: V28GitBlockStore;
  readonly factStore: V28FactStore;

  constructor(deps: V28TimeTravelDeps) {
    this.gitStore = deps.gitStore;
    this.factStore = deps.factStore;
  }

  /** Tat ca label block tung ton tai (hien tai + da archive + trong lich su). */
  knownLabels(): string[] {
    const set = new Set<string>();
    for (const meta of this.gitStore.listBlocks()) set.add(meta.label);
    for (const label of this.gitStore.listArchived()) set.add(label);
    return [...set].sort();
  }

  /**
   * Trang thai memory tai thoi diem `at`:
   *  - blocks: noi dung tung block tai `at` (bo qua block chua
   *    ton tai tai `at`).
   *  - facts: fact dung tai `at` VA he thong da biet truoc `at`.
   */
  getStateAt(at: string | Date | number): V28Result<V28TimeTravelState> {
    const atMs = parseIsoV28(at);
    if (atMs === null) return errV28(`Thoi diem khong hop le: "${String(at)}"`);
    const atIso = isoAtV28(atMs) as string;
    const blocks: V28TimeTravelState['blocks'] = [];
    for (const label of this.knownLabels()) {
      const got = this.gitStore.getAt(label, atMs);
      if (!got.ok) continue;
      blocks.push({
        label,
        version: got.value.version,
        commit: got.value.commit,
        hash: '',
        content: got.value.content,
        updatedAt: got.value.at,
      });
    }
    // Dien hash cho tung block (hash cua noi dung tai thoi diem do).
    for (const block of blocks) {
      block.hash = hashContentV28(block.content);
    }
    const factsResult = this.factStore.validAndKnownAt(atMs);
    if (!factsResult.ok) return errV28(factsResult.error);
    const facts: V28Fact[] = factsResult.value.map((f) => ({ ...f }));
    blocks.sort((a, b) => a.label.localeCompare(b.label));
    return okV28({ at: atIso, blocks, facts });
  }

  /**
   * Diff 2 thoi diem: so sanh get_state_at(from) voi
   * get_state_at(to). Thu tu muc: block truoc, fact sau; trong
   * moi nhom sap theo key.
   */
  diffTimerange(from: string | Date | number, to: string | Date | number): V28Result<V28DiffRange> {
    const fromMs = parseIsoV28(from);
    const toMs = parseIsoV28(to);
    if (fromMs === null) return errV28(`Thoi diem bat dau khong hop le: "${String(from)}"`);
    if (toMs === null) return errV28(`Thoi diem ket thuc khong hop le: "${String(to)}"`);
    if (fromMs > toMs) return errV28('diff_timerange yeu cau from <= to');
    const fromIso = isoAtV28(fromMs) as string;
    const toIso = isoAtV28(toMs) as string;
    const fromState = this.getStateAt(fromMs);
    const toState = this.getStateAt(toMs);
    if (!fromState.ok) return errV28(fromState.error);
    if (!toState.ok) return errV28(toState.error);

    const entries: V28DiffEntry[] = [];
    let blocksAdded = 0;
    let blocksRemoved = 0;
    let blocksChanged = 0;
    let factsAdded = 0;
    let factsInvalidated = 0;

    const fromBlocks = new Map(fromState.value.blocks.map((b) => [b.label, b]));
    const toBlocks = new Map(toState.value.blocks.map((b) => [b.label, b]));
    const allLabels = new Set([...fromBlocks.keys(), ...toBlocks.keys()]);
    for (const label of [...allLabels].sort()) {
      const before = fromBlocks.get(label);
      const after = toBlocks.get(label);
      if (!before && after) {
        blocksAdded += 1;
        entries.push({
          kind: 'block',
          key: label,
          change: 'added',
          at: after.updatedAt,
          summary: `block "${label}" duoc tao (v${after.version})`,
          toVersion: after.version,
          toHash: after.hash,
        });
      } else if (before && !after) {
        blocksRemoved += 1;
        entries.push({
          kind: 'block',
          key: label,
          change: 'removed',
          at: toIso,
          summary: `block "${label}" khong con ton tai (da archive hoac xoa khoi repo)`,
          fromVersion: before.version,
          fromHash: before.hash,
        });
      } else if (before && after && before.hash !== after.hash) {
        blocksChanged += 1;
        entries.push({
          kind: 'block',
          key: label,
          change: 'changed',
          at: after.updatedAt,
          summary: `block "${label}" doi v${before.version} -> v${after.version}`,
          fromVersion: before.version,
          toVersion: after.version,
          fromHash: before.hash,
          toHash: after.hash,
        });
      }
    }

    // Fact: su kien trong khoang — fact duoc TAO trong [from, to]
    // la added; fact bi VO HIEU trong [from, to] la invalidated.
    // (So sanh state tai 2 dau moc khong du: fact tao roi vo
    // hieu trong cung khoang se khong hien o ca 2 dau.)
    const createdInRange = this.factStore
      .all()
      .filter((f) => {
        const created = parseIsoV28(f.createdAt);
        return created !== null && created >= fromMs && created <= toMs;
      });
    for (const fact of createdInRange) {
      factsAdded += 1;
      entries.push({
        kind: 'fact',
        key: fact.id,
        change: 'added',
        at: fact.createdAt,
        summary: `fact moi: ${fact.subject} ${fact.predicate} ${fact.object}`,
      });
    }
    const invalidatedInRange = this.factStore.all().filter((f) => {
      if (!f.invalidatedAt) return false;
      const invalidated = parseIsoV28(f.invalidatedAt);
      return invalidated !== null && invalidated >= fromMs && invalidated <= toMs;
    });
    for (const fact of invalidatedInRange) {
      factsInvalidated += 1;
      const change = fact.status === 'superseded' ? 'invalidated' : 'invalidated';
      entries.push({
        kind: 'fact',
        key: fact.id,
        change,
        at: fact.invalidatedAt as string,
        summary:
          fact.status === 'superseded'
            ? `fact bi supersede: ${fact.subject} ${fact.predicate} ${fact.object} (ly do: ${fact.invalidateReason ?? 'superseded'})`
            : `fact bi vo hieu: ${fact.subject} ${fact.predicate} ${fact.object} (ly do: ${fact.invalidateReason ?? 'unknown'})`,
      });
    }
    entries.sort((a, b) => a.at.localeCompare(b.at));
    return okV28({
      from: fromIso,
      to: toIso,
      entries,
      blocksAdded,
      blocksRemoved,
      blocksChanged,
      factsAdded,
      factsInvalidated,
    });
  }

  /**
   * Timeline cua 1 block: moi version kem noi dung tai version
   * do (qua git show / fallback). Moi nhat truoc.
   */
  blockTimeline(label: string, limit: number = 50): V28BlockTimelineEntry[] {
    const versions = this.gitStore.history(label, limit);
    return versions.map((v) => {
      let content: string | null = null;
      if (v.commit) content = this.gitStore.readContentAtCommit(label, v.commit);
      if (content === null) content = this.gitStore.resolveContent(label, v.version);
      return { ...v, content };
    });
  }

  /**
   * Timeline cua 1 subject: moi fact kem cua so hieu luc
   * (valid + known), sap theo validFrom.
   */
  factTimeline(subject: string): V28FactTimelineEntry[] {
    const facts = this.factStore.factsForSubject(subject, { includeInactive: true });
    const entries = facts.map((fact) => ({
      fact: { ...fact },
      validWindow: `${fact.validFrom} .. ${fact.validTo ?? 'hien tai'}`,
      knownWindow: `${fact.createdAt} .. ${fact.invalidatedAt ?? 'hien tai'}`,
    }));
    entries.sort((a, b) => a.fact.validFrom.localeCompare(b.fact.validFrom));
    return entries;
  }

  /** So luong version cua 1 block (dung cho stats nhanh). */
  blockVersionCount(label: string): number {
    return this.gitStore.history(label, 500).length;
  }
}
