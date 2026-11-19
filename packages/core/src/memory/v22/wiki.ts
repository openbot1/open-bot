/**
 * Memory v22 — Wiki representation (v1.37, Doi T1).
 *
 * Y tuong (Anthropic Dreams "xay representation dang wiki"):
 * sau khi consolidate, fact khong nen nam roi rac — chung duoc
 * gom thanh trang wiki theo chu de, moi trang tom tat + liet ke
 * fact + link sang trang lien quan (tag chung / topic co cung
 * tien to). Wiki la "ban do" cua memory: user/agent doc wiki
 * la hieu user la ai, thich gi, dang lam gi — ma khong can doc
 * het tung fact.
 *
 * Quy tac:
 *  1. NHOM TRANG: fact active gom theo topic (chuan hoa); fact
 *     khong co topic gom theo tag dau tien; khong co ca hai thi
 *     vao trang `general`. Pattern fact luon co trang rieng
 *     theo topic cua no (neu co) de noi bat.
 *  2. LINK: hai trang link nhau khi co >= 1 tag chung (ly do
 *     ghi ro tag nao) hoac cung tien to topic truoc dau `|`
 *     (vd `user|...` — cung chu the). Link hai chieu.
 *  3. MARKDOWN: moi trang render san thanh Markdown (`# tieu
 *     de`, dong tom tat, `## Facts` liet ke kem confidence +
 *     id de truy vet, `## Links`).
 *  4. DIFF: `diffWikiV22` so chi muc cu / moi — trang them /
 *     mat / doi (factIds thay doi) — de dream report noi ro
 *     wiki thay doi the nao.
 *  5. Wiki la DUOC SUY RA tu fact (derived view): xoa wiki
 *     khong mat fact; build lai tu fact la khoi phuc duoc.
 */
import type { V22DreamFact, V22WikiIndex, V22WikiLink, V22WikiPage } from './types';
import { normalizeTopicV22, stripDiacriticsV22 } from './store';
import { dreamTextTokensV22 } from './dedupe';

/** Slug hoa mot chuoi (tieu de / topic) thanh slug URL-safe. */
export function slugifyWikiV22(value: string): string {
  const slug = stripDiacriticsV22(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 80);
  return slug || 'general';
}

/** Tieu de hien thi cua mot topic (vd `user|thich_uong` -> `User: thich uong`). */
export function topicTitleV22(topic: string): string {
  if (topic === 'general') return 'General';
  const parts = topic.split('|');
  return parts
    .map((p) => p.replace(/[_-]+/g, ' '))
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(': ');
}

