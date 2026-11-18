/**
 * Inference broker v2 — prefix-cache cho multi-turn agent loop
 * (v1.33, Doi T5).
 *
 * Y tuong hoc tu SGLang RadixAttention (survey v133 muc 4): cac turn
 * cua 1 agent loop chia se chung 1 prompt prefix (system prompt +
 * lich su turn truoc + tool definitions). Thay vi tinh lai toan bo
 * prefix moi turn, cache prefix chung theo cay Radix (trie): moi
 * node la 1 doan (segment) cua prompt — system, 1 message, hoac 1
 * tool definition — va node con ke thua prefix cua node cha. Turn
 * sau chi can tinh them phan duoi moi, giam latency/turn khi chay
 * local (dac biet tren Ollama / llama.cpp, noi khong co prefix
 * caching phia server).
 *
 * Thuc thi o day la cache PHIA CLIENT (open-bot), khong phai KV cache
 * cua engine: no luu "prefix nao da thay + do dai khop" de broker
 * biet turn nay tiet kiem duoc bao nhieu, do hit rate, va quyet dinh
 * co nen gui lai toan bo lich su hay cat ngan. Engine co prefix
 * caching that (vLLM / SGLang) van duoc huong loi them tu phia server;
 * cache nay khong gia vo thay the KV cache cua engine.
 *
 * Thuan, khong I/O. Hash FNV-1a tu viet (khong phu thuoc crypto).
 * Gioi han so node + tuoi (TTL) de khong an RAM vo han.
 */

/** 1 message trong prompt (dang toi thieu de hash prefix). */
export interface InferenceBrokerV2CacheMessage {
  role: string;
  content: string;
  /** Ten tool (neu la tool call / tool result). */
  name?: string;
}

/** 1 node trong cay Radix (1 segment cua prefix). */
export interface InferenceBrokerV2RadixNode {
  /** Hash cua segment nay (FNV-1a cua role+content+name da chuan hoa). */
  segmentHash: string;
  /** Do dai uoc luong cua segment (ky tu — proxy cho token). */
  segmentChars: number;
  /** So con truc tiep. */
  childCount: number;
  /** So lan node nay duoc dung (hit). */
  hits: number;
  /** Lan dung gan nhat (ms epoch). */
  lastUsedAt: number;
  /** Lan tao node (ms epoch). */
  createdAt: number;
}

/** Ket qua lookup prefix cua 1 turn. */
export interface InferenceBrokerV2PrefixLookup {
  /** So segment khop tu dau (prefix chung dai nhat). */
  matchedSegments: number;
  /** Tong so segment cua prompt hien tai. */
  totalSegments: number;
  /** So ky tu thuoc prefix da cache (uoc luong tiet kiem). */
  matchedChars: number;
  /** Tong so ky tu cua prompt. */
  totalChars: number;
  /** Ty le prefix duoc cache (0..1). */
  hitRatio: number;
  /** true = toan bo prompt da cache (full hit). */
  fullHit: boolean;
  /** true = co 1 phan prefix cache (partial hit). */
  partialHit: boolean;
  /** true = khong co segment nao khop. */
  miss: boolean;
}

/** Thong ke cua cache. */
export interface InferenceBrokerV2PrefixCacheStats {
  /** Tong so lookup. */
  lookups: number;
  /** So full hit (toan bo prompt da cache). */
  fullHits: number;
  /** So partial hit (co prefix, khong full). */
  partialHits: number;
  /** So miss hoan toan. */
  misses: number;
  /** Hit rate: (full + partial) / lookups. */
  hitRate: number;
  /** Full-hit rate. */
  fullHitRate: number;
  /** Tong ky tu tiet kiem duoc nho prefix cache (uoc luong). */
  charsSaved: number;
  /** Tong ky tu da lookup. */
  totalCharsSeen: number;
  /** So node trong cay hien tai. */
  nodes: number;
  /** So node da bi evict (het cho / het han). */
  evictions: number;
  /** So session dang theo doi. */
  sessions: number;
}

/** So node toi da trong cay (mac dinh). */
export const BROKER_V2_PREFIX_CACHE_MAX_NODES = 2000;
/** TTL mac dinh cua 1 node (ms) — het han thi prune. */
export const BROKER_V2_PREFIX_CACHE_TTL_MS = 30 * 60 * 1000;
/** So ky tu toi da cua 1 segment luu trong cay (cat ngan de hash on dinh). */
export const BROKER_V2_PREFIX_SEGMENT_MAX_CHARS = 8000;

/** Hash FNV-1a 32-bit, tra hex 8 ky tu (tu viet, khong phu thuoc). */
export function brokerV2Fnv1aHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Chuan hoa 1 message thanh chuoi de hash (bo khoang trang thua). */
export function brokerV2NormalizeCacheMessage(msg: InferenceBrokerV2CacheMessage): string {
  const content = msg.content.replace(/\s+/g, ' ').trim();
  const name = (msg.name ?? '').trim();
  return `${msg.role}|${name}|${content}`;
}

/**
 * Tach prompt thanh cac segment: system rieng, moi message 1 segment,
 * tool definitions (neu co) thanh 1 segment dau tien. Thu tu giu
 * nguyen — prefix chi co nghia khi thu tu khop.
 */
export function brokerV2PromptSegments(
  messages: readonly InferenceBrokerV2CacheMessage[],
  toolDefinitions?: readonly string[],
): string[] {
  const segments: string[] = [];
  if (toolDefinitions && toolDefinitions.length > 0) {
    segments.push(`tools|${toolDefinitions.map((t) => t.trim()).join('\n')}`);
  }
  for (const m of messages) {
    segments.push(brokerV2NormalizeCacheMessage(m));
  }
  return segments;
}

/** Node noi bo cua cay Radix. */
interface BrokerV2TrieNode {
  segmentHash: string;
  segmentChars: number;
  hits: number;
  lastUsedAt: number;
  createdAt: number;
  children: Map<string, BrokerV2TrieNode>;
}

/**
 * Prefix cache dang cay Radix cho multi-turn agent loop.
 *
 * Cach dung: moi turn goi `lookup(messages, toolDefinitions?)` truoc
 * khi gui request (de biet prefix khop bao nhieu), roi goi
 * `store(messages, toolDefinitions?)` sau khi gui (de turn sau dung).
 * `beginTurn` lam ca hai trong 1 lan goi. Moi session (agent loop)
 * co the dung chung 1 cache (prefix system + tool defs giong nhau)
 * hoac cache rieng — broker tao 1 cache cho moi session.
 */
export class InferenceBrokerV2PrefixCache {
  private readonly root: BrokerV2TrieNode;
  private readonly maxNodes: number;
  private readonly ttlMs: number;
  private readonly nowFn: () => number;
  private nodeCount = 0;
  private lookups = 0;
  private fullHits = 0;
  private partialHits = 0;
  private misses = 0;
  private charsSaved = 0;
  private totalCharsSeen = 0;
  private evictions = 0;
  private readonly sessions = new Set<string>();

  constructor(opts?: { maxNodes?: number; ttlMs?: number; now?: () => number }) {
    this.maxNodes = opts?.maxNodes ?? BROKER_V2_PREFIX_CACHE_MAX_NODES;
    this.ttlMs = opts?.ttlMs ?? BROKER_V2_PREFIX_CACHE_TTL_MS;
    this.nowFn = opts?.now ?? Date.now;
    const now = this.nowFn();
    this.root = {
      segmentHash: '__root__',
      segmentChars: 0,
      hits: 0,
      lastUsedAt: now,
      createdAt: now,
      children: new Map(),
    };
  }

  /** So node hien co (khong tinh root). */
  get size(): number {
    return this.nodeCount;
  }