/** Render Markdown day du cua mot trang wiki. */
export function renderWikiPageMarkdownV22(page: V22WikiPage, factsById: Map<string, V22DreamFact>): string {
  const lines: string[] = [];
  lines.push(`# ${page.title}`);
  lines.push('');
  lines.push(page.summary);
  lines.push('');
  lines.push('## Facts');
  lines.push('');
  for (const factId of page.factIds) {
    const fact = factsById.get(factId);
    if (!fact) continue;
    lines.push(`- ${fact.text} (confidence ${fact.confidence.toFixed(2)}, id ${fact.id})`);
  }
  if (page.links.length > 0) {
    lines.push('');
    lines.push('## Links');
    lines.push('');
    for (const link of page.links) {
      lines.push(`- [${link.slug}](${link.slug}.md) — ${link.reason}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Tom tat mot trang: text cua fact manh nhat, cat 160 ky tu. */
export function summarizePageV22(facts: V22DreamFact[]): string {
  if (facts.length === 0) return 'Chua co fact.';
  const top = facts[0];
  const text = top.text.length > 160 ? `${top.text.slice(0, 157)}...` : top.text;
  return facts.length === 1 ? text : `${text} (+${facts.length - 1} fact khac)`;
}

/** Nhom fact active thanh trang theo topic/tag (chua tinh link). */
export function groupFactsIntoPagesV22(facts: V22DreamFact[]): Map<string, V22DreamFact[]> {
  const pages = new Map<string, V22DreamFact[]>();
  const active = facts
    .filter((f) => f.status === 'active')
    .sort((a, b) => b.confidence - a.confidence || b.observedAt - a.observedAt);
  for (const fact of active) {
    let topic = 'general';
    if (typeof fact.topic === 'string' && fact.topic.trim() !== '') {
      topic = normalizeTopicV22(fact.topic);
    } else if (fact.tags.length > 0) {
      topic = `tag:${normalizeTopicV22(fact.tags[0])}`;
    }
    const list = pages.get(topic) ?? [];
    list.push(fact);
    pages.set(topic, list);
  }
  return pages;
}

/** Tinh link giua cac trang (tag chung / cung tien to topic). */
export function computeWikiLinksV22(
  topics: string[],
  factsByTopic: Map<string, V22DreamFact[]>,
): Map<string, V22WikiLink[]> {
  const links = new Map<string, V22WikiLink[]>();
  const tagsOf = (topic: string): Set<string> => {
    const tags = new Set<string>();
    for (const fact of factsByTopic.get(topic) ?? []) {
      for (const tag of fact.tags) tags.add(tag);
    }
    return tags;
  };
  const prefixOf = (topic: string): string => topic.split('|')[0];
  for (const topic of topics) {
    const out: V22WikiLink[] = [];
    const myTags = tagsOf(topic);
    for (const other of topics) {
      if (other === topic) continue;
      const shared = [...tagsOf(other)].filter((t) => myTags.has(t) && !t.startsWith('pattern:'));
      if (shared.length > 0) {
        out.push({ slug: slugifyWikiV22(other), reason: `tag chung: ${shared.slice(0, 3).join(', ')}` });
        continue;
      }
      if (topic !== 'general' && !topic.startsWith('tag:') && prefixOf(other) === prefixOf(topic) && other !== topic) {
        out.push({ slug: slugifyWikiV22(other), reason: `cung chu the: ${prefixOf(topic)}` });
      }
    }
    out.sort((a, b) => a.slug.localeCompare(b.slug));
    links.set(topic, out);
  }
  return links;
}

/**
 * Xay chi muc wiki tu fact hien tai. `previous` (tuy chon) de
 * tinh pagesAdded / pagesRemoved / pagesChanged so voi lan truoc.
 */
export function buildWikiV22(
  facts: V22DreamFact[],
  opts: { jobId: string; previous?: V22WikiIndex; now?: number } = { jobId: 'manual' },
): V22WikiIndex {
  const now = opts.now ?? Date.now();
  const factsById = new Map(facts.map((f) => [f.id, f]));
  const grouped = groupFactsIntoPagesV22(facts);
  const topics = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  const linksByTopic = computeWikiLinksV22(topics, grouped);
  const pages: V22WikiPage[] = [];
  for (const topic of topics) {
    const members = grouped.get(topic) as V22DreamFact[];
    const slug = slugifyWikiV22(topic === 'general' ? 'general' : topic.replace(/^tag:/, 'tag-'));
    const page: V22WikiPage = {
      slug,
      title: topic.startsWith('tag:')
        ? `Tag: ${topicTitleV22(topic.slice(4))}`
        : topicTitleV22(topic),
      topic,
      summary: summarizePageV22(members),
      factIds: members.map((f) => f.id),
      links: linksByTopic.get(topic) ?? [],
      markdown: '',
      updatedAt: now,
    };
    page.markdown = renderWikiPageMarkdownV22(page, factsById);
    pages.push(page);
  }
  // Diff so voi chi muc truoc (neu co).
  let pagesAdded = 0;
  let pagesRemoved = 0;
  let pagesChanged = 0;
  if (opts.previous) {
    const prevBySlug = new Map(opts.previous.pages.map((p) => [p.slug, p]));
    const nextBySlug = new Map(pages.map((p) => [p.slug, p]));
    for (const slug of nextBySlug.keys()) {
      if (!prevBySlug.has(slug)) pagesAdded += 1;
    }
    for (const slug of prevBySlug.keys()) {
      if (!nextBySlug.has(slug)) pagesRemoved += 1;
    }
    for (const [slug, next] of nextBySlug) {
      const prev = prevBySlug.get(slug);
      if (!prev) continue;
      const same = prev.factIds.length === next.factIds.length
        && prev.factIds.every((id, i) => id === next.factIds[i]);
      if (!same) pagesChanged += 1;
    }
  } else {
    pagesAdded = pages.length;
  }
  return {
    pages,
    generatedAt: now,
    jobId: opts.jobId,
    pagesAdded,
    pagesRemoved,
    pagesChanged,
  };
}

/** So sanh hai chi muc wiki (de test / bao cao doc lap voi build). */
export function diffWikiV22(
  previous: V22WikiIndex | undefined,
  next: V22WikiIndex,
): { added: string[]; removed: string[]; changed: string[] } {
  if (!previous) {
    return { added: next.pages.map((p) => p.slug), removed: [], changed: [] };
  }
  const prevBySlug = new Map(previous.pages.map((p) => [p.slug, p]));
  const nextBySlug = new Map(next.pages.map((p) => [p.slug, p]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const slug of nextBySlug.keys()) if (!prevBySlug.has(slug)) added.push(slug);
  for (const slug of prevBySlug.keys()) if (!nextBySlug.has(slug)) removed.push(slug);
  for (const [slug, nextPage] of nextBySlug) {
    const prev = prevBySlug.get(slug);
    if (!prev) continue;
    const same = prev.factIds.length === nextPage.factIds.length
      && prev.factIds.every((id, i) => id === nextPage.factIds[i]);
    if (!same) changed.push(slug);
  }
  return { added, removed, changed };
}

/** Tim trang wiki chua mot fact (de UI nhay tu fact sang wiki). */
export function findWikiPageForFactV22(index: V22WikiIndex, factId: string): V22WikiPage | undefined {
  return index.pages.find((p) => p.factIds.includes(factId));
}

/** Do phu wiki: bao nhieu fact active da co trong wiki. */
export function wikiCoverageV22(index: V22WikiIndex, facts: V22DreamFact[]): { covered: number; total: number; ratio: number } {
  const active = facts.filter((f) => f.status === 'active');
  const coveredIds = new Set(index.pages.flatMap((p) => p.factIds));
  const covered = active.filter((f) => coveredIds.has(f.id)).length;
  return { covered, total: active.length, ratio: active.length === 0 ? 1 : covered / active.length };
}

/** Cac tu khoa chung giua hai trang (de giai thich link — dung trong test). */
export function sharedTokensV22(a: V22DreamFact[], b: V22DreamFact[]): string[] {
  const tokensA = new Set(a.flatMap((f) => dreamTextTokensV22(f.text)));
  const tokensB = new Set(b.flatMap((f) => dreamTextTokensV22(f.text)));
  return [...tokensA].filter((t) => tokensB.has(t) && t.length > 2).sort();
}