  /** Lookup prefix cua 1 prompt (khong ghi — chi do). */
  lookup(
    messages: readonly InferenceBrokerV2CacheMessage[],
    opts?: { toolDefinitions?: readonly string[] },
  ): InferenceBrokerV2PrefixLookup {
    const segments = brokerV2PromptSegments(messages, opts?.toolDefinitions);
    this.lookups += 1;
    let node: BrokerV2TrieNode = this.root;
    let matchedSegments = 0;
    let matchedChars = 0;
    let totalChars = 0;
    const now = this.nowFn();
    for (const seg of segments) {
      const chars = Math.min(seg.length, BROKER_V2_PREFIX_SEGMENT_MAX_CHARS);
      totalChars += chars;
      const hash = brokerV2Fnv1aHash(seg.slice(0, BROKER_V2_PREFIX_SEGMENT_MAX_CHARS));
      const child = node.children.get(hash);
      if (!child) break;
      if (now - child.lastUsedAt > this.ttlMs) break;
      matchedSegments += 1;
      matchedChars += child.segmentChars;
      node = child;
    }
    this.totalCharsSeen += totalChars;
    const fullHit = segments.length > 0 && matchedSegments === segments.length;
    const partialHit = matchedSegments > 0 && !fullHit;
    if (fullHit) {
      this.fullHits += 1;
      this.charsSaved += matchedChars;
    } else if (partialHit) {
      this.partialHits += 1;
      this.charsSaved += matchedChars;
    } else {
      this.misses += 1;
    }
    return {
      matchedSegments,
      totalSegments: segments.length,
      matchedChars,
      totalChars,
      hitRatio: totalChars > 0 ? matchedChars / totalChars : 0,
      fullHit,
      partialHit,
      miss: matchedSegments === 0,
    };
  }

  /** Luu prefix cua 1 prompt vao cay (sau khi gui request). */
  store(
    messages: readonly InferenceBrokerV2CacheMessage[],
    opts?: { toolDefinitions?: readonly string[]; sessionId?: string },
  ): number {
    const segments = brokerV2PromptSegments(messages, opts?.toolDefinitions);
    const sessionId = opts?.sessionId;
    if (sessionId) this.sessions.add(sessionId);
    const now = this.nowFn();
    let node: BrokerV2TrieNode = this.root;
    let added = 0;
    for (const seg of segments) {
      const chars = Math.min(seg.length, BROKER_V2_PREFIX_SEGMENT_MAX_CHARS);
      const hash = brokerV2Fnv1aHash(seg.slice(0, BROKER_V2_PREFIX_SEGMENT_MAX_CHARS));
      let child = node.children.get(hash);
      if (!child) {
        if (this.nodeCount >= this.maxNodes) {
          // Het cho: prune node het han truoc, neu van het thi dung lai
          // (khong evict bua — prefix cu co the la system prompt quan
          // trong; bao cao qua evictions de host tang maxNodes).
          const pruned = this.pruneExpired(now);
          if (this.nodeCount >= this.maxNodes) {
            this.evictions += 1;
            void pruned;
            break;
          }
        }
        child = {
          segmentHash: hash,
          segmentChars: chars,
          hits: 0,
          lastUsedAt: now,
          createdAt: now,
          children: new Map(),
        };
        node.children.set(hash, child);
        this.nodeCount += 1;
        added += 1;
      }
      child.hits += 1;
      child.lastUsedAt = now;
      node = child;
    }
    return added;
  }

  /**
   * Lookup + store trong 1 lan goi (dung o dau moi turn): tra lookup
   * truoc khi store, de turn hien tai biet minh tiet kiem duoc bao
   * nhieu roi moi ghi them phan moi vao cay.
   */
  beginTurn(
    messages: readonly InferenceBrokerV2CacheMessage[],
    opts?: { toolDefinitions?: readonly string[]; sessionId?: string },
  ): InferenceBrokerV2PrefixLookup {
    const lookup = this.lookup(messages, opts);
    this.store(messages, opts);
    return lookup;
  }

  /**
   * Cat ngan lich su gui di dua tren prefix da cache: tra ve chi so
   * segment bat dau phan chua cache. Vi du: 10 message, 7 khop ->
   * caller co the gui ngan gon hon (neu engine ho tro) hoac it nhat
   * biet 70% prompt da co trong cache phia server/client.
   * Tra -1 khi khong co prefix nao khop.
   */
  cachedPrefixLength(
    messages: readonly InferenceBrokerV2CacheMessage[],
    opts?: { toolDefinitions?: readonly string[] },
  ): number {
    const lookup = this.lookup(messages, opts);
    // Lookup da dem vao stats — day la ham do, khong phai ham gui.
    return lookup.matchedSegments > 0 ? lookup.matchedSegments : -1;
  }

  /** Xoa node het han (TTL). Tra so node da xoa. */
  pruneExpired(now: number = this.nowFn()): number {
    let removed = 0;
    const prune = (node: BrokerV2TrieNode): void => {
      for (const [hash, child] of [...node.children.entries()]) {
        if (now - child.lastUsedAt > this.ttlMs && child.children.size === 0) {
          node.children.delete(hash);
          this.nodeCount -= 1;
          removed += 1;
        } else {
          prune(child);
        }
      }
    };
    prune(this.root);
    return removed;
  }

  /** Xoa toan bo cay (giu thong ke tong). */
  clear(): void {
    this.root.children.clear();
    this.nodeCount = 0;
    this.sessions.clear();
  }

  /** Thong ke cache (hit rate do that). */
  stats(): InferenceBrokerV2PrefixCacheStats {
    const lookups = this.lookups;
    return {
      lookups,
      fullHits: this.fullHits,
      partialHits: this.partialHits,
      misses: this.misses,
      hitRate: lookups > 0 ? (this.fullHits + this.partialHits) / lookups : 0,
      fullHitRate: lookups > 0 ? this.fullHits / lookups : 0,
      charsSaved: this.charsSaved,
      totalCharsSeen: this.totalCharsSeen,
      nodes: this.nodeCount,
      evictions: this.evictions,
      sessions: this.sessions.size,
    };
  }

  /** Liet ke node goc (de debug / UI): segment hash + hits. */
  rootChildren(): InferenceBrokerV2RadixNode[] {
    const now = this.nowFn();
    void now;
    return [...this.root.children.values()].map((c) => ({
      segmentHash: c.segmentHash,
      segmentChars: c.segmentChars,
      childCount: c.children.size,
      hits: c.hits,
      lastUsedAt: c.lastUsedAt,
      createdAt: c.createdAt,
    }));
  }

  /** Tom tat dang markdown. */
  markdown(): string {
    const s = this.stats();
    return [
      '# Inference broker v2 — prefix cache (RadixAttention-style, phia client)',
      '',
      `- Lookup: ${s.lookups}; full hit: ${s.fullHits}; partial hit: ${s.partialHits}; miss: ${s.misses}.`,
      `- Hit rate: ${(s.hitRate * 100).toFixed(1)}% (full-hit ${(s.fullHitRate * 100).toFixed(1)}%).`,
      `- Ky tu tiet kiem uoc luong: ${s.charsSaved} / ${s.totalCharsSeen} (${s.totalCharsSeen > 0 ? ((s.charsSaved / s.totalCharsSeen) * 100).toFixed(1) : '0.0'}%).`,
      `- Node trong cay: ${s.nodes}; evictions: ${s.evictions}; session: ${s.sessions}.`,
      '',
      'Luu y: day la cache phia client (do hit rate + uoc luong tiet kiem). Engine co prefix caching that (vLLM / SGLang) huong loi them tu phia server.',
    ].join('\n');
  }
}

/**
 * Uoc luong token tu so ky tu (proxy tho: ~4 ky tu / token cho tieng
 * Anh, dung de bao cao tiet kiem — khong dung de cat context that).
 */
export function brokerV2EstimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}
